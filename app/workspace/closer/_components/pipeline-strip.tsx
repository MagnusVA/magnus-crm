import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  PIPELINE_DISPLAY_ORDER,
  opportunityStatusConfig,
  type OpportunityStatus,
} from "./status-config";

type PipelineStripProps = {
  counts: Record<string, number>;
  total: number;
};

/**
 * Horizontal row of pipeline‑stage cards — each shows a status dot, label,
 * and count. Clicking a card navigates to the pipeline page filtered by that
 * status.
 *
 * Uses `font-variant-numeric: tabular-nums` so the counts align neatly when
 * the numbers change width as data streams in via Convex.
 */
export function PipelineStrip({ counts, total }: PipelineStripProps) {
  return (
    <section aria-label="Pipeline summary">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Pipeline</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {total}&nbsp;{total === 1 ? "opportunity" : "opportunities"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
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
        "flex flex-col gap-1 rounded-lg border p-3 transition-colors",
        stripBg,
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      </div>
      <span className="text-2xl font-bold tabular-nums">{count}</span>
    </Link>
  );
}
