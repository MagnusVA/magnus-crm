import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  PIPELINE_DISPLAY_ORDER,
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import type { ViewMode } from "./calendar-utils";

type PipelineStripProps = {
  counts: Record<string, number>;
  total: number;
  /** Human-readable range driving the counts (e.g. "Apr 12 – Apr 18, 2026"). */
  rangeLabel?: string;
  /** Active calendar view mode — used to phrase the filter context. */
  viewMode?: ViewMode;
};

const VIEW_MODE_NOUN: Record<ViewMode, string> = {
  day: "this day",
  week: "this week",
  month: "this month",
};

/**
 * Horizontal row of pipeline‑stage cards — each shows a status dot, label,
 * and count. Clicking a card navigates to the pipeline page filtered by that
 * status.
 *
 * When `rangeLabel` + `viewMode` are provided, counts reflect opportunities
 * whose meetings fall inside the active calendar range, and the header
 * communicates that scope. Otherwise, counts are all‑time.
 *
 * Uses `font-variant-numeric: tabular-nums` so the counts align neatly when
 * the numbers change width as data streams in via Convex.
 *
 * On mobile: horizontal scroll with snap points for refined UX.
 * On desktop: full row visible without scrolling.
 */
export function PipelineStrip({
  counts,
  total,
  rangeLabel,
  viewMode,
}: PipelineStripProps) {
  const isFiltered = rangeLabel !== undefined && viewMode !== undefined;
  const periodNoun = viewMode ? VIEW_MODE_NOUN[viewMode] : undefined;

  return (
    <section aria-label="Pipeline summary">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Pipeline
          </h2>
          {isFiltered && (
            <span
              className="text-xs text-muted-foreground/80"
              title={`Stats for ${rangeLabel}`}
            >
              · {rangeLabel}
            </span>
          )}
        </div>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {total}&nbsp;{total === 1 ? "opportunity" : "opportunities"}
          {isFiltered && periodNoun ? ` ${periodNoun}` : ""}
        </span>
      </div>

      <div className="overflow-x-auto scroll-smooth [-webkit-overflow-scrolling:touch]">
        <div className="flex gap-2.5 lg:grid lg:grid-cols-9">
          {PIPELINE_DISPLAY_ORDER.map((status) => {
            const config = opportunityStatusConfig[status];
            const count = counts[status] ?? 0;

            return (
              <PipelineCard
                key={status}
                status={status}
                label={config.label}
                count={count}
                dotClass={config.dotClass}
                stripBg={config.stripBg}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}

// ─── Individual card ─────────────────────────────────────────────────────────

type PipelineCardProps = {
  status: OpportunityStatus;
  label: string;
  count: number;
  dotClass: string;
  stripBg: string;
};

function PipelineCard({
  status,
  label,
  count,
  dotClass,
  stripBg,
}: PipelineCardProps) {
  return (
    <Link
      href={`/workspace/closer/pipeline?status=${status}`}
      className={cn(
        "flex min-w-[140px] flex-col gap-1 rounded-lg border p-3 transition-colors lg:min-w-0",
        stripBg,
      )}
    >
      {/*
        Reserve 2 lines of label height (text-xs ≈ 1rem line-height → min-h-8)
        so cards with single‑line labels ("Lost") stay the same height as
        wrapped two‑line labels ("Meeting Overran", "Reschedule Sent").
        Combined with mt-auto on the count, this keeps every number aligned
        on the same baseline across the row.
      */}
      <div className="flex min-h-8 items-start gap-1.5">
        <span
          className={cn("mt-1.5 size-2 shrink-0 rounded-full", dotClass)}
          aria-hidden
        />
        <span className="text-xs font-medium leading-4 text-muted-foreground">
          {label}
        </span>
      </div>
      <span className="mt-auto text-2xl font-bold font-mono tabular-nums">
        {count}
      </span>
    </Link>
  );
}
