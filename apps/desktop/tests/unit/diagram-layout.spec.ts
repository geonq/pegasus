import { expect, test } from "@playwright/test";
import { layoutDiagram, NODE_HEIGHT, NODE_WIDTH } from "../../src/features/generative-ui/diagram-layout";

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + NODE_WIDTH && b.x < a.x + NODE_WIDTH && a.y < b.y + NODE_HEIGHT && b.y < a.y + NODE_HEIGHT;

test("flow runs left to right, areas are lanes, and a cycle still draws", () => {
  const layout = layoutDiagram(
    [
      { id: "ui", label: "Renderer", group: "App" },
      { id: "main", label: "Main", group: "App" },
      { id: "driver", label: "Driver", group: "Runtime" },
      { id: "pi", label: "pi SDK", group: "Runtime" },
    ],
    [
      { from: "ui", to: "main" },
      { from: "main", to: "driver" },
      { from: "driver", to: "pi" },
      { from: "pi", to: "main", label: "events" },
    ],
  );
  const x = Object.fromEntries(layout.nodes.map((node) => [node.id, node.x]));
  expect(x.ui! < x.main! && x.main! < x.driver! && x.driver! < x.pi!).toBe(true);
  expect(layout.lanes.map((lane) => lane.name)).toEqual(["App", "Runtime"]);
  const lane = (id: string) => layout.lanes.find((entry) => {
    const node = layout.nodes.find((item) => item.id === id)!;
    return node.y >= entry.y && node.y + NODE_HEIGHT <= entry.y + entry.height;
  })?.name;
  expect([lane("ui"), lane("driver")]).toEqual(["App", "Runtime"]);
  expect(layout.edges).toHaveLength(4);
  expect(layout.edges.every((edge) => edge.path.startsWith("M "))).toBe(true);
});

test("fifty nodes lay out without overlap, inside the canvas, in a few milliseconds", () => {
  const nodes = Array.from({ length: 50 }, (_, index) => ({
    id: `n${index}`,
    label: `Module ${index}`,
    group: `Area ${index % 5}`,
  }));
  const edges = nodes.slice(1).map((node, index) => ({ from: `n${Math.floor(index / 3)}`, to: node.id }));
  const started = performance.now();
  const layout = layoutDiagram(nodes, edges);
  expect(performance.now() - started).toBeLessThan(50);
  expect(layout.nodes).toHaveLength(50);
  for (const [index, a] of layout.nodes.entries()) {
    expect(a.x + NODE_WIDTH).toBeLessThanOrEqual(layout.width);
    expect(a.y + NODE_HEIGHT).toBeLessThanOrEqual(layout.height);
    for (const b of layout.nodes.slice(index + 1)) expect(overlaps(a, b), `${a.id} ${b.id}`).toBe(false);
  }
  // Same spec, same picture.
  expect(layoutDiagram(nodes, edges)).toEqual(layout);
});
