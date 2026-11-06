"use client";

import { useRef, type KeyboardEvent } from "react";
import { formatWholeNumber } from "@/app/workspace/_components/overview-formatters";
import { cn } from "@/lib/utils";
import type { KindCounts, KindFilter } from "./missed-deals-card";

// The band's tab row, in the Billing band's grammar: ALL · NO-SHOWS ·
// CANCELED, each with its count, a 2px lime rule under the chosen one. The
// tabs filter the Deals card on the page; arrows move between them.

const TABS: ReadonlyArray<{ value: KindFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "no_show", label: "No-shows" },
  { value: "canceled", label: "Canceled" },
];

export function kindTabId(kind: KindFilter) {
  return `missed-kind-${kind}`;
}

export function KindTabs({
  kind,
  counts,
  partial,
  reloading,
  onSelect,
  controls,
}: {
  kind: KindFilter;
  /** Undefined before the first rows arrive. */
  counts: KindCounts | undefined;
  /** The range holds more deals than the page reads, so the counts are lower bounds. */
  partial: boolean;
  /** The counts are the last range's, dimmed while the new one loads. */
  reloading: boolean;
  onSelect: (kind: KindFilter) => void;
  /** The id of the card the tabs filter. */
  controls: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const tab = TABS[(index + TABS.length) % TABS.length];
    onSelect(tab.value);
    listRef.current?.querySelector<HTMLButtonElement>(`#${kindTabId(tab.value)}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = TABS.findIndex((tab) => tab.value === kind);
    if (event.key === "ArrowRight") select(current + 1);
    else if (event.key === "ArrowLeft") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(TABS.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Deals by missed meeting"
      onKeyDown={onKeyDown}
      className="-mx-4 flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:-mx-[18px] @lg:px-[18px]"
    >
      {TABS.map((tab) => {
        const selected = tab.value === kind;
        return (
          <button
            key={tab.value}
            id={kindTabId(tab.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={controls}
            tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(tab.value)}
            className={cn(
              "flex h-10 shrink-0 items-center gap-[7px] border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              selected ? "border-primary text-board-foreground" : "border-transparent text-board-muted hover:text-board-foreground",
            )}
          >
            {tab.label}
            {counts ? (
              <span
                className={cn(
                  "font-condensed text-[14px] tracking-[0.02em] tabular-nums transition-opacity duration-200 motion-reduce:transition-none",
                  selected ? "text-board-foreground" : "text-board-muted",
                  reloading && "opacity-60",
                )}
              >
                {formatWholeNumber(counts[tab.value])}
                {partial ? "+" : ""}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
