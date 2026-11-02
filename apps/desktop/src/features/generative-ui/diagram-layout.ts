import type { DiagramEdge, DiagramNode } from "../../../contracts/generative-ui";

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 44;
const COLUMN_GAP = 64;
const ROW_GAP = 16;
const LANE_PADDING = 14;
const LANE_LABEL = 22;
const LANE_GAP = 12;

export interface PlacedNode extends DiagramNode {
  readonly x: number;
  readonly y: number;
}

export interface Lane {
  readonly name: string;
  readonly y: number;
  readonly height: number;
}

export interface DiagramLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly { readonly edge: DiagramEdge; readonly path: string; readonly mid: { x: number; y: number } }[];
  readonly lanes: readonly Lane[];
  readonly width: number;
  readonly height: number;
}

/**
 * A floorplan layout: each group is a horizontal lane (an area of the project) and columns follow
 * the flow, a node one column right of everything that points at it. Cycles are broken by
 * ignoring edges that point back. Deterministic, so the same spec always draws the same picture.
 */
export function layoutDiagram(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): DiagramLayout {
  const index = new Map(nodes.map((node, position) => [node.id, position]));
  const incoming = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of forwardEdges(nodes, edges)) incoming.get(edge.to)!.push(edge.from);

  const column = new Map<string, number>();
  const columnOf = (id: string, seen: Set<string>): number => {
    const known = column.get(id);
    if (known !== undefined) return known;
    seen.add(id);
    const parents = incoming.get(id)!.filter((parent) => !seen.has(parent));
    const value = parents.length ? Math.max(...parents.map((parent) => columnOf(parent, seen))) + 1 : 0;
    seen.delete(id);
    column.set(id, value);
    return value;
  };
  for (const node of nodes) columnOf(node.id, new Set());

  const groups = [...new Set(nodes.map((node) => node.group ?? ""))];
  const laned = groups.length > 1 || groups[0] !== "";
  const lanes: Lane[] = [];
  const placed: PlacedNode[] = [];
  let top = 0;
  for (const group of groups) {
    const members = nodes.filter((node) => (node.group ?? "") === group);
    // Within a lane, each column stacks its nodes in spec order.
    const rowsInColumn = new Map<number, number>();
    let rows = 0;
    const laneTop = top + (laned ? LANE_LABEL + LANE_PADDING : 0);
    for (const node of [...members].sort((a, b) => index.get(a.id)! - index.get(b.id)!)) {
      const col = column.get(node.id)!;
      const row = rowsInColumn.get(col) ?? 0;
      rowsInColumn.set(col, row + 1);
      rows = Math.max(rows, row + 1);
      placed.push({
        ...node,
        x: (laned ? LANE_PADDING : 0) + col * (NODE_WIDTH + COLUMN_GAP),
        y: laneTop + row * (NODE_HEIGHT + ROW_GAP),
      });
    }
    const height = (laned ? LANE_LABEL + LANE_PADDING * 2 : 0) + rows * NODE_HEIGHT + (rows - 1) * ROW_GAP;
    if (laned) lanes.push({ name: group || "Other", y: top, height });
    top += height + (laned ? LANE_GAP : 0);
  }

  const columns = Math.max(...placed.map((node) => column.get(node.id)!)) + 1;
  const width = (laned ? LANE_PADDING * 2 : 0) + columns * NODE_WIDTH + (columns - 1) * COLUMN_GAP;
  const at = new Map(placed.map((node) => [node.id, node]));
  return {
    nodes: placed,
    edges: edges.map((edge) => route(edge, at.get(edge.from)!, at.get(edge.to)!)),
    lanes,
    width,
    height: Math.max(NODE_HEIGHT, top - (laned ? LANE_GAP : 0)),
  };
}

/** Edges kept for column placement: any edge that would close a cycle is left out. */
function forwardEdges(nodes: readonly DiagramNode[], edges: readonly DiagramEdge[]): DiagramEdge[] {
  const out = new Map<string, DiagramEdge[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) if (edge.from !== edge.to) out.get(edge.from)?.push(edge);
  const state = new Map<string, "open" | "done">();
  const kept: DiagramEdge[] = [];
  const visit = (id: string) => {
    state.set(id, "open");
    for (const edge of out.get(id) ?? []) {
      const next = state.get(edge.to);
      if (next === "open") continue;
      kept.push(edge);
      if (next === undefined) visit(edge.to);
    }
    state.set(id, "done");
  };
  for (const node of nodes) if (!state.has(node.id)) visit(node.id);
  return kept;
}

/** A curve from the right edge of one box to the left edge of the next, or around for back edges. */
function route(edge: DiagramEdge, from: PlacedNode, to: PlacedNode) {
  const forward = to.x > from.x;
  const start = { x: from.x + (forward ? NODE_WIDTH : NODE_WIDTH / 2), y: from.y + (forward ? NODE_HEIGHT / 2 : NODE_HEIGHT) };
  const end = { x: forward ? to.x : to.x + NODE_WIDTH / 2, y: to.y + (forward ? NODE_HEIGHT / 2 : NODE_HEIGHT) };
  const bend = forward ? Math.max(24, (end.x - start.x) / 2) : 0;
  const drop = forward ? 0 : 36;
  const path = forward
    ? `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`
    : `M ${start.x} ${start.y} C ${start.x} ${start.y + drop}, ${end.x} ${end.y + drop}, ${end.x} ${end.y}`;
  return { edge, path, mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 + drop * 0.75 } };
}
