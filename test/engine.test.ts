import assert from "node:assert/strict";
import { test } from "node:test";
import { checkTrade, MemoryStore, parseMandate, runTick, emptyState } from "../src/index.js";
import type { Broker, Fill, Portfolio, Proposal, Quote, Research } from "../src/index.js";

const NOW = new Date("2026-10-05T15:00:00Z");

function mandate(overrides: Record<string, unknown> = {}) {
  return parseMandate({
    version: 1,
    id: "t",
    name: "test",
    status: "active",
    autonomy: "auto",
    universe: ["NVDA", "TSLA"],
    budget: { totalUsd: 1000, perTradeUsd: 50, perDayUsd: 100, researchPerDayUsd: 0.5 },
    rules: [
      { kind: "dca", id: "nvda", stock: "NVDA", amountUsd: 50, every: "1w" },
      { kind: "dca", id: "tsla", stock: "TSLA", amountUsd: 50, every: "1w" },
    ],
    constraints: { maxAllocationPct: 40 },
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

/** Broker that fills everything and tracks the resulting portfolio. */
function fakeBroker(cashUsd: number) {
  const portfolio: Portfolio = { cashUsd, positions: [] };
  const fills: Fill[] = [];
  const broker: Broker = {
    portfolio: async () => structuredClone(portfolio),
    quote: async (stock): Promise<Quote> => ({ symbol: `${stock}x`, mint: `mint-${stock}`, priceUsd: 100, liquidityUsd: 1e6, marketOpen: true }),
    execute: async (p: Proposal): Promise<Fill> => {
      portfolio.cashUsd -= p.usd;
      portfolio.positions.push({ symbol: `${p.stock}x`, mint: `mint-${p.stock}`, qty: p.usd / 100, usdValue: p.usd });
      const fill: Fill = { txSig: `sig-${fills.length}`, symbol: `${p.stock}x`, mint: `mint-${p.stock}`, side: p.side, usd: p.usd };
      fills.push(fill);
      return fill;
    },
  };
  return { broker, fills };
}

test("a file-supplied mandate must name rule stocks inside the universe", () => {
  assert.throws(() => mandate({ universe: ["TSLA"] }), /NVDA is not in the universe/);
});

test("auto mandate fills due rules and records them", async () => {
  const store = new MemoryStore(mandate());
  const { broker, fills } = fakeBroker(500);
  const receipt = await runTick({ store, broker, now: NOW });

  assert.deepEqual(receipt.decisions.map((d) => d.outcome), ["filled", "filled"]);
  assert.equal(fills.length, 2);
  assert.equal(store.loadState().tradedUsd, 100);
  assert.equal(store.receipts.length, 1);
});

test("rules are not due again inside their interval", async () => {
  const store = new MemoryStore(mandate());
  const { broker, fills } = fakeBroker(500);
  await runTick({ store, broker, now: NOW });
  const again = await runTick({ store, broker, now: new Date(NOW.getTime() + 60 * 60 * 1000) });

  assert.equal(again.decisions.length, 0);
  assert.equal(fills.length, 2);
});

test("the daily cap blocks the trade that would cross it", async () => {
  const store = new MemoryStore(mandate({ budget: { totalUsd: 1000, perTradeUsd: 50, perDayUsd: 60 } }));
  const { broker } = fakeBroker(500);
  const receipt = await runTick({ store, broker, now: NOW });

  assert.deepEqual(receipt.decisions.map((d) => d.outcome), ["filled", "blocked"]);
  assert.match(receipt.decisions[1]!.detail!, /daily cap/);
});

test("the allocation limit blocks a concentrated buy", () => {
  const verdict = checkTrade({
    mandate: mandate(),
    state: emptyState(),
    portfolio: { cashUsd: 60, positions: [{ symbol: "NVDAx", mint: "mint-NVDA", qty: 0.4, usdValue: 40 }] },
    proposal: { side: "buy", stock: "NVDA", usd: 50, reason: "test" },
    quote: { symbol: "NVDAx", mint: "mint-NVDA", marketOpen: true },
    now: NOW,
  });
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /allocation limit/);
});

test("propose autonomy and dry runs never execute", async () => {
  for (const [m, dryRun] of [[mandate({ autonomy: "propose" }), false], [mandate(), true]] as const) {
    const { broker, fills } = fakeBroker(500);
    const receipt = await runTick({ store: new MemoryStore(m), broker, dryRun, now: NOW });
    assert.deepEqual(receipt.decisions.map((d) => d.outcome), ["proposed", "proposed"]);
    assert.equal(fills.length, 0);
  }
});

test("a paused mandate skips the tick and still writes a receipt", async () => {
  const store = new MemoryStore(mandate({ status: "paused" }));
  const receipt = await runTick({ store, broker: fakeBroker(500).broker, now: NOW });
  assert.equal(receipt.skipped, "mandate is paused");
  assert.equal(store.receipts.length, 1);
});

test("research spend lands on the receipt and the ledger, within budget", async () => {
  const store = new MemoryStore(mandate({ research: { enabled: true, topics: ["earnings"] } }));
  let asked = 0;
  const research: Research = {
    gather: async (req) => {
      asked = req.budgetUsd;
      return [{ id: "n1", topic: "earnings", source: "https://example.test/earnings", costUsd: 0.05, txSig: "rsig", data: {}, at: NOW.toISOString() }];
    },
  };
  const receipt = await runTick({ store, broker: fakeBroker(500).broker, research, now: NOW });

  assert.equal(asked, 0.5);
  assert.equal(receipt.researchUsd, 0.05);
  assert.equal(store.loadState().researchUsd, 0.05);
});
