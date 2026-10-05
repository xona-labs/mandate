/**
 * One tick of the mandate loop:
 *   snapshot -> research -> quote -> decide -> policy gate -> execute -> receipt
 *
 * A tick always writes exactly one receipt, including when it does nothing.
 */

import { checkActive, checkTrade, researchBudgetLeft } from "../policy/index.js";
import { normalizeTicker } from "../mandate/schema.js";
import type { Broker, Decider, Portfolio, Quote, Research, ResearchNote } from "../ports.js";
import { receiptId, type DecisionRecord, type Receipt } from "../receipts/index.js";
import type { Store } from "../store/index.js";
import { RulesDecider } from "./rules.js";

export interface TickOptions {
  store: Store;
  broker: Broker;
  /** Omit to run without paid research regardless of the mandate. */
  research?: Research;
  decider?: Decider;
  /** Evaluate everything but never execute a trade. Research is skipped too. */
  dryRun?: boolean;
  now?: Date;
}

export async function runTick(opts: TickOptions): Promise<Receipt> {
  const { store, broker } = opts;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const decider = opts.decider ?? new RulesDecider();
  const mandate = store.loadMandate();
  const state = store.loadState();

  const receipt: Receipt = {
    id: receiptId(now),
    mandateId: mandate.id,
    at: now.toISOString(),
    dryRun,
    portfolio: { cashUsd: 0, positions: [] },
    research: [],
    researchUsd: 0,
    decisions: [],
  };

  const active = checkActive(mandate, now);
  if (!active.ok) {
    receipt.skipped = active.reason;
    store.appendReceipt(receipt);
    return receipt;
  }

  let portfolio: Portfolio = await broker.portfolio(mandate.universe);
  receipt.portfolio = portfolio;

  // Research. Paid, so never on a dry run. A failing source must not stop trading.
  let notes: ResearchNote[] = [];
  const budgetUsd = researchBudgetLeft(mandate, state, now);
  if (opts.research && !dryRun && budgetUsd > 0) {
    try {
      notes = await opts.research.gather({
        stocks: mandate.universe,
        topics: mandate.research.topics,
        budgetUsd,
        maxPerCallUsd: Math.min(mandate.budget.researchPerCallUsd, budgetUsd),
        maxCalls: mandate.research.maxCallsPerTick,
        minTrust: mandate.research.minTrust,
      });
    } catch {
      notes = [];
    }
    for (const note of notes) {
      state.researchUsd += note.costUsd;
      state.ledger.push({ at: note.at, kind: "research", usd: note.costUsd });
    }
    // Persist before trading: the money is already spent.
    store.saveState(state);
  }
  receipt.research = notes;
  receipt.researchUsd = notes.reduce((sum, n) => sum + n.costUsd, 0);

  // Quote the universe once: the decider reasons over it and the gate reuses it.
  const quotes = new Map<string, Quote>();
  for (const stock of mandate.universe) {
    try {
      quotes.set(normalizeTicker(stock), await broker.quote(stock));
    } catch {
      // Left out; retried below if a proposal actually needs it.
    }
  }

  const decision = await decider.decide({ mandate, state, portfolio, notes, quotes: [...quotes.values()], now });
  const skipped = decision.skipped ?? [];
  receipt.deliberation = { decider: decision.decider ?? "custom", summary: decision.summary, skipped };

  const executing = !dryRun && mandate.autonomy === "auto";
  if (executing && skipped.length > 0) {
    // A skip uses up the period, so the same question is not re-researched every tick.
    for (const { ruleId } of skipped) {
      state.rules[ruleId] = { lastRunAt: now.toISOString(), fills: state.rules[ruleId]?.fills ?? 0 };
    }
    store.saveState(state);
  }

  for (const proposal of decision.proposals) {
    const record: DecisionRecord = { proposal, outcome: "blocked" };
    receipt.decisions.push(record);

    let quote: Quote;
    try {
      quote = quotes.get(normalizeTicker(proposal.stock)) ?? (await broker.quote(proposal.stock));
    } catch (err) {
      record.outcome = "failed";
      record.detail = `quote failed: ${(err as Error).message}`;
      continue;
    }

    const verdict = checkTrade({ mandate, state, portfolio, proposal, quote, now });
    if (!verdict.ok) {
      record.detail = verdict.reason;
      continue;
    }

    if (!executing) {
      record.outcome = "proposed";
      record.detail = dryRun ? "dry run" : "awaiting human execution";
      continue;
    }

    try {
      const fill = await broker.execute(proposal, {
        maxPremiumPct: mandate.constraints.maxPremiumPct,
        minLiquidityUsd: mandate.constraints.minLiquidityUsd,
        slippageBps: mandate.constraints.slippageBps,
      });
      record.outcome = "filled";
      record.fill = fill;
      state.tradedUsd += fill.usd;
      state.ledger.push({ at: now.toISOString(), kind: "trade", usd: fill.usd });
      if (proposal.ruleId) {
        const progress = state.rules[proposal.ruleId] ?? { fills: 0 };
        state.rules[proposal.ruleId] = { lastRunAt: now.toISOString(), fills: progress.fills + 1 };
      }
      // Save after every fill so a crash mid-tick cannot double-spend the budget.
      store.saveState(state);
      portfolio = await broker.portfolio(mandate.universe).catch(() => portfolio);
    } catch (err) {
      record.outcome = "failed";
      record.detail = (err as Error).message;
    }
  }

  store.appendReceipt(receipt);
  return receipt;
}
