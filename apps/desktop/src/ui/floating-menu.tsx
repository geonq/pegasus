import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Gap kept between a menu and the window edge, in CSS pixels. */
const EDGE = 8;

/**
 * Where a menu of `size` opened at the pointer `at` must sit so it stays inside the viewport:
 * it opens down-right of the pointer and flips up or left when there is no room (like a native
 * context menu), then clamps to the window as a last resort.
 */
export function placeMenu(
  at: { readonly x: number; readonly y: number },
  size: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number } {
  const clamp = (value: number, max: number) => Math.max(EDGE, Math.min(value, max));
  let left = at.x;
  if (left + size.width > viewport.width - EDGE) left = at.x - size.width;
  let top = at.y;
  if (top + size.height > viewport.height - EDGE) top = at.y - size.height;
  return {
    left: clamp(left, viewport.width - size.width - EDGE),
    top: clamp(top, viewport.height - size.height - EDGE),
  };
}

/**
 * Renders a menu into document.body at the pointer, so no scrolling list, sidebar or panel with
 * overflow clipping can cut it off. Hidden for the first frame while it is measured.
 */
export function FloatingMenu({
  at,
  children,
  wrapRef,
}: {
  readonly at: { readonly x: number; readonly y: number };
  readonly children: ReactNode;
  readonly wrapRef?: RefObject<HTMLDivElement | null>;
}) {
  const local = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const node = local.current;
    if (!node) return;
    const place = () => {
      const rect = node.getBoundingClientRect();
      setPosition(
        placeMenu(
          at,
          { width: rect.width, height: rect.height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [at]);

  return createPortal(
    <div
      className="floating-menu"
      data-placed={position ? "true" : "false"}
      ref={(node) => {
        local.current = node;
        if (wrapRef) wrapRef.current = node;
      }}
      style={{
        left: position?.left ?? at.x,
        top: position?.top ?? at.y,
        visibility: position ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
