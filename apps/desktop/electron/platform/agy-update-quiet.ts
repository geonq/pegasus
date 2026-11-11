import { existsSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REFRESH_MS = 5 * 60_000;

/**
 * agy starts a background self-update check whenever its last check is more than 15 minutes old
 * (`~/.gemini/antigravity-cli/last_check.timestamp`, by modification time; a time in the future does
 * not count). On Windows that updater's console opens as a visible terminal window, every hour with
 * this app's usage and model checks, and its AGY_CLI_DISABLE_AUTO_UPDATE variable is ignored. Keeping
 * the stamp fresh makes agy take its "checked less than 15 minutes ago" fast path. pi-ecosystem's
 * update-clis runs `agy update` on purpose instead.
 */
export function keepAgyUpdateCheckQuiet(stamp = defaultStamp()): () => void {
  const touch = () => {
    if (!existsSync(stamp)) return;
    const now = new Date();
    try {
      utimesSync(stamp, now, now);
    } catch {
      // agy may be rewriting it right now; the next tick refreshes it.
    }
  };
  touch();
  const timer = setInterval(touch, REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function defaultStamp(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "last_check.timestamp");
}
