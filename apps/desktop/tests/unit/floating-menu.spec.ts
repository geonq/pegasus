import { expect, test } from "@playwright/test";
import { placeMenu } from "../../src/ui/floating-menu";

const viewport = { width: 800, height: 600 };
const size = { width: 200, height: 300 };

test("opens down-right of the pointer when there is room", () => {
  expect(placeMenu({ x: 100, y: 100 }, size, viewport)).toEqual({ left: 100, top: 100 });
});

test("flips up near the bottom edge instead of being cut off", () => {
  expect(placeMenu({ x: 100, y: 590 }, size, viewport)).toEqual({ left: 100, top: 290 });
});

test("flips left near the right edge", () => {
  expect(placeMenu({ x: 790, y: 100 }, size, viewport)).toEqual({ left: 590, top: 100 });
});

test("clamps inside the window when it fits neither way", () => {
  const tall = { width: 200, height: 580 };
  const placed = placeMenu({ x: 100, y: 300 }, tall, viewport);
  expect(placed.top).toBeGreaterThanOrEqual(8);
  expect(placed.top + tall.height).toBeLessThanOrEqual(viewport.height);
});
