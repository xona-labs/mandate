import assert from "node:assert/strict";
import { test } from "node:test";
import { compileMandate, LlmDecider, MemoryStore, parseMandate, runTick } from "../src/index.js";
import * as z from "zod/v4";
import { resolveProvider } from "../src/adapters/llm.js";
import { createOpenRouterLlm } from "../src/adapters/openrouter.js";
import type { Broker, Fill, Llm, Portfolio, Proposal, Quote, Research } from "../src/index.js";

const NOW = new Date("2026-10-05T15:00:00Z");

/** Model stand-in: returns canned answers in order and records what it was asked. */
function fakeLlm(...answers: unknown[]) {
  const prompts: string[] = [];
  const llm: Llm = {
    generate: async (req) => {
      prompts.push(req.prompt);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return req.schema.parse(next) as never;
    },
  };
  return { llm, prompts };
}

function fakeBroker(cashUsd = 500) {
  const portfolio: Portfolio = { cashUsd, positions: [] };
  const fills: Fill[] = [];
  const broker: Broker = {
    portfolio: async () => structuredClone(portfolio),
    quote: async (stock): Promise<Quote> => ({ symbol: `${stock}x`, mint: `mint-${stock}`, priceUsd: 100, liquidityUsd: 1e6, marketOpen: true }),
    execute: async (p: Proposal): Promise<Fill> => {
      portfolio.cashUsd -= p.usd;
      const fill: Fill = { txSig: `sig-${fills.length}`, symbol: `${p.stock}x`, mint: `mint-${p.stock}`, side: p.side, usd: p.usd };
      fills.push(fill);
      return fill;
    },
  };
  return { broker, fills };
}

function mandate(overrides: Record<string, unknown> = {}) {
  return parseMandate({
    version: 1,
    id: "t",
    name: "test",
    status: "active",
    autonomy: "auto",
    decider: "llm",
    guidance: ["Skip a buy after an earnings miss"],
    universe: ["NVDA", "TSLA"],
    budget: { totalUsd: 1000, perTradeUsd: 50, perDayUsd: 100, researchPerDayUsd: 0.5 },
    rules: [
      { kind: "dca", id: "nvda", stock: "NVDA", amountUsd: 50, every: "1w" },
      { kind: "dca", id: "tsla", stock: "TSLA", amountUsd: 50, every: "1w" },
    ],
    research: { enabled: true, topics: ["earnings"] },
    createdAt: NOW.toISOString(),
    ...overrides,
  });
}

const research: Research = {
  gather: async () => [{ id: "n1", topic: "earnings", stock: "TSLA", source: "https://example.test/e", costUsd: 0.05, data: { tsla: "missed" }, at: NOW.toISOString() }],
};

const verdict = (over: Record<string, unknown> = {}) => ({
  summary: "TSLA missed earnings; NVDA is unremarkable.",
  scheduled: [
    { ruleId: "nvda", action: "buy", usd: 50, reason: "Nothing argued against the scheduled buy.", evidence: [] },
    { ruleId: "tsla", action: "skip", usd: 0, reason: "TSLA missed earnings this week.", evidence: ["n1", "made-up"] },
  ],
  discretionary: [],
  ...over,
});

test("llm decider keeps one buy, skips the other, and the receipt says why", async () => {
  const store = new MemoryStore(mandate());
  const { broker, fills } = fakeBroker();
  const { llm, prompts } = fakeLlm(verdict());
  const receipt = await runTick({ store, broker, research, decider: new LlmDecider({ llm }), now: NOW });

  assert.equal(fills.length, 1);
  assert.equal(receipt.decisions[0]!.outcome, "filled");
  assert.deepEqual(receipt.deliberation!.skipped, [{ ruleId: "tsla", reason: "TSLA missed earnings this week." }]);
  assert.match(prompts[0]!, /missed/);
  // The skipped rule's period is used up, so the next tick does not ask again.
  assert.ok(store.loadState().rules.tsla!.lastRunAt);
  assert.equal(store.loadState().rules.tsla!.fills, 0);
});

