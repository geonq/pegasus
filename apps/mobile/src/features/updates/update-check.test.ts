import assert from "node:assert/strict";
import test from "node:test";
import { MIN_CHECK_INTERVAL_MS, shouldCheck } from "./update-check.ts";

test("a foreground check waits a minute after the last one", () => {
  assert.equal(shouldCheck(0, MIN_CHECK_INTERVAL_MS - 1), false);
  assert.equal(shouldCheck(0, MIN_CHECK_INTERVAL_MS), true);
});
