import { Skeleton } from "@/components/ui/skeleton";

/** The strip and two program cards, at their real sizes, while the desk first loads. */
export function DeskSkeleton() {
  return (
    <div role="status" aria-label="Loading your month" className="flex flex-col gap-3.5">
      <div className="grid grid-cols-2 gap-x-7 gap-y-4 rounded-xl bg-board px-4 py-3.5 sm:px-[18px] md:grid-cols-[1.25fr_1fr_1fr_1fr]">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-24 bg-board-raised" />
            <Skeleton className="h-7 w-20 bg-board-raised" />
            <Skeleton className="h-3.5 w-32 bg-board-raised" />
          </div>
        ))}
      </div>
      <div className="grid gap-3.5 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, card) => (
          <div key={card} className="rounded-xl border bg-card">
            <div className="flex min-h-11 items-center justify-between border-b px-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-44" />
            </div>
            <div className="h-7 border-b" />
            {Array.from({ length: 3 }).map((_, row) => (
              <div key={row} className="flex h-10 items-center gap-6 border-t px-4 first:border-t-0">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3.5 w-16" />
                <Skeleton className="h-4 w-36" />
              </div>
            ))}
            <div className="flex h-10 items-center justify-between border-t px-4">
              <Skeleton className="h-3.5 w-28" />
              <Skeleton className="h-3.5 w-36" />
            </div>
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
      <div className="rounded-xl border bg-card">
        <div className="flex min-h-12 items-center gap-3 border-b px-4">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-56" />
          <Skeleton className="hidden h-7 w-36 sm:block" />
        </div>
        <div className="h-24" />
      </div>
    </div>
  );
}
