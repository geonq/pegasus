import type { DesktopAppState } from "../../api/types";

/**
 * What Settings reads from the PC beyond the shared mobile types. Shapes mirror the desktop's
 * contracts (packages/session-driver/src/runtime-types.ts RuntimeSnapshot, apps/desktop/contracts/
 * usage.ts UsageReport and ClaudeSlot), cut to the fields the phone shows. All optional reads, so
 * a PC that sends less still renders.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RuntimeModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly label: string;
  readonly available: boolean;
  readonly thinkingLevels: readonly string[];
}

export interface RuntimeSnapshot {
  readonly models: readonly RuntimeModel[];
  readonly settings: {
    readonly defaultProvider?: string;
    readonly defaultModelId?: string;
    readonly defaultThinkingLevel?: ThinkingLevel;
  };
}

/** The PC sends runtimeByWorkspace for the workspaces this phone may see (remote-desktop-policy). */
export type StateWithRuntime = DesktopAppState & {
  readonly runtimeByWorkspace?: Readonly<Record<string, RuntimeSnapshot>>;
};

export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cost: number | null;
  readonly apiCost?: number;
}

export interface UsageReport {
  readonly refreshedAt: number;
  readonly totals: UsageTokens;
  readonly sessions: number;
  readonly models: readonly { readonly key: string; readonly label: string; readonly tokens: UsageTokens }[];
}

export interface ClaudeSlot {
  readonly slot: number;
  readonly signedIn: boolean;
  readonly name?: string;
  readonly plan?: string;
}

/** pi's total: input + output + cache read + cache write (contracts/usage.ts totalTokens). */
export function totalTokens(tokens: UsageTokens): number {
  return tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
}

/** "1.2 M", "34 k", "980": token counts at a glance. */
export function compactCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)} B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)} k`;
  return String(Math.round(value));
}

/** The workspace whose model settings Settings shows: the PC's selected one, else the first. */
export function settingsWorkspaceId(state: DesktopAppState | null): string | null {
  if (!state) return null;
  const selected = state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId);
  return (selected ?? state.workspaces[0])?.id ?? null;
}

/** The current default model record, and the effort levels it accepts ("off" alone = none). */
export function defaultModel(runtime: RuntimeSnapshot | undefined): RuntimeModel | undefined {
  const { defaultProvider, defaultModelId } = runtime?.settings ?? {};
  return runtime?.models.find(
    (model) => model.providerId === defaultProvider && model.modelId === defaultModelId,
  );
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function thinkingLevelsFor(model: RuntimeModel | undefined): readonly ThinkingLevel[] {
  if (!model) return [];
  const levels = THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level));
  return levels.length > 1 ? levels : [];
}

/** "Extra high" for xhigh; every other level is its own word, capitalised. */
export function thinkingLabel(level: ThinkingLevel): string {
  return level === "xhigh" ? "Extra high" : level.charAt(0).toUpperCase() + level.slice(1);
}
