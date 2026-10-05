/**
 * Deterministic decider: turns the mandate's rules into proposals, no model.
 *
 * It is also the baseline the LLM decider starts from: the model can keep,
 * shrink or skip what this produces, and the policy gate treats both the same.
 */

import { everyToMs, type Rule } from "../mandate/schema.js";
import type { Decider, DecisionContext, DecisionResult, Proposal } from "../ports.js";

/** Rules whose interval has elapsed since their last run. */
export function dueRules({ mandate, state, now }: Pick<DecisionContext, "mandate" | "state" | "now">): Rule[] {
  return mandate.rules.filter((rule) => {
    const last = state.rules[rule.id]?.lastRunAt;
    return !last || now.getTime() - Date.parse(last) >= everyToMs(rule.every)!;
  });
}

export function scheduledProposal(rule: Rule): Proposal {
  return {
    ruleId: rule.id,
    side: "buy",
    stock: rule.stock,
    usd: rule.amountUsd,
    reason: `Scheduled buy: $${rule.amountUsd} of ${rule.stock} every ${rule.every}`,
  };
}

export class RulesDecider implements Decider {
  async decide(ctx: DecisionContext): Promise<DecisionResult> {
    return { decider: "rules", proposals: dueRules(ctx).map(scheduledProposal) };
  }
}
