import { expect, test } from "@playwright/test";
import { isClaudeLimitFailure, limitResumeAt } from "../../electron/usage/limit-resume";

const NOW = Date.parse("2026-10-31T18:00:00Z");
const MIN = 60_000;

test("only a pool refusal for a usage or rate limit continues by itself", () => {
  expect(
    isClaudeLimitFailure(
      "No authenticated Claude account can complete this request within the bounded quota policy: claude-code-account-2 hit a Claude usage or rate limit in the last 5 minutes; try again after it resets",
    ),
  ).toBe(true);
  expect(
    isClaudeLimitFailure(
      "No authenticated Claude account can complete this request within the bounded quota policy: 429 Too Many Requests",
    ),
  ).toBe(true);
  // Waiting does not fix a used-up retry budget, a sign-in, or another provider's error.
  expect(
    isClaudeLimitFailure(
      "No authenticated Claude account can complete this request within the bounded quota policy: this task used up its Claude retry budget",
    ),
  ).toBe(false);
  expect(isClaudeLimitFailure("Provider is not configured")).toBe(false);
  expect(isClaudeLimitFailure("OpenAI: 429 rate limit")).toBe(false);
});

test("continues when the first account is back: the later of its cooldown and its spent window", () => {
  const states = [
    { id: "claude-code-account-1", state: "limited" as const, resetAt: NOW + 5 * MIN },
    { id: "claude-code-account-2", state: "limited" as const, resetAt: NOW + 4 * MIN },
    { id: "claude-code-account-3", state: "disabled" as const },
  ];
  const limits = [
    // Account 1's five-hour window is spent until 19:30; account 2's until 18:40.
    { id: "claude-code-account-1", name: "A", asOf: NOW, windows: [{ label: "5-hour", usedPercent: 100, resetsAt: NOW + 90 * MIN }] },
    { id: "claude-code-account-2", name: "B", asOf: NOW, windows: [{ label: "5-hour", usedPercent: 100, resetsAt: NOW + 40 * MIN }, { label: "Weekly", usedPercent: 60, resetsAt: NOW + 3 * 24 * 60 * MIN }] },
  ];
  expect(limitResumeAt(states, limits, NOW)).toBe(NOW + 41 * MIN);
});

test("never sooner than two minutes, and a half-hour retry when no reset time is known", () => {
  const ready = [{ id: "claude-code-account-1", state: "ready" as const }];
  expect(limitResumeAt(ready, [], NOW)).toBe(NOW + 2 * MIN);
  const unknown = [{ id: "claude-code-account-1", state: "ready" as const }];
  const spentNoReset = [{ id: "claude-code-account-1", name: "A", asOf: NOW, windows: [{ label: "5-hour", usedPercent: 100 }] }];
  expect(limitResumeAt(unknown, spentNoReset, NOW)).toBe(NOW + 30 * MIN);
  expect(limitResumeAt([], [], NOW)).toBe(NOW + 30 * MIN);
});
