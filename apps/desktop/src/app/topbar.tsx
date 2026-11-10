import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { AppView, WorkspaceRecord, WorktreeRecord } from "../../contracts/desktop-state";
import { getSidePanelToggleShortcutLabel, type PiDesktopApi } from "../../contracts/ipc";
import { SidePanelIcon } from "../ui/icons";

interface TopbarProps {
  readonly activeView: AppView;
  readonly sessionTitle?: string;
  readonly children?: ReactNode;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly selectedWorkspace: WorkspaceRecord | undefined;
  readonly selectedWorktree: WorktreeRecord | undefined;
  readonly api: PiDesktopApi;
  readonly panelAvailable: boolean;
  readonly panelVisible: boolean;
  readonly onTogglePanel: () => void;
}

export function Topbar({
  activeView,
  sessionTitle,
  children,
  rootWorkspace,
  selectedWorkspace,
  selectedWorktree,
  api,
  panelAvailable,
  panelVisible,
  onTogglePanel,
}: TopbarProps) {
  const handleDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(".topbar__actions")) return;
    void api.toggleWindowMaximize().catch((error: unknown) => {
      console.error("[renderer] toggleWindowMaximize failed", error);
    });
  };
  const checkoutLabel =
    selectedWorkspace?.kind === "worktree"
      ? (selectedWorktree?.name ?? selectedWorkspace.branchName ?? selectedWorkspace.name)
      : selectedWorkspace?.branchName;

  return (
    <header className="topbar" data-testid="topbar" onDoubleClick={handleDoubleClick}>
      <div className="topbar__title">
        <span
          className="topbar__workspace"
          title={checkoutLabel ? `${rootWorkspace?.name ?? ""} · ${checkoutLabel}` : undefined}
        >
          {rootWorkspace ? rootWorkspace.name : "Open a folder to begin"}
        </span>
        {sessionTitle ? (
          <>
            <span aria-hidden="true" className="topbar__separator">
              /
            </span>
            <h1 className="chat-header__title" title={sessionTitle}>
              {sessionTitle}
            </h1>
          </>
        ) : activeView === "threads" && checkoutLabel ? (
          <>
            <span aria-hidden="true" className="topbar__separator">
              /
            </span>
            <span className="topbar__session">{checkoutLabel}</span>
          </>
        ) : activeView === "new-thread" && rootWorkspace ? (
          <>
            <span aria-hidden="true" className="topbar__separator">
              /
            </span>
            <span className="topbar__session">New thread</span>
          </>
        ) : null}
        <WorktreeSetupStatus api={api} rootWorkspace={rootWorkspace} worktree={selectedWorktree} />
      </div>
      <div className="topbar__actions">
        {children}
        {!panelVisible ? (
          <div className="shortcut-tooltip-wrap topbar__tooltip-wrap">
            <button
              type="button"
              aria-label="Toggle side panel"
              aria-pressed="false"
              aria-controls="task-workbench"
              data-testid="toggle-side-panel"
              className="icon-button topbar__icon"
              disabled={!panelAvailable}
              onClick={onTogglePanel}
            >
              <SidePanelIcon />
            </button>
            <span className="shortcut-tooltip topbar__tooltip" role="tooltip">
              <span>Show side panel</span>
              <kbd>{getSidePanelToggleShortcutLabel(api.platform)}</kbd>
            </span>
          </div>
        ) : null}
      </div>
    </header>
  );
}

/** Progress, approval prompt or error for a new worktree's background setup; absent once it is done. */
function WorktreeSetupStatus({
  api,
  rootWorkspace,
  worktree,
}: {
  readonly api: PiDesktopApi;
  readonly rootWorkspace: WorkspaceRecord | undefined;
  readonly worktree: WorktreeRecord | undefined;
}) {
  const setup = worktree?.setup;
  if (!setup || !worktree || !rootWorkspace) return null;
  const approve = () => {
    void api
      .approveWorktreeSetup({ workspaceId: rootWorkspace.id, worktreeId: worktree.id })
      .catch((error: unknown) => console.error("[renderer] approveWorktreeSetup failed", error));
  };
  return (
    <span
      className={`topbar__setup topbar__setup--${setup.state}`}
      data-testid="worktree-setup-status"
      role="status"
      aria-live="polite"
    >
      {setup.state === "running" ? (
        <span className="topbar__setup-text">{setup.step}</span>
      ) : setup.state === "failed" ? (
        <span className="topbar__setup-text" title={setup.message}>
          Setup failed: {setup.message}
        </span>
      ) : (
        <>
          <span className="topbar__setup-text" title={setup.command} translate="no">
            Setup not run: {firstLine(setup.command)}
          </span>
          <button type="button" className="button button--ghost" onClick={approve}>
            Run setup command
          </button>
        </>
      )}
    </span>
  );
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0] ?? "";
}
