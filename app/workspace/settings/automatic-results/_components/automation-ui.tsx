"use client";

import { LockIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { LEVELS, levelRank, type Level, type LevelDefinition } from "./automation-kinds";

/** One side of a segmented toggle; the chosen side lifts (DESIGN.md, Segment lift). */
export const SEGMENT =
  "h-[26px] gap-1 rounded-[5px]! px-2.5 text-[13px] text-muted-foreground data-[state=on]:bg-card data-[state=on]:font-medium data-[state=on]:text-foreground data-[state=on]:shadow-[0_1px_2px_rgb(20_26_40/0.12)] disabled:opacity-60";
/** The segmented toggle's track. */
export const SEGMENT_GROUP = "rounded-[7px] border bg-background p-0.5";

/**
 * The level for one kind: Off / Shadow / Ask / Automatic as one segmented
 * toggle. It never changes by itself: a pick calls `onRequest`, and the page
 * confirms before saving. Levels above the current one are disabled without
 * `canRaise`, below it without `canLower`; a locked level shows its lock.
 */
export function LevelControl({
  value,
  label,
  canRaise,
  canLower,
  disabled,
  onRequest,
  levels = LEVELS,
}: {
  value: Level;
  /** The accessible name of the group, such as "Level for Won, from a payment". */
  label: string;
  canRaise: boolean;
  canLower: boolean;
  disabled?: boolean;
  onRequest: (next: Level) => void;
  levels?: readonly LevelDefinition[];
}) {
  const current = levelRank(value);
  return (
    <ToggleGroup
      type="single"
      value={value}
      aria-label={label}
      className={SEGMENT_GROUP}
      onValueChange={(next) => {
        if (next && next !== value) onRequest(next as Level);
      }}
    >
      {levels.map((level) => {
        const rank = levelRank(level.value);
        const blocked =
          !level.available || (rank > current && !canRaise) || (rank < current && !canLower);
        const item = (
          <ToggleGroupItem
            key={level.value}
            value={level.value}
            disabled={disabled || blocked}
            aria-label={level.available ? level.label : `${level.label}, ${level.lockedReason ?? "not available"}`}
            className={SEGMENT}
          >
            {level.available ? null : <LockIcon aria-hidden="true" className="size-3" />}
            {level.label}
          </ToggleGroupItem>
        );
        if (level.available) return item;
        // A disabled button gets no hover, so the tip sits on a wrapper.
        return (
          <Tooltip key={level.value}>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="rounded-[5px] outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {item}
              </span>
            </TooltipTrigger>
            <TooltipContent className="text-[12.5px]">{level.lockedReason}</TooltipContent>
          </Tooltip>
        );
      })}
    </ToggleGroup>
  );
}

/** A condensed, tabular figure inline in a sentence or a cell. */
export const INLINE_FIGURE = "font-condensed text-[15px] leading-none font-semibold tabular-nums";

/** One ruled line of the scorecard's queues: a 13px term, a figure, and a slate explanation. */
export function QueueLine({
  term,
  figure,
  children,
  tone = "muted",
}: {
  term: string;
  figure: React.ReactNode;
  children?: React.ReactNode;
  tone?: "muted" | "warning";
}) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 border-t border-border px-4 py-2.5 @2xl/scorecard:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <dt className="text-[13px] font-medium">{term}</dt>
      <dd className="min-w-0 text-[13px] leading-[1.45]">
        <span className={cn(INLINE_FIGURE, tone === "warning" && "text-warning-ink")}>{figure}</span>
        {children ? <span className="text-muted-foreground"> · {children}</span> : null}
      </dd>
    </div>
  );
}
