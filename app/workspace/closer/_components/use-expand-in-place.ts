"use client";

import { useRef, useState } from "react";

/**
 * "Show N more" that keeps a card its size: expanding locks the list at the
 * height it had collapsed and lets the extra rows scroll inside it, so the
 * card never grows. Spread `listProps` on the list's scroll container.
 * `canExpand` says there are more rows than the collapsed list shows; once
 * it turns false the lock is dropped, so a shrinking list can't stay pinned
 * at the old height with no control left to collapse it.
 */
export function useExpandInPlace<T extends HTMLElement>(canExpand: boolean) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  if (!canExpand && height !== null) setHeight(null);
  const expanded = canExpand && height !== null;

  function toggle() {
    setHeight(expanded ? null : (ref.current?.offsetHeight ?? null));
  }

  return {
    expanded,
    toggle,
    listProps: {
      ref,
      style: expanded ? { height } : undefined,
      className: expanded ? "overflow-y-auto overscroll-contain" : undefined,
    },
  };
}
