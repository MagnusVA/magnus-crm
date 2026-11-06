import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the review page at its real container steps: the band with
// its one sentence, the comparison card (column heads, six 34px rows, the
// fact line and three folds; a block per record below @2xl), and the rail.

const COLUMNS = 3;

function ColumnHead() {
  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-3 w-32 max-w-full" />
      <Skeleton className="h-3 w-20" />
    </div>
  );
}

function CompareBones() {
  return (
    <div className="@container/cmp min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="hidden @2xl/cmp:block">
        <div className="grid grid-cols-[5.5rem_24%_repeat(2,minmax(0,1fr))]">
          <div />
          {Array.from({ length: COLUMNS }, (_, index) => (
            <ColumnHead key={index} />
          ))}
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div key={row} className="grid h-[34px] grid-cols-[5.5rem_24%_repeat(2,minmax(0,1fr))] items-center border-t border-border">
            <Skeleton className="ml-4 h-3 w-14" />
            {Array.from({ length: COLUMNS }, (_, index) => (
              <Skeleton key={index} className="mx-3 h-3.5 w-3/4" />
            ))}
          </div>
        ))}
      </div>
      <div className="@2xl/cmp:hidden">
        {Array.from({ length: 2 }, (_, block) => (
          <div key={block} className="flex flex-col gap-2 border-b border-border px-4 py-2.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-28" />
            {Array.from({ length: 4 }, (_, row) => (
              <div key={row} className="flex min-h-6 items-center gap-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3.5 w-40 max-w-full" />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex min-h-9 items-center gap-6 border-t border-border px-4">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="h-3 w-32" />
      </div>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex min-h-10 items-center border-t border-border px-4">
          <Skeleton className="h-3.5 w-52" />
        </div>
      ))}
    </div>
  );
}

export function BookingReviewPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading booking review"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 pt-3.5 @lg:px-[18px] @lg:pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-28 bg-board-raised" />
            <Skeleton className="h-7 w-80 max-w-full bg-board-raised" />
            <Skeleton className="h-3.5 w-[26rem] max-w-full bg-board-raised" />
          </div>
          <Skeleton className="h-5 w-16 bg-board-raised" />
        </div>
        <div className="px-4 pt-1.5 pb-3.5 @lg:px-[18px] @lg:pb-4">
          <Skeleton className="h-3.5 w-[40rem] max-w-full bg-board-raised" />
        </div>
      </div>
      <div className="grid items-start gap-[18px] @4xl:grid-cols-[minmax(0,1fr)_20rem] @6xl:grid-cols-[minmax(0,1fr)_24rem]">
        <CompareBones />
        <div className="flex flex-col gap-2 rounded-xl border-2 border-border bg-card px-4 pt-3 pb-4">
          <Skeleton className="mb-1 h-5 w-36" />
          <Skeleton className="h-36 rounded-[7px]" />
          <Skeleton className="h-28 rounded-[7px]" />
        </div>
      </div>
    </div>
  );
}