test("the model can shrink a scheduled buy but not grow it", async () => {
  const { llm } = fakeLlm(
    verdict({
      scheduled: [
        { ruleId: "nvda", action: "buy", usd: 500, reason: "Very bullish.", evidence: [] },
        { ruleId: "tsla", action: "buy", usd: 20, reason: "Half size after a weak report.", evidence: ["n1"] },
      ],
    }),
  );
  const { broker, fills } = fakeBroker();
  await runTick({ store: new MemoryStore(mandate()), broker, research, decider: new LlmDecider({ llm }), now: NOW });

  assert.deepEqual(fills.map((f) => f.usd), [50, 20]);
});

test("extra trades are dropped unless the mandate is discretionary", async () => {
  const extra = { discretionary: [{ side: "sell", stock: "NVDA", usd: 30, reason: "Trim.", evidence: [] }] };
  const run = async (discretionary: boolean) => {
    const { llm } = fakeLlm(verdict(extra));
    const m = mandate({ discretionary });
    return new LlmDecider({ llm }).decide({ mandate: m, state: new MemoryStore(m).loadState(), portfolio: { cashUsd: 500, positions: [] }, notes: [], quotes: [], now: NOW });
  };

  assert.equal((await run(false)).proposals.some((p) => p.side === "sell"), false);
  assert.match((await run(false)).summary!, /not discretionary/);
  assert.equal((await run(true)).proposals.some((p) => p.side === "sell"), true);
});

test("evidence is limited to notes that exist, and a missing verdict keeps the schedule", async () => {
  const { llm } = fakeLlm(verdict({ scheduled: [{ ruleId: "tsla", action: "buy", usd: 50, reason: "Fine.", evidence: ["n1", "made-up"] }] }));
  const m = mandate();
  const notes = await research.gather({ stocks: [], topics: [], budgetUsd: 1, maxPerCallUsd: 1, maxCalls: 1 });
  const result = await new LlmDecider({ llm }).decide({ mandate: m, state: new MemoryStore(m).loadState(), portfolio: { cashUsd: 500, positions: [] }, notes, quotes: [], now: NOW });

  assert.deepEqual(result.proposals.find((p) => p.ruleId === "tsla")!.evidence, ["n1"]);
  assert.match(result.proposals.find((p) => p.ruleId === "nvda")!.reason, /schedule stands/);
});

test("a failed model call holds by default and trades nothing", async () => {
  const store = new MemoryStore(mandate());
  const { broker, fills } = fakeBroker();
  const receipt = await runTick({ store, broker, decider: new LlmDecider({ llm: fakeLlm(new Error("boom")).llm }), now: NOW });

  assert.equal(fills.length, 0);
  assert.match(receipt.deliberation!.summary!, /boom.*holding/);
  assert.equal(store.loadState().rules.nvda, undefined);
});

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Weekly Tech DCA",
  autonomy: "auto",
  universe: ["nvda", "TSLAx"],
  budget: { totalUsd: 1200, perTradeUsd: 50, perDayUsd: 100, researchPerDayUsd: 0.5, researchPerCallUsd: 0.1 },
  rules: [
    { stock: "NVDA", amountUsd: 50, every: "1w" },
    { stock: "TSLA", amountUsd: 50, every: "1w" },
  ],
  constraints: { maxAllocationPct: 40, maxPremiumPct: null, minLiquidityUsd: null, marketOpenOnly: false, slippageBps: null },
  researchTopics: ["earnings"],
  guidance: ["Skip a scheduled buy if the company just missed earnings."],
  discretionary: false,
  expiresAt: null,
  assumptions: ["Total budget set to twelve weeks of buys ($1200)."],
  unsupported: [],
  ...over,
});

test("compile produces a validated draft and surfaces assumptions", async () => {
  const text = "DCA $50/week into NVDA and TSLA on autopilot, max 40% in one name, skip after an earnings miss";
  const result = await compileMandate({ text, llm: fakeLlm(draft()).llm, now: NOW, checkStock: async (t) => t !== "TSLA" });
  const m = result.mandate;

  assert.equal(m.status, "draft");
  assert.equal(m.approvedAt, undefined);
  assert.equal(m.id, "weekly-tech-dca");
  assert.equal(m.text, text);
  assert.equal(m.decider, "llm");
  assert.deepEqual(m.universe, ["NVDA", "TSLA"]);
  assert.deepEqual(m.rules.map((r) => r.id), ["nvda-1w", "tsla-1w"]);
  assert.equal(m.constraints.maxAllocationPct, 40);
  assert.equal(m.constraints.maxPremiumPct, undefined);
  assert.equal(result.assumptions.length, 1);
  assert.deepEqual(result.unavailable, ["TSLA"]);
});

