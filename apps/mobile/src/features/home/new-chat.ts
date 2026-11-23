/**
 * What the new-chat screen reads from the PC's state: a project's models from `runtimeByWorkspace`
 * (packages/session-driver/src/runtime-types.ts RuntimeSnapshot), read defensively so a PC that
 * has not loaded the runtime yet still lets you start a chat with its default model.
 */

/** The levels the remote policy accepts, in order (remote-desktop-policy.ts THINKING_LEVELS). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface NewChatModel {
  readonly provider: string;
  readonly modelId: string;
  readonly label: string;
  readonly thinkingLevels: readonly string[];
}

export interface NewChatRuntime {
  readonly loaded: boolean;
  readonly models: readonly NewChatModel[];
  readonly defaultModel?: NewChatModel;
  readonly defaultThinkingLevel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function newChatRuntime(state: unknown, workspaceId: string): NewChatRuntime {
  const runtimes = isRecord(state) ? state.runtimeByWorkspace : undefined;
  const runtime = isRecord(runtimes) ? runtimes[workspaceId] : undefined;
  if (!isRecord(runtime)) return { loaded: false, models: [] };
  const models: NewChatModel[] = [];
  for (const raw of Array.isArray(runtime.models) ? runtime.models : []) {
    if (!isRecord(raw) || raw.available !== true) continue;
    const provider = str(raw.providerId);
    const modelId = str(raw.modelId);
    if (!provider || !modelId) continue;
    models.push({
      provider,
      modelId,
      label: str(raw.label) ?? modelId,
      thinkingLevels: Array.isArray(raw.thinkingLevels)
        ? raw.thinkingLevels.filter((level): level is string => typeof level === "string")
        : [],
    });
  }
  const settings = isRecord(runtime.settings) ? runtime.settings : {};
  const defaultModel = models.find(
    (model) =>
      model.provider === settings.defaultProvider && model.modelId === settings.defaultModelId,
  );
  const defaultThinkingLevel = str(settings.defaultThinkingLevel);
  return {
    loaded: true,
    models,
    ...(defaultModel ? { defaultModel } : {}),
    ...(defaultThinkingLevel ? { defaultThinkingLevel } : {}),
  };
}

/** The levels a model accepts, in the policy's order; all of them when the model does not say. */
export function thinkingOptions(model: NewChatModel | undefined): readonly string[] {
  if (!model || model.thinkingLevels.length === 0) return THINKING_LEVELS;
  return THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level));
}
