import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import type { DiagramNode, UiNode } from "../../../contracts/generative-ui";
import { layoutDiagram, NODE_HEIGHT, NODE_WIDTH } from "./diagram-layout";
import { useGenerativeUiHost } from "./generative-ui-view";

type DiagramSpec = Extract<UiNode, { type: "diagram" }>;

/** An agent's diagram: a node graph drawn as a floorplan, or Mermaid text drawn safely. */
export function DiagramView({
  node,
  inPanel = false,
}: {
  readonly node: DiagramSpec;
  readonly inPanel?: boolean;
}) {
  const host = useGenerativeUiHost();
  return (
    <figure className="generative-ui__diagram" data-testid="generative-ui-diagram">
      <figcaption className="generative-ui__diagram-head">
        {node.title ? <span className="generative-ui__label">{node.title}</span> : <span />}
        {!inPanel && host?.pinDiagram ? (
          <button
            type="button"
            className="generative-ui__diagram-pin"
            onClick={() => host.pinDiagram?.(node)}
          >
            Open in side panel
          </button>
        ) : null}
      </figcaption>
      {node.mermaid ? (
        <MermaidDiagram source={node.mermaid} />
      ) : (
        <GraphDiagram nodes={node.nodes ?? []} edges={node.edges ?? []} />
      )}
    </figure>
  );
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;

function GraphDiagram({
  nodes,
  edges,
}: {
  readonly nodes: readonly DiagramNode[];
  readonly edges: NonNullable<DiagramSpec["edges"]>;
}) {
  const layout = useMemo(() => layoutDiagram(nodes, edges), [nodes, edges]);
  const host = useGenerativeUiHost();
  const [selected, setSelected] = useState<string>();
  const [view, setView] = useState({ x: -12, y: -12, zoom: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const width = layout.width + 24;
  const height = layout.height + 24;
  const shown = selected ? layout.nodes.find((entry) => entry.id === selected) : undefined;

  const zoomBy = (factor: number) =>
    setView((current) => ({
      ...current,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current.zoom * factor)),
    }));
  const onWheel = (event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  };
  const onPointerDown = (event: PointerEvent) => {
    // No pointer capture: it would send the click to the canvas instead of the node under it.
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
  };
  const onPointerMove = (event: PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) start.moved = true;
    drag.current = { ...start, x: event.clientX, y: event.clientY };
    setView((current) => ({ ...current, x: current.x - dx / current.zoom, y: current.y - dy / current.zoom }));
  };
  const onPointerUp = () => {
    // A click after a drag would otherwise select the node under the pointer.
    setTimeout(() => (drag.current = null), 0);
  };

  return (
    <div className="generative-ui__graph">
      <div className="generative-ui__graph-tools">
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={() => setView({ x: -12, y: -12, zoom: 1 })}>
          Reset
        </button>
      </div>
      <svg
        className="generative-ui__graph-canvas"
        role="img"
        aria-label={`Diagram with ${layout.nodes.length} parts`}
        viewBox={`${view.x} ${view.y} ${width / view.zoom} ${height / view.zoom}`}
        // The frame takes the drawing's own shape, so a short diagram leaves no empty band.
        style={{ aspectRatio: `${width} / ${height}` }}
        preserveAspectRatio="xMinYMin meet"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker id="generative-ui-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" className="generative-ui__graph-arrow" />
          </marker>
        </defs>
        {layout.lanes.map((lane) => (
          <g key={lane.name} className="generative-ui__graph-lane">
            <rect x={0} y={lane.y} width={layout.width} height={lane.height} rx={12} />
            <text x={14} y={lane.y + 18}>
              {lane.name}
            </text>
          </g>
        ))}
        {layout.edges.map(({ edge, path, mid }, position) => (
          <g key={`${edge.from}-${edge.to}-${position}`} className="generative-ui__graph-edge">
            <path d={path} markerEnd="url(#generative-ui-arrow)" />
            {edge.label ? (
              <text x={mid.x} y={mid.y - 4} textAnchor="middle">
                {edge.label}
              </text>
            ) : null}
          </g>
        ))}
        {layout.nodes.map((entry) => (
          <g
            key={entry.id}
            className={`generative-ui__graph-node ${entry.id === selected ? "generative-ui__graph-node--selected" : ""}`}
            transform={`translate(${entry.x} ${entry.y})`}
            role="button"
            tabIndex={0}
            aria-label={entry.label}
            data-node-id={entry.id}
            onClick={() => {
              if (drag.current?.moved) return;
              setSelected((current) => (current === entry.id ? undefined : entry.id));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelected((current) => (current === entry.id ? undefined : entry.id));
              }
            }}
          >
            <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />
            <text x={NODE_WIDTH / 2} y={entry.kind ? 19 : NODE_HEIGHT / 2 + 4} textAnchor="middle">
              {clip(entry.label, 22)}
            </text>
            {entry.kind ? (
              <text className="generative-ui__graph-kind" x={NODE_WIDTH / 2} y={34} textAnchor="middle">
                {clip(entry.kind, 26)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      {shown ? (
        <div className="generative-ui__graph-details" data-testid="generative-ui-diagram-details">
          <div className="generative-ui__card-title">{shown.label}</div>
          {shown.group || shown.kind ? (
            <div className="generative-ui__card-subtitle">
              {[shown.group, shown.kind].filter(Boolean).join(" · ")}
            </div>
          ) : null}
          {shown.description ? <p className="generative-ui__text">{shown.description}</p> : null}
          <div className="generative-ui__graph-actions">
            {shown.path && host?.runAction ? (
              <button
                type="button"
                onClick={() => host.runAction?.({ type: "openFile", label: "Open file", path: shown.path! })}
              >
                Open {shown.path}
              </button>
            ) : null}
            {host?.runAction ? (
              <button
                type="button"
                onClick={() =>
                  host.runAction?.({
                    type: "composer",
                    label: "Explain this",
                    text: `Explain "${shown.label}"${shown.path ? ` (${shown.path})` : ""}: what it does and how it connects to the rest.`,
                  })
                }
              >
                Explain this
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function clip(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

let mermaidQueue: Promise<unknown> = Promise.resolve();
let mermaidCount = 0;

/**
 * Mermaid text drawn as SVG in strict mode: labels are escaped, click handlers and links are off,
 * and Mermaid sanitizes its own output. The library loads only when a diagram needs it.
 */
export function MermaidDiagram({ source }: { readonly source: string }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  const dark = typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  useEffect(() => {
    let live = true;
    const id = `generative-ui-mermaid-${(mermaidCount += 1)}`;
    // A reply still streaming changes the text every tick; draw once it rests.
    const wait = setTimeout(() => {
    // Mermaid keeps global state, so renders run one at a time.
    mermaidQueue = mermaidQueue.then(async () => {
      if (!live) return;
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "inherit",
        });
        const result = await mermaid.render(id, source);
        if (live) setSvg(result.svg);
      } catch (problem) {
        if (live) setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        document.getElementById(`d${id}`)?.remove();
      }
    });
    }, 300);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [source, dark]);
  if (error) {
    return (
      <div className="generative-ui__mermaid-error">
        <span className="generative-ui__error">This diagram could not be drawn: {error}</span>
        <pre className="generative-ui__code">{source}</pre>
      </div>
    );
  }
  if (!svg) return <div className="generative-ui__muted">Drawing diagram…</div>;
  // Mermaid's strict mode output, sanitized by Mermaid itself (DOMPurify).
  return (
    <div
      className="generative-ui__mermaid"
      data-testid="generative-ui-mermaid"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
