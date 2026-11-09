import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ClaudeSlot } from "../../contracts/usage";

const SLOTS = [1, 2, 3, 4, 5] as const;

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Who each Claude CLI slot (`<claudeDir>/account-N`) is signed in as. A slot is signed in iff it holds a token. */
export async function readClaudeSlots(claudeDir: string): Promise<readonly ClaudeSlot[]> {
  return Promise.all(
    SLOTS.map(async (slot): Promise<ClaudeSlot> => {
      const dir = join(claudeDir, `account-${slot}`);
      const credentials = await readJson<{
        claudeAiOauth?: { accessToken?: string; subscriptionType?: string };
      }>(join(dir, ".credentials.json"));
      if (!credentials?.claudeAiOauth?.accessToken) return { slot, signedIn: false };
      const profile = await readJson<{
        oauthAccount?: { accountUuid?: string; displayName?: string; emailAddress?: string };
      }>(join(dir, ".claude.json"));
      const account = profile?.oauthAccount;
      return {
        slot,
        signedIn: true,
        name: account?.displayName?.trim() || account?.emailAddress?.trim() || undefined,
        plan: credentials.claudeAiOauth.subscriptionType || undefined,
        accountUuid: account?.accountUuid || undefined,
      };
    }),
  );
}

/** Signing out removes only this slot's token; other slots and the CLI profile are untouched. */
export async function signOutClaudeSlot(claudeDir: string, providerId: string): Promise<void> {
  const slot =
    providerId === "anthropic" ? 1 : Number(/^anthropic-account-([2-5])$/.exec(providerId)?.[1]);
  if (!slot) return;
  await rm(join(claudeDir, `account-${slot}`, ".credentials.json"), { force: true });
}
