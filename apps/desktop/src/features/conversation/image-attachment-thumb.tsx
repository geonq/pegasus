import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { trapDialogFocus } from "../../ui/dialog-focus";
import { ChevronRightIcon, CloseIcon } from "../../ui/icons";

interface ImageAttachmentThumbProps {
  readonly src: string;
  readonly name: string;
  readonly className: string;
}

interface GalleryImage {
  readonly src: string;
  readonly name: string;
}

/**
 * Every image thumbnail of the chat the opened one sits in, in reading order, so the viewer can
 * step through them. Read from the DOM at open time; images outside the chat (the composer)
 * only see themselves.
 */
function galleryAround(
  trigger: HTMLButtonElement | null,
  current: GalleryImage,
): { images: GalleryImage[]; index: number } {
  const thumbs = Array.from(
    trigger
      ?.closest("[data-testid='transcript']")
      ?.querySelectorAll<HTMLButtonElement>("button.image-attachment-thumb") ?? [],
  );
  const index = trigger ? thumbs.indexOf(trigger) : -1;
  if (index < 0) return { images: [current], index: 0 };
  const images = thumbs.map((thumb) => {
    const img = thumb.querySelector("img");
    return { src: img?.getAttribute("src") ?? "", name: img?.getAttribute("alt") ?? "" };
  });
  return { images, index };
}

/** Image attachment thumbnail that opens the full image in a focused viewer when clicked. */
export function ImageAttachmentThumb({ src, name, className }: ImageAttachmentThumbProps) {
  const [gallery, setGallery] = useState<{ images: GalleryImage[]; index: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        aria-label={`View ${name}`}
        className={`image-attachment-thumb ${className}`}
        ref={triggerRef}
        title={name}
        type="button"
        onClick={() => setGallery(galleryAround(triggerRef.current, { src, name }))}
      >
        <img alt={name} src={src} />
      </button>
      {gallery ? (
        <ImageViewer
          images={gallery.images}
          startIndex={gallery.index}
          onClose={() => {
            setGallery(null);
            triggerRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

const MAX_ZOOM = 8;

/**
 * Zoom and pan live in a ref and are written straight to the image's style: a wheel tick or a
 * drag fires dozens of times a second and must not re-render React or animate (it tracks 1:1).
 */
function ImageViewer({
  images,
  startIndex,
  onClose,
}: {
  readonly images: readonly GalleryImage[];
  readonly startIndex: number;
  readonly onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const view = useRef({ zoom: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const [index, setIndex] = useState(startIndex);
  const count = images.length;
  const image = images[index] ?? images[0];

  const apply = () => {
    const node = imageRef.current;
    if (!node) return;
    const { zoom, x, y } = view.current;
    node.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    node.dataset.zoom = zoom.toFixed(3);
    node.style.cursor = zoom > 1 ? (pointers.current.size ? "grabbing" : "grab") : "zoom-in";
    if (badgeRef.current) {
      badgeRef.current.hidden = zoom <= 1;
      badgeRef.current.textContent = `${Math.round(zoom * 100)}%`;
    }
  };

  /** Zooms toward a viewport point so the spot under the pointer stays put. */
  const zoomTo = (target: number, at?: { x: number; y: number }) => {
    const current = view.current;
    const zoom = Math.min(MAX_ZOOM, Math.max(1, target));
    if (zoom === 1) {
      view.current = { zoom: 1, x: 0, y: 0 };
    } else {
      const rect = imageRef.current?.getBoundingClientRect();
      const ratio = zoom / current.zoom;
      view.current = {
        zoom,
        x: rect && at ? current.x + (at.x - (rect.left + rect.width / 2)) * (1 - ratio) : current.x,
        y: rect && at ? current.y + (at.y - (rect.top + rect.height / 2)) * (1 - ratio) : current.y,
      };
    }
    apply();
  };

  const show = (next: number) => {
    if (count < 2) return;
    view.current = { zoom: 1, x: 0, y: 0 };
    setIndex((next + count) % count);
  };

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLButtonElement>(".image-viewer__close")?.focus();
  }, []);
  useEffect(apply, [index]);

  // React's onWheel is passive; zooming must stop the page behind from scrolling.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025));
      zoomTo(view.current.zoom * factor, { x: event.clientX, y: event.clientY });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      trapDialogFocus(event, dialogRef.current);
      return;
    }
    const handled = {
      Escape: onClose,
      ArrowRight: () => show(index + 1),
      ArrowLeft: () => show(index - 1),
      "+": () => zoomTo(view.current.zoom * 1.5),
      "=": () => zoomTo(view.current.zoom * 1.5),
      "-": () => zoomTo(view.current.zoom / 1.5),
      "0": () => zoomTo(1),
    }[event.key];
    if (!handled) return;
    event.preventDefault();
    event.stopPropagation();
    handled();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a!.x - b!.x, a!.y - b!.y), zoom: view.current.zoom };
    }
    apply();
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      zoomTo((pinch.current.zoom * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.current.distance, {
        x: (a!.x + b!.x) / 2,
        y: (a!.y + b!.y) / 2,
      });
    } else if (view.current.zoom > 1 && pointers.current.size === 1) {
      view.current.x += event.clientX - previous.x;
      view.current.y += event.clientY - previous.y;
      apply();
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLImageElement>) => {
    pointers.current.delete(event.pointerId);
    pinch.current = null;
    apply();
  };

  /** Double-click toggles between fitting the window and the image's own pixel size (100%). */
  const toggleActualSize = (event: { clientX: number; clientY: number }) => {
    const node = imageRef.current;
    if (!node) return;
    if (view.current.zoom > 1) return zoomTo(1);
    const fitted = node.offsetWidth;
    const actual = fitted > 0 ? node.naturalWidth / fitted : 2;
    // shortcut: an image already shown at or above its own size jumps to 2x, not 100%.
    zoomTo(actual > 1.05 ? actual : 2, { x: event.clientX, y: event.clientY });
  };

  return createPortal(
    <div
      aria-label={image?.name}
      aria-modal="true"
      className="image-viewer"
      data-testid="image-viewer"
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {image ? (
        <img
          alt={image.name}
          className="image-viewer__image"
          data-testid="image-viewer-image"
          draggable={false}
          ref={imageRef}
          src={image.src}
          onDoubleClick={toggleActualSize}
          onPointerCancel={onPointerUp}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
      ) : null}
      {count > 1 ? (
        <>
          <button
            aria-label="Previous image"
            className="image-viewer__nav image-viewer__nav--prev"
            type="button"
            onClick={() => show(index - 1)}
          >
            <ChevronRightIcon />
          </button>
          <button
            aria-label="Next image"
            className="image-viewer__nav image-viewer__nav--next"
            type="button"
            onClick={() => show(index + 1)}
          >
            <ChevronRightIcon />
          </button>
          <span className="image-viewer__count" data-testid="image-viewer-count">
            {index + 1} / {count}
          </span>
        </>
      ) : null}
      <span className="image-viewer__zoom" data-testid="image-viewer-zoom" hidden ref={badgeRef} />
      <button
        aria-label="Close image"
        className="image-viewer__close"
        type="button"
        onClick={onClose}
      >
        <CloseIcon />
      </button>
    </div>,
    document.body,
  );
}
