"use client";

import { useEffect, useRef } from "react";

/**
 * Closes a dialog on Escape, as keyboard and screen reader users expect.
 *
 * None of the app's sheets did, so a keyboard user who opened one had to find
 * its close button by tabbing, and some sheets have none. Pass `open` false
 * (or a busy flag folded into it) to leave the key alone, for example while a
 * request the sheet started is still running.
 */
export function useEscapeToClose(open: boolean, onClose: () => void) {
  // The latest handler, so a parent passing a new arrow function each render
  // does not re-register the listener every time.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
}
