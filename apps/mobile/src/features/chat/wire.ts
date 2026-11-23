/**
 * The parts of the PC's state the chat screen reads beyond src/api/types.ts. The PC already sends
 * them (apps/desktop/contracts/desktop-state.ts, generative-ui.ts, session-permission.ts); they are
 * read defensively here so an older PC without a field still opens the chat.
 */
import type { DesktopAppState, SessionRecord, TranscriptMessage, TranscriptTool } from "../../api/types";

export interface SessionConfig {
  readonly provider?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

export interface RuntimeModel {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly label: string;
  readonly available: boolean;
  readonly thinkingLevels: readonly string[];
  readonly supportsImages: boolean;
}

export type SessionPermission = "plan" | "ask" | "edits" | "full";

export const PERMISSION_OPTIONS: readonly {
  readonly value: SessionPermission;
  readonly label: string;
  readonly description: string;
}[] = [
  { value: "plan", label: "Plan", description: "Reads and plans, changes nothing" },
  { value: "ask", label: "Ask first", description: "Asks before each change or command" },
  { value: "edits", label: "Accept edits", description: "Changes files freely, asks before commands" },
  { value: "full", label: "Full access", description: "Changes files and runs commands without asking" },
];

/** The remote policy's accepted levels, in order (remote-desktop-policy.ts THINKING_LEVELS). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const THINKING_LABELS: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function thinkingLabel(level: string): string {
  return THINKING_LABELS[level] ?? level;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function sessionConfigOf(session: SessionRecord | undefined): SessionConfig {
  const config: unknown = (session as { readonly config?: unknown } | undefined)?.config;
  if (!isRecord(config)) return {};
  const provider = str(config.provider);
  const modelId = str(config.modelId);
  const thinkingLevel = str(config.thinkingLevel);
  return {
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

/** The models a workspace's runtime offers, available ones only; [] until the runtime is loaded. */
export function modelsOf(state: unknown, workspaceId: string): RuntimeModel[] {
  if (!isRecord(state)) return [];
  const runtimes = state.runtimeByWorkspace;
  if (!isRecord(runtimes)) return [];
  const runtime = runtimes[workspaceId];
  if (!isRecord(runtime) || !Array.isArray(runtime.models)) return [];
  const models: RuntimeModel[] = [];
  for (const raw of runtime.models) {
    if (!isRecord(raw)) continue;
    const providerId = str(raw.providerId);
    const modelId = str(raw.modelId);
    if (!providerId || !modelId || raw.available !== true) continue;
    models.push({
      providerId,
      providerName: str(raw.providerName) ?? providerId,
      modelId,
      label: str(raw.label) ?? modelId,
      available: true,
      thinkingLevels: Array.isArray(raw.thinkingLevels)
        ? raw.thinkingLevels.filter((level): level is string => typeof level === "string")
        : [],
      supportsImages: raw.supportsImages === true,
    });
  }
  return models;
}

export function hasRuntime(state: unknown, workspaceId: string): boolean {
  return (
    isRecord(state) &&
    isRecord(state.runtimeByWorkspace) &&
    isRecord(state.runtimeByWorkspace[workspaceId])
  );
}

/** The levels a model accepts, in the policy's order; every level when the model is unknown. */
export function thinkingOptionsFor(model: RuntimeModel | undefined): readonly string[] {
  if (!model || model.thinkingLevels.length === 0) return THINKING_LEVELS;
  return THINKING_LEVELS.filter((level) => model.thinkingLevels.includes(level));
}

/**
 * The permission the Pi extension reports for this chat (status key `pi-permission`), `null` when it
 * reports one Pegasus does not know, `undefined` when permissions do not apply to the chat.
 */
export function permissionOf(
  state: DesktopAppState | null,
  key: string,
): SessionPermission | null | undefined {
  const ui: unknown = state?.sessionExtensionUiBySession?.[key];
  if (!isRecord(ui) || !Array.isArray(ui.statuses)) return undefined;
  const status = ui.statuses.find((entry) => isRecord(entry) && entry.key === "pi-permission");
  if (!isRecord(status)) return undefined;
  const text = typeof status.text === "string" ? status.text.trim() : "";
  return PERMISSION_OPTIONS.some((option) => option.value === text)
    ? (text as SessionPermission)
    : null;
}

export interface MessageImage {
  readonly uri: string;
  readonly name?: string;
}

/** Image attachments on a sent message, as data URIs; file attachments live on the PC's disk. */
export function messageImages(message: TranscriptMessage): MessageImage[] {
  const raw: unknown = (message as { readonly attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];
  const images: MessageImage[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || entry.kind !== "image") continue;
    const mimeType = str(entry.mimeType);
    const data = str(entry.data);
    if (!mimeType?.startsWith("image/") || !data) continue;
    const name = str(entry.name);
    images.push({ uri: `data:${mimeType};base64,${data}`, ...(name ? { name } : {}) });
  }
  return images;
}

// ---- Photo attachments (sendText's `attachments`, checked by remote-desktop-policy.ts) ----

export interface ImageAttachment {
  readonly id: string;
  readonly kind: "image";
  readonly name: string;
  readonly mimeType: string;
  /** Base64 file bytes, no data: prefix. */
  readonly data: string;
}

/** The PC's limits (contracts/composer-attachments.ts), and the phone's own count cap. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGES_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
export const IMAGES_MAX_COUNT = 4;

export function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/** Why another image cannot join the composer, or null when it can. */
export function attachmentProblem(
  current: readonly ImageAttachment[],
  next: ImageAttachment,
): string | null {
  if (current.length >= IMAGES_MAX_COUNT) return `At most ${IMAGES_MAX_COUNT} photos per message.`;
  const size = base64Bytes(next.data);
  if (size > IMAGE_MAX_BYTES) return "That photo is larger than 10 MB.";
  const total = current.reduce((sum, image) => sum + base64Bytes(image.data), size);
  if (total > IMAGES_MAX_TOTAL_BYTES) return "These photos are larger than 20 MB together.";
  return null;
}

// ---- Generative UI (ask_user / show_ui), a closed catalog of plain-text blocks ----

export type ChecklistStatus = "pending" | "running" | "done" | "failed";

export interface UiOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type UiField =
  | {
      readonly kind: "text";
      readonly id: string;
      readonly label: string;
      readonly placeholder?: string;
      readonly multiline?: boolean;
      readonly required?: boolean;
    }
  | {
      readonly kind: "select";
      readonly id: string;
      readonly label: string;
      readonly options: readonly UiOption[];
      readonly required?: boolean;
    }
  | { readonly kind: "toggle"; readonly id: string; readonly label: string };

export type UiNode =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "card";
      readonly title: string;
      readonly subtitle?: string;
      readonly children: readonly UiNode[];
    }
  | {
      readonly type: "checklist";
      readonly title?: string;
      readonly items: readonly {
        readonly label: string;
        readonly status: ChecklistStatus;
        readonly note?: string;
      }[];
    }
  | {
      readonly type: "choice";
      readonly id: string;
      readonly label: string;
      readonly options: readonly UiOption[];
      readonly multiple?: boolean;
      readonly allowOther?: boolean;
    }
  | { readonly type: "form"; readonly fields: readonly UiField[] }
  | {
      readonly type: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly type: "progress"; readonly label: string; readonly value: number }
  | {
      readonly type: "callout";
      readonly tone: "info" | "success" | "warning" | "error";
      readonly text: string;
    }
  | { readonly type: "code"; readonly code: string; readonly language?: string }
  /** Diagrams and agent maps, flattened to labelled lines (the phone has no graph canvas). */
  | { readonly type: "list"; readonly title?: string; readonly lines: readonly string[] };

