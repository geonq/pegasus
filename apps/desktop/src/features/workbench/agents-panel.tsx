import { useEffect, useState } from "react";
import type { DesktopAppState, SessionRecord } from "../../../contracts/desktop-state";
import { StateOrb } from "../../app/activity-indicator";

export interface SessionTarget {
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface AgentCard {
  readonly key: string;
  readonly title: string;
  readonly status: string;
  readonly target: SessionTarget;
  readonly parentKey?: string;
  readonly role?: string;
  readonly model?: string;
  readonly step?: string;
  readonly runningSince?: string;
  readonly files: readonly string[];
  readonly workspaceName: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: "Working",
  queued: "Queued",
  waiting: "Waiting",
  failed: "Failed",
  complete: "Done",
  idle: "Idle",
};
const RANK: Record<string, number> = { running: 0, waiting: 1, queued: 2, failed: 3, complete: 4, idle: 5 };
const ACTIVE = new Set(["running", "waiting", "queued"]);
const ROLE = /\[(?:PI|HERMES)_CHILD_ROLE=(\w+)\]/i;
const keyOf = (target: SessionTarget) => `${target.workspaceId}/${target.sessionId}`;

/**
 * Who is working on what: every agent with its parent chat, role, model, current step and the
 * files it changed. Children come from the orchestration owner; a chat counts when it works, failed,
 * or started agents.
 */
export function agentCards(snapshot: DesktopAppState): AgentCard[] {
  const sessions = new Map<string, { session: SessionRecord; workspaceName: string; workspaceId: string }>();
  for (const workspace of snapshot.workspaces) {
    for (const session of workspace.sessions) {
      sessions.set(`${workspace.id}/${session.id}`, { session, workspaceName: workspace.name, workspaceId: workspace.id });
    }
  }
  const card = (key: string, extra: Partial<AgentCard> & Pick<AgentCard, "title" | "status" | "target">): AgentCard => {
    const entry = sessions.get(key);
    return {
      key,
      files: entry?.session.touchedFiles ?? [],
      workspaceName: entry?.workspaceName ?? "",
      ...(entry?.session.config?.modelId ? { model: entry.session.config.modelId } : {}),
      ...(entry?.session.currentStep ? { step: entry.session.currentStep } : {}),
      ...(entry?.session.runningSince && entry.session.status === "running"
        ? { runningSince: entry.session.runningSince }
        : {}),
      ...extra,
    };
  };
  const children = snapshot.orchestrationChildren.map((child) => {
    const target = { workspaceId: child.childWorkspaceId, sessionId: child.childSessionId };
    const role = child.role ?? ROLE.exec(child.goal)?.[1]?.toLowerCase();
    return card(keyOf(target), {
      title: child.title,
      status: child.status,
      target,
      parentKey: `${child.parentWorkspaceId}/${child.parentSessionId}`,
      ...(role ? { role } : {}),
    });
  });
  const childKeys = new Set(children.map((child) => child.key));
  const parentKeys = new Set(children.map((child) => child.parentKey!));
  const threads = [...sessions.entries()]
    .filter(([key, { session }]) =>
      !childKeys.has(key) &&
      !session.archivedAt &&
      (session.status !== "idle" || parentKeys.has(key)),
    )
    .map(([key, { session, workspaceId }]) =>
      card(key, { title: session.title, status: session.status, target: { workspaceId, sessionId: session.id } }),
    );
  return [...threads, ...children];
}

/** Agents grouped by the folder their changes landed in; an area two agents changed is a likely conflict. */
export function agentAreas(cards: readonly AgentCard[]): { readonly area: string; readonly agents: readonly AgentCard[] }[] {
  const byArea = new Map<string, AgentCard[]>();
  for (const agent of cards) {
    for (const area of new Set(agent.files.map(areaOf))) {
      byArea.set(area, [...(byArea.get(area) ?? []), agent]);
    }
  }
  return [...byArea.entries()]
    .map(([area, agents]) => ({ area, agents }))
    .sort((a, b) => b.agents.length - a.agents.length || a.area.localeCompare(b.area));
}

/** The folder a change belongs to: its first two folders, or the project root. */
function areaOf(file: string): string {
  const parts = file.split("/").filter((part) => part && part !== ".");
  const folders = parts.slice(0, -1);
  return folders.length ? folders.slice(0, 2).join("/") : "(project root)";
}

function elapsed(since: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function AgentsPanel({
  snapshot,
  onSelect,
  onStop,
}: {
  readonly snapshot: DesktopAppState;
  readonly onSelect: (target: SessionTarget) => void;
  readonly onStop?: (target: SessionTarget) => void;
}) {
  const [view, setView] = useState<"team" | "areas">("team");
  const [now, setNow] = useState(() => Date.now());
  const cards = agentCards(snapshot).sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9));
  const working = cards.filter((card) => card.status === "running" || card.status === "waiting").length;
  const queued = cards.filter((card) => card.status === "queued").length;
  const anyRunning = cards.some((card) => card.runningSince);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  const byKey = new Set(cards.map((card) => card.key));
  // A child whose parent is not listed stands at the top level.
  const roots = cards.filter((card) => !card.parentKey || !byKey.has(card.parentKey));
  const childrenOf = (key: string) => cards.filter((card) => card.parentKey === key);
  const areas = agentAreas(cards);

