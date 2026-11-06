import type { PricedTokens } from "./api-pricing";

// OpenScale PAYG prices retrieved 2026-11-06: https://openscale.so/docs/models
export function openscaleApiCost(modelId: string, tokens: PricedTokens): number | null {
  const rates: readonly [number, number, number] | null =
    /^deepseek\/deepseek-v4\.1-flash(?:-\d+)?$/.test(modelId)
      ? [0.06, 0.24, 0.003]
      : /^z-ai\/glm-5\.3-flash(?:-\d+)?$/.test(modelId)
        ? [0.12, 0.4, 0.024]
        : null;
  return rates
    ? (tokens.input * rates[0] +
        tokens.output * rates[1] +
        tokens.cacheRead * rates[2] +
        tokens.cacheWrite * rates[0]) /
        1_000_000
    : null;
}
