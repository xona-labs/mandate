/**
 * Claude adapter: the Llm port backed by the Anthropic API.
 *
 * Credentials come from the environment (ANTHROPIC_API_KEY, or an
 * `ant auth login` profile) unless a client is passed in.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Llm } from "../ports.js";

const DEFAULT_MODEL = "claude-opus-5-5";
/** Models that accept server-side refusal fallbacks in "default" mode. */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1|sonnet-5-5)/;

export interface ClaudeLlmOptions {
  client?: Anthropic;
  /** Default claude-opus-5-5, or $MANDATE_MODEL. */
  model?: string;
}

export function createClaudeLlm(opts: ClaudeLlmOptions = {}): Llm {
  const client = opts.client ?? new Anthropic();
  const model = opts.model ?? process.env.MANDATE_MODEL ?? DEFAULT_MODEL;
  const withFallback = FALLBACK_MODELS.test(model);

  return {
    async generate(req) {
      let response;
      try {
        response = await client.beta.messages.parse({
          model,
          max_tokens: 16000,
          // If a safety classifier declines, the API reruns the request on a fallback model.
          ...(withFallback && { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
          system: req.system,
          messages: [{ role: "user", content: req.prompt }],
          output_config: { effort: req.effort ?? "high", format: betaZodOutputFormat(req.schema) },
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          throw new Error("Anthropic credentials are missing or invalid (set ANTHROPIC_API_KEY)");
        }
        if (err instanceof Anthropic.RateLimitError) throw new Error("Anthropic rate limit hit, try again shortly");
        if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status ?? ""}: ${err.message}`.trim());
        // Raised before any request is sent, most often because no credentials were found.
        if (err instanceof Anthropic.AnthropicError) throw new Error(`Anthropic client: ${err.message} (is ANTHROPIC_API_KEY set?)`);
        throw err;
      }

      if (response.stop_reason === "refusal") {
        throw new Error(`the model declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`);
      }
      if (response.stop_reason === "max_tokens") throw new Error("the model ran out of output room before finishing");
      if (response.parsed_output == null) throw new Error("the model's answer did not match the expected shape");
      return response.parsed_output;
    },
  };
}
