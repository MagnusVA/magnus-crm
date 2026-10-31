import { Skeleton } from "@/components/ui/skeleton";

/**
 * The person page's shape while it loads, at its real heights and on the
 * page's own container steps: the board strip; a deal card, then the
 * booking answers beside the timeline; the person card on the right from
 * @4xl, under the rest when narrower.
 */
export function EntityDetailSkeleton() {
  return (
    <div
      className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3"
      role="status"
      aria-label="Loading the person"
    >
      <div className="h-[12.5rem] rounded-xl bg-board @5xl:h-[5.75rem]">
        <div className="flex h-full flex-col gap-4 p-4 @5xl:flex-row @5xl:items-center @5xl:gap-6 @5xl:pt-9">
          <Skeleton className="h-9 w-60 bg-board-raised" />
          <Skeleton className="h-6 w-28 bg-board-raised" />
          <Skeleton className="h-8 w-24 bg-board-raised" />
          <Skeleton className="h-9 flex-1 bg-board-raised" />
          <Skeleton className="h-8 w-72 max-w-full bg-board-raised" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 short:gap-3 @4xl:grid-cols-[minmax(0,1fr)_360px] @4xl:gap-x-[1.125rem]">
        <div className="flex flex-col gap-3.5 short:gap-3">
          <Skeleton className="h-[15.5rem] rounded-xl" />
          <div className="grid grid-cols-1 gap-3.5 short:gap-3 @4xl:grid-cols-2">
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
          </div>
        </div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    </div>
  );
}
