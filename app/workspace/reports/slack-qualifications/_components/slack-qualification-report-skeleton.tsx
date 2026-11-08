import { Skeleton } from "@/components/ui/skeleton";
import { REPORT_PAGE } from "../../_components/report-ui";

// Stands in for the page at its real container steps: the band with its
// controls, six figure zones and the setter filter, the trend card and the
// setters card's 44px rows.

function CardHead() {
  return (
    <div className="flex min-h-11 items-center border-b px-4">
      <Skeleton className="h-4 w-36" />
      <Skeleton className="ml-auto h-3.5 w-32" />
    </div>
  );
}

export function SlackQualificationReportSkeleton() {
  return (
    <div role="status" aria-label="Loading Slack qualification report" className={REPORT_PAGE}>
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-7 w-52 bg-board-raised" />
            <Skeleton className="h-3.5 w-80 max-w-full bg-board-raised" />
          </div>
          <Skeleton className="h-[34px] w-[36rem] max-w-full bg-board-raised" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-board-line bg-board-line @3xl:grid-cols-3 @5xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 bg-board px-4 py-3 @lg:px-[18px]">
              <Skeleton className="h-3 w-20 bg-board-raised" />
              <Skeleton className="h-8 w-16 bg-board-raised" />
              <Skeleton className="h-3.5 w-32 max-w-full bg-board-raised" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-board-line px-4 py-2.5 @lg:px-[18px]">
          <Skeleton className="h-[34px] w-56 bg-board-raised" />
          <Skeleton className="ml-auto h-[34px] w-28 bg-board-raised" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <CardHead />
        <div className="px-4 py-3">
          <Skeleton className="h-[296px] w-full rounded-md" />
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border bg-card">
        <CardHead />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-11 items-center gap-4 border-b px-4 last:border-b-0">
            <Skeleton className="size-6 rounded-full" />
            <Skeleton className="h-4 w-40 max-w-[40%]" />
            <Skeleton className="ml-auto hidden h-4 w-[45%] @3xl:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