export interface UiSpec {
  readonly title?: string;
  readonly blocks: readonly UiNode[];
}

export type UiAnswer = Readonly<Record<string, string | readonly string[] | boolean>>;

const STATUSES = new Set(["pending", "running", "done", "failed"]);
const TONES = new Set(["info", "success", "warning", "error"]);

function options(value: unknown): UiOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = str(entry.id);
    const label = str(entry.label);
    if (!id || !label) return [];
    const description = str(entry.description);
    return [{ id, label, ...(description ? { description } : {}) }];
  });
}

function field(value: unknown): UiField[] {
  if (!isRecord(value)) return [];
  const id = str(value.id);
  const label = str(value.label);
  if (!id || !label) return [];
  if (value.kind === "toggle") return [{ kind: "toggle", id, label }];
  if (value.kind === "select") {
    return [{ kind: "select", id, label, options: options(value.options), required: value.required === true }];
  }
  if (value.kind === "text") {
    const placeholder = str(value.placeholder);
    return [
      {
        kind: "text",
        id,
        label,
        ...(placeholder ? { placeholder } : {}),
        multiline: value.multiline === true,
        required: value.required === true,
      },
    ];
  }
  return [];
}

function node(value: unknown, depth: number): UiNode[] {
  if (!isRecord(value) || depth > 4) return [];
  switch (value.type) {
    case "text": {
      const text = str(value.text);
      return text ? [{ type: "text", text }] : [];
    }
    case "card": {
      const title = str(value.title) ?? "";
      const subtitle = str(value.subtitle);
      const text = str(value.text);
      const children = [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...(Array.isArray(value.children) ? value.children.flatMap((child) => node(child, depth + 1)) : []),
      ];
      return [{ type: "card", title, ...(subtitle ? { subtitle } : {}), children }];
    }
    case "checklist": {
      const title = str(value.title);
      const items = Array.isArray(value.items)
        ? value.items.flatMap((item) => {
            if (!isRecord(item)) return [];
            const label = str(item.label);
            if (!label) return [];
            const status = (STATUSES.has(item.status as string) ? item.status : "pending") as ChecklistStatus;
            const note = str(item.note);
            return [{ label, status, ...(note ? { note } : {}) }];
          })
        : [];
      return [{ type: "checklist", ...(title ? { title } : {}), items }];
    }
    case "choice": {
      const id = str(value.id);
      const label = str(value.label);
      if (!id || !label) return [];
      return [
        {
          type: "choice",
          id,
          label,
          options: options(value.options),
          multiple: value.multiple === true,
          allowOther: value.allowOther === true,
        },
      ];
    }
    case "form":
      return [{ type: "form", fields: Array.isArray(value.fields) ? value.fields.flatMap(field) : [] }];
    case "table": {
      const columns = Array.isArray(value.columns) ? value.columns.map(String) : [];
      const rows = Array.isArray(value.rows)
        ? value.rows.filter(Array.isArray).map((row: unknown[]) => row.map(String))
        : [];
      return [{ type: "table", columns, rows }];
    }
    case "progress": {
      const raw = typeof value.value === "number" ? value.value : 0;
      return [{ type: "progress", label: str(value.label) ?? "", value: Math.min(1, Math.max(0, raw)) }];
    }
    case "callout": {
      const text = str(value.text);
      if (!text) return [];
      const tone = (TONES.has(value.tone as string) ? value.tone : "info") as "info";
      return [{ type: "callout", tone, text }];
    }
    case "code": {
      const code = str(value.code);
      const language = str(value.language);
      return code ? [{ type: "code", code, ...(language ? { language } : {}) }] : [];
    }
    case "diagram": {
      const title = str(value.title);
      const nodes = Array.isArray(value.nodes) ? value.nodes.filter(isRecord) : [];
      const labelOf = new Map(nodes.map((entry) => [String(entry.id), str(entry.label) ?? String(entry.id)]));
      const edges = Array.isArray(value.edges) ? value.edges.filter(isRecord) : [];
      const lines =
        edges.length > 0
          ? edges.map((edge) => {
              const from = labelOf.get(String(edge.from)) ?? String(edge.from);
              const to = labelOf.get(String(edge.to)) ?? String(edge.to);
              const label = str(edge.label);
              return `${from} → ${to}${label ? ` (${label})` : ""}`;
            })
          : [...labelOf.values()];
      return lines.length > 0 ? [{ type: "list", ...(title ? { title } : {}), lines }] : [];
    }
    case "agent_map": {
      const title = str(value.title);
      const agents = Array.isArray(value.agents) ? value.agents.filter(isRecord) : [];
      const items = agents.flatMap((agent) => {
        const label = str(agent.label);
        if (!label) return [];
        const status = (STATUSES.has(agent.status as string) ? agent.status : "pending") as ChecklistStatus;
        const note = str(agent.note) ?? str(agent.role);
        return [{ label, status, ...(note ? { note } : {}) }];
      });
      return [{ type: "checklist", ...(title ? { title } : {}), items }];
    }
    default:
      return [];
  }
}

