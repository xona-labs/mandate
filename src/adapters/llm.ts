/**
 * Picks the model provider from the environment.
 *
 * MANDATE_PROVIDER ("openrouter" or "anthropic") wins. Otherwise OpenRouter is
 * used when OPENROUTER_API_KEY is set, and the Anthropic API when not.
 * MANDATE_MODEL overrides the model, in the chosen provider's own naming.
 */

import type { Llm } from "../ports.js";

export type LlmProvider = "openrouter" | "anthropic";

export function resolveProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const explicit = env.MANDATE_PROVIDER?.trim().toLowerCase();
  if (explicit === "openrouter" || explicit === "anthropic") return explicit;
  if (explicit) throw new Error(`unknown MANDATE_PROVIDER "${explicit}" (use openrouter or anthropic)`);
  return env.OPENROUTER_API_KEY ? "openrouter" : "anthropic";
}

export async function createLlm(provider: LlmProvider = resolveProvider()): Promise<Llm> {
  // Imported lazily so one provider's SDK is never loaded for the other.
  if (provider === "openrouter") return (await import("./openrouter.js")).createOpenRouterLlm();
  return (await import("./claude.js")).createClaudeLlm();
}
