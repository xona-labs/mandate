/**
 * @xona-labs/mandate - give an agent a policy and a budget.
 *
 * ```ts
 * import { FileStore, runTick } from "@xona-labs/mandate";
 * import { createXpayBroker, createXpayResearch } from "@xona-labs/mandate/xpay";
 *
 * const receipt = await runTick({
 *   store: new FileStore(dir),
 *   broker: createXpayBroker(xpay),
 *   research: createXpayResearch(xpay),
 * });
 * ```
 *
 * The root entry is wallet-free: schema, policy, engine, receipts, store.
 * The xpay-backed ports live under "@xona-labs/mandate/xpay" and the model
 * providers under "@xona-labs/mandate/openrouter" and "@xona-labs/mandate/claude".
 */

export * from "./mandate/schema.js";
export * from "./ports.js";
export * from "./policy/index.js";
export * from "./receipts/index.js";
export * from "./store/index.js";
export { runTick, type TickOptions } from "./engine/tick.js";
export { RulesDecider, dueRules } from "./engine/rules.js";
export { LlmDecider, type LlmDeciderOptions } from "./engine/llm-decider.js";
export { compileMandate, type CompileOptions, type CompileResult } from "./mandate/compile.js";
