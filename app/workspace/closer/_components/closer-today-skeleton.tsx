import { Skeleton } from "@/components/ui/skeleton";

/** The Today page's shape while it loads: header, board, performance, outcomes, tasks. */
export function CloserTodaySkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 pb-6"
      role="status"
      aria-label="Loading today"
    >
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3.5 w-72 max-w-full" />
        </div>
        <Skeleton className="h-7 w-24" />
      </header>

      <div className="grid gap-x-5 gap-y-3.5 xl:grid-cols-[minmax(0,1fr)_384px] xl:grid-rows-[auto_1fr]">
        <div className="overflow-hidden rounded-xl bg-board xl:col-start-1 xl:row-start-1">
          <div className="flex h-[46px] items-center gap-3 px-[18px]">
            <Skeleton className="h-5 w-32 bg-board-raised" />
            <Skeleton className="ml-auto h-[30px] w-52 bg-board-raised" />
          </div>
          <div className="h-7 border-t border-board-line" />
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="flex h-11 items-center gap-4 border-t border-board-line px-[18px]">
              <Skeleton className="h-5 w-14 bg-board-raised" />
              <Skeleton className="h-4 w-40 bg-board-raised" />
              <Skeleton className="ml-auto h-4 w-20 bg-board-raised" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3.5 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          <div className="rounded-xl border bg-card">
            <div className="flex h-[46px] items-center border-b px-4">
              <Skeleton className="h-4 w-28" />
            </div>
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0">
                <div className="flex flex-1 flex-col gap-1.5">
                  <Skeleton className="h-4 w-36" />
                  <Skeleton className="h-3.5 w-48" />
                </div>
                <Skeleton className="h-8 w-28" />
              </div>
            ))}
          </div>
          <div className="rounded-xl border bg-card">
            <div className="flex h-[46px] items-center border-b px-4">
              <Skeleton className="h-4 w-16" />
            </div>
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-1.5 border-t px-4 py-2.5 first:border-t-0">
                <Skeleton className="h-4 w-52 max-w-full" />
                <Skeleton className="h-3.5 w-32" />
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border bg-card xl:col-start-1 xl:row-start-2 xl:self-start">
          <div className="flex h-[46px] items-center gap-2 border-b px-4">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="ml-auto h-7 w-44" />
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr]">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex flex-col gap-2 px-4 pt-3.5 pb-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-3.5 w-32" />
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2.5 border-t px-4 pt-3 pb-3.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-2.5 w-full rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}
