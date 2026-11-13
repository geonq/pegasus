import { expect, test } from "@playwright/test";
import { providersPlaceholderVisible } from "../../src/features/settings/providers-load-state";

test("providers page renders from cache while a slow status refresh is loading", () => {
  expect(providersPlaceholderVisible("loading", true)).toBe(false);
});

test("providers page still blocks when nothing is cached or the load failed", () => {
  expect(providersPlaceholderVisible("loading", false)).toBe(true);
  expect(providersPlaceholderVisible("error", true)).toBe(true);
  expect(providersPlaceholderVisible("unavailable", false)).toBe(true);
  expect(providersPlaceholderVisible("ready", true)).toBe(false);
});
