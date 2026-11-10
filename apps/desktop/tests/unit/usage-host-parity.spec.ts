import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { sharedHost } from "@pi-gui/host-protocol/shared";
import type { HistoricalUsageRead } from "../../electron/usage/historical-usage";
import { openscaleApiCost } from "../../electron/usage/openscale-pricing";
import {
  aggregateUsage,
  hostUsageSource,
  nodeUsageSource,
} from "../../electron/usage/usage-aggregate";
import type { UsageReport } from "../../contracts/usage";
import { useIsolatedHost } from "../helpers/isolated-host";

useIsolatedHost();

// pi-ai's catalog prices are ESM-only, which the unit lane cannot load; OpenScale's table prices both readers alike.
const price = (model: string, tokens: Parameters<typeof openscaleApiCost>[1]) =>
  openscaleApiCost(model, tokens);
const noHistory: HistoricalUsageRead = { status: "missing", history: { status: "missing" } };
async function viaNode(): Promise<UsageReport> {
  return aggregateUsage(await nodeUsageSource(undefined), noHistory, price);
}
async function viaHost(): Promise<UsageReport> {
  const client = await sharedHost(true);
  if (!client) throw new Error("the isolated host did not start");
  return aggregateUsage(await hostUsageSource(client), noHistory, price);
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 9, 10, minute)).toISOString();
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
});

function session(id: string, cwd: string, extra: readonly object[]): string {
  const lines: object[] = [
    { type: "session", version: 3, id, timestamp: at(0), cwd },
    {
      type: "message",
      id: `${id}-u`,
      parentId: null,
      timestamp: at(1),
      message: { role: "user", content: "Fix the parser", timestamp: Date.parse(at(1)) },
    },
    {
      type: "message",
      id: `${id}-a1`,
      parentId: `${id}-u`,
      timestamp: at(3),
      message: {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6.1-sol",
        content: [{ type: "text", text: "Looking." }],
        stopReason: "toolUse",
        timestamp: Date.parse(at(2)),
        usage: usage(1200, 80, 400),
      },
    },
    {
      type: "message",
      id: `${id}-t`,
      parentId: `${id}-a1`,
      timestamp: at(4),
      message: {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: "file",
        timestamp: Date.parse(at(4)),
      },
    },
    {
      type: "message",
      id: `${id}-a2`,
      parentId: `${id}-t`,
      timestamp: at(6),
      message: {
        role: "assistant",
        api: "anthropic-messages",
        provider: "openscale",
        model: "deepseek/deepseek-v4.1-flash",
        content: [{ type: "text", text: "Done." }],
        stopReason: "stop",
        timestamp: Date.parse(at(5)),
        usage: usage(300, 900, 0, 50),
      },
    },
    {
      type: "usage",
      id: `${id}-w`,
      parentId: `${id}-a2`,
      timestamp: at(7),
      usage: usage(10, 0, 0, 500),
    },
    {
      type: "compaction",
      id: `${id}-c`,
      parentId: `${id}-w`,
      timestamp: at(8),
      summary: "s",
      usage: usage(5000, 300),
    },
    {
      type: "session_info",
      id: `${id}-i`,
      parentId: `${id}-c`,
      timestamp: at(9),
      name: `Chat ${id}`,
    },
    ...extra,
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

/** Order-free view: the two readers visit sessions in different orders, so ties and float sums may differ in the last digits. */
function canon(report: UsageReport): unknown {
  const round = (value: unknown): unknown =>
    typeof value === "number"
      ? Number(value.toPrecision(9))
      : Array.isArray(value)
        ? value.map(round)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.keys(value)
                .sort()
                .map((key) => [key, round((value as Record<string, unknown>)[key])]),
            )
          : value;
  const rows = (list: readonly unknown[] | undefined) =>
    (list ?? []).map((row) => JSON.stringify(round(row))).sort();
  return round({
    ...report,
    refreshedAt: 0,
    models: rows(report.models),
    workspaces: rows(report.workspaces),
    threads: rows(report.threads),
    performance: rows(report.performance),
  });
}

test("the host's usage scan adds up to exactly what pi's own reader counts, and reads files over its cap", async () => {
  test.setTimeout(60_000);
  const sessions = join(process.env.PI_CODING_AGENT_DIR ?? "", "sessions");
  await mkdir(join(sessions, "--ws-a--"), { recursive: true });
  await mkdir(join(sessions, "--ws-b--"), { recursive: true });
  await writeFile(join(sessions, "--ws-a--", "one.jsonl"), session("one", "D:\\ws-a", []));
  await writeFile(join(sessions, "--ws-b--", "two.jsonl"), session("two", "D:\\ws-b", []));
  // Not a session: no header line.
  await writeFile(
    join(sessions, "--ws-b--", "stray.jsonl"),
    `${JSON.stringify({ type: "message" })}\n`,
  );

  const node = await viaNode();
  const host = await viaHost();
  expect(node.sessions).toBe(2);
  expect(node.totals.input).toBe(2 * (1200 + 300 + 10 + 5000));
  expect(canon(host)).toEqual(canon(node));

  // A session past the in-process reader's 64 MiB cap: pi's reader skips it, the host counts it.
  const big = "x".repeat(65 * 1024 * 1024);
  await writeFile(
    join(sessions, "--ws-a--", "big.jsonl"),
    session("big", "D:\\ws-a", [
      {
        type: "custom",
        id: "pad",
        parentId: null,
        timestamp: at(10),
        customType: "pad",
        data: big,
      },
    ]),
  );
  const nodeBig = await viaNode();
  const hostBig = await viaHost();
  expect(nodeBig.unreadable).toBe(1);
  expect(hostBig.unreadable).toBe(0);
  expect(hostBig.sessions).toBe(3);
  expect(hostBig.totals.input).toBe(3 * (1200 + 300 + 10 + 5000));
  expect(hostBig.threads.map((thread) => thread.label).sort()).toEqual([
    "Chat big",
    "Chat one",
    "Chat two",
  ]);
});
