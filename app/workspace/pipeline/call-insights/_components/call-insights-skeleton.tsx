import { Skeleton } from "@/components/ui/skeleton";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { CALL_INSIGHTS_TABS, CallInsightsBand } from "./call-insights-band";

export const PAGE_ROOT =
  "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

/** A ruled card's skeleton: the 44px title row, then rows at their real height. */
export function CardSkeleton({
  label,
  rows = 6,
  rowHeight = "h-14",
}: {
  label: string;
  rows?: number;
  rowHeight?: string;
}) {
  return (
    <div role="status" aria-label={label} className={CARD}>
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-4">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="ml-auto h-7 w-32" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={`flex items-center gap-4 border-b border-border px-4 last:border-b-0 ${rowHeight}`}
        >
          <div className="flex w-48 max-w-[45%] flex-col gap-1.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-3 w-2/3" />
          </div>
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function CallInsightsSkeleton() {
  return (
    <div className={PAGE_ROOT}>
      <CallInsightsBand
        tabs={CALL_INSIGHTS_TABS.map((tab) => (
          <span
            key={tab.value}
            className="flex h-10 shrink-0 items-center font-condensed text-[13px] font-semibold tracking-[0.12em] text-board-muted uppercase"
          >
            {tab.label}
          </span>
        ))}
      />
      <CardSkeleton label="Loading Call insights" />
    </div>
  );
}
