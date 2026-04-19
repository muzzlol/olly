/**
 * Model wiring — Claude Sonnet 4.6 via OpenCode Zen.
 *
 * `createZenModel(env)` returns the bare `LanguageModel` the state machine
 * feeds into `streamText` / `generateText`. `withTracing(model, name)` is the
 * extension point for Braintrust wrapping: when `BRAINTRUST_API_KEY` is set
 * we'd wrap here, but Braintrust's Workers support is shaky for the MVP so
 * the current implementation no-ops. The signature is the contract the
 * HYPOTHESIZE state will eventually call through.
 *
 * NOTE: the spec caps HYPOTHESIZE at 8 turns / 60s wall time. Those caps
 * live in the state machine, not here.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Env } from "./worker";

const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const MODEL_ID = "claude-sonnet-4-6";

export function createZenModel(env: Env): LanguageModel {
  const zen = createAnthropic({
    apiKey: env.OPENCODE_ZEN_API_KEY,
    baseURL: ZEN_BASE_URL,
  });

  return zen(MODEL_ID);
}

export function withTracing(
  model: LanguageModel,
  _name: string,
  _env: Env,
): LanguageModel {
  // TODO: wrap with Braintrust once Workers support lands. Keeping a no-op
  // here so callers can treat tracing as always-on.
  return model;
}

export { MODEL_ID };
