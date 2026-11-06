import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SessionRef } from "@pi-gui/session-driver";
import {
  createNamedThread,
  emitTestSessionEvents,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  runOrchestrationRuntimeTool,
  seedAgentDir,
} from "../helpers/electron-app";

// A model server that never answers, so delegated agents stay working while the test looks.
async function hangingServer() {
  const pending = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    pending.add(response);
    response.on("close", () => pending.delete(response));
    request.resume();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("the Agents panel maps a chat's agents live, opens one, and stops one", async () => {
  test.setTimeout(90_000);
  const server = await hangingServer();
  const userDataDir = await makeUserDataDir();
  const agentDir = join(userDataDir, "agent");
  const workspacePath = await makeWorkspace("agent-map");
  await seedAgentDir(agentDir, {
    withOpenAiAuth: false,
    withDefaultModel: false,
    enabledModels: ["slow-test/slow"],
  });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "slow-test",
      defaultModel: "slow",
      enabledModels: ["slow-test/slow"],
    }),
  );
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "slow-test": {
          baseUrl: server.baseUrl,
          api: "openai-completions",
          apiKey: "unused",
          models: [{ id: "slow" }],
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
    for (const [id, prompt] of [
      ["child-docs", "[PI_CHILD_ROLE=implementer]\nWrite the docs page."],
      ["child-tests", "[PI_CHILD_ROLE=reviewer]\nReview the tests."],
    ] as const) {
      await runOrchestrationRuntimeTool(harness, {
        toolName: "create_child_thread",
        toolCallId: id,
        sessionRef: parentRef,
        params: { prompt },
      });
    }
    const children = (await getDesktopState(window)).orchestrationChildren;
    expect(children).toHaveLength(2);
    const docs = children.find((child) => child.sourceToolCallId === "child-docs")!;
    const tests = children.find((child) => child.sourceToolCallId === "child-tests")!;

    // The lead shows its plan as an agent map linked to the two threads.
    const now = new Date().toISOString();
    await emitTestSessionEvents(harness, [
      {
        type: "toolStarted",
        sessionRef: parentRef,
        timestamp: now,
        toolName: "show_ui",
        callId: "plan",
        input: {
          spec: {
            blocks: [
              {
                type: "agent_map",
                title: "Plan",
                agents: [
                  { id: "lead", label: "Lead", status: "running" },
                  {
                    id: "docs",
                    label: "Docs page",
                    status: "pending",
                    parent: "lead",
                    role: "implementer",
                    threadId: docs.childSessionId,
                  },
                  {
                    id: "tests",
                    label: "Test review",
                    status: "pending",
                    parent: "lead",
                    role: "reviewer",
                    threadId: tests.childSessionId,
                  },
                ],
              },
            ],
          },
        },
      },
      {
        type: "toolFinished",
        sessionRef: parentRef,
        timestamp: now,
        callId: "plan",
        success: true,
      },
    ]);
    const map = window.getByTestId("generative-ui-agent-map");
    // Linked entries follow their threads: both agents are working, not "pending".
    await expect(
      map.getByTestId("generative-ui-agent").filter({ hasText: "Docs page" }),
    ).toHaveAttribute("data-status", "running");
    await expect(
      map.getByTestId("generative-ui-agent").filter({ hasText: "Test review" }),
    ).toHaveAttribute("data-status", "running");

    await window.getByRole("button", { name: "Toggle side panel" }).click();
    const panel = window.locator(".agents-panel");
    await expect(panel).toContainText("2 working");
    const cards = panel.getByTestId("agents-panel-card");
    await expect(cards).toHaveCount(3);
    // The children sit under their lead chat, with their role and model.
    await expect(cards.nth(0)).toContainText("Lead chat");
    const docsCard = cards.filter({ hasText: docs.title });
    await expect(docsCard).toContainText("implementer · slow");
    await expect(docsCard).toHaveAttribute("data-status", "running");
    expect(
      await docsCard.evaluate((element) => parseFloat(getComputedStyle(element).marginLeft)),
    ).toBeGreaterThan(0);
    await window.screenshot({ path: test.info().outputPath("agents-panel.png") });

    // Clicking a card opens that agent's chat.
    await docsCard.locator(".agents-panel__row").click();
    await expect
      .poll(async () => (await getDesktopState(window)).selectedSessionId)
      .toBe(docs.childSessionId);

    // Each chat keeps its own side panel, so it opens again here.
    await window.getByRole("button", { name: "Toggle side panel" }).click();
    // Stop ends the agent's run; the panel follows.
    await cards
      .filter({ hasText: tests.title })
      .getByRole("button", { name: `Stop ${tests.title}` })
      .click();
    await expect(cards.filter({ hasText: tests.title })).not.toHaveAttribute(
      "data-status",
      "running",
      { timeout: 15_000 },
    );
    await expect(panel).toContainText("1 working");
    await expect(
      cards.filter({ hasText: tests.title }).getByRole("button", { name: `Stop ${tests.title}` }),
    ).toHaveCount(0);
    // Stop left this chat open.
    expect((await getDesktopState(window)).selectedSessionId).toBe(docs.childSessionId);
  } finally {
    await harness.close();
    await server.close();
  }
});
