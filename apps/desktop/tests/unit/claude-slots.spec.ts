import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { readClaudeSlots, signOutClaudeSlot } from "../../electron/usage/claude-slots";

test("reads slot identity and sign-out clears only that slot's token", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-slots-"));
  for (const n of [1, 2]) {
    await mkdir(join(dir, `account-${n}`), { recursive: true });
    await writeFile(
      join(dir, `account-${n}`, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "t", subscriptionType: "pro" } }),
    );
    await writeFile(
      join(dir, `account-${n}`, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "u", emailAddress: "a@b.c" } }),
    );
  }
  let slots = await readClaudeSlots(dir);
  expect(slots.filter((s) => s.signedIn).map((s) => [s.slot, s.name, s.plan])).toEqual([
    [1, "a@b.c", "pro"],
    [2, "a@b.c", "pro"],
  ]);
  await signOutClaudeSlot(dir, "anthropic-account-2");
  slots = await readClaudeSlots(dir);
  expect(slots.map((s) => s.signedIn)).toEqual([true, false, false, false, false]);
  await signOutClaudeSlot(dir, "openai");
  expect((await readFile(join(dir, "account-1", ".claude.json"), "utf8")).length).toBeGreaterThan(
    0,
  );
  expect((await readClaudeSlots(dir))[0]!.signedIn).toBe(true);
});
