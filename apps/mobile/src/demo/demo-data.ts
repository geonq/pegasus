// Realistic PC state for the dev-only demo mode (src/demo/install.ts). Pure data, no React Native.
import type {
  DesktopAppState,
  SelectedTranscript,
  SessionRecord,
  TranscriptItem,
  WorkspaceRecord,
} from "../api/types.ts";
import { demoAgentSessions, demoAgents, demoHistory } from "./demo-agents.ts";

export const DEMO_URL = "http://demo.pegasus:47219";
export const DEMO_PAIRING_LINK = `pegasus://pair?v=1&url=${encodeURIComponent(DEMO_URL)}&token=demo-token-0123456789abcdefghijklmnopqrstuv&name=Studio%20PC`;

const ago = (now: number, minutes: number) => new Date(now - minutes * 60_000).toISOString();

function session(
  now: number,
  id: string,
  minutes: number,
  extra: Partial<SessionRecord>,
): SessionRecord {
  return {
    id,
    title: id,
    updatedAt: ago(now, minutes),
    lastInteractedAt: ago(now, minutes),
    preview: "",
    status: "idle",
    hasUnseenUpdate: false,
    ...extra,
  };
}

const config = (provider: string, modelId: string, thinkingLevel = "high") => ({
  config: { provider, modelId, thinkingLevel },
});

export function demoWorkspaces(now: number, busy = false): WorkspaceRecord[] {
  const workspaces: WorkspaceRecord[] = [
    {
      id: "pegasus",
      name: "pegasus",
      path: "D:/Pi/pi-gui",
      kind: "primary",
      sessions: [
        session(now, "phone-design", 1, {
          title: "Phone app in Pegasus style",
          status: "running",
          runningSince: ago(now, 4),
          currentStep: "Editing src/ui/Overlay.tsx",
          preview: "Rebuilding the top bar and the popover menu",
          ...config("anthropic", "claude-opus-5-5"),
        } as Partial<SessionRecord>),
        session(now, "release-notes", 6, {
          title: "Draft 1.1.3 release notes",
          preview: "Ready to push the tag?",
          ...config("openai", "gpt-6.1"),
        } as Partial<SessionRecord>),
        session(now, "sidebar-drag", 38, {
          title: "Drag to reorder pinned chats",
          preview: "Done. Pinned chats keep their order across restarts.",
          hasUnseenUpdate: true,
          ...config("anthropic", "claude-opus-5-5"),
        } as Partial<SessionRecord>),
        session(now, "ci-mac", 95, {
          title: "Local CI on the Mac",
          preview: "xcodebuild exited with 65",
          status: "failed",
          hasUnseenUpdate: true,
          ...config("anthropic", "claude-sonnet-5"),
        } as Partial<SessionRecord>),
        session(now, "theme-tokens", 60 * 26, {
          title: "Theme tokens from the desktop",
          preview: "Ported the 4 pt ramp and the radius scale.",
          pinnedAt: ago(now, 60 * 30),
          ...config("anthropic", "claude-opus-5-5"),
        } as Partial<SessionRecord>),
        session(now, "agent-review", 3, {
          title: "Review the transcript deltas",
          status: "running",
          runningSince: ago(now, 2),
          currentStep: "Reading live-state.ts",
          preview: "",
          ...config("anthropic", "claude-sonnet-5"),
        } as Partial<SessionRecord>),
        session(now, "old-1", 60 * 24 * 4, {
          title: "Keyboard-aware composer",
          preview: "The last message stays above the composer now.",
        }),
        session(now, "old-2", 60 * 24 * 9, {
          title: "Photo attachments from the phone",
          preview: "Library and camera both send JPEG under 2 MB.",
        }),
      ],
    },
    {
      id: "seher",
      name: "seher",
      path: "D:/Pi/projects/Seher",
      kind: "primary",
      sessions: [
        session(now, "finance-sync", 12, {
          title: "Bank sync retries",
          preview: "Allow running the migration?",
          ...config("anthropic", "claude-opus-5-5"),
        } as Partial<SessionRecord>),
        session(now, "health-widget", 60 * 5, {
          title: "Health widget layout",
          preview: "The ring now reads as one glance on the lock screen.",
          ...config("openai", "gpt-6.1"),
        } as Partial<SessionRecord>),
      ],
    },
    {
      id: "seher-wt",
      name: "seher",
      path: "D:/Pi/worktrees/seher-maps",
      kind: "worktree",
      rootWorkspaceId: "seher",
      sessions: [
        session(now, "maps-canvas", 60 * 50, {
          title: "Map canvas links",
          preview: "JSON Canvas export round-trips.",
        }),
      ],
    },
    // Added on the PC after the phone paired: it must still show, with no chats yet.
    {
      id: "uni",
      name: "uni-notes",
      path: "C:/Users/Georg/Documents/Uni",
      kind: "primary",
      sessions: [],
    },
  ];
  if (!busy) return workspaces;
  const [pegasus, ...rest] = workspaces as [WorkspaceRecord, ...WorkspaceRecord[]];
  return [{ ...pegasus, sessions: [...pegasus.sessions, ...demoAgentSessions(now)] }, ...rest];
}

