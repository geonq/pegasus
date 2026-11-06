import type { AgentMapEntry, UiNode } from "../../../contracts/generative-ui";
import { CHECK_MARKS, useGenerativeUiHost } from "./generative-ui-view";

/**
 * The agent's plan of who does what: a tree of agents (parent → children) with their role and
 * status. An entry linked to a child thread follows that thread live and opens it on click.
 */
export function AgentMapView({ node }: { readonly node: Extract<UiNode, { type: "agent_map" }> }) {
  const host = useGenerativeUiHost();
  const ids = new Set(node.agents.map((agent) => agent.id));
  const roots = node.agents.filter((agent) => !agent.parent || !ids.has(agent.parent));
  const children = (id: string) => node.agents.filter((agent) => agent.parent === id);
  const done = node.agents.filter((agent) => statusOf(agent) === "done").length;

  function statusOf(agent: AgentMapEntry) {
    return (agent.threadId && host?.threadStatus?.(agent.threadId)) || agent.status;
  }

  const renderAgent = (agent: AgentMapEntry, depth: number, seen: Set<string>) => {
    if (seen.has(agent.id)) return null;
    const next = new Set(seen).add(agent.id);
    const status = statusOf(agent);
    const open =
      agent.threadId && host?.runAction
        ? () =>
            host.runAction?.({ type: "openThread", label: agent.label, sessionId: agent.threadId! })
        : undefined;
    return (
      <li key={agent.id}>
        <div
          className={`generative-ui__agent generative-ui__agent--${status}`}
          style={{ marginLeft: depth * 18 }}
          data-testid="generative-ui-agent"
          data-status={status}
        >
          <span className="generative-ui__check-mark" aria-label={status}>
            {CHECK_MARKS[status]}
          </span>
          <span className="generative-ui__agent-text">
            {open ? (
              <button type="button" className="generative-ui__agent-link" onClick={open}>
                {agent.label}
              </button>
            ) : (
              <span className="generative-ui__agent-label">{agent.label}</span>
            )}
            {agent.role || agent.note ? (
              <span className="generative-ui__check-note">
                {[agent.role, agent.note].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </span>
        </div>
        {children(agent.id).length ? (
          <ul>{children(agent.id).map((child) => renderAgent(child, depth + 1, next))}</ul>
        ) : null}
      </li>
    );
  };

  return (
    <div className="generative-ui__agent-map" data-testid="generative-ui-agent-map">
      <div className="generative-ui__label">
        {node.title ?? "Agents"}{" "}
        <span className="generative-ui__muted">
          {done} of {node.agents.length} done
        </span>
      </div>
      <ul>{roots.map((agent) => renderAgent(agent, 0, new Set()))}</ul>
    </div>
  );
}