  const renderCard = (card: AgentCard, depth: number) => (
    <li key={card.key}>
      <div className="agents-panel__card" style={{ marginLeft: depth * 16 }} data-testid="agents-panel-card" data-status={card.status}>
        <button className="agents-panel__row" type="button" onClick={() => onSelect(card.target)}>
          {ACTIVE.has(card.status) ? (
            <StateOrb state="working" />
          ) : (
            <span aria-hidden="true" className={`agents-panel__dot agents-panel__dot--${card.status}`} />
          )}
          <span className="agents-panel__text">
            <span className="agents-panel__title" title={card.title}>
              {card.title}
            </span>
            <span className="agents-panel__detail">
              {[card.role, card.model, card.parentKey ? undefined : card.workspaceName]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {card.step ? <span className="agents-panel__step">{card.step}</span> : null}
          </span>
          <span className="agents-panel__status">
            {STATUS_LABEL[card.status] ?? card.status}
            {card.runningSince ? ` · ${elapsed(card.runningSince, now)}` : ""}
          </span>
        </button>
        {card.status === "running" && onStop ? (
          <button type="button" className="agents-panel__stop" onClick={() => onStop(card.target)} aria-label={`Stop ${card.title}`}>
            Stop
          </button>
        ) : null}
      </div>
      {depth < 4 && childrenOf(card.key).length ? (
        <ul className="agents-panel__list">{childrenOf(card.key).map((child) => renderCard(child, depth + 1))}</ul>
      ) : null}
    </li>
  );

  return (
    <div className="agents-panel">
      <div className="agents-panel__head">
        <p className="agents-panel__summary" aria-live="polite">
          {working ? `${working} working` : "Nothing is working"}
          {queued ? ` · ${queued} queued` : ""}
          {cards.length ? ` · ${cards.length} total` : ""}
        </p>
        <div className="agents-panel__views" role="tablist" aria-label="Agents view">
          <button type="button" role="tab" aria-selected={view === "team"} onClick={() => setView("team")}>
            Team
          </button>
          <button type="button" role="tab" aria-selected={view === "areas"} onClick={() => setView("areas")}>
            By area
          </button>
        </div>
      </div>
      {view === "team" ? (
        <ul className="agents-panel__list">{roots.map((card) => renderCard(card, 0))}</ul>
      ) : areas.length === 0 ? (
        <p className="agents-panel__summary">No agent has changed files yet.</p>
      ) : (
        <ul className="agents-panel__areas" data-testid="agents-panel-areas">
          {areas.map(({ area, agents }) => (
            <li key={area} className={`agents-panel__area ${agents.length > 1 ? "agents-panel__area--overlap" : ""}`}>
              <div className="agents-panel__area-name">
                {area}
                {agents.length > 1 ? <span className="agents-panel__overlap">{agents.length} agents · possible conflict</span> : null}
              </div>
              <ul className="agents-panel__area-agents">
                {agents.map((agent) => (
                  <li key={agent.key}>
                    <button type="button" className="agents-panel__chip" onClick={() => onSelect(agent.target)}>
                      {agent.title}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
