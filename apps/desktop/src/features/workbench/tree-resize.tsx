import type { CSSProperties } from "react";
import { PaneResizeHandle, type PaneWidthBounds } from "../../ui/pane-resize-handle";
import { usePersistedPaneWidth } from "../../ui/use-persisted-pane-width";

const TREE_RANGE = { min: 160, max: 720 } as const;
const TREE_DEFAULT = 220;

/** The tree may take whatever leaves `reserve` px for the editor or diff beside it. */
function treeBounds(reserve: number) {
  return (_tree: HTMLElement, container: HTMLElement): PaneWidthBounds => ({
    min: TREE_RANGE.min,
    max: Math.max(TREE_RANGE.min, Math.min(TREE_RANGE.max, container.clientWidth - reserve)),
  });
}

/** Persisted width of a file tree column; `style` goes on the tree element (CSS reads `--tree-width`). */
export function useTreeWidth(storageKey: string) {
  const [width, setWidth] = usePersistedPaneWidth(storageKey, TREE_RANGE);
  const style: CSSProperties & { "--tree-width": string } = {
    "--tree-width": `${width ?? TREE_DEFAULT}px`,
  };
  return { style, setWidth, reset: () => setWidth(undefined) };
}

/** Drag handle on the left edge of a file tree; the tree must be its grid's last column. */
export function TreeResizeHandle({
  label,
  controls,
  reserve,
  onResize,
  onReset,
}: {
  /** Width in px that must stay free for the content beside the tree. */
  readonly reserve: number;
  readonly label: string;
  readonly controls: string;
  readonly onResize: (width: number) => void;
  readonly onReset: () => void;
}) {
  return (
    <PaneResizeHandle
      className="tree-resize-handle"
      label={label}
      controls={controls}
      edge="left"
      bounds={treeBounds(reserve)}
      onResize={onResize}
      onReset={onReset}
      cssVar="--tree-width"
      cssVarOn="pane"
    />
  );
}
