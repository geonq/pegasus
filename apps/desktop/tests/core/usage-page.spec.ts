import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop, makeUserDataDir, seedAgentDir } from "../helpers/electron-app";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString();

function reply(id: string, minute: number, input: number, output: number): object {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: at(minute + 1),
    message: {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-6.1-sol",
      content: [{ type: "text", text: "Done." }],
      stopReason: "stop",
      timestamp: Date.parse(at(minute)),
      usage: {
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: input + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

function sessionFile(id: string, lines: readonly object[]): string {
  const header = { type: "session", version: 3, id, timestamp: at(0), cwd: "D:\\usage-ws" };
  const user = {
    type: "message",
    id: `${id}-u`,
    parentId: null,
    timestamp: at(0),
    message: { role: "user", content: `Task ${id}`, timestamp: Date.parse(at(0)) },
  };
  return `${[header, user, ...lines].map((line) => JSON.stringify(line)).join("\n")}\n`;
}

// The Usage page totals every saved session through the Rust host, including sessions larger
// than the old in-process reader's 64 MiB limit (that reader skipped them as unreadable).
test("the Usage page counts every session, also ones past the old 64 MiB reader limit", async () => {
  test.setTimeout(120_000);
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  await seedAgentDir(agentDir);
  const folder = join(agentDir, "sessions", "--D--usage-ws--");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "small.jsonl"),
    sessionFile("small", [reply("a1", 2, 400_000, 100_000), reply("a2", 4, 300_000, 200_000)]),
  );
  const padding = {
    type: "custom",
    id: "pad",
    parentId: null,
    timestamp: at(9),
    customType: "pad",
    data: "x".repeat(65 * 1024 * 1024),
  };
  await writeFile(
    join(folder, "big.jsonl"),
    sessionFile("big", [padding, reply("b1", 10, 800_000, 200_000)]),
  );

  const harness = await launchDesktop(userDataDir, { agentDir, testMode: "background" });
  try {
    const window = await harness.firstWindow();
    await window.getByRole("button", { name: "Usage", exact: true }).click();
    const view = window.getByTestId("usage-view");
    await expect(view).toBeVisible();
    const totals = view.getByRole("region", { name: "Totals" });
    // 1.0M + 1.0M tokens across three replies.
    // Each stat renders value then label: 2M tokens, 3 requests (the old reader saw 1M and 2).
    await expect(totals).toHaveText(/^2MTokens, all time.*3Requests, all time$/, {
      timeout: 60_000,
    });
    await expect(view).not.toContainText("could not be read");
  } finally {
    await harness.close();
  }
});
