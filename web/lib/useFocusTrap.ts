"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside a dialog while it is open, and returns it to
 * where it was when the dialog closes. Without it, Tab walked out of a modal
 * into the page behind it, where a keyboard or screen reader user cannot see
 * what they are on.
 */
export function useFocusTrap<T extends HTMLElement>(open: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => (ref.current ? [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)] : []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      const all = items();
      if (e.key !== "Tab" || !box || all.length === 0) return;
      const first = all[0]!;
      const last = all[all.length - 1]!;
      const inside = box.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus();
    };
  }, [open]);
  return ref;
}
