import test from "node:test";
import assert from "node:assert/strict";
import { SessionSupervisor } from "../dist/session-supervisor.js";

/**
 * A subagent chat gets its model from the runtime extension (the parent assigned it), not from the
 * composer. Pi records that as a model_change entry; the picker reads record.config, so the
 * supervisor must re-derive it then, or the chat shows the workspace default model.
 */
function harness(model: { provider: string; modelId: string } | null) {
  const emitted: Array<{ type: string }> = [];
  let current = model;
  const record = {
    ref: { workspaceId: "ws-1", sessionId: "child-1" },
    workspace: { workspaceId: "ws-1", path: "/tmp/ws-1", displayName: "ws-1" },
    title: "child",
    runtime: undefined,
    session: {
      sessionManager: {
        buildSessionContext: () => ({ thinkingLevel: "high", model: current }),
      },
    },
    sessionFile: undefined,
    status: "idle",
    updatedAt: new Date().toISOString(),
    archivedAt: undefined,
    preview: undefined,
    config: undefined as unknown,
    runningRunId: undefined,
    queuedMessages: [],
    closed: false,
    listeners: new Set([(event: { type: string }) => void emitted.push(event)]),
    eventQueue: Promise.resolve(),
    unsubscribeAgent: undefined,
    pendingHostUiRequests: new Map(),
    extensionUiState: { dialogs: [], notices: [] },
    bindingExtensions: false,
    sessionCommands: [],
    leasePath: undefined,
    transcriptDiskMtimeMs: undefined,
  };
  const supervisor = new SessionSupervisor({
    catalogStorage: {
      sessions: { upsertSession: async () => undefined },
      setSessionFile: async () => undefined,
    } as never,
  }) as unknown as { handleAgentEvent: (record: unknown, event: unknown) => void };
  return {
    record,
    emitted,
    setModel: (next: typeof current) => (current = next),
    send: async (entry: unknown) => {
      supervisor.handleAgentEvent(record, { type: "entry_appended", entry });
      await record.eventQueue;
    },
  };
}

await test("a model the extension selects for a subagent chat reaches the picker", async () => {
  const h = harness(null);
  h.setModel({ provider: "claude-code-account-1", modelId: "claude-sonnet-5-5" });
  await h.send({
    type: "model_change",
    id: "m1",
    parentId: null,
    timestamp: new Date().toISOString(),
    provider: "claude-code-account-1",
    modelId: "claude-sonnet-5-5",
  });
  assert.deepEqual(h.record.config, {
    provider: "claude-code-account-1",
    modelId: "claude-sonnet-5-5",
    thinkingLevel: "high",
  });
  assert.ok(h.emitted.some((event) => event.type === "sessionUpdated"));
});

await test("a later thinking-level change keeps the chat's model", async () => {
  const h = harness({ provider: "openai-account-2", modelId: "gpt-6.1-terra" });
  await h.send({
    type: "thinking_level_change",
    id: "t1",
    parentId: null,
    timestamp: new Date().toISOString(),
    thinkingLevel: "high",
  });
  assert.equal((h.record.config as { modelId?: string }).modelId, "gpt-6.1-terra");
});
