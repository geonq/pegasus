// The chat's subagents as the dock and the agents sheet show them. Pure, no React Native.
import type { OrchestrationChildThread } from "../../api/types.ts";

type Status = OrchestrationChildThread["status"];

export const AGENT_STATUS_LABELS: Record<Status, string> = {
  queued: "Queued",
  running: "Working",
  waiting: "Needs you",
  complete: "Done",
  failed: "Failed",
};

export type AgentGroupId = "needs" | "running" | "done";

export interface AgentGroup {
  readonly id: AgentGroupId;
  readonly title: string;
  readonly agents: readonly OrchestrationChildThread[];
}

const GROUP_OF: Record<Status, AgentGroupId> = {
  waiting: "needs",
  running: "running",
  queued: "running",
  complete: "done",
  failed: "done",
};

const GROUP_TITLES: Record<AgentGroupId, string> = {
  needs: "Needs you",
  running: "Running",
  done: "Done",
};

/** Needs you, Running, Done (failed ones too), newest first; empty groups left out. */
export function groupAgents(agents: readonly OrchestrationChildThread[]): AgentGroup[] {
  const newest = [...agents].sort(
    (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
  );
  return (["needs", "running", "done"] as const)
    .map((id) => ({
      id,
      title: GROUP_TITLES[id],
      agents: newest.filter((agent) => GROUP_OF[agent.status] === id),
    }))
    .filter((group) => group.agents.length > 0);
}

export interface AgentCounts {
  readonly total: number;
  /** Running or queued. */
  readonly running: number;
  readonly waiting: number;
  readonly failed: number;
}

export function countAgents(agents: readonly OrchestrationChildThread[]): AgentCounts {
  let running = 0;
  let waiting = 0;
  let failed = 0;
  for (const agent of agents) {
    if (agent.status === "running" || agent.status === "queued") running += 1;
    else if (agent.status === "waiting") waiting += 1;
    else if (agent.status === "failed") failed += 1;
  }
  return { total: agents.length, running, waiting, failed };
}

/** The pill's words, most urgent first after the total: "16 agents · 1 needs you · 3 running". */
export function agentSummaryParts(counts: AgentCounts): {
  readonly total: string;
  readonly parts: readonly {
    readonly text: string;
    readonly tone: "warning" | "danger" | "muted";
  }[];
} {
  const total = counts.total === 1 ? "1 agent" : `${counts.total} agents`;
  const parts: { text: string; tone: "warning" | "danger" | "muted" }[] = [];
  if (counts.waiting > 0) parts.push({ text: `${counts.waiting} needs you`, tone: "warning" });
  if (counts.running > 0) parts.push({ text: `${counts.running} running`, tone: "muted" });
  if (counts.failed > 0) parts.push({ text: `${counts.failed} failed`, tone: "danger" });
  if (parts.length === 0) parts.push({ text: "all done", tone: "muted" });
  return { total, parts };
}