/** The spec an ask_user or show_ui call carries (its own title/blocks or an older {spec}). */
export function specFromToolInput(input: unknown): UiSpec | undefined {
  if (!isRecord(input)) return undefined;
  const source = isRecord(input.spec) ? input.spec : input;
  if (!Array.isArray(source.blocks)) return undefined;
  const blocks = source.blocks.flatMap((block) => node(block, 0));
  if (blocks.length === 0) return undefined;
  const title = str(source.title);
  return { ...(title ? { title } : {}), blocks };
}

/** The answer a finished ask_user call returned in its details. */
export function answerFromToolOutput(output: unknown): UiAnswer | undefined {
  if (!isRecord(output) || !isRecord(output.details)) return undefined;
  const answer = output.details.answer;
  return isRecord(answer) ? (answer as UiAnswer) : undefined;
}

export type QuestionState =
  | { readonly kind: "display" }
  | { readonly kind: "open"; readonly callId: string }
  | { readonly kind: "answered"; readonly answer: UiAnswer }
  | { readonly kind: "closed" };

/** Same rules as the desktop's generative-ui-tool-item: a waiting ask_user expires with its run. */
export function questionState(tool: TranscriptTool, sessionRunning: boolean): QuestionState {
  if (tool.toolName === "show_ui") return { kind: "display" };
  const extra = tool as TranscriptTool & { readonly output?: unknown; readonly callId?: unknown };
  const answer = answerFromToolOutput(extra.output);
  if (answer) return { kind: "answered", answer };
  const callId = str(extra.callId);
  if (tool.status === "running" && sessionRunning && callId) return { kind: "open", callId };
  return { kind: "closed" };
}

