import type { CSSProperties } from "react";
import { usePersistedPaneWidth } from "../../ui/use-persisted-pane-width";

/**
 * Window layout preferences shared by all tools and tasks, independent of their contents: the
 * floating side panel's width and, when the owner pulled its bottom edge up, its height.
 */
export function useWorkbenchWidth() {
  const [width, setWidth] = usePersistedPaneWidth("pi-gui.workbench-width", {
    min: 320,
    max: 1200,
  });
  const [height, setHeight] = usePersistedPaneWidth("pi-gui.workbench-height", {
    min: 280,
    max: 4000,
  });
  const style = {
    "--workbench-width": `${width ?? 440}px`,
    ...(height === undefined ? {} : { "--workbench-height": `${height}px` }),
  } as CSSProperties;
  return { style, setWidth, setHeight };
}
