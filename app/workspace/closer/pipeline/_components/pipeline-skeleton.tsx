import { Skeleton } from "@/components/ui/skeleton";

/** The book panel and the first open-deal rows, at their real sizes, while the desk first loads. */
export function DeskSkeleton() {
  return (
    <div role="status" aria-label="Loading your month and open deals" className="flex flex-col gap-3.5">
      <div className="@container/book rounded-xl bg-board">
        <div className="grid @4xl/book:grid-cols-[minmax(12rem,0.7fr)_minmax(0,1.55fr)] @5xl/book:grid-cols-[minmax(10rem,0.5fr)_minmax(0,1.2fr)_minmax(25rem,1.2fr)]">
        <div className="flex flex-col gap-2 px-4 py-3.5 sm:px-[18px]">
          <Skeleton className="h-3 w-28 bg-board-raised" />
          <Skeleton className="h-7 w-20 bg-board-raised" />
          <Skeleton className="h-3.5 w-32 bg-board-raised" />
          <Skeleton className="mt-3 h-3 w-16 bg-board-raised" />
          <Skeleton className="h-7 w-10 bg-board-raised" />
        </div>
        <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:px-[18px]">
          <Skeleton className="h-7 w-56 bg-board-raised" />
          <Skeleton className="h-3.5 w-full bg-board-raised" />
          <Skeleton className="h-4 w-4/5 bg-board-raised" />
          <Skeleton className="h-3.5 w-3/5 bg-board-raised" />
        </div>
        <div className="hidden flex-col gap-2 px-4 py-3.5 sm:px-[18px] @5xl/book:flex">
          {Array.from({ length: 5 }).map((_, row) => (
            <Skeleton key={row} className="h-4 w-full bg-board-raised" />
          ))}
        </div>
        </div>
      </div>
      <div className="rounded-xl border bg-card">
        <div className="flex min-h-12 items-center gap-3 border-b px-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-80 max-w-full" />
          <Skeleton className="hidden h-7 w-36 sm:block" />
        </div>
        {Array.from({ length: 6 }).map((_, row) => (
          <div key={row} className="flex h-12 items-center gap-6 border-t px-4 first:border-t-0">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="hidden h-4 w-24 sm:block" />
            <Skeleton className="hidden h-4 w-32 md:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The whole page while the route loads. */
export function PipelinePageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading My Pipeline"
      className="mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6"
    >
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-7 w-48" />
      </div>
      <DeskSkeleton />
      <div className="flex min-h-12 items-center gap-3 rounded-xl border bg-card px-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-3.5 w-56 max-w-full" />
      </div>
    </div>
  );
}
