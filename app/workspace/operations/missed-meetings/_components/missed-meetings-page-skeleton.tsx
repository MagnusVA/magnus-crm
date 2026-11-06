import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the page at its real container steps: the band with its
// title, picker and four figure zones, then the Deals card's title row,
// column heads and rows.

export function MissedMeetingsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading no-shows and cancellations"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-7 w-72 max-w-full bg-board-raised" />
            <Skeleton className="h-3.5 w-[30rem] max-w-full bg-board-raised" />
          </div>
          <Skeleton className="h-[34px] w-[30rem] max-w-full bg-board-raised" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-board-line bg-board-line @3xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
              <Skeleton className="h-3 w-16 bg-board-raised" />
              <Skeleton className="h-8 w-16 bg-board-raised" />
              <Skeleton className="h-3.5 w-32 max-w-full bg-board-raised" />
            </div>
          ))}
        </div>
      </div>

      <div className="@container/missed min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
          <Skeleton className="mr-auto h-4 w-40" />
          <Skeleton className="h-[30px] w-64 max-w-full" />
          <Skeleton className="h-5 w-52" />
        </div>
        <div className="hidden min-h-7 border-b border-border @3xl/missed:block" />
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="flex min-h-[57px] items-center gap-4 border-b border-border px-4 py-2 last:border-b-0">
            <div className="hidden w-[6.5rem] flex-col gap-1.5 @3xl/missed:flex">
              <Skeleton className="h-3.5 w-12" />
              <Skeleton className="h-3.5 w-14" />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-28" />
            </div>
            <Skeleton className="hidden h-4 w-[40%] @3xl/missed:block" />
            <Skeleton className="h-3.5 w-14" />
          </div>
        ))}
      </div>
    </div>
  );
}
