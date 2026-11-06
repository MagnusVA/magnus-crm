"use client";

import { useRef, type KeyboardEvent } from "react";
import { PageBand } from "@/app/workspace/_components/page-band";
import { BUSINESS_DAY_REBUILD_MESSAGE } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { BandZone, BandZones, ZonePending } from "./setter-ui";

// Capture's band: the title and one line, today's three figures as zones,
// and the source as tabs (the Team and Settings band grammar). Shared with
// the skeleton, which passes no handler.

export type CaptureSource = "instagram" | "meta_business";

export const CAPTURE_PANEL_ID = "capture-panel";

const SOURCES: ReadonlyArray<{ value: CaptureSource; label: string }> = [
  { value: "instagram", label: "Instagram" },
  { value: "meta_business", label: "Meta Business" },
];

export function sourceTabId(source: CaptureSource) {
  return `capture-source-${source}`;
}

type DaySummary = { submissions: number; uniqueProspects: number; duplicates: number };

const count = (value: number) => value.toLocaleString("en-US");

export function CaptureBand({
  day,
  dayTip,
  rebuilding = false,
  source,
  disabled = false,
  onSourceChange,
}: {
  day: DaySummary | undefined;
  /** How the business day runs, said on TODAY. */
  dayTip?: string;
  rebuilding?: boolean;
  source: CaptureSource;
  disabled?: boolean;
  onSourceChange?: (source: CaptureSource) => void;
}) {
  return (
    <PageBand
      title="Capture"
      description="Paste a profile and press Enter. The origin stays set until you change it."
    >
      <div className="-mx-4 @lg:-mx-[18px]">
        {rebuilding ? (
          <p role="status" className="border-t border-board-line px-4 py-2.5 text-[13px] text-board-muted @lg:px-[18px]">
            {BUSINESS_DAY_REBUILD_MESSAGE}
          </p>
        ) : (
          <BandZones label="Today's captures" busy={day === undefined} className="grid-cols-3">
            <BandZone label="Today" tip={dayTip ? `Your captures today. ${dayTip}.` : "Your captures today."}>
              {day ? count(day.submissions) : <ZonePending />}
            </BandZone>
            <BandZone label="Unique" tip="Different people you captured today.">
              {day ? count(day.uniqueProspects) : <ZonePending />}
            </BandZone>
            <BandZone label="Dupes" tip="Captures of someone who had been captured before, by you or anyone else. They still count in Today.">
              {day ? count(day.duplicates) : <ZonePending />}
            </BandZone>
          </BandZones>
        )}
        <SourceTabs source={source} disabled={disabled} onSourceChange={onSourceChange} />
      </div>
    </PageBand>
  );
}

/** INSTAGRAM · META BUSINESS: a tab list over the capture cards; arrows move between them. */
function SourceTabs({
  source,
  disabled,
  onSourceChange,
}: {
  source: CaptureSource;
  disabled: boolean;
  onSourceChange?: (source: CaptureSource) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const select = (index: number) => {
    const next = SOURCES[(index + SOURCES.length) % SOURCES.length];
    if (next.value !== source) onSourceChange?.(next.value);
    listRef.current?.querySelector<HTMLButtonElement>(`#${sourceTabId(next.value)}`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = SOURCES.findIndex((entry) => entry.value === source);
    if (event.key === "ArrowRight") select(current + 1);
    else if (event.key === "ArrowLeft") select(current - 1);
    else if (event.key === "Home") select(0);
    else if (event.key === "End") select(SOURCES.length - 1);
    else return;
    event.preventDefault();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Source"
      onKeyDown={disabled ? undefined : onKeyDown}
      className="flex items-center gap-[22px] overflow-x-auto border-t border-board-line px-4 [scrollbar-width:none] @lg:px-[18px]"
    >
      {SOURCES.map((entry) => {
        const selected = entry.value === source;
        return (
          <button
            key={entry.value}
            id={sourceTabId(entry.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={CAPTURE_PANEL_ID}
            tabIndex={selected ? 0 : -1}
            disabled={disabled && !selected}
            onClick={() => {
              if (!selected) onSourceChange?.(entry.value);
            }}
            className={cn(
              "flex h-10 shrink-0 items-center border-b-2 font-condensed text-[13px] font-semibold tracking-[0.12em] whitespace-nowrap uppercase outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50",
              selected ? "border-primary text-board-foreground" : "border-transparent text-board-muted hover:text-board-foreground",
            )}
          >
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}
