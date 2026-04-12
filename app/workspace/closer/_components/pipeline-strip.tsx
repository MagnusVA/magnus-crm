import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  PIPELINE_DISPLAY_ORDER,
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";

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
 *
 * On mobile: horizontal scroll with snap points for refined UX.
 * On desktop: full row visible without scrolling.
 */
export function PipelineStrip({ counts, total }: PipelineStripProps) {
  return (
    <section aria-label="Pipeline summary">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Pipeline</h2>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {total}&nbsp;{total === 1 ? "opportunity" : "opportunities"}
        </span>
      </div>

      <div className="overflow-x-auto scroll-smooth [-webkit-overflow-scrolling:touch]">
        <div className="flex gap-2.5 lg:grid lg:grid-cols-8">
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
      <div className="flex items-center gap-1.5">
        <span className={cn("size-2 rounded-full", dotClass)} aria-hidden />
        <span className="text-xs font-medium text-muted-foreground">
          {label}
        </span>
      </div>
      <span className="text-2xl font-bold font-mono tabular-nums">{count}</span>
    </Link>
  );
}
