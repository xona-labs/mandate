/**
 * Plain-language compiler: turns "DCA $50 a week into NVDA..." into a draft
 * mandate.
 *
 * The model only fills in a form. Ids, timestamps and status are set here,
 * the result is validated by the same schema as a hand-written mandate, and
 * it is always a draft: compiling never approves anything. Whatever the
 * model had to assume or could not express is returned for the human to read
 * before they approve.
 */

import * as z from "zod/v4";
import type { Llm } from "../ports.js";
import { normalizeTicker, parseMandate, type Mandate, type MandateInput } from "./schema.js";

const DraftSchema = z.object({
  /** Short human name, three to five words. */
  name: z.string(),
  autonomy: z.enum(["propose", "auto"]),
  /** Underlying US tickers, uppercase (NVDA, not NVDAx). */
  universe: z.array(z.string()),
  budget: z.object({
    totalUsd: z.number(),
    perTradeUsd: z.number(),
    perDayUsd: z.number(),
    researchPerDayUsd: z.number(),
    researchPerCallUsd: z.number(),
  }),
  /** Scheduled buys. */
  rules: z.array(z.object({ stock: z.string(), amountUsd: z.number(), every: z.string() })),
  constraints: z.object({
    maxAllocationPct: z.number().nullable(),
    maxPremiumPct: z.number().nullable(),
    minLiquidityUsd: z.number().nullable(),
    marketOpenOnly: z.boolean(),
    slippageBps: z.number().nullable(),
  }),
  researchTopics: z.array(z.string()),
  guidance: z.array(z.string()),
  discretionary: z.boolean(),
  /** ISO 8601 timestamp, or null when the instruction gives no end. */
  expiresAt: z.string().nullable(),
  assumptions: z.array(z.string()),
  unsupported: z.array(z.string()),
});
type Draft = z.infer<typeof DraftSchema>;

const SYSTEM = `You translate a person's plain-language trading instruction into a structured mandate for Mandate, a system where an AI agent trades tokenized US stocks on Solana with the person's USDC.

The person will read your result and approve or reject it before anything trades. Your job is a faithful translation: capture what they said, never widen it, and be explicit about anything you had to fill in.

What the mandate can express:
- universe: the only stocks the agent may touch, as underlying US tickers (NVDA, TSLA, SPY).
- rules: scheduled buys of a fixed USD amount of one stock at an interval. "every" is a number plus h, d, w or m ("12h", "1d", "1w", "1m" where m is 30 days). The shortest allowed interval is 1h.
- budget, all in USD: totalUsd (lifetime cap on trading), perTradeUsd (largest single trade), perDayUsd (cap per rolling 24 hours), researchPerDayUsd (daily cap on paid research, 0 for none), researchPerCallUsd (largest single research purchase).
- constraints: maxAllocationPct (no buy may push one stock above this share of the portfolio), maxPremiumPct (skip when the token trades at an adverse premium or discount beyond this), minLiquidityUsd, marketOpenOnly, slippageBps. Use null for any the person did not ask for.
- researchTopics: what to buy data about before acting, as short phrases ("earnings", "news", "analyst ratings").
- guidance: the person's judgment-based instructions that a schedule cannot capture, each as one clear sentence in their own terms ("Skip a scheduled buy if the company just missed earnings"). An AI applies these with judgment each tick. They can only make the agent more cautious or pick among allowed trades; they never raise a limit.
- discretionary: true only if the instruction asks for trades beyond the scheduled buys, such as selling, trimming or rebalancing based on conditions. Otherwise false.
- autonomy: "auto" only if the person clearly wants trades executed without asking each time ("automatically", "on autopilot", "just do it"). Otherwise "propose", where the agent suggests and the person executes.
- expiresAt: only when the instruction gives an end or a duration. Work it out from the current date you are given.

Filling gaps: hard limits are required, so when the person did not state one, derive the tightest value consistent with what they did say, and list it in assumptions. For example, perTradeUsd defaults to the largest scheduled buy, perDayUsd to the most the schedule could spend in one day, and totalUsd, when no budget or duration is given, to twelve intervals of the schedule. If the person asked for research but gave no research budget, use 0.50 per day and 0.10 per call and say so. If they did not ask for research, set both research budgets to 0 and leave researchTopics empty.

assumptions: one plain sentence for every value you derived or interpreted, so the person can catch a wrong guess. Do not list things they stated outright.

unsupported: one plain sentence for each part of the instruction the mandate cannot express or enforce: options, leverage, shorting, price-target or limit orders, assets that are not US stocks or ETFs, anything about other wallets or chains. Do not approximate these silently with something else. If part of it fits as guidance, put that part in guidance and name the rest here.`;