const models = [
  {
    providerId: "anthropic",
    providerName: "Claude",
    modelId: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    available: true,
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    supportsImages: true,
  },
  {
    providerId: "anthropic",
    providerName: "Claude",
    modelId: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    available: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    supportsImages: true,
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-6.1",
    label: "GPT-6.1",
    available: true,
    thinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
    supportsImages: true,
  },
  {
    providerId: "deepseek",
    providerName: "DeepSeek",
    modelId: "deepseek-v4",
    label: "DeepSeek V4",
    available: true,
    thinkingLevels: [],
    supportsImages: false,
  },
];

export function demoRuntime() {
  return {
    models,
    settings: {
      defaultProvider: "anthropic",
      defaultModelId: "claude-opus-5-5",
      defaultThinkingLevel: "high",
    },
  };
}

export function demoState(
  now: number,
  workspaces: readonly WorkspaceRecord[],
  revision: number,
  selected: { workspaceId: string; sessionId: string },
  busy = false,
): DesktopAppState {
  const runtime = demoRuntime();
  return {
    revision,
    workspaces,
    selectedWorkspaceId: selected.workspaceId,
    selectedSessionId: selected.sessionId,
    workspaceOrder: ["pegasus", "seher", "uni"],
    pinnedSessionOrder: ["pegasus:theme-tokens"],
    sessionExtensionUiBySession: {
      "seher:finance-sync": {
        pendingDialogs: [
          {
            kind: "confirm",
            requestId: "dialog-1",
            title: "Run the database migration?",
            message:
              "pnpm --filter server db:migrate\n\nAdds the retry_count column to bank_syncs.",
          },
        ],
        statuses: [{ key: "pi-permission", text: "ask" }],
      },
      "pegasus:phone-design": {
        pendingDialogs: [],
        statuses: [{ key: "pi-permission", text: "edits" }],
      },
      "pegasus:release-notes": {
        pendingDialogs: [],
        statuses: [{ key: "pi-permission", text: "ask" }],
      },
    } as DesktopAppState["sessionExtensionUiBySession"],
    queuedComposerMessages: [],
    sessionUsageBySession: {
      "pegasus:phone-design": {
        subscription: true,
        totals: { cost: 4.12 },
        planLimits: {
          provider: "Claude",
          reportedAt: ago(now, 1),
          limits: [
            { windowMinutes: 300, usedPercent: 92, resetsAt: ago(now, -43) },
            { windowMinutes: 10080, usedPercent: 61, resetsAt: ago(now, -60 * 70) },
          ],
        },
      },
    },
    orchestrationChildren: busy
      ? demoAgents(now)
      : [
          {
            id: "child-1",
            title: "Check VoiceOver labels",
            role: "reviewer",
            status: "running",
            latestTranscript: "Reading ChatListRow.tsx",
            parentWorkspaceId: "pegasus",
            parentSessionId: "phone-design",
            childWorkspaceId: "pegasus",
            childSessionId: "agent-review",
            updatedAt: ago(now, 1),
          },
        ],
    runtimeByWorkspace: { pegasus: runtime, seher: runtime, uni: runtime },
  } as DesktopAppState;
}

