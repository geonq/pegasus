import { sessionKey } from "@pi-gui/session-driver";
import type { DesktopAppState } from "../../contracts/desktop-state";

/** The one remote device allowed to see running threads across all workspaces. */
export const ACTIVE_RUNS_CLIENT_ID = "seher-server";

export type ActiveRunStatus = "running" | "tool" | "waiting";

/**
 * One running thread, as the Seher server shows it. Only identifiers, the model and the
 * workspace's display name leave the host: never a title, prompt, preview, tool label or path.
 */
export interface ActiveRun {
  readonly threadId: string;
  readonly provider: string;
  readonly accountLabel: string;
  readonly model: string;
  readonly workspaceName: string;
  readonly status: ActiveRunStatus;
  readonly startedAt: string;
  readonly lastEventAt: string;
}

/**
 * Answer a remote device's getActiveRuns. It is host-wide, so it bypasses the device's workspace
 * scope; only the Seher server's client may ask.
 */
export function answerActiveRuns(
  clientId: string,
  getActiveRuns: (() => readonly ActiveRun[]) | undefined,
): readonly ActiveRun[] {
  if (clientId !== ACTIVE_RUNS_CLIENT_ID || !getActiveRuns) {
    throw new TypeError("Remote method is not allowed.");
  }
  return getActiveRuns();
}

/** Running threads across every workspace, from in-memory state only (no disk reads). */
export function mapActiveRuns(
  state: Readonly<DesktopAppState>,
  accountNames: ReadonlyMap<string, string>,
): readonly ActiveRun[] {
  const workspaceNames = new Map(
    state.workspaces.map((workspace) => [workspace.id, workspace.name]),
  );
  const runs: ActiveRun[] = [];
  for (const workspace of state.workspaces) {
    // A worktree reports under its project's name, not its generated folder name.
    const workspaceName =
      (workspace.rootWorkspaceId && workspaceNames.get(workspace.rootWorkspaceId)) ||
      workspace.name;
    for (const session of workspace.sessions) {
      if (session.status !== "running") continue;
      const key = sessionKey({ workspaceId: workspace.id, sessionId: session.id });
      const waiting = (state.sessionExtensionUiBySession[key]?.pendingDialogs.length ?? 0) > 0;
      const provider = session.config?.provider ?? "";
      const startedAt = session.runningSince ?? session.updatedAt;
      runs.push({
        threadId: session.id,
        provider,
        accountLabel: accountNames.get(provider) ?? provider,
        model: session.config?.modelId ?? "",
        workspaceName,
        status: waiting ? "waiting" : session.currentStep ? "tool" : "running",
        startedAt,
        lastEventAt:
          Date.parse(session.updatedAt) > Date.parse(startedAt) ? session.updatedAt : startedAt,
      });
    }
  }
  return runs;
}
