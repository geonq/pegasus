import { expect, test } from "@playwright/test";
import type { AccountLimits } from "../../contracts/usage";
import { isRunningLow, orderByTightestLimit } from "../../src/features/usage/limit-order";

function account(id: string, used: readonly number[]): AccountLimits {
  return {
    id,
    name: id,
    asOf: 0,
    windows: used.map((usedPercent, index) => ({ label: `w${index}`, usedPercent })),
  };
}

test("plan limits list the account with the least left first and flag 80 % used", () => {
  const limits = [
    account("roomy", [10, 20]),
    account("tight", [30, 91]),
    account("none", []),
    account("tie-a", [50]),
    account("tie-b", [50]),
  ];
  expect(orderByTightestLimit(limits).map((entry) => entry.id)).toEqual([
    "tight",
    "tie-a",
    "tie-b",
    "roomy",
    "none",
  ]);
  expect(limits.filter(isRunningLow).map((entry) => entry.id)).toEqual(["tight"]);
  expect(isRunningLow(account("edge", [80]))).toBe(true);
  expect(isRunningLow(account("below", [79.9]))).toBe(false);
});
