"use client";

import { useEffect, useRef, useState } from "react";

/**
 * "Show N more" that keeps a card its size: expanding locks the list at the
 * height it had collapsed and lets the extra rows scroll inside it, so the
 * card never grows. Spread `listProps` on the list's scroll container.
 * `canExpand` says there are more rows than the collapsed list shows; once
 * it turns false the lock is dropped, so a shrinking list can't stay pinned
 * at the old height with no control left to collapse it.
 *
 * While expanded and not scrolled to the end, `hintProps.visible` is true:
 * pass `hintProps` to `ScrollMoreHint`, inside a `relative` wrapper around
 * the list, to point at the rows below the fold.
 */
export function useExpandInPlace<T extends HTMLElement>(canExpand: boolean) {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [atEnd, setAtEnd] = useState(true);
  if (!canExpand && height !== null) setHeight(null);
  const expanded = canExpand && height !== null;

  useEffect(() => {
    const list = ref.current;
    if (!expanded || !list) return;
    const update = () =>
      setAtEnd(list.scrollHeight - list.scrollTop - list.clientHeight <= 1);
    // Rows arrive live and text rewraps on resize, so the end can move
    // without a scroll.
    const resizes = new ResizeObserver(update);
    const mutations = new MutationObserver(update);
    list.addEventListener("scroll", update, { passive: true });
    resizes.observe(list);
    mutations.observe(list, { childList: true, subtree: true });
    return () => {
      list.removeEventListener("scroll", update);
      resizes.disconnect();
      mutations.disconnect();
    };
  }, [expanded]);

  function toggle() {
    // Expanding always adds rows past the locked height, so the list opens
    // with more below.
    setAtEnd(expanded);
    setHeight(expanded ? null : (ref.current?.offsetHeight ?? null));
  }

  function scrollToEnd() {
    const list = ref.current;
    if (!list) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollTo({ top: list.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }

  return {
    expanded,
    toggle,
    listProps: {
      ref,
      style: expanded ? { height } : undefined,
      className: expanded ? "overflow-y-auto overscroll-contain" : undefined,
    },
    hintProps: { visible: expanded && !atEnd, onClick: scrollToEnd },
  };
}
