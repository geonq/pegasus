/**
 * Generative UI: the agent describes a small interface as JSON and the app draws it with its own
 * components (A2UI / json-render style). The catalog is closed and every value is plain text, so
 * nothing the model writes ever runs as HTML or script. The same parser runs where the tool call
 * arrives (main) and where it is drawn (renderer).
 */

export const showUiToolName = "show_ui";
export const askUserToolName = "ask_user";
export const GENERATIVE_UI_VERSION = 1;

export type ChecklistStatus = "pending" | "running" | "done" | "failed";
export type CalloutTone = "info" | "success" | "warning" | "error";

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

export interface DiagramNode {
  readonly id: string;
  readonly label: string;
  readonly kind?: string;
  readonly group?: string;
  readonly description?: string;
  /** A file in the workspace the node stands for; clicking the node opens it. */
  readonly path?: string;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface AgentMapEntry {
  readonly id: string;
  readonly label: string;
  readonly status: ChecklistStatus;
  /** A child thread working on this entry, so the map can follow it. */
  readonly threadId?: string;
  readonly role?: string;
  readonly note?: string;
  readonly parent?: string;
}

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
        /** A child thread doing this item; its live status overrides `status`. */
        readonly threadId?: string;
      }[];
    }
  | {
      readonly type: "choice";
      readonly id: string;
      readonly label: string;
      readonly options: readonly UiOption[];
      readonly multiple?: boolean;
      /** Offers an "Other…" option with a text box. */
      readonly allowOther?: boolean;
    }
  | { readonly type: "form"; readonly fields: readonly UiField[] }
  | {
      readonly type: "table";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly type: "progress"; readonly label: string; readonly value: number }
  | { readonly type: "callout"; readonly tone: CalloutTone; readonly text: string }
  | { readonly type: "code"; readonly code: string; readonly language?: string }
  | {
      readonly type: "diagram";
      readonly title?: string;
      readonly mermaid?: string;
      readonly nodes?: readonly DiagramNode[];
      readonly edges?: readonly DiagramEdge[];
    }
  | { readonly type: "agent_map"; readonly title?: string; readonly agents: readonly AgentMapEntry[] };

export interface GenerativeUiSpec {
  readonly version: typeof GENERATIVE_UI_VERSION;
  readonly title?: string;
  readonly blocks: readonly UiNode[];
}

/** What the user picked: one value per choice or field id. */
export type GenerativeUiAnswer = Readonly<Record<string, string | readonly string[] | boolean>>;

const MAX_SPEC_BYTES = 64 * 1024;
const MAX_BLOCKS = 40;
const MAX_TEXT = 4000;
const MAX_LABEL = 200;
const MAX_ID = 64;
const MAX_OPTIONS = 20;
const MAX_ROWS = 200;
const MAX_COLUMNS = 12;
const MAX_NODES = 200;
const MAX_DEPTH = 2;
const ID = /^[A-Za-z0-9_.:-]+$/u;
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