function tool(
  id: string,
  label: string,
  status: "success" | "running" | "error",
  at: string,
  detail?: string,
) {
  return {
    kind: "tool",
    id,
    toolName: "bash",
    status,
    label,
    createdAt: at,
    ...(detail ? { detail } : {}),
  } as TranscriptItem;
}

export function demoTranscript(
  now: number,
  workspaceId: string,
  sessionId: string,
  busy = false,
): SelectedTranscript {
  const t = (minutes: number) => ago(now, minutes);
  const items: TranscriptItem[] =
    sessionId === "phone-design"
      ? [
          {
            kind: "message",
            id: "m1",
            role: "user",
            text: "The phone app still looks like slop. Make it look and feel like Pegasus: no stock menus or pickers anywhere.",
            createdAt: t(9),
          } as TranscriptItem,
          {
            kind: "thinking",
            id: "th1",
            text: "Start from the desktop tokens…",
            createdAt: t(8.8),
            durationMs: 14_000,
          } as TranscriptItem,
          tool("t1", "Read apps/desktop/src/styles/floating-panels.css", "success", t(8.5)),
          tool("t2", "Read apps/desktop/src/styles/sidebar.css", "success", t(8.4)),
          tool(
            "t3",
            "Search for @expo/ui in apps/mobile/src",
            "success",
            t(8.2),
            "src/ui/NativeMenu.tsx\nsrc/ui/menu-model.ts",
          ),
          {
            kind: "message",
            id: "m2",
            role: "assistant",
            text: "Here is the plan:\n\n1. **One glass** for every floating layer, from `polish.css`.\n2. A Pegasus **popover menu** that grows from the control that opened it.\n3. Swipe actions drawn by Pegasus, with the same actions in the long-press menu.\n\nThe chat list keeps the desktop's order: *Needs you*, *Working*, *Pinned*, then every project.",
            createdAt: t(7),
          } as TranscriptItem,
          {
            kind: "message",
            id: "m3",
            role: "user",
            text: "Go. Keep the back swipe.",
            createdAt: t(5),
          } as TranscriptItem,
          tool("t4", "Write src/ui/Overlay.tsx", "success", t(4.5)),
          tool("t5", "Write src/ui/SwipeRow.tsx", "success", t(3.9)),
          tool("t6", "npx tsc --noEmit", "running", t(0.3)),
        ]
      : sessionId === "finance-sync"
        ? [
            {
              kind: "message",
              id: "f1",
              role: "user",
              text: "Bank syncs fail silently after a timeout. Retry them.",
              createdAt: t(20),
            } as TranscriptItem,
            tool("f2", "Read server/finance/sync.ts", "success", t(18)),
            tool("f3", "Edit server/finance/sync.ts", "success", t(15)),
            {
              kind: "message",
              id: "f4",
              role: "assistant",
              text: "Retries now back off 1, 4 and 16 minutes. The migration adds a `retry_count` column; I need your go-ahead to run it.",
              createdAt: t(12),
            } as TranscriptItem,
          ]
        : [
            {
              kind: "message",
              id: "g1",
              role: "user",
              text: "What changed?",
              createdAt: t(40),
            } as TranscriptItem,
            {
              kind: "message",
              id: "g2",
              role: "assistant",
              text: "Nothing yet on this chat. Ask for a change, a review or an answer.",
              createdAt: t(39),
            } as TranscriptItem,
          ];
  const history = busy && sessionId === "phone-design" ? demoHistory(now) : [];
  return { workspaceId, sessionId, transcript: [...history, ...items] };
}

