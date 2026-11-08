import { Skeleton } from "@/components/ui/skeleton";
import { REPORT_PAGE } from "./_components/report-ui";

/** A report's band with four figure zones and two ruled cards, at their real heights. */
export default function ReportsLoading() {
  return (
    <div role="status" aria-label="Loading report" className={REPORT_PAGE}>
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-wrap items-center gap-3.5 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-[29px] w-56 bg-board-raised" />
            <Skeleton className="h-3.5 w-72 max-w-full bg-board-raised" />
          </div>
          <Skeleton className="h-[34px] w-[30rem] max-w-full rounded-[7px] bg-board-raised" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-board-line bg-board-line @3xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
              <Skeleton className="h-3 w-20 bg-board-raised" />
              <Skeleton className="h-8 w-24 bg-board-raised" />
              <Skeleton className="h-3.5 w-36 max-w-full bg-board-raised" />
            </div>
          ))}
        </div>
      </div>
      {[6, 4].map((rows, card) => (
        <div key={card} className="overflow-hidden rounded-xl border bg-card">
          <div className="flex min-h-11 items-center border-b px-4">
            <Skeleton className="h-4 w-40" />
          </div>
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex h-11 items-center gap-4 border-b px-4 last:border-b-0">
              <Skeleton className="h-4 w-40 max-w-[40%]" />
              <Skeleton className="h-2 flex-1" />
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