class SpecError extends Error {}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SpecError(`${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string, max: number): readonly unknown[] {
  if (!Array.isArray(value)) throw new SpecError(`${where} must be a list.`);
  if (value.length > max) throw new SpecError(`${where} holds at most ${max} entries.`);
  return value;
}

function text(value: unknown, where: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SpecError(`${where} must be non-empty text.`);
  }
  if (value.length > max) throw new SpecError(`${where} is longer than ${max} characters.`);
  return value;
}

function optionalText(value: unknown, where: string, max = MAX_TEXT): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : text(value, where, max);
}

function id(value: unknown, where: string): string {
  const parsed = text(value, where, MAX_ID);
  if (!ID.test(parsed)) throw new SpecError(`${where} may use only letters, digits and _ . : -`);
  // Ids become answer keys; these would reach the object prototype instead.
  if (RESERVED_IDS.has(parsed)) throw new SpecError(`${where} cannot be ${parsed}.`);
  return parsed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function options(value: unknown, where: string): UiOption[] {
  const parsed = list(value, where, MAX_OPTIONS).map((entry, index) => {
    const option = record(entry, `${where}[${index}]`);
    const label = text(option.label, `${where}[${index}].label`, MAX_LABEL);
    const description = optionalText(option.description, `${where}[${index}].description`, 600);
    return {
      id: option.id === undefined ? `option-${index + 1}` : id(option.id, `${where}[${index}].id`),
      label,
      ...(description ? { description } : {}),
    };
  });
  if (parsed.length === 0) throw new SpecError(`${where} needs at least one option.`);
  uniqueIds(parsed, where);
  return parsed;
}

function uniqueIds(entries: readonly { readonly id: string }[], where: string): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new SpecError(`${where} repeats the id ${entry.id}.`);
    seen.add(entry.id);
  }
}

const STATUSES: readonly ChecklistStatus[] = ["pending", "running", "done", "failed"];
const TONES: readonly CalloutTone[] = ["info", "success", "warning", "error"];

/** One node, or undefined for a type outside the catalog so a newer agent's extra blocks are skipped. */
function node(value: unknown, where: string, depth: number): UiNode | undefined {
  const raw = record(value, where);
  switch (raw.type) {
    case "text":
      return { type: "text", text: text(raw.text, `${where}.text`) };
    case "card": {
      if (depth >= MAX_DEPTH) throw new SpecError(`${where}: cards nest at most ${MAX_DEPTH} deep.`);
      const subtitle = optionalText(raw.subtitle, `${where}.subtitle`, MAX_LABEL);
      const body = optionalText(raw.text, `${where}.text`);
      return {
        type: "card",
        title: text(raw.title, `${where}.title`, MAX_LABEL),
        ...(subtitle ? { subtitle } : {}),
        children: [
          ...(body ? [{ type: "text" as const, text: body }] : []),
          ...nodes(raw.children ?? [], `${where}.children`, depth + 1),
        ],
      };
    }
    case "checklist": {
      const title = optionalText(raw.title, `${where}.title`, MAX_LABEL);
      const items = list(raw.items, `${where}.items`, MAX_ROWS).map((entry, index) => {
        const item = record(entry, `${where}.items[${index}]`);
        const note = optionalText(item.note, `${where}.items[${index}].note`, 600);
        const threadId = optionalText(item.threadId, `${where}.items[${index}].threadId`, 128);
        return {
          label: text(item.label, `${where}.items[${index}].label`, 600),
          status: oneOf(item.status, STATUSES, "pending"),
          ...(note ? { note } : {}),
          ...(threadId ? { threadId } : {}),
        };
      });
      return { type: "checklist", ...(title ? { title } : {}), items };
    }
    case "choice":
      return {
        type: "choice",
        id: id(raw.id, `${where}.id`),
        label: text(raw.label, `${where}.label`, 600),
        options: options(raw.options, `${where}.options`),
        ...(raw.multiple === true ? { multiple: true } : {}),
        ...(raw.allowOther === true ? { allowOther: true } : {}),
      };
    case "form": {
      const fields = list(raw.fields, `${where}.fields`, MAX_OPTIONS).map((entry, index) =>
        field(entry, `${where}.fields[${index}]`),
      );
      if (fields.length === 0) throw new SpecError(`${where}.fields needs at least one field.`);
      return { type: "form", fields };
    }
    case "table": {
      const columns = list(raw.columns, `${where}.columns`, MAX_COLUMNS).map((entry, index) =>
        text(entry, `${where}.columns[${index}]`, MAX_LABEL),
      );
      const rows = list(raw.rows, `${where}.rows`, MAX_ROWS).map((entry, rowIndex) =>
        list(entry, `${where}.rows[${rowIndex}]`, MAX_COLUMNS).map((cell) =>
          typeof cell === "number" || typeof cell === "boolean"
            ? String(cell)
            : typeof cell === "string"
              ? cell.slice(0, 600)
              : "",
        ),
      );
      return { type: "table", columns, rows };
    }
    case "progress": {
      const value = typeof raw.value === "number" && Number.isFinite(raw.value) ? raw.value : 0;
      return {
        type: "progress",
        label: text(raw.label, `${where}.label`, MAX_LABEL),
        // Accept 0..1 or a percentage.
        value: Math.min(1, Math.max(0, value > 1 ? value / 100 : value)),
      };
    }
    case "callout":
      return {
        type: "callout",
        tone: oneOf(raw.tone, TONES, "info"),
        text: text(raw.text, `${where}.text`),
      };
    case "code": {
      const language = optionalText(raw.language, `${where}.language`, 32);
      return { type: "code", code: text(raw.code, `${where}.code`, 20_000), ...(language ? { language } : {}) };
    }
    case "diagram":
      return diagram(raw, where);
    case "agent_map":
      return agentMap(raw, where);
    default:
      return undefined;
  }
}

function field(value: unknown, where: string): UiField {
  const raw = record(value, where);
  const base = { id: id(raw.id, `${where}.id`), label: text(raw.label, `${where}.label`, 600) };
  if (raw.kind === "select") {
    return {
      kind: "select",
      ...base,
      options: options(raw.options, `${where}.options`),
      ...(raw.required === true ? { required: true } : {}),
    };
  }
  if (raw.kind === "toggle") return { kind: "toggle", ...base };
  const placeholder = optionalText(raw.placeholder, `${where}.placeholder`, MAX_LABEL);
  return {
    kind: "text",
    ...base,
    ...(placeholder ? { placeholder } : {}),
    ...(raw.multiline === true ? { multiline: true } : {}),
    ...(raw.required === true ? { required: true } : {}),
  };
}

function diagram(raw: Record<string, unknown>, where: string): UiNode {
  const title = optionalText(raw.title, `${where}.title`, MAX_LABEL);
  const mermaid = optionalText(raw.mermaid, `${where}.mermaid`, 20_000);
  if (mermaid) return { type: "diagram", ...(title ? { title } : {}), mermaid };
  const nodes = list(raw.nodes, `${where}.nodes`, MAX_NODES).map((entry, index) => {
    const item = record(entry, `${where}.nodes[${index}]`);
    const at = `${where}.nodes[${index}]`;
    const kind = optionalText(item.kind, `${at}.kind`, 40);
    const group = optionalText(item.group, `${at}.group`, MAX_LABEL);
    const description = optionalText(item.description, `${at}.description`, 1000);
    const path = optionalText(item.path, `${at}.path`, 1000);
    return {
      id: id(item.id, `${at}.id`),
      label: text(item.label, `${at}.label`, MAX_LABEL),
      ...(kind ? { kind } : {}),
      ...(group ? { group } : {}),
      ...(description ? { description } : {}),
      ...(path ? { path } : {}),
    };
  });
  if (nodes.length === 0) throw new SpecError(`${where} needs mermaid text or at least one node.`);
  uniqueIds(nodes, `${where}.nodes`);
  const known = new Set(nodes.map((entry) => entry.id));
  const edges = list(raw.edges ?? [], `${where}.edges`, MAX_NODES * 2).flatMap((entry, index) => {
    const edge = record(entry, `${where}.edges[${index}]`);
    const from = id(edge.from, `${where}.edges[${index}].from`);
    const to = id(edge.to, `${where}.edges[${index}].to`);
    const label = optionalText(edge.label, `${where}.edges[${index}].label`, MAX_LABEL);
    // An edge to a node that is not in the diagram is dropped rather than drawn to nowhere.
    return known.has(from) && known.has(to) ? [{ from, to, ...(label ? { label } : {}) }] : [];
  });
  return { type: "diagram", ...(title ? { title } : {}), nodes, edges };
}

function agentMap(raw: Record<string, unknown>, where: string): UiNode {
  const title = optionalText(raw.title, `${where}.title`, MAX_LABEL);
  const agents = list(raw.agents, `${where}.agents`, MAX_NODES).map((entry, index) => {
    const item = record(entry, `${where}.agents[${index}]`);
    const at = `${where}.agents[${index}]`;
    const threadId = optionalText(item.threadId, `${at}.threadId`, 128);
    const role = optionalText(item.role, `${at}.role`, 60);
    const note = optionalText(item.note, `${at}.note`, 600);
    const parent = item.parent === undefined ? undefined : id(item.parent, `${at}.parent`);
    return {
      id: id(item.id, `${at}.id`),
      label: text(item.label, `${at}.label`, 600),
      status: oneOf(item.status, STATUSES, "pending"),
      ...(threadId ? { threadId } : {}),
      ...(role ? { role } : {}),
      ...(note ? { note } : {}),
      ...(parent ? { parent } : {}),
    };
  });
  if (agents.length === 0) throw new SpecError(`${where}.agents needs at least one entry.`);
  uniqueIds(agents, `${where}.agents`);
  return { type: "agent_map", ...(title ? { title } : {}), agents };
}

function nodes(value: unknown, where: string, depth: number): UiNode[] {
  return list(value, where, MAX_BLOCKS).flatMap((entry, index) => {
    const parsed = node(entry, `${where}[${index}]`, depth);
    return parsed ? [parsed] : [];
  });
}

/**
 * The agent's spec, checked against the catalog. Throws an Error that says what to fix, so the
 * tool can hand it back to the model; blocks of an unknown type are skipped.
 */
export function parseGenerativeUi(value: unknown): GenerativeUiSpec {
  const raw = record(typeof value === "string" ? safeJson(value) : value, "spec");
  if (JSON.stringify(raw).length > MAX_SPEC_BYTES) {
    throw new SpecError(`spec is larger than ${MAX_SPEC_BYTES / 1024} KB.`);
  }
  const title = optionalText(raw.title, "spec.title", MAX_LABEL);
  const blocks = nodes(raw.blocks, "spec.blocks", 0);
  if (blocks.length === 0) throw new SpecError("spec.blocks needs at least one known block.");
  const inputIds = inputs(blocks).map((input) => input.id);
  const seen = new Set<string>();
  for (const inputId of inputIds) {
    if (seen.has(inputId)) throw new SpecError(`Two inputs share the id ${inputId}.`);
    seen.add(inputId);
  }
  return { version: GENERATIVE_UI_VERSION, ...(title ? { title } : {}), blocks };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new SpecError("spec must be a JSON object.");
  }
}

/** Every choice and form field in the spec, cards included, in order. */
export function inputs(
  blocks: readonly UiNode[],
): ({ readonly kind: "choice"; readonly id: string; readonly node: Extract<UiNode, { type: "choice" }> } | {
  readonly kind: "field";
  readonly id: string;
  readonly field: UiField;
})[] {
  return blocks.flatMap((block) => {
    if (block.type === "choice") return [{ kind: "choice" as const, id: block.id, node: block }];
    if (block.type === "form") {
      return block.fields.map((entry) => ({ kind: "field" as const, id: entry.id, field: entry }));
    }
    if (block.type === "card") return inputs(block.children);
    return [];
  });
}

/**
 * The user's answer, checked against the spec it answers: only its own ids, a choice's own option
 * ids (or free text where "Other…" is offered), and required fields filled.
 */
export function parseGenerativeUiAnswer(spec: GenerativeUiSpec, value: unknown): GenerativeUiAnswer {
  const raw = record(value, "answer");
  const answer: Record<string, string | readonly string[] | boolean> = {};
  for (const input of inputs(spec.blocks)) {
    const given = raw[input.id];
    if (input.kind === "choice") {
      const allowed = new Set(input.node.options.map((option) => option.id));
      const picked = (Array.isArray(given) ? given : given === undefined ? [] : [given]).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      );
      for (const entry of picked) {
        if (!allowed.has(entry) && !input.node.allowOther) {
          throw new SpecError(`${entry} is not an option of ${input.id}.`);
        }
        if (entry.length > MAX_TEXT) throw new SpecError(`The answer to ${input.id} is too long.`);
      }
      if (picked.length === 0) throw new SpecError(`Pick an option for "${input.node.label}".`);
      if (!input.node.multiple && picked.length > 1) {
        throw new SpecError(`"${input.node.label}" takes one option.`);
      }
      answer[input.id] = input.node.multiple ? picked : picked[0]!;
      continue;
    }
    const entry = input.field;
    if (entry.kind === "toggle") {
      answer[entry.id] = given === true;
      continue;
    }
    const filled = typeof given === "string" ? given.trim() : "";
    if (filled.length > MAX_TEXT) throw new SpecError(`The answer to ${entry.id} is too long.`);
    if (entry.kind === "select" && filled && !entry.options.some((option) => option.id === filled)) {
      throw new SpecError(`${filled} is not an option of ${entry.id}.`);
    }
    if (entry.required && !filled) throw new SpecError(`Fill in "${entry.label}".`);
    if (filled) answer[entry.id] = filled;
  }
  return answer;
}

/** The answer as the tool result's text: each question with what was picked, by label. */
export function describeGenerativeUiAnswer(spec: GenerativeUiSpec, answer: GenerativeUiAnswer): string {
  const label = (options: readonly UiOption[], value: string) =>
    options.find((option) => option.id === value)?.label ?? value;
  const lines = inputs(spec.blocks).flatMap((input) => {
    const value = answer[input.id];
    if (value === undefined) return [];
    if (input.kind === "choice") {
      const values = Array.isArray(value) ? value : [value as string];
      return [`${input.node.label}: ${values.map((entry) => label(input.node.options, entry)).join(", ")}`];
    }
    const entry = input.field;
    if (entry.kind === "toggle") return [`${entry.label}: ${value === true ? "yes" : "no"}`];
    if (entry.kind === "select") return [`${entry.label}: ${label(entry.options, value as string)}`];
    return [`${entry.label}: ${value as string}`];
  });
  return `The user answered.\n${lines.join("\n")}\n\nAnswer as JSON: ${JSON.stringify(answer)}`;
}

/** The spec an ask_user or show_ui call carries, or undefined when its input is not a valid spec. */
export function specFromToolInput(input: unknown): GenerativeUiSpec | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { spec } = input as Record<string, unknown>;
  try {
    return parseGenerativeUi(spec);
  } catch {
    return undefined;
  }
}

/** The answer a finished ask_user call returned in its details. */
export function answerFromToolOutput(output: unknown): GenerativeUiAnswer | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const details = (output as Record<string, unknown>).details;
  if (typeof details !== "object" || details === null) return undefined;
  const answer = (details as Record<string, unknown>).answer;
  return typeof answer === "object" && answer !== null && !Array.isArray(answer)
    ? (answer as GenerativeUiAnswer)
    : undefined;
}