export function demoAccountLimits(now: number) {
  return [
    {
      id: "claude-1",
      name: "Claude Max · georg",
      asOf: now,
      windows: [
        { label: "5-hour window", usedPercent: 92, resetsAt: now + 43 * 60_000 },
        { label: "Weekly", usedPercent: 61, resetsAt: now + 70 * 3_600_000 },
      ],
    },
    {
      id: "openai",
      name: "ChatGPT Pro",
      asOf: now,
      windows: [{ label: "5-hour window", usedPercent: 18, resetsAt: now + 3 * 3_600_000 }],
    },
  ];
}

export function demoUsageReport(now: number) {
  return {
    refreshedAt: now,
    totals: {
      input: 41_200_000,
      output: 2_900_000,
      cacheRead: 118_000_000,
      cacheWrite: 6_100_000,
      cost: 412.5,
      apiCost: 1893.4,
    },
    sessions: 214,
    models: [
      {
        key: "anthropic/claude-opus-5-5",
        label: "Claude Opus 5.5",
        tokens: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: 1 },
      },
    ],
  };
}

export const demoTurns = {
  state: "available",
  turns: [
    {
      checkpointId: "cp-2",
      checkoutId: "pegasus",
      entryIds: ["m3"],
      files: [
        { path: "apps/mobile/src/ui/Overlay.tsx", lines: { added: 412, removed: 0 } },
        { path: "apps/mobile/src/ui/SwipeRow.tsx", lines: { added: 168, removed: 0 } },
      ],
    },
    {
      checkpointId: "cp-1",
      checkoutId: "pegasus",
      entryIds: ["m1"],
      files: [{ path: "apps/mobile/src/theme.ts", lines: { added: 4, removed: 0 } }],
    },
  ],
};

export function demoReview(scopeKind: string) {
  return {
    state: "available",
    reviewId: `review-${scopeKind}`,
    scope: { kind: scopeKind },
    checkoutId: "pegasus",
    baseLabel: "main",
    headOid: "2b669af8",
    baseOid: "2b669af8",
    branchName: "main",
    coverage: { state: "complete", notes: [] },
    files: [
      {
        id: "f1",
        path: "apps/mobile/src/ui/Overlay.tsx",
        status: "added",
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        conflicted: false,
        reviewed: false,
        lines: { added: 412, removed: 0 },
      },
      {
        id: "f2",
        path: "apps/mobile/src/ui/SwipeRow.tsx",
        status: "untracked",
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        conflicted: false,
        reviewed: true,
        lines: { added: 168, removed: 0 },
      },
      {
        id: "f3",
        path: "apps/mobile/src/screens/ChatsScreen.tsx",
        status: "modified",
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        conflicted: false,
        reviewed: false,
        lines: { added: 96, removed: 141 },
      },
      {
        id: "f4",
        path: "apps/mobile/src/ui/NativeMenu.tsx",
        status: "deleted",
        hasStagedChanges: false,
        hasUnstagedChanges: true,
        conflicted: false,
        reviewed: false,
        lines: { added: 0, removed: 40 },
      },
    ],
  };
}

export const demoPatch = `diff --git a/apps/mobile/src/theme.ts b/apps/mobile/src/theme.ts
@@ -296,6 +296,10 @@ export const motion = {
   easeInOut: Easing.bezier(0.4, 0, 0.2, 1),
   /** Pressables shrink to this, like the desktop's :active. */
   pressScale: 0.97,
-  slow: 400,
+  /** Springs (Reanimated withSpring), critically damped. */
+  spring: { duration: 260, dampingRatio: 1 },
+  /** After a gesture that carried momentum. */
+  springFlick: { duration: 340, dampingRatio: 0.86 },
 } as const;
`;

export const demoGit = {
  state: "available",
  branch: "main",
  upstream: "origin/main",
  remote: "origin",
  ahead: 0,
  staged: 0,
  unstaged: 4,
  conflicted: 0,
  base: "main",
  aheadOfBase: 0,
  ghAvailable: true,
  pullRequest: null,
};
