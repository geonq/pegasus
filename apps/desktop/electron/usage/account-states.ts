import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AccountState, AccountStatus } from "../../contracts/usage";
import { resolveAgentDir } from "../platform/agent-dir";

interface AccountRecord {
  readonly approved?: boolean;
  readonly activePid?: number | null;
  readonly resetAt?: number;
  readonly checkedAt?: number;
  readonly loggedIn?: boolean;
  readonly subscription?: boolean;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Same rule as pi-ecosystem's `accountState()` (src/claude-accounts.mjs). */
function stateOf(record: AccountRecord, now: number): AccountState {
  if (record.approved !== true) return "disabled";
  if (record.activePid && pidAlive(record.activePid)) return "busy";
  if ((record.resetAt ?? 0) > now) return "limited";
  if (!record.checkedAt) return "unknown";
  return record.loggedIn && record.subscription ? "ready" : "relogin";
}

/** The ledger lives beside the agent dir (`<state>/claude/accounts.json`); none means no slots yet. */
export async function readAccountStates(
  agentDir = resolveAgentDir(),
  now = Date.now(),
): Promise<readonly AccountStatus[]> {
  let accounts: Record<string, AccountRecord>;
  try {
    const raw = await readFile(join(dirname(agentDir), "claude", "accounts.json"), "utf8");
    accounts = (JSON.parse(raw) as { accounts?: Record<string, AccountRecord> }).accounts ?? {};
  } catch {
    return [];
  }
  return Object.entries(accounts)
    .map(([id, record]) => {
      const state = stateOf(record, now);
      return state === "limited" ? { id, state, resetAt: record.resetAt } : { id, state };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