export interface CompileOptions {
  text: string;
  llm: Llm;
  now?: Date;
  /** Override the id; default is a slug of the generated name. */
  id?: string;
  /** Checks a ticker is actually tradable. Failures land in `unavailable`. */
  checkStock?: (ticker: string) => Promise<boolean>;
}

export interface CompileResult {
  /** Always a draft. */
  mandate: Mandate;
  /** Values the model derived or interpreted. Show these before approval. */
  assumptions: string[];
  /** Parts of the instruction the mandate cannot express. */
  unsupported: string[];
  /** Universe tickers with no tradable tokenized stock. A mandate with any should not be saved. */
  unavailable: string[];
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return s || "mandate";
}

function toInput(draft: Draft, opts: CompileOptions, now: Date): MandateInput {
  const taken = new Set<string>();
  const rules = draft.rules.map((r) => {
    const base = `${normalizeTicker(r.stock).toLowerCase()}-${r.every.toLowerCase()}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return { kind: "dca" as const, id, stock: normalizeTicker(r.stock), amountUsd: r.amountUsd, every: r.every };
  });
  const c = draft.constraints;
  const researchOn = draft.budget.researchPerDayUsd > 0 && draft.researchTopics.length > 0;
  return {
    version: 1,
    id: opts.id ?? slug(draft.name),
    name: draft.name,
    text: opts.text,
    // Compiling never approves: a human activates the draft.
    status: "draft",
    autonomy: draft.autonomy,
    // Judgment needs a model; a plain schedule does not.
    decider: draft.guidance.length > 0 || draft.discretionary || researchOn ? "llm" : "rules",
    guidance: draft.guidance,
    discretionary: draft.discretionary,
    universe: [...new Set(draft.universe.map(normalizeTicker))],
    budget: draft.budget,
    rules,
    constraints: {
      marketOpenOnly: c.marketOpenOnly,
      ...(c.maxAllocationPct !== null && { maxAllocationPct: c.maxAllocationPct }),
      ...(c.maxPremiumPct !== null && { maxPremiumPct: c.maxPremiumPct }),
      ...(c.minLiquidityUsd !== null && { minLiquidityUsd: c.minLiquidityUsd }),
      ...(c.slippageBps !== null && { slippageBps: c.slippageBps }),
    },
    research: { enabled: researchOn, topics: draft.researchTopics },
    createdAt: now.toISOString(),
    ...(draft.expiresAt !== null && { expiresAt: draft.expiresAt }),
  };
}

export async function compileMandate(opts: CompileOptions): Promise<CompileResult> {
  const now = opts.now ?? new Date();
  const text = opts.text.trim();
  if (!text) throw new Error("mandate: nothing to compile");

  const base = `Current date: ${now.toISOString()}\n\nThe person's instruction:\n<instruction>\n${text}\n</instruction>`;
  let prompt = base;
  let lastError = "";

  // One retry: the model sees exactly what the validator rejected.
  for (let attempt = 0; attempt < 2; attempt++) {
    const draft = await opts.llm.generate({ system: SYSTEM, prompt, schema: DraftSchema, effort: "medium" });
    let mandate: Mandate;
    try {
      mandate = parseMandate(toInput(draft, opts, now));
    } catch (err) {
      lastError = (err as Error).message;
      prompt = `${base}\n\nYour previous translation was rejected by the validator:\n${lastError}\n\nFix those fields and answer again.`;
      continue;
    }

    const unavailable: string[] = [];
    if (opts.checkStock) {
      for (const ticker of mandate.universe) {
        if (!(await opts.checkStock(ticker).catch(() => false))) unavailable.push(ticker);
      }
    }
    return { mandate, assumptions: draft.assumptions, unsupported: draft.unsupported, unavailable };
  }
  throw new Error(`mandate: could not compile the instruction into a valid mandate\n${lastError}`);
}
