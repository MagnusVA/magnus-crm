import { Skeleton } from "@/components/ui/skeleton";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { PageBand } from "../page-band";
import { RankingSkeleton } from "./ranking-skeleton";

// Overview's first load, at the page's real layout and heights.

function RowsSkeleton({ rows, thumb = false }: { rows: number; thumb?: boolean }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-[60px] items-center gap-3 border-b px-4 last:border-b-0">
          <Skeleton className={thumb ? "size-11 rounded-[7px]" : "size-6 rounded-full"} />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40 max-w-full" />
            <Skeleton className="h-3 w-56 max-w-full" />
          </div>
          <Skeleton className="h-5 w-10" />
        </div>
      ))}
    </div>
  );
}

/** The rankings, phone closers and posts while their first data loads. */
export function OverviewSectionsSkeleton() {
  return (
    <div role="status" aria-label="Loading the overview" className="flex flex-col gap-3.5">
      <div className="grid gap-3.5 @4xl:grid-cols-3">
        {["Lead Gen", "Top Qualifiers", "Top DM Closers"].map((title) => (
          <DetailCard key={title} title={title} className="min-w-0">
            <RankingSkeleton />
          </DetailCard>
        ))}
      </div>
      <div className="grid items-start gap-3.5 @5xl:grid-cols-[1.35fr_1fr]">
        <DetailCard title="Phone closers" className="min-w-0">
          <RowsSkeleton rows={5} />
        </DetailCard>
        <DetailCard title="Top posts & reels" className="min-w-0">
          <RowsSkeleton rows={5} thumb />
        </DetailCard>
      </div>
    </div>
  );
}

export function OverviewDashboardSkeleton() {
  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6">
      <PageBand
        title="Overview"
        description={
          // The band sets its description in a <p>, so the placeholder is an inline span.
          <span
            aria-hidden="true"
            className="inline-block h-3.5 w-72 max-w-full animate-pulse rounded-md bg-board-foreground/10 align-middle"
          />
        }
      />
      <OverviewSectionsSkeleton />
    </div>
  );
}
