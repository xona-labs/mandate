/**
 * Receipts: one record per tick, covering what the agent saw, what it paid
 * for, what it wanted to do, and what the mandate let it do.
 */

import type { Fill, Portfolio, Proposal, ResearchNote } from "../ports.js";

export type DecisionOutcome = "filled" | "proposed" | "blocked" | "failed";

export interface DecisionRecord {
  proposal: Proposal;
  outcome: DecisionOutcome;
  /** Why it was blocked or failed; absent on a fill. */
  detail?: string;
  fill?: Fill;
}

export interface Receipt {
  id: string;
  mandateId: string;
  at: string;
  dryRun: boolean;
  portfolio: Portfolio;
  research: ResearchNote[];
  researchUsd: number;
  decisions: DecisionRecord[];
  /** Set when the tick stopped before deciding (mandate paused, expired, ...). */
  skipped?: string;
}

export function receiptId(now: Date): string {
  return `rcpt_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** One-screen human summary of a receipt. */
export function formatReceipt(r: Receipt): string {
  const lines = [`${r.id}  ${r.at}${r.dryRun ? "  (dry run)" : ""}`];
  if (r.skipped) lines.push(`  skipped: ${r.skipped}`);
  for (const n of r.research) {
    lines.push(`  research  $${n.costUsd.toFixed(3)}  ${n.topic}${n.stock ? ` ${n.stock}` : ""}  ${n.source}`);
  }
  for (const d of r.decisions) {
    const p = d.proposal;
    const head = `  ${d.outcome.padEnd(8)}  ${p.side} $${p.usd.toFixed(2)} ${p.stock}`;
    lines.push(d.fill ? `${head}  tx ${d.fill.txSig}` : d.detail ? `${head}  (${d.detail})` : head);
    lines.push(`            why: ${p.reason}`);
  }
  if (!r.skipped && r.decisions.length === 0) lines.push("  no action");
  return lines.join("\n");
}
