import { Skeleton } from "@/components/ui/skeleton";

/**
 * The meeting page's shape while it loads: the board row, the outcome panel,
 * prep and comments on the left, the deal, person and recording on the right.
 */
export function MeetingDetailSkeleton() {
  return (
    <div
      className="flex flex-col gap-3.5"
      role="status"
      aria-label="Loading meeting details"
    >
      <div className="h-[9.5rem] rounded-xl bg-board lg:h-[5.75rem]">
        <div className="flex h-full items-center gap-6 px-4">
          <Skeleton className="h-9 w-28 bg-board-raised" />
          <Skeleton className="h-9 flex-1 bg-board-raised" />
          <Skeleton className="hidden h-8 w-48 bg-board-raised lg:block" />
          <Skeleton className="hidden h-9 w-40 bg-board-raised lg:block" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_24rem] lg:gap-5">
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <div className="flex flex-col gap-3.5">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
      </div>
    </div>
  );
}
