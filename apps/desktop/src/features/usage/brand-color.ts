export type Brand = "claude" | "codex" | "antigravity" | "openscale";
export type BrandWeights = Partial<Record<Brand, number>>;

export const BRAND_HEX: Readonly<Record<Brand, string>> = {
  claude: "#D97757",
  codex: "#7C5CFC",
  antigravity: "#4285F4",
  openscale: "#34E3A0",
};
/** OpenScale's own orange-to-cyan glow, for fills where a gradient reads (meters); BRAND_HEX elsewhere. */
export const OPENSCALE_GRADIENT =
  "linear-gradient(45deg, #EA7841, #EAB83F 30%, #A9EA8C 55%, #34E3A0 75%, #31C2EA)";
/** Providers without a brand (compaction & cache, unknown) keep the owner's blue. */
export const NEUTRAL_HEX = "#0253c4";
/** Above 1, the busiest provider pulls the blend harder than its plain share would. */
const LEAN = 1.6;

export function brandOf(providerId: string): Brand | null {
  if (/openscale/i.test(providerId)) return "openscale";
  if (/claude|anthropic/i.test(providerId)) return "claude";
  if (/openai|codex|gpt/i.test(providerId)) return "codex";
  if (/antigravity|agy|gemini|google/i.test(providerId)) return "antigravity";
  return null;
}

/** Series names for charts, so a tooltip reads "Claude" rather than a raw key. */
export const BRAND_LABEL: Readonly<Record<Brand, string>> = {
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
  openscale: "OpenScale",
};
export const OTHER_LABEL = "Other";
export const seriesColor = (label: string): string => {
  const brand = (Object.keys(BRAND_LABEL) as Brand[]).find((entry) => BRAND_LABEL[entry] === label);
  return brand ? BRAND_HEX[brand] : NEUTRAL_HEX;
};

export function addWeight(weights: BrandWeights, providerId: string, amount: number): void {
  const brand = brandOf(providerId);
  if (brand && amount > 0) weights[brand] = (weights[brand] ?? 0) + amount;
}

type Lab = readonly [number, number, number];

const toLinear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
const fromLinear = (channel: number) =>
  channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;

function toLab(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map((at) => toLinear(parseInt(hex.slice(at, at + 2), 16) / 255)) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function toHex([lightness, a, b]: Lab): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, fromLinear(channel))) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The brand colors blended in OKLab by usage, so the busiest provider's color dominates. */
export function mixBrands(weights: BrandWeights): string {
  const entries = (Object.keys(BRAND_HEX) as Brand[])
    .map((brand) => [brand, (weights[brand] ?? 0) ** LEAN] as const)
    .filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return NEUTRAL_HEX;
  const mixed: [number, number, number] = [0, 0, 0];
  for (const [brand, weight] of entries) {
    const lab = toLab(BRAND_HEX[brand]);
    for (let axis = 0; axis < 3; axis += 1) mixed[axis]! += (lab[axis]! * weight) / total;
  }
  return toHex(mixed);
}

/** One provider's color; the n-th account of the same brand is lightened so rings stay apart. */
export function providerColor(providerId: string, sameBrandBefore = 0): string {
  const brand = brandOf(providerId);
  const base = brand ? BRAND_HEX[brand] : NEUTRAL_HEX;
  return sameBrandBefore > 0
    ? `color-mix(in srgb, ${base} ${Math.max(35, 100 - sameBrandBefore * 24)}%, white)`
    : base;
}

/** Colors for a list of providers, lightening repeats of the same brand. */
export function providerColors(providerIds: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return providerIds.map((id) => {
    const key = brandOf(id) ?? id;
    const before = seen.get(key) ?? 0;
    seen.set(key, before + 1);
    return providerColor(id, before);
  });
}
