import { expect, test } from "@playwright/test";
import { BRAND_HEX, brandOf, mixBrands, providerColor } from "../../src/features/usage/brand-color";

test("OpenScale is its own brand with the green from its usage bar", () => {
  expect(brandOf("openscale")).toBe("openscale");
  expect(providerColor("openscale")).toBe(BRAND_HEX.openscale);
  expect(mixBrands({ openscale: 5 })).toBe(BRAND_HEX.openscale.toLowerCase());
  expect(brandOf("claude-code-account-1")).toBe("claude");
});
