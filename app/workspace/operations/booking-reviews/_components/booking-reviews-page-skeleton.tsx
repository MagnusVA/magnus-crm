import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the list at its real container steps: the band with its two
// figures, then the card's title row, column heads and 48px rows.

export function BookingReviewsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading booking reviews"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
          <Skeleton className="h-7 w-52 bg-board-raised" />
          <Skeleton className="h-3.5 w-[34rem] max-w-full bg-board-raised" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-board-line bg-board-line @3xl:grid-cols-[minmax(0,16rem)_minmax(0,16rem)_1fr]">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
              <Skeleton className="h-3 w-16 bg-board-raised" />
              <Skeleton className="h-8 w-12 bg-board-raised" />
              <Skeleton className="h-3.5 w-32 max-w-full bg-board-raised" />
            </div>
          ))}
          <div className="hidden bg-board @3xl:block" />
        </div>
      </div>
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-11 items-center border-b border-border px-4">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="hidden min-h-7 border-b border-border @3xl:block" />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex min-h-12 items-center gap-4 border-b border-border px-4 py-2 last:border-b-0">
            <Skeleton className="hidden h-4 w-24 @3xl:block" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-56 max-w-full" />
            </div>
            <Skeleton className="hidden h-4 w-[28%] @3xl:block" />
            <Skeleton className="h-3.5 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
