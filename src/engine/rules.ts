/**
 * Deterministic decider: turns the mandate's rules into proposals, no LLM.
 *
 * This is the baseline and the fallback. An LLM-backed decider implements the
 * same {@link Decider} port and can use research notes to skip, shrink, or
 * add trades; the policy gate treats both the same.
 */

import { everyToMs } from "../mandate/schema.js";
import type { Decider, DecisionContext, Proposal } from "../ports.js";

export class RulesDecider implements Decider {
  async decide({ mandate, state, now }: DecisionContext): Promise<Proposal[]> {
    const proposals: Proposal[] = [];
    for (const rule of mandate.rules) {
      const last = state.rules[rule.id]?.lastRunAt;
      const interval = everyToMs(rule.every)!;
      if (last && now.getTime() - Date.parse(last) < interval) continue;
      proposals.push({
        ruleId: rule.id,
        side: "buy",
        stock: rule.stock,
        usd: rule.amountUsd,
        reason: `Scheduled buy: $${rule.amountUsd} of ${rule.stock} every ${rule.every}`,
      });
    }
    return proposals;
  }
}
