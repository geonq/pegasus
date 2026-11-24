// Demo mode only: a busy parent chat with many subagents and a long history, so the chat screen can
// be checked the way the owner uses it (15+ agents, the newest reply still in view).
import type { OrchestrationChildThread, SessionRecord, TranscriptItem } from "../api/types.ts";

const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

const AGENTS: readonly (readonly [
  title: string,
  role: string,
  status: OrchestrationChildThread["status"],
  model: readonly [string, string],
  latest: string,
  minutes: number,
])[] = [
  [
    "Check VoiceOver labels",
    "reviewer",
    "running",
    ["anthropic", "claude-sonnet-5"],
    "Reading ChatListRow.tsx",
    1,
  ],
  [
    "Run the migration on staging",
    "implementer",
    "waiting",
    ["anthropic", "claude-opus-5-5"],
    "Allow running pnpm db:migrate?",
    2,
  ],
  [
    "Port the sheet spring to Reanimated",
    "implementer",
    "running",
    ["openai", "gpt-6.1"],
    "Editing src/ui/Overlay.tsx",
    1,
  ],
  [
    "Measure list scroll jank",
    "planner",
    "running",
    ["anthropic", "claude-sonnet-5"],
    "Profiling 400 rows",
    3,
  ],
  [
    "Audit tap targets under 44 pt",
    "reviewer",
    "complete",
    ["anthropic", "claude-sonnet-5"],
    "Three targets fixed",
    9,
  ],
  [
    "Dark mode contrast pass",
    "reviewer",
    "complete",
    ["openai", "gpt-6.1"],
    "All text above 4.5:1",
    14,
  ],
  ["Rewrite empty states", "implementer", "complete", ["anthropic", "claude-opus-5-5"], "Done", 18],
  [
    "Composer keyboard inset",
    "implementer",
    "failed",
    ["anthropic", "claude-opus-5-5"],
    "tsc failed: 2 errors",
    21,
  ],
  ["Pairing QR flow", "implementer", "complete", ["deepseek", "deepseek-v4"], "Done", 26],
  ["Toast timing review", "reviewer", "complete", ["anthropic", "claude-sonnet-5"], "Done", 31],
  ["Haptics on approvals", "implementer", "complete", ["anthropic", "claude-sonnet-5"], "Done", 35],
  ["Settings screen density", "planner", "complete", ["openai", "gpt-6.1"], "Done", 40],
  [
    "Review screen diff colours",
    "implementer",
    "complete",
    ["anthropic", "claude-opus-5-5"],
    "Done",
    44,
  ],
  ["Usage sheet numbers", "reviewer", "complete", ["anthropic", "claude-sonnet-5"], "Done", 50],
  ["Offline banner copy", "implementer", "complete", ["deepseek", "deepseek-v4"], "Done", 55],
  ["Swipe row thresholds", "implementer", "complete", ["anthropic", "claude-sonnet-5"], "Done", 61],
];

/** The subagents' own chats, so the screen can name each one's model. */
export function demoAgentSessions(now: number): SessionRecord[] {
  return AGENTS.map(([title, , status, [provider, modelId], latest, minutes], index) => ({
    id: `agent-${index + 1}`,
    title,
    updatedAt: ago(now, minutes),
    lastInteractedAt: ago(now, minutes),
    preview: latest,
    status: status === "running" ? "running" : status === "failed" ? "failed" : "idle",
    hasUnseenUpdate: false,
    config: { provider, modelId, thinkingLevel: "high" },
  })) as SessionRecord[];
}

export function demoAgents(now: number): OrchestrationChildThread[] {
  return AGENTS.map(([title, role, status, , latest, minutes], index) => ({
    id: `child-${index + 1}`,
    title,
    role,
    status,
    latestTranscript: latest,
    parentWorkspaceId: "pegasus",
    parentSessionId: "phone-design",
    childWorkspaceId: "pegasus",
    childSessionId: `agent-${index + 1}`,
    updatedAt: ago(now, minutes),
  }));
}

/** An hour of earlier turns ahead of the chat's current one. */
export function demoHistory(now: number): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (let turn = 0; turn < 8; turn += 1) {
    const start = 70 - turn * 7;
    items.push(
      {
        kind: "message",
        id: `h${turn}-u`,
        role: "user",
        text: [
          "Start with the chat list: what needs me first.",
          "The top bar feels heavy. Lighter, like the desktop.",
          "Run reviewers on every screen in parallel.",
          "Fix what the reviewers found.",
          "Now the composer: it jumps when the keyboard opens.",
          "Haptics on approvals, please.",
          "Check dark mode.",
          "Spin up agents for the remaining screens.",
        ][turn] as string,
        createdAt: ago(now, start),
      } as TranscriptItem,
      {
        kind: "thinking",
        id: `h${turn}-th`,
        text: "Plan the change…",
        createdAt: ago(now, start - 0.5),
        durationMs: 6_000 + turn * 1_000,
      } as TranscriptItem,
    );
    for (let step = 0; step < 5; step += 1) {
      items.push({
        kind: "tool",
        id: `h${turn}-t${step}`,
        toolName: "bash",
        status: "success",
        label: `Read src/screens/Screen${turn}${step}.tsx`,
        createdAt: ago(now, start - 1 - step * 0.4),
      } as TranscriptItem);
    }
    items.push({
      kind: "message",
      id: `h${turn}-a`,
      role: "assistant",
      text: `Turn ${turn + 1} done. I changed the files above and the typecheck passes. Two agents are still checking the result.`,
      createdAt: ago(now, start - 4),
    } as TranscriptItem);
  }
  return items;
}
