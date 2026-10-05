/**
 * Policy: the pure gate between "the agent wants to" and "the agent may".
 *
 * No I/O. Every check takes the mandate, the running state, and a snapshot,
 * and returns a verdict with a reason that goes on the receipt.
 */

import { normalizeTicker, type Mandate } from "../mandate/schema.js";
import type { Portfolio, Proposal, Quote } from "../ports.js";
import type { MandateState } from "../store/index.js";

export type Verdict = { ok: true } | { ok: false; reason: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const deny = (reason: string): Verdict => ({ ok: false, reason });

/** Spend of one kind over the trailing 24h. */
export function spentLast24h(state: MandateState, kind: "trade" | "research", now: Date): number {
  const cutoff = now.getTime() - DAY_MS;
  return state.ledger
    .filter((e) => e.kind === kind && Date.parse(e.at) >= cutoff)
    .reduce((sum, e) => sum + e.usd, 0);
}

/** Can this mandate act at all right now? */
export function checkActive(mandate: Mandate, now: Date): Verdict {
  if (mandate.status !== "active") return deny(`mandate is ${mandate.status}`);
  if (mandate.expiresAt && Date.parse(mandate.expiresAt) <= now.getTime()) return deny("mandate expired");
  return { ok: true };
}

/** Research budget left for this tick, USD. */
export function researchBudgetLeft(mandate: Mandate, state: MandateState, now: Date): number {
  if (!mandate.research.enabled) return 0;
  return Math.max(0, mandate.budget.researchPerDayUsd - spentLast24h(state, "research", now));
}

export interface TradeCheck {
  mandate: Mandate;
  state: MandateState;
  portfolio: Portfolio;
  proposal: Proposal;
  quote: Quote;
  now: Date;
}

/** Check one proposed trade against every limit in the mandate. */
export function checkTrade({ mandate, state, portfolio, proposal, quote, now }: TradeCheck): Verdict {
  const active = checkActive(mandate, now);
  if (!active.ok) return active;

  const { budget, constraints } = mandate;
  const ticker = normalizeTicker(proposal.stock);
  if (!mandate.universe.some((s) => normalizeTicker(s) === ticker)) {
    return deny(`${proposal.stock} is outside the mandate universe`);
  }
  if (!(proposal.usd > 0)) return deny("trade size must be positive");

  if (proposal.usd > budget.perTradeUsd) {
    return deny(`$${proposal.usd} exceeds the per-trade cap of $${budget.perTradeUsd}`);
  }
  const day = spentLast24h(state, "trade", now);
  if (day + proposal.usd > budget.perDayUsd) {
    return deny(`would bring 24h volume to $${(day + proposal.usd).toFixed(2)}, over the $${budget.perDayUsd} daily cap`);
  }
  if (state.tradedUsd + proposal.usd > budget.totalUsd) {
    return deny(`would exceed the mandate's total budget of $${budget.totalUsd}`);
  }

  if (constraints.marketOpenOnly && !quote.marketOpen) return deny("US market is closed");
  if (constraints.minLiquidityUsd !== undefined && (quote.liquidityUsd ?? 0) < constraints.minLiquidityUsd) {
    return deny(`liquidity $${quote.liquidityUsd ?? 0} is under the $${constraints.minLiquidityUsd} floor`);
  }
  if (constraints.maxPremiumPct !== undefined && quote.premiumDiscountPct !== undefined) {
    // A premium hurts buyers, a discount hurts sellers.
    const adverse = proposal.side === "buy" ? quote.premiumDiscountPct : -quote.premiumDiscountPct;
    if (adverse > constraints.maxPremiumPct) {
      return deny(`adverse ${proposal.side === "buy" ? "premium" : "discount"} of ${adverse.toFixed(2)}% is over the ${constraints.maxPremiumPct}% limit`);
    }
  }

  const held = portfolio.positions.find((p) => p.mint === quote.mint)?.usdValue ?? 0;
  if (proposal.side === "buy") {
    if (proposal.usd > portfolio.cashUsd) {
      return deny(`needs $${proposal.usd} but only $${portfolio.cashUsd.toFixed(2)} USDC is available`);
    }
    if (constraints.maxAllocationPct !== undefined) {
      // Buying moves cash into a position, so total portfolio value is unchanged.
      const total = portfolio.cashUsd + portfolio.positions.reduce((sum, p) => sum + p.usdValue, 0);
      const pct = total > 0 ? ((held + proposal.usd) / total) * 100 : 100;
      if (pct > constraints.maxAllocationPct) {
        return deny(`would put ${pct.toFixed(1)}% in ${quote.symbol}, over the ${constraints.maxAllocationPct}% allocation limit`);
      }
    }
  } else if (proposal.usd > held) {
    return deny(`cannot sell $${proposal.usd} of ${quote.symbol}, only $${held.toFixed(2)} held`);
  }

  return { ok: true };
}
