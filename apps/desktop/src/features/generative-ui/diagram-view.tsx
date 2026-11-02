import type { UiNode } from "../../../contracts/generative-ui";

/** Placeholder until the diagram renderer lands: the diagram's nodes as a list. */
export function DiagramView({ node }: { readonly node: Extract<UiNode, { type: "diagram" }> }) {
  return (
    <div className="generative-ui__diagram" data-testid="generative-ui-diagram">
      {node.title ? <div className="generative-ui__label">{node.title}</div> : null}
      {node.mermaid ? <pre className="generative-ui__code">{node.mermaid}</pre> : null}
      <ul>
        {(node.nodes ?? []).map((entry) => (
          <li key={entry.id}>{entry.label}</li>
        ))}
      </ul>
    </div>
  );
}
