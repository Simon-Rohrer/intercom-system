import { useEffect, useRef, useState } from "react";

/** How long a message from JMS Control (Beamer / Stage Display) stays highlighted. */
export const ALERT_HIGHLIGHT_MS = 15_000;
/** The zoom-in animation only plays right after the message arrived. */
const POP_MS = 1_500;

export type AlertState = "" | "fresh" | "pop";

/**
 * Highlight alerts only for a short time after they arrive, then they look like any
 * other message. Alerts that are already there when the view opens stay normal.
 * Returns a function giving the state of one entry; re-renders when a highlight ends.
 */
export function useFreshAlerts<T>(
  entries: T[],
  keyOf: (entry: T) => string,
  isAlert: (entry: T) => boolean,
  now: () => number = Date.now,
): (entry: T) => AlertState {
  const firstSeen = useRef(new Map<string, number>());
  const initialized = useRef(false);
  const [, setTick] = useState(0);

  const at = now();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!firstSeen.current.has(key)) {
      firstSeen.current.set(key, initialized.current ? at : Number.NEGATIVE_INFINITY);
    }
  }
  initialized.current = true;

  let nextEnd = Number.POSITIVE_INFINITY;
  for (const entry of entries) {
    if (!isAlert(entry)) continue;
    const age = at - (firstSeen.current.get(keyOf(entry)) ?? Number.NEGATIVE_INFINITY);
    if (age < ALERT_HIGHLIGHT_MS) nextEnd = Math.min(nextEnd, ALERT_HIGHLIGHT_MS - age);
  }

  useEffect(() => {
    if (nextEnd === Number.POSITIVE_INFINITY) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), nextEnd + 50);
    return () => window.clearTimeout(timer);
  });

  return (entry: T) => {
    if (!isAlert(entry)) return "";
    const age = at - (firstSeen.current.get(keyOf(entry)) ?? Number.NEGATIVE_INFINITY);
    if (age >= ALERT_HIGHLIGHT_MS) return "";
    return age < POP_MS ? "pop" : "fresh";
  };
}
