import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@playwright/test";
import { stopSharedHost } from "@pi-gui/host-protocol/shared";

/**
 * For unit specs whose code runs in the Rust host (Git review, terminals): gives the spec file its
 * own scratch agent dir, so the host it starts never touches the real profile, and stops that host
 * afterwards. The unit lane disables the host by default (PEGASUS_HOST=0); this opts one file in.
 */
export function useIsolatedHost(): void {
  let saved: Record<string, string | undefined> = {};
  let agentDir: string | undefined;
  test.beforeAll(async () => {
    saved = {
      PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      PEGASUS_HOST: process.env.PEGASUS_HOST,
      PEGASUS_HOST_IDLE_SECS: process.env.PEGASUS_HOST_IDLE_SECS,
    };
    agentDir = await mkdtemp(join(tmpdir(), "pi-gui-unit-host-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PEGASUS_HOST_IDLE_SECS = "5";
    delete process.env.PEGASUS_HOST;
  });
  test.afterAll(async () => {
    await stopSharedHost();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (agentDir) await rm(agentDir, { recursive: true, force: true, maxRetries: 5 });
  });
}
