import { homedir } from "node:os";
import { join } from "node:path";

/** pi's agent directory: PI_CODING_AGENT_DIR (`~` expanded), else `~/.pi/agent`. */
export function resolveAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  return override
    ? override.startsWith("~")
      ? join(homedir(), override.slice(1))
      : override
    : join(homedir(), ".pi", "agent");
}
