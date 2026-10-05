/**
 * OpenRouter adapter: the Llm port backed by any model on openrouter.ai.
 *
 * Uses the chat completions endpoint with a strict JSON schema, then validates
 * the answer again locally, since not every provider enforces the schema.
 */

import * as z from "zod/v4";
import type { Llm } from "../ports.js";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "anthropic/claude-opus-5.5";

export interface OpenRouterLlmOptions {
  /** Default $OPENROUTER_API_KEY. */
  apiKey?: string;
  /** Any OpenRouter model slug. Default anthropic/claude-opus-5.5, or $MANDATE_MODEL. */
  model?: string;
  /** Per-request timeout. Default 120s. */
  timeoutMs?: number;
  /** Override for tests. */
  fetch?: typeof fetch;
}

interface ChatCompletion {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  error?: { message?: string; code?: number | string };
}

export function createOpenRouterLlm(opts: OpenRouterLlmOptions = {}): Llm {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OpenRouter credentials are missing (set OPENROUTER_API_KEY)");
  const model = opts.model ?? process.env.MANDATE_MODEL ?? DEFAULT_MODEL;
  const doFetch = opts.fetch ?? fetch;

  return {
    async generate(req) {
      const body = {
        model,
        max_tokens: 16000,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "answer", strict: true, schema: z.toJSONSchema(req.schema) },
        },
        // Only route to providers that honor the schema.
        provider: { require_parameters: true },
        // Sent for Claude only: with require_parameters, a model without a
        // reasoning control would otherwise find no provider.
        ...(model.startsWith("anthropic/") && { reasoning: { effort: req.effort === "xhigh" ? "high" : (req.effort ?? "high") } }),
      };

      let res: Response;
      try {
        res = await doFetch(ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "X-Title": "Mandate",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
        });
      } catch (err) {
        throw new Error(`OpenRouter request failed: ${(err as Error).message}`);
      }

      const text = await res.text();
      let json: ChatCompletion;
      try {
        json = JSON.parse(text) as ChatCompletion;
      } catch {
        throw new Error(`OpenRouter returned a non-JSON response (HTTP ${res.status})`);
      }
      // OpenRouter can report a provider error inside a 200.
      if (!res.ok || json.error) {
        if (res.status === 401) throw new Error("OpenRouter credentials are invalid (check OPENROUTER_API_KEY)");
        if (res.status === 402) throw new Error("OpenRouter account is out of credits");
        if (res.status === 429) throw new Error("OpenRouter rate limit hit, try again shortly");
        throw new Error(`OpenRouter error ${json.error?.code ?? res.status}: ${json.error?.message ?? "unknown error"}`);
      }

      const choice = json.choices?.[0];
      if (choice?.message?.refusal) throw new Error("the model declined this request");
      if (choice?.finish_reason === "length") throw new Error("the model ran out of output room before finishing");
      const content = choice?.message?.content;
      if (!content) throw new Error("the model returned an empty answer");

      let value: unknown;
      try {
        value = JSON.parse(content);
      } catch {
        throw new Error("the model's answer was not valid JSON");
      }
      const parsed = req.schema.safeParse(value);
      if (!parsed.success) throw new Error("the model's answer did not match the expected shape");
      return parsed.data;
    },
  };
}
