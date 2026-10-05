/**
 * The mandate: a structured, human-approved policy an agent trades under.
 *
 * Natural language is only ever an input. Whatever compiles it (an LLM, the
 * MCP host, a form) must produce this shape, and this shape is what a human
 * approves and what the policy engine enforces.
 */

import { z } from "zod";

/** Interval spec: "12h", "1d", "1w", "1m" or "daily" / "weekly" / "monthly". */
const EverySchema = z
  .string()
  .refine((s) => everyToMs(s) !== undefined, { message: 'expected an interval like "12h", "1d", "1w", "1m"' });

/** Hard spending limits. Everything is USD (USDC on Solana). */
export const BudgetSchema = z.object({
  /** Lifetime cap on trade notional under this mandate. */
  totalUsd: z.number().positive(),
  /** Max notional of a single trade. */
  perTradeUsd: z.number().positive(),
  /** Max trade notional across a rolling 24h window. */
  perDayUsd: z.number().positive(),
  /** Max spent on paid research across a rolling 24h window. 0 disables paid research. */
  researchPerDayUsd: z.number().min(0).default(0),
  /** Max price of a single paid research call. */
  researchPerCallUsd: z.number().min(0).default(0.1),
});

/** Buy a fixed USD amount of one stock on a schedule. */
export const DcaRuleSchema = z.object({
  kind: z.literal("dca"),
  id: z.string().min(1),
  /** Ticker (AAPL) or tokenized symbol (AAPLx). Must be in the universe. */
  stock: z.string().min(1),
  amountUsd: z.number().positive(),
  every: EverySchema,
});

export const RuleSchema = z.discriminatedUnion("kind", [DcaRuleSchema]);

export const ConstraintsSchema = z.object({
  /** No buy may push one stock above this share of the mandate's portfolio. */
  maxAllocationPct: z.number().positive().max(100).optional(),
  /** Block trades when the token trades at an adverse premium/discount beyond this. */
  maxPremiumPct: z.number().positive().optional(),
  minLiquidityUsd: z.number().positive().optional(),
  /** Only trade while the US equity market is open. */
  marketOpenOnly: z.boolean().default(false),
  slippageBps: z.number().int().positive().optional(),
});

export const ResearchPolicySchema = z.object({
  enabled: z.boolean().default(false),
  /** What the agent should look into before acting ("earnings", "news", "sentiment"). */
  topics: z.array(z.string()).default([]),
  /** Minimum ERC-8004 merchant score (0-100) for a source to be paid. */
  minTrust: z.number().min(0).max(100).optional(),
  /** Max paid calls per tick. */
  maxCallsPerTick: z.number().int().positive().default(3),
});

export const MandateStatusSchema = z.enum(["draft", "active", "paused", "revoked"]);

export const MandateSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    name: z.string().min(1),
    /** The original plain-language instruction, kept verbatim for the receipt trail. */
    text: z.string().optional(),
    status: MandateStatusSchema.default("draft"),
    /**
     * "propose": the agent only writes proposals, a human executes.
     * "auto": the agent executes inside the limits without asking.
     */
    autonomy: z.enum(["propose", "auto"]).default("propose"),
    /**
     * "rules": scheduled rules only, no model involved.
     * "llm": a model reviews each tick and may keep, shrink or skip scheduled buys.
     */
    decider: z.enum(["rules", "llm"]).default("rules"),
    /**
     * Soft instructions the LLM decider applies with judgment ("skip a buy after
     * an earnings miss"). Never enforced by the policy gate, never able to widen it.
     */
    guidance: z.array(z.string()).default([]),
    /** Lets the LLM decider propose trades beyond the scheduled rules (still inside every limit). */
    discretionary: z.boolean().default(false),
    /** The only stocks this mandate may touch. */
    universe: z.array(z.string().min(1)).min(1),
    budget: BudgetSchema,
    rules: z.array(RuleSchema).default([]),
    constraints: ConstraintsSchema.default({}),
    research: ResearchPolicySchema.default({}),
    createdAt: z.string(),
    approvedAt: z.string().optional(),
    expiresAt: z.string().optional(),
  })
  .superRefine((m, ctx) => {
    const universe = new Set(m.universe.map(normalizeTicker));
    const ids = new Set<string>();
    m.rules.forEach((rule, i) => {
      if (!universe.has(normalizeTicker(rule.stock))) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "stock"], message: `${rule.stock} is not in the universe` });
      }
      if (ids.has(rule.id)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: `duplicate rule id ${rule.id}` });
      }
      ids.add(rule.id);
      if (rule.amountUsd > m.budget.perTradeUsd) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "amountUsd"], message: "exceeds budget.perTradeUsd" });
      }
    });
    if (m.budget.perTradeUsd > m.budget.perDayUsd) {
      ctx.addIssue({ code: "custom", path: ["budget", "perTradeUsd"], message: "exceeds budget.perDayUsd" });
    }
  });

export type Mandate = z.infer<typeof MandateSchema>;
export type MandateInput = z.input<typeof MandateSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type DcaRule = z.infer<typeof DcaRuleSchema>;
export type Constraints = z.infer<typeof ConstraintsSchema>;
export type MandateStatus = z.infer<typeof MandateStatusSchema>;

/** Validate untrusted input into a mandate. Throws a readable error. */
export function parseMandate(input: unknown): Mandate {
  const result = MandateSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`mandate: invalid mandate\n${issues}`);
  }
  return result.data;
}

/** "AAPLx" and "aapl" refer to the same underlying for universe checks. */
export function normalizeTicker(stock: string): string {
  const s = stock.trim().toUpperCase();
  return s.length > 1 && s.endsWith("X") ? s.slice(0, -1) : s;
}

const UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  m: 30 * 24 * 60 * 60 * 1000,
};
const ALIASES: Record<string, string> = { hourly: "1h", daily: "1d", weekly: "1w", monthly: "1m" };

/** Interval spec to milliseconds, or undefined when it does not parse. */
export function everyToMs(spec: string): number | undefined {
  const s = ALIASES[spec.trim().toLowerCase()] ?? spec.trim().toLowerCase();
  const match = /^(\d+)([hdwm])$/.exec(s);
  if (!match) return undefined;
  const n = Number(match[1]);
  return n > 0 ? n * UNIT_MS[match[2]!]! : undefined;
}
