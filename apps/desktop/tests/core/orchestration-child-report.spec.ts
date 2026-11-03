import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

// An OpenAI-compatible server that answers every turn at once and keeps each request body.
async function answeringServer(reply: string) {
  const bodies: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: 0,
          model: "fast",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.write(chunk({ role: "assistant", content: reply }, null));
      response.write(chunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    bodies,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("a finished child reports to its parent thread without the parent polling", async () => {
  test.setTimeout(90_000);
  const server = await answeringServer("Child done: committed the fix.");
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("orchestration-child-report");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["fast-test/fast"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "fast-test",
      defaultModel: "fast",
      enabledModels: ["fast-test/fast"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "fast-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "fast" }],
        },
      },
    }),
  );
  const harness = await launchDesktop(userDataDir, {
    agentDir,
    initialWorkspaces: [workspacePath],
    scrubProviderEnv: true,
    testMode: "background",
  });
  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "Lead chat");
    const state = await getDesktopState(window);
    const parentRef: SessionRef = {
      workspaceId: state.selectedWorkspaceId!,
      sessionId: state.selectedSessionId!,
    };
    await runOrchestrationRuntimeTool(harness, {
      toolName: "create_child_thread",
      toolCallId: "child-report",
      sessionRef: parentRef,
      params: { prompt: "[PI_CHILD_ROLE=implementer]\nFix the bug and commit." },
    });

    // The parent never called read_thread or list_threads: its next model turn carries the report.
    await expect
      .poll(() => server.bodies.filter((body) => body.includes("[Child thread report]")).length, {
        timeout: 60_000,
      })
      .toBe(1);
    const report = server.bodies.find((body) => body.includes("[Child thread report]")) ?? "";
    expect(report).toContain("finished");
    expect(report).toContain("Child done: committed the fix.");

    // Each finished run reports once: a follow-up run of the same child sends a second report.
    const child = (await getDesktopState(window)).orchestrationChildren.find(
      (entry) => entry.sourceToolCallId === "child-report",
    );
    expect(child?.status).toBe("complete");
    await runOrchestrationRuntimeTool(harness, {
      toolName: "send_message_to_thread",
      toolCallId: "child-follow-up",
      sessionRef: parentRef,
      params: { threadId: child!.id, message: "Also update the changelog." },
    });
    await expect
      .poll(() => server.bodies.filter((body) => body.includes("[Child thread report]")).length, {
        timeout: 60_000,
      })
      .toBe(2);
  } finally {
    await harness.close();
    await server.close();
  }
});
