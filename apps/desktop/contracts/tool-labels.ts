import type { RuntimeSnapshot } from "@pi-gui/session-driver/runtime-types";

/** Tool name → the label its extension registered, for one folder's loaded extensions. */
export type ExtensionToolLabels = ReadonlyMap<string, string>;

const NO_LABELS: ExtensionToolLabels = new Map();

/**
 * Labels of the tools a folder's own extensions registered. A tool keeps pi-gui's own wording
 * when it replaces one of pi's tools, comes from pi-gui's built-in extensions, or is registered by
 * more than one extension (the label shown could be another extension's than the one pi runs).
 */
export function extensionToolLabels(runtime: RuntimeSnapshot | undefined): ExtensionToolLabels {
  if (!runtime) {
    return NO_LABELS;
  }
  // A switched-off extension's tools are still listed for Settings, but pi does not run them.
  const registrations = runtime.extensions
    .filter((extension) => extension.enabled)
    .flatMap((extension) =>
      extension.tools.map((tool) => ({ tool, builtin: extension.sourceInfo.source === "builtin" })),
    );
  const counts = new Map<string, number>();
  for (const { tool } of registrations) {
    counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const { tool, builtin } of registrations) {
    const label = tool.label.trim();
    // A tool the verb table knows (pi-ecosystem's project_shell, labelled "project shell") reads
    // better as a sentence ("Ran git status") than as its registered label.
    if (
      label &&
      !builtin &&
      !tool.replacesPiTool &&
      counts.get(tool.name) === 1 &&
      builtInToolLabel(tool.name, {}) === undefined
    ) {
      labels.set(tool.name, label);
    }
  }
  return labels;
}

/**
 * "Read GitHub issue or PR: pr 223": the extension's label, then the call's main argument, or
 * else its plain values in order, since an extension's parameters have no names pi-gui knows.
 */
export function extensionToolRowLabel(label: string, input: unknown): string {
  const detail = toolInputSummary(input) ?? scalarValues(input);
  return detail ? `${label}: ${detail}` : label;
}

function scalarValues(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const values = Object.values(input).filter(
    (value) =>
      (typeof value === "string" && value.trim()) ||
      typeof value === "number" ||
      typeof value === "boolean",
  );
  return values.length > 0 ? truncate(values.join(" "), 80) : undefined;
}

/** The call argument a person recognizes the call by (a path, query, command, ...), shortened. */
export function toolInputSummary(input: unknown): string | undefined {
  if (typeof input === "string") {
    return truncate(input, 80);
  }
  if (typeof input !== "object" || input === null) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  for (const key of INPUT_SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value, 80);
    }
  }
  return undefined;
}

const INPUT_SUMMARY_KEYS = [
  "path",
  "filePath",
  "query",
  "q",
  "url",
  "command",
  "text",
  "prompt",
  "title",
  "app",
] as const;

export function truncate(value: string, limit = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|heic)$/i;

/**
 * The tool's own name without the wrappers that say nothing to a reader: an MCP server prefix
 * (`mcp__github__get_issue`) and pi-ecosystem's `project_` aliases of pi's tools.
 */
export function baseToolName(toolName: string): string {
  return toolName.replace(/^mcp__.+?__/, "").replace(/^project_/, "");
}

/** "get_issue" → "Get issue": a name a person can read when no verb fits the tool. */
export function humanToolName(toolName: string): string {
  const words = baseToolName(toolName).replace(/[_-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : toolName;
}

/**
 * A plain sentence for the tools pi and its wrappers run: "Ran git status", "Read src/app.ts",
 * "Looked at image shot.png". Undefined for a tool this table does not know.
 */
export function builtInToolLabel(toolName: string, input: unknown): string | undefined {
  const args = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const text = (...keys: string[]) => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const path = text("path", "file_path", "filePath");
  const shown = path ? shortPath(path) : undefined;
  switch (baseToolName(toolName).toLowerCase()) {
    case "bash":
    case "shell":
    case "powershell":
    case "exec":
    case "mac_exec": {
      // A command can say what it is for, like Claude Code's Bash tool; that reads best.
      const description = text("description");
      if (description) return truncate(description, 80);
      const command = text("command");
      return command ? `Ran ${truncate(command.split("\n")[0]!, 80)}` : "Ran a command";
    }
    case "read":
    case "read_file":
    case "view":
      if (!path) return "Read a file";
      return IMAGE_FILE.test(path)
        ? `Looked at image ${path.split(/[\\/]/).at(-1)}`
        : `Read ${shown}`;
    case "ls":
    case "list":
    case "list_dir":
    case "glob": {
      const target = text("pattern") ?? shown;
      return target ? `Listed ${truncate(target, 80)}` : "Listed files";
    }
    case "grep":
    case "find":
    case "rg": {
      const query = text("pattern", "query");
      return query ? `Searched for ${truncate(query, 80)}` : "Searched files";
    }
    case "edit":
    case "multi_edit":
    case "apply_patch":
    case "mac_edit":
      return shown ? `Edited ${shown}` : "Edited a file";
    case "write":
    case "create_file":
    case "mac_create_file":
      return shown ? `Wrote ${shown}` : "Wrote a file";
    case "web_fetch":
    case "fetch": {
      const url = text("url");
      return url ? `Opened ${urlHost(url)}` : "Opened a web page";
    }
    case "web_search": {
      const query = text("query", "q");
      return query ? `Searched the web for ${truncate(query, 80)}` : "Searched the web";
    }
    case "screen_record":
      return shown ? `Recorded screen to ${shown}` : "Recorded screen";
    case "screenshot":
    case "take_screenshot":
      return "Took screenshot";
    case "read_skill": {
      const id = text("id", "name");
      return id ? `Loaded skill ${truncate(id, 80)}` : "Loaded a skill";
    }
    case "find_skills": {
      const query = text("query");
      return query ? `Searched skills for ${truncate(query, 80)}` : "Searched skills";
    }
    default:
      return undefined;
  }
}

/** The last three parts of a path, either separator, so a long path still names its file. */
function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return truncate(parts.length <= 3 ? path : parts.slice(-3).join("/"), 80);
}

function urlHost(url: string): string {
  try {
    return new URL(url).host || truncate(url, 80);
  } catch {
    return truncate(url, 80);
  }
}

const SEARCH_TOOLS = new Set(["grep", "find", "rg", "glob", "find_skills", "web_search"]);
const LOOK_TOOLS = new Set(["read", "read_file", "view", "ls", "list", "list_dir", "read_skill"]);

/**
 * "search" or "file" for a call that only looks around, so a run of them can fold into one row.
 * An image read is not folded: its row shows the picture.
 */
export function exploreKind(toolName: string, input: unknown): "search" | "file" | undefined {
  const name = baseToolName(toolName).toLowerCase();
  if (SEARCH_TOOLS.has(name)) return "search";
  if (!LOOK_TOOLS.has(name)) return undefined;
  const path =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>).path : undefined;
  return typeof path === "string" && IMAGE_FILE.test(path) ? undefined : "file";
}
