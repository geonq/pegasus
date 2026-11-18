import { PaneResizeHandle, type PaneWidthBounds } from "../../ui/pane-resize-handle";

function workbenchBounds(_panel: HTMLElement, main: HTMLElement): PaneWidthBounds {
  const max = Math.floor(Math.min(1200, main.clientWidth * (window.innerWidth <= 980 ? 1 : 0.65)));
  return { min: 320, max };
}

/** The floating side panel is pinned to the top-right; its bottom edge can be pulled up. */
function workbenchHeightBounds(panel: HTMLElement, main: HTMLElement): PaneWidthBounds {
  const top = panel.getBoundingClientRect().top - main.getBoundingClientRect().top;
  const gap = Number.parseFloat(getComputedStyle(main).getPropertyValue("--float-gap")) || 0;
  return { min: 280, max: Math.max(280, Math.floor(main.clientHeight - top - gap)) };
}

export function WorkbenchResizeHandle({
  onResize,
  onResizeHeight,
}: {
  readonly onResize: (width: number) => void;
  readonly onResizeHeight?: (height: number | undefined) => void;
}) {
  return (
    <>
      <PaneResizeHandle
        className="workbench__resize-handle"
        label="Side panel width"
        controls="task-workbench"
        edge="left"
        bounds={workbenchBounds}
        onResize={onResize}
        cssVar="--workbench-width"
      />
      {onResizeHeight ? (
        <PaneResizeHandle
          className="workbench__resize-handle workbench__resize-handle--bottom"
          label="Side panel height"
          controls="task-workbench"
          edge="bottom"
          bounds={workbenchHeightBounds}
          onResize={onResizeHeight}
          onReset={() => onResizeHeight(undefined)}
          cssVar="--workbench-height"
        />
      ) : null}
    </>
  );
}
