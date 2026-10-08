import { useCallback, useEffect, useRef, useState } from "react";

function readStoredNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeStoredNumber(key: string, value: number | null) {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, String(Math.round(value)));
    }
  } catch {
    // Storage can be unavailable (private mode, kiosk policies); size just won't persist.
  }
}

/** A pixel size that survives reloads; `null` means "use the CSS default". */
export function useStoredSize(key: string) {
  const [size, setSize] = useState<number | null>(() => readStoredNumber(key));
  const update = useCallback(
    (next: number | null) => {
      setSize(next);
      writeStoredNumber(key, next);
    },
    [key],
  );
  return [size, update] as const;
}

type PanelResizerProps = {
  orientation: "vertical" | "horizontal";
  label: string;
  className?: string;
  /** Current size of the panel being resized, read when a drag starts. */
  getSize: () => number;
  /** +1 when moving the pointer right/down grows the panel, -1 when it shrinks it. */
  direction: 1 | -1;
  min: number;
  max: () => number;
  onResize: (size: number) => void;
  onReset: () => void;
};

/** Drag handle (mouse, touch, keyboard) that resizes a neighbouring panel. */
export function PanelResizer({
  orientation,
  label,
  className = "",
  getSize,
  direction,
  min,
  max,
  onResize,
  onReset,
}: PanelResizerProps) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ start: number; base: number } | null>(null);

  const clamp = useCallback(
    (value: number) => Math.max(min, Math.min(Math.max(min, max()), value)),
    [min, max],
  );

  useEffect(() => {
    if (!dragging) return;
    const cursorClass =
      orientation === "vertical" ? "panel-resizing-col" : "panel-resizing-row";
    document.body.classList.add("panel-resizing", cursorClass);
    return () => document.body.classList.remove("panel-resizing", cursorClass);
  }, [dragging, orientation]);

  const coordinate = (event: { clientX: number; clientY: number }) =>
    orientation === "vertical" ? event.clientX : event.clientY;

  return (
    <div
      className={`panel-resizer panel-resizer-${orientation} ${dragging ? "dragging" : ""} ${className}`.trim()}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      title={`${label} · Doppelklick = zurücksetzen`}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // Synthetic events have no capturable pointer.
        }
        dragRef.current = { start: coordinate(event), base: getSize() };
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        onResize(clamp(drag.base + direction * (coordinate(event) - drag.start)));
      }}
      onPointerUp={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        setDragging(false);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 60 : 20;
        const delta =
          orientation === "vertical"
            ? { ArrowLeft: -step, ArrowRight: step }[event.key]
            : { ArrowUp: -step, ArrowDown: step }[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        onResize(clamp(getSize() + direction * delta));
      }}
    />
  );
}
