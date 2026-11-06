import { openscaleApiCost } from "./openscale-pricing";
import { calculateCost, type AnyModel } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";

/** Public API list prices shipped with pi-ai, keyed by model id ("gpt-6-luna", "claude-opus-5-5"). */
const catalogs = [OPENAI_MODELS, ANTHROPIC_MODELS, GOOGLE_MODELS] as readonly Readonly<
  Record<string, AnyModel | undefined>
>[];

export interface PricedTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/**
 * What one request would cost at the provider's public API prices, including the higher tier for
 * long inputs, or null when pi-ai has no price for the model. Subscription use is never billed this
 * way; the figure answers "what would these tokens have cost on the API".
 */
export function apiCostUsd(
  modelId: string,
  tokens: PricedTokens,
  provider?: string,
): number | null {
  if (provider === "openscale") return openscaleApiCost(modelId, tokens);
  const id = modelId.slice(modelId.lastIndexOf("/") + 1);
  for (const catalog of catalogs) {
    const model = catalog[id];
    if (!model?.cost) continue;
    return calculateCost(model, {
      ...tokens,
      totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }).total;
  }
  return null;
}