type Input =
  | { readonly kind: "choice"; readonly node: Extract<UiNode, { type: "choice" }> }
  | { readonly kind: "field"; readonly field: UiField };

function inputs(blocks: readonly UiNode[]): Input[] {
  return blocks.flatMap((block): Input[] => {
    if (block.type === "choice") return [{ kind: "choice", node: block }];
    if (block.type === "form") return block.fields.map((entry) => ({ kind: "field" as const, field: entry }));
    if (block.type === "card") return inputs(block.children);
    return [];
  });
}

export function specAsksSomething(spec: UiSpec): boolean {
  return inputs(spec.blocks).length > 0;
}

/**
 * The answer to send, or the first thing still missing. Mirrors the PC's parseGenerativeUiAnswer
 * (a choice needs a pick, required fields need text) so the person sees it before a round trip.
 */
export function buildAnswer(
  spec: UiSpec,
  draft: Readonly<Record<string, string | readonly string[] | boolean | undefined>>,
): { readonly answer: UiAnswer } | { readonly missing: string } {
  const answer: Record<string, string | readonly string[] | boolean> = {};
  for (const input of inputs(spec.blocks)) {
    if (input.kind === "choice") {
      const given = draft[input.node.id];
      const picked = (Array.isArray(given) ? given : typeof given === "string" ? [given] : [])
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (picked.length === 0) return { missing: `Pick an option for "${input.node.label}".` };
      answer[input.node.id] = input.node.multiple ? picked : picked[0]!;
      continue;
    }
    const entry = input.field;
    const given = draft[entry.id];
    if (entry.kind === "toggle") {
      answer[entry.id] = given === true;
      continue;
    }
    const filled = typeof given === "string" ? given.trim() : "";
    if (entry.required && !filled) return { missing: `Fill in "${entry.label}".` };
    if (filled) answer[entry.id] = filled;
  }
  return { answer };
}

/** "Approach: Smaller change", what was answered, by label, for the answered card. */
export function describeAnswer(spec: UiSpec, answer: UiAnswer): string[] {
  const label = (list: readonly UiOption[], value: string) =>
    list.find((option) => option.id === value)?.label ?? value;
  return inputs(spec.blocks).flatMap((input) => {
    if (input.kind === "choice") {
      const value = answer[input.node.id];
      if (value === undefined) return [];
      const values = Array.isArray(value) ? value : [String(value)];
      return [`${input.node.label}: ${values.map((entry) => label(input.node.options, entry)).join(", ")}`];
    }
    const entry = input.field;
    const value = answer[entry.id];
    if (value === undefined) return [];
    if (entry.kind === "toggle") return [`${entry.label}: ${value === true ? "yes" : "no"}`];
    if (entry.kind === "select") return [`${entry.label}: ${label(entry.options, String(value))}`];
    return [`${entry.label}: ${String(value)}`];
  });
}
