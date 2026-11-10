import { useEffect, useRef, useState } from "react";

export interface PaneWidthBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Drag and keyboard handle on one vertical edge of a pane. The handle must be a
 * direct child of the pane; `bounds` receives the pane and the pane's parent.
 * `edge` is the pane edge the handle sits on, so dragging away from the pane widens it.
 */
export function PaneResizeHandle({
  className,
  label,
  controls,
  edge,
  bounds,
  onResize,
  onReset,
  cssVar,
  cssVarOn = "container",
}: {
  readonly className: string;
  readonly label: string;
  readonly controls: string;
  readonly edge: "left" | "right";
  readonly bounds: (pane: HTMLElement, container: HTMLElement) => PaneWidthBounds;
  readonly onResize: (width: number) => void;
  readonly onReset?: () => void;
  /**
   * CSS custom property that carries this pane's width. When set, a pointer drag writes it straight
   * to the DOM (one write per animation frame) and calls `onResize` once on release, so the app
   * does not re-render on every pointermove. `cssVarOn` is the element React sets it on.
   */
  readonly cssVar?: string;
  readonly cssVarOn?: "pane" | "container";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;
  const frame = useRef<{ raf: number; width: number } | null>(null);
  const remeasure = useRef<() => void>(() => {});
  const [size, setSize] = useState({ width: 0, min: 0, max: 0 });
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const pane = ref.current?.parentElement;
    const container = pane?.parentElement;
    if (!pane || !container) return;
    const measure = () => {
      // A live drag moves the pane every frame; the readout catches up when it ends.
      if (drag.current) return;
      const { min, max } = boundsRef.current(pane, container);
      setSize({
        width: Math.round(pane.getBoundingClientRect().width),
        min: Math.min(min, max),
        max,
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(container);
    measure();
    remeasure.current = measure;
    return () => observer.disconnect();
  }, []);

  const liveTarget = () => {
    const pane = ref.current?.parentElement;
    return cssVarOn === "pane" ? pane : pane?.parentElement;
  };
  const applyLive = (width: number) => liveTarget()?.style.setProperty(cssVar!, `${width}px`);
  // Ends a drag: stops the pending frame and commits the last previewed width to app state.
  const commit = () => {
    drag.current = null;
    setResizing(false);
    window.requestAnimationFrame(() => remeasure.current());
    const pending = frame.current;
    if (!pending) return;
    if (pending.raf) window.cancelAnimationFrame(pending.raf);
    frame.current = null;
    applyLive(pending.width);
    onResize(pending.width);
  };
  const widen = edge === "right" ? 1 : -1;
  const resize = (width: number) => onResize(Math.max(size.min, Math.min(size.max, width)));
  // `size.width` follows the pane through a ResizeObserver, so it can lag a resize that has just
  // been applied; steps and drags start from the width on screen now.
  const currentWidth = () =>
    Math.round(ref.current?.parentElement?.getBoundingClientRect().width ?? size.width);
  return (
    <div
      ref={ref}
      className={className}
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      aria-controls={controls}
      aria-valuemin={size.min}
      aria-valuemax={size.max}
      aria-valuenow={size.width}
      tabIndex={0}
      data-resizing={resizing}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        if (document.activeElement === event.currentTarget) event.currentTarget.blur();
        event.currentTarget.setPointerCapture(event.pointerId);
        const startWidth = currentWidth();
        drag.current = { pointerId: event.pointerId, x: event.clientX, width: startWidth };
        // A live variable left from the last drag must not show before the first frame.
        if (cssVar) applyLive(startWidth);
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const width = start.width + widen * (event.clientX - start.x);
        if (!cssVar) return resize(width);
        const clamped = Math.max(size.min, Math.min(size.max, width));
        const live = frame.current ?? (frame.current = { raf: 0, width: clamped });
        live.width = clamped;
        if (!live.raf)
          live.raf = window.requestAnimationFrame(() => {
            live.raf = 0;
            applyLive(live.width);
          });
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        commit();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={commit}
      onLostPointerCapture={commit}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowRight"
            ? currentWidth() + widen * 20
            : event.key === "ArrowLeft"
              ? currentWidth() - widen * 20
              : event.key === "Home"
                ? size.min
                : event.key === "End"
                  ? size.max
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        resize(next);
      }}
    />
  );
}
