import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { AccountLimits, AccountStatus, SignInStatus } from "../../contracts/usage";
import { keepKnownStates, startSignInMonitor } from "../../electron/usage/sign-ins";
import { providerStatuses } from "../../src/features/usage/account-state";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const HOUR = 3_600_000;

test("every provider gets its status by the same rules", () => {
  const accounts = new Map<string, AccountStatus>([
    ["claude-code-account-1", { id: "claude-code-account-1", state: "ready" }],
    ["claude-code-account-2", { id: "claude-code-account-2", state: "disabled" }],
  ]);
  const signIns: SignInStatus[] = [
    { id: "claude-code-account-1", name: "Claude · work", state: "ok" },
    { id: "openai", name: "ChatGPT (Pi)", state: "ok" },
    { id: "antigravity", name: "Antigravity", state: "signed-out", fix: "Run `agy`" },
    { id: "codex", name: "Codex CLI", state: "ok" },
  ];
  const limits: AccountLimits[] = [
    // The weekly window is used up; the fresh 5-hour window resets sooner but does not help.
    {
      id: "openai",
      name: "ChatGPT",
      asOf: NOW,
      windows: [
        { label: "5-hour", usedPercent: 100, resetsAt: NOW + HOUR },
        { label: "Weekly", usedPercent: 100, resetsAt: NOW + 48 * HOUR },
      ],
    },
  ];
  const statuses = providerStatuses(accounts, signIns, limits, NOW);
  expect(Object.fromEntries(statuses)).toEqual({
    "claude-code-account-1": { state: "ready" },
    openai: { state: "limited", until: NOW + 48 * HOUR },
    antigravity: { state: "relogin" },
  });
});

test("a sign-in about to end outranks a limit; a lost sign-in outranks everything", () => {
  const signIns: SignInStatus[] = [
    {
      id: "claude-code-account-1",
      name: "Claude · work",
      state: "expiring",
      expiresAt: NOW + 2 * 24 * HOUR,
    },
  ];
  const accounts = new Map<string, AccountStatus>([
    [
      "claude-code-account-1",
      { id: "claude-code-account-1", state: "limited", resetAt: NOW + HOUR },
    ],
    ["claude-code-account-3", { id: "claude-code-account-3", state: "relogin" }],
  ]);
  expect(Object.fromEntries(providerStatuses(accounts, signIns, [], NOW))).toEqual({
    "claude-code-account-1": { state: "expiring", until: NOW + 2 * 24 * HOUR },
    "claude-code-account-3": { state: "relogin" },
  });
});

test("one notification per new problem, also across restarts; none again once it is fixed and stays fixed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-signins-"));
  const paths = { stateDir: dir, memoryFile: join(dir, "notices.json") };
  let world: SignInStatus[] = [
    { id: "antigravity", name: "Antigravity", state: "signed-out", fix: "Run `agy`" },
  ];
  const notified: string[] = [];
  const start = () =>
    startSignInMonitor(
      paths,
      (problem) => notified.push(`${problem.id}:${problem.state}`),
      async () => world,
    );
  try {
    const first = start();
    await first.checkNow();
    await first.checkNow();
    first.stop();
    expect(notified).toEqual(["antigravity:signed-out"]);

    const afterRestart = start();
    await afterRestart.checkNow();
    expect(notified).toEqual(["antigravity:signed-out"]);

    world = [{ id: "antigravity", name: "Antigravity", state: "ok" }];
    await afterRestart.checkNow();
    world = [{ id: "antigravity", name: "Antigravity", state: "signed-out", fix: "Run `agy`" }];
    await afterRestart.checkNow();
    afterRestart.stop();
    expect(notified).toEqual(["antigravity:signed-out", "antigravity:signed-out"]);
    expect(afterRestart.current()).toEqual(world);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a check that could not finish keeps the last answer and is retried, not shown as unverified", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-signins-"));
  const paths = { stateDir: dir, memoryFile: join(dir, "notices.json") };
  const ok: SignInStatus = { id: "claude-code-account-1", name: "Claude · work", state: "ok" };
  const timedOut: SignInStatus = { ...ok, state: "unknown" };
  let world: SignInStatus[] = [ok];
  const monitor = startSignInMonitor(
    paths,
    () => undefined,
    async () => world,
  );
  try {
    await monitor.checkNow();
    world = [timedOut];
    await monitor.checkNow();
    expect(monitor.current()).toEqual([ok]);
  } finally {
    monitor.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a sign-in never answered stays unknown until a check finishes", () => {
  const timedOut: SignInStatus = { id: "claude-code-account-2", name: "Claude", state: "unknown" };
  expect(keepKnownStates([], [timedOut])).toEqual([timedOut]);
  const signedOut: SignInStatus = { ...timedOut, state: "signed-out" };
  expect(keepKnownStates([{ ...timedOut, state: "ok" }], [signedOut])).toEqual([signedOut]);
});
