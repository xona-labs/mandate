#!/usr/bin/env node
/**
 * mandate CLI. Approval lives here on purpose: an agent can draft a mandate,
 * only a human at a terminal can activate one.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { parseMandate, type Mandate } from "../mandate/schema.js";
import { formatReceipt } from "../receipts/index.js";
import { FileStore, mandateHome } from "../store/index.js";
import { spentLast24h } from "../policy/index.js";
import { runTick } from "../engine/tick.js";

const program = new Command();
program.name("mandate").description("Give an agent a policy and a budget.").version("0.0.1");

const storeFor = (id: string) => new FileStore(join(mandateHome(), id));

function summarize(m: Mandate): string {
  const b = m.budget;
  return [
    `${m.name} (${m.id})  status: ${m.status}  autonomy: ${m.autonomy}  decider: ${m.decider}`,
    m.text ? `  "${m.text}"` : undefined,
    `  universe: ${m.universe.join(", ")}`,
    `  budget:   $${b.totalUsd} total, $${b.perTradeUsd}/trade, $${b.perDayUsd}/day, research $${b.researchPerDayUsd}/day`,
    ...m.rules.map((r) => `  rule:     ${r.id}: buy $${r.amountUsd} of ${r.stock} every ${r.every}`),
    m.constraints.maxAllocationPct !== undefined ? `  limit:    max ${m.constraints.maxAllocationPct}% in one stock` : undefined,
    ...m.guidance.map((g) => `  guidance: ${g}`),
    m.discretionary ? "  discretionary: may propose trades beyond the schedule" : undefined,
    m.research.enabled ? `  research: ${m.research.topics.join(", ")}` : undefined,
    m.expiresAt ? `  expires:  ${m.expiresAt}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

program
  .command("create <file>")
  .description("Validate a mandate JSON file and save it as a draft")
  .action((file: string) => {
    const input = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    // A file can never activate itself.
    const mandate = parseMandate({ createdAt: new Date().toISOString(), ...input, status: "draft", approvedAt: undefined });
    const store = storeFor(mandate.id);
    if (store.exists()) throw new Error(`mandate ${mandate.id} already exists`);
    store.saveMandate(mandate);
    console.log(summarize(mandate));
    console.log(`\nSaved as draft. Activate with: mandate approve ${mandate.id}`);
  });

program
  .command("compile <text>")
  .description("Turn a plain-language instruction into a draft mandate")
  .option("--id <id>", "mandate id (default: derived from the name)")
  .option("--no-save", "print the draft without saving it")
  .action(async (text: string, opts: { id?: string; save: boolean }) => {
    const { compileMandate } = await import("../mandate/compile.js");
    const { createLlm } = await import("../adapters/llm.js");
    const { stockAvailable } = await import("../adapters/xpay.js");
    const result = await compileMandate({ text, id: opts.id, llm: await createLlm(), checkStock: stockAvailable });
    const { mandate } = result;

    console.log(summarize(mandate));
    const section = (title: string, items: string[]) => {
      if (items.length) console.log(`\n${title}\n${items.map((i) => `  - ${i}`).join("\n")}`);
    };
    section("Assumed (check these before approving):", result.assumptions);
    section("Not covered by this mandate:", result.unsupported);
    section("No tradable tokenized stock found for:", result.unavailable);

    if (result.unavailable.length > 0) throw new Error("\nNot saved: remove or replace the unavailable stocks and compile again.");
    if (!opts.save) return;
    const store = storeFor(mandate.id);
    if (store.exists()) throw new Error(`\nNot saved: mandate ${mandate.id} already exists (pass --id to choose another).`);
    store.saveMandate(mandate);
    console.log(`\nSaved as draft. Activate with: mandate approve ${mandate.id}`);
  });

program
  .command("approve <id>")
  .description("Activate a draft or paused mandate")
  .action((id: string) => {
    const store = storeFor(id);
    const mandate = store.loadMandate();
    if (mandate.status === "revoked") throw new Error("a revoked mandate cannot be reactivated");
    store.saveMandate({ ...mandate, status: "active", approvedAt: new Date().toISOString() });
    console.log(summarize(store.loadMandate()));
  });

for (const [name, status, about] of [
  ["pause", "paused", "Pause a mandate (resume with approve)"],
  ["revoke", "revoked", "Permanently revoke a mandate"],
] as const) {
  program
    .command(`${name} <id>`)
    .description(about)
    .action((id: string) => {
      const store = storeFor(id);
      store.saveMandate({ ...store.loadMandate(), status });
      console.log(`${id}: ${status}`);
    });
}

program
  .command("status <id>")
  .description("Show a mandate and what it has spent")
  .action((id: string) => {
    const store = storeFor(id);
    const mandate = store.loadMandate();
    const state = store.loadState();
    const now = new Date();
    console.log(summarize(mandate));
    console.log(`  traded:   $${state.tradedUsd.toFixed(2)} of $${mandate.budget.totalUsd} ($${spentLast24h(state, "trade", now).toFixed(2)} in 24h)`);
    console.log(`  research: $${state.researchUsd.toFixed(3)} ($${spentLast24h(state, "research", now).toFixed(3)} in 24h)`);
  });

program
  .command("run <id>")
  .description("Run one tick: research, decide, trade inside the mandate")
  .option("--dry-run", "evaluate without paying for research or trading")
  .option("--profile <name>", "xpay profile to trade from", "default")
  .option("--decider <kind>", "override the mandate's decider: rules or llm")
  .action(async (id: string, opts: { dryRun?: boolean; profile: string; decider?: string }) => {
    // Loaded lazily so the read-only commands never touch a wallet.
    const { createXPay, loadProfile } = await import("@xona-labs/xpay");
    const { createXpayBroker, createXpayResearch } = await import("../adapters/xpay.js");
    const xpay = createXPay({ profile: await loadProfile({ name: opts.profile }) });
    const store = storeFor(id);
    const kind = opts.decider ?? store.loadMandate().decider;
    if (kind !== "rules" && kind !== "llm") throw new Error(`unknown decider "${kind}" (use rules or llm)`);
    let decider;
    if (kind === "llm") {
      const { LlmDecider } = await import("../engine/llm-decider.js");
      const { createLlm } = await import("../adapters/llm.js");
      decider = new LlmDecider({ llm: await createLlm() });
    }
    const receipt = await runTick({
      store,
      decider,
      broker: createXpayBroker(xpay),
      research: createXpayResearch(xpay),
      dryRun: opts.dryRun,
    });
    console.log(formatReceipt(receipt));
  });

program
  .command("receipts <id>")
  .description("Show the decision log")
  .option("-n, --limit <n>", "how many, newest last", "10")
  .option("--json", "raw JSON lines")
  .action((id: string, opts: { limit: string; json?: boolean }) => {
    const receipts = storeFor(id).loadReceipts().slice(-Number(opts.limit));
    if (opts.json) return receipts.forEach((r) => console.log(JSON.stringify(r)));
    console.log(receipts.length ? receipts.map(formatReceipt).join("\n\n") : "No receipts yet.");
  });

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
