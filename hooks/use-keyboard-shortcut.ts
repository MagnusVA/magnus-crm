"use client";

import { useEffect } from "react";

type Modifier = "meta" | "ctrl" | "shift" | "alt";

interface ShortcutOptions {
  key: string;
  modifiers?: Modifier[];
  handler: () => void;
  enabled?: boolean;
}

/**
 * Registers a global keyboard shortcut.
 * Automatically handles Mac (Meta) vs Windows (Ctrl).
 */
export function useKeyboardShortcut({
  key,
  modifiers = [],
  handler,
  enabled = true,
}: ShortcutOptions) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== key.toLowerCase()) return;

      const modifierCheck = modifiers.every((mod) => {
        switch (mod) {
          case "meta":
            return e.metaKey || e.ctrlKey; // Mac or Windows
          case "ctrl":
            return e.ctrlKey;
          case "shift":
            return e.shiftKey;
          case "alt":
            return e.altKey;
        }
      });

      if (modifierCheck) {
        e.preventDefault();
        handler();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [key, modifiers, handler, enabled]);
}
