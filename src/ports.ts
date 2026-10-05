/**
 * Ports: everything the engine needs from the outside world.
 *
 * The core never imports a wallet, an RPC client, or an LLM. Xona wallet, the
 * standalone CLI, and tests each plug in their own implementations.
 */

import type * as z4 from "zod/v4";
import type { Mandate } from "./mandate/schema.js";
import type { MandateState } from "./store/index.js";

export type Side = "buy" | "sell";

export interface Quote {
  symbol: string;
  mint: string;
  /** Live on-chain price, USD. */
  priceUsd?: number;
  premiumDiscountPct?: number;
  liquidityUsd?: number;
  marketOpen: boolean;
}

export interface Position {
  symbol: string;
  mint: string;
  qty: number;
  usdValue: number;
}

export interface Portfolio {
  cashUsd: number;
  positions: Position[];
}

/** A trade the decider wants. Not yet checked against the mandate. */
export interface Proposal {
  /** Rule that produced it, when rule-driven. */
  ruleId?: string;
  side: Side;
  stock: string;
  /** Notional in USD. */
  usd: number;
  /** Why. Ends up verbatim on the receipt. */
  reason: string;
  /** Ids of the research notes this decision leaned on. */
  evidence?: string[];
}

export interface Fill {
  txSig: string;
  symbol: string;
  mint: string;
  side: Side;
  usd: number;
  qty?: number;
  warnings?: string[];
}

export interface ExecuteOptions {
  maxPremiumPct?: number;
  minLiquidityUsd?: number;
  slippageBps?: number;
}

/** Holds the wallet. The only port that can move funds for trades. */
export interface Broker {
  portfolio(universe: string[]): Promise<Portfolio>;
  quote(stock: string): Promise<Quote>;
  execute(proposal: Proposal, opts?: ExecuteOptions): Promise<Fill>;
}

/** One piece of paid (or free) evidence, with its cost and settlement proof. */
export interface ResearchNote {
  id: string;
  topic: string;
  stock?: string;
  /** URL of the service that was paid. */
  source: string;
  costUsd: number;
  txSig?: string;
  /** Raw response from the source. */
  data: unknown;
  at: string;
}

export interface ResearchRequest {
  stocks: string[];
  topics: string[];
  /** Remaining research budget for this tick, USD. Implementations must not exceed it. */
  budgetUsd: number;
  maxPerCallUsd: number;
  maxCalls: number;
  minTrust?: number;
}

/** Buys evidence. The only port that can move funds for research. */
export interface Research {
  gather(req: ResearchRequest): Promise<ResearchNote[]>;
}

export interface DecisionContext {
  mandate: Mandate;
  state: MandateState;
  portfolio: Portfolio;
  notes: ResearchNote[];
  /** Live quotes for the universe; a stock is missing when its quote failed. */
  quotes: Quote[];
  now: Date;
}

/** A scheduled rule the decider chose not to act on this period. */
export interface SkippedRule {
  ruleId: string;
  reason: string;
}

export interface DecisionResult {
  proposals: Proposal[];
  skipped?: SkippedRule[];
  /** The decider's overall read of the situation. Goes on the receipt. */
  summary?: string;
  /** Which decider produced this ("rules", "llm"). */
  decider?: string;
}

/** Turns context into proposals. The policy gate treats every decider the same. */
export interface Decider {
  decide(ctx: DecisionContext): Promise<DecisionResult>;
}

export interface LlmRequest<S extends z4.ZodType> {
  system: string;
  prompt: string;
  /** Shape the model must answer in. Keep it plain: no refinements or numeric bounds. */
  schema: S;
  effort?: "low" | "medium" | "high" | "xhigh";
}

/** A model that answers in a given shape. Claude by default; hosts can plug their own. */
export interface Llm {
  generate<S extends z4.ZodType>(req: LlmRequest<S>): Promise<z4.infer<S>>;
}
