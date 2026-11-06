import type { TranscriptMessage } from "./timeline-types";

export type AgentActivityState = "solving" | "listening" | "searching" | "connecting" | "composing";

export function activityForTool(toolName: string): { state: AgentActivityState; label: string } {
  if (
    /(?:web|browser|browse|internet|fetch_url|search_query|tavily|brave_search|exa_search)/i.test(
      toolName,
    )
  )
    return { state: "searching", label: "Searching…" };
  if (/(?:ask_user|question|confirm|approval|listen)/i.test(toolName))
    return { state: "listening", label: "Waiting for you…" };
  return { state: "connecting", label: "Working…" };
}

export function activityForTranscript(items: readonly TranscriptMessage[]): AgentActivityState {
  let reported: AgentActivityState | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (!item) continue;
    if (item.kind === "activity" && item.tone === "working") reported ??= item.activityState;
    if (item.kind === "message" && item.role === "user") break;
    if (item.kind === "tool" && item.status === "running")
      return activityForTool(item.toolName).state;
  }
  if (reported) return reported;
  const last = items.at(-1);
  return last?.kind === "message" && last.role === "assistant" && last.text
    ? "composing"
    : "solving";
}

const FILE_CHANGE_TOOLS = new Set([
  "edit",
  "write",
  "multi_edit",
  "apply_patch",
  "create_file",
  "mac_edit",
  "mac_create_file",
]);
const MAX_TOUCHED_FILES = 50;

/**
 * What an agent is doing and where, from its transcript: the step it is on (its running tool's
 * row label) and the files it changed, newest first. Feeds the Agents panel's map.
 */
export function sessionAgentActivity(
  transcript: readonly TranscriptMessage[],
  status: string,
): { readonly currentStep?: string; readonly touchedFiles?: readonly string[] } {
  let currentStep: string | undefined;
  const files: string[] = [];
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const item = transcript[index];
    if (item?.kind !== "tool") continue;
    if (status === "running" && currentStep === undefined && item.status === "running")
      currentStep = item.label;
    const name = item.toolName
      .replace(/^mcp__.+?__/, "")
      .replace(/^project_/, "")
      .toLowerCase();
    const path =
      (item.input as { path?: unknown; file_path?: unknown } | undefined)?.path ??
      (item.input as { file_path?: unknown } | undefined)?.file_path;
    if (
      item.status === "success" &&
      FILE_CHANGE_TOOLS.has(name) &&
      typeof path === "string" &&
      path.trim()
    ) {
      const normalized = path.trim().replaceAll("\\", "/");
      if (!files.includes(normalized) && files.length < MAX_TOUCHED_FILES) files.push(normalized);
    }
  }
  return {
    ...(currentStep ? { currentStep } : {}),
    ...(files.length ? { touchedFiles: files } : {}),
  };
}
