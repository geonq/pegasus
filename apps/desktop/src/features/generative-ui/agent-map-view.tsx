import type { UiNode } from "../../../contracts/generative-ui";

/** Placeholder until the agent map lands: the agents as a list. */
export function AgentMapView({ node }: { readonly node: Extract<UiNode, { type: "agent_map" }> }) {
  return (
    <div className="generative-ui__agent-map" data-testid="generative-ui-agent-map">
      {node.title ? <div className="generative-ui__label">{node.title}</div> : null}
      <ul>
        {node.agents.map((agent) => (
          <li key={agent.id}>
            {agent.label} · {agent.status}
          </li>
        ))}
      </ul>
    </div>
  );
}
