import { Skeleton } from "@/components/ui/skeleton";

/**
 * The person page's shape while it loads, at its real heights: the board
 * strip, two deal cards, and the rail's booking answers, source, timeline
 * and record.
 */
export function EntityDetailSkeleton() {
  return (
    <div
      className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6"
      role="status"
      aria-label="Loading the person"
    >
      <div className="h-[13.5rem] rounded-xl bg-board @5xl:h-[5.75rem]">
        <div className="flex h-full flex-col gap-4 p-4 @5xl:flex-row @5xl:items-center @5xl:gap-6 @5xl:pt-9">
          <Skeleton className="h-9 w-60 bg-board-raised" />
          <Skeleton className="h-6 w-28 bg-board-raised" />
          <Skeleton className="h-8 w-24 bg-board-raised" />
          <Skeleton className="h-9 flex-1 bg-board-raised" />
          <Skeleton className="h-8 w-72 max-w-full bg-board-raised" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:gap-x-[1.125rem] @5xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-[11.5rem] rounded-xl" />
          <Skeleton className="h-[11.5rem] rounded-xl" />
        </div>
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-80 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