test("a plain schedule compiles to the rules decider", async () => {
  const plain = draft({ guidance: [], researchTopics: [], budget: { totalUsd: 1200, perTradeUsd: 50, perDayUsd: 100, researchPerDayUsd: 0, researchPerCallUsd: 0 } });
  const { mandate: m } = await compileMandate({ text: "buy $50 of NVDA and TSLA weekly", llm: fakeLlm(plain).llm, now: NOW });
  assert.equal(m.decider, "rules");
  assert.equal(m.research.enabled, false);
});

test("compile retries once with the validator's complaint, then gives up", async () => {
  const bad = draft({ rules: [{ stock: "AAPL", amountUsd: 50, every: "1w" }] });
  const { llm, prompts } = fakeLlm(bad, draft());
  const result = await compileMandate({ text: "x", llm, now: NOW });
  assert.equal(result.mandate.rules.length, 2);
  assert.match(prompts[1]!, /AAPL is not in the universe/);

  await assert.rejects(compileMandate({ text: "x", llm: fakeLlm(bad, bad).llm, now: NOW }), /could not compile/);
});

const Shape = z.object({ action: z.enum(["buy", "skip"]), usd: z.number().nullable() });

/** fetch stand-in that records the request and replies with a canned completion. */
function fakeFetch(status: number, payload: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const completion = (content: string, finish_reason = "stop") => ({ choices: [{ finish_reason, message: { content } }] });

test("openrouter adapter sends a strict schema and returns the validated answer", async () => {
  const { impl, calls } = fakeFetch(200, completion('{"action":"skip","usd":null}'));
  const llm = createOpenRouterLlm({ apiKey: "test-key", fetch: impl });
  const answer = await llm.generate({ system: "sys", prompt: "ask", schema: Shape });

  assert.deepEqual(answer, { action: "skip", usd: null });
  const { body, headers } = calls[0]!;
  assert.equal(headers.Authorization, "Bearer test-key");
  assert.equal(body.model, "anthropic/claude-opus-5.5");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.response_format.json_schema.schema.required, ["action", "usd"]);
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(body.provider.require_parameters, true);
  assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ["system", "user"]);
});

test("openrouter adapter rejects answers that are off-shape, cut off, or errors", async () => {
  const gen = (status: number, payload: unknown) =>
    createOpenRouterLlm({ apiKey: "k", fetch: fakeFetch(status, payload).impl }).generate({ system: "s", prompt: "p", schema: Shape });

  await assert.rejects(gen(200, completion('{"action":"sell","usd":1}')), /did not match/);
  await assert.rejects(gen(200, completion("not json")), /not valid JSON/);
  await assert.rejects(gen(200, completion('{"action":', "length")), /ran out of output room/);
  await assert.rejects(gen(401, { error: { message: "no auth" } }), /credentials are invalid/);
  await assert.rejects(gen(402, { error: { message: "pay" } }), /out of credits/);
  await assert.rejects(gen(200, { error: { code: 502, message: "provider down" } }), /502: provider down/);
});

test("provider selection follows the environment", () => {
  assert.equal(resolveProvider({}), "anthropic");
  assert.equal(resolveProvider({ OPENROUTER_API_KEY: "k" }), "openrouter");
  assert.equal(resolveProvider({ OPENROUTER_API_KEY: "k", MANDATE_PROVIDER: "anthropic" }), "anthropic");
  assert.throws(() => resolveProvider({ MANDATE_PROVIDER: "gemini" }), /unknown MANDATE_PROVIDER/);
  assert.throws(() => createOpenRouterLlm({ apiKey: "" }), /OPENROUTER_API_KEY/);
});
