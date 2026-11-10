import { join } from "node:path";
import {
  SessionManager,
  SettingsManager,
  createExtensionRuntime,
  createAgentSession,
  ModelRuntime,
  type CreateAgentSessionOptions,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { SessionModelSelection, WorkspaceRef } from "@pi-gui/session-driver";
import { messageText } from "./session-supervisor-utils.js";

export interface GenerateOneShotTextOptions {
  readonly system: string;
  readonly prompt: string;
  readonly model?: SessionModelSelection;
  readonly signal?: AbortSignal;
}

/**
 * One tool-less model call outside any chat, like the thread title generator but with its own
 * instructions and no length cap. Null when the model, its sign-in or its answer is unavailable.
 */
export async function generateOneShotText(
  workspace: WorkspaceRef,
  options: GenerateOneShotTextOptions,
  deps: { readonly agentDir: string },
): Promise<string | null> {
  if (!options.prompt.trim() || options.signal?.aborted) return null;
  const modelRuntime = await ModelRuntime.create({
    authPath: join(deps.agentDir, "auth.json"),
    modelsPath: join(deps.agentDir, "models.json"),
    refreshOnCreate: false,
  });
  await modelRuntime.refresh({ allowNetwork: false });
  const createOptions: CreateAgentSessionOptions = {
    cwd: workspace.path,
    agentDir: deps.agentDir,
    modelRuntime,
    resourceLoader: oneShotResourceLoader(options.system),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
    sessionManager: SessionManager.inMemory(),
    tools: [],
  };
  if (options.model) {
    const selected = modelRuntime.getModel(options.model.provider, options.model.modelId);
    if (!selected) return null;
    createOptions.model = selected;
  }
  const { session } = await createAgentSession(createOptions);
  const abort = () => {
    void session.abort().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted || !session.model) return null;
    const auth = await session.modelRuntime.getAuth(session.model.provider);
    if (!auth?.auth.apiKey) return null;
    await session.prompt(options.prompt, { source: "interactive" });
    const messages: readonly unknown[] = session.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (isRecord(message) && message.role === "assistant")
        return messageText(message).trim() || null;
    }
    return null;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    session.dispose();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function oneShotResourceLoader(system: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => system,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
