import { Skeleton } from "@/components/ui/skeleton";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";

// Merge people at its real heights (no hooks, so loading.tsx draws the same):
// the band with its back link, then the search card or the comparison card.

/** The page root: the container every card folds by, on an 1100px measure. */
export const MERGE_ROOT = "@container mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";

const BONE = "block animate-pulse rounded-md bg-board-raised";

/** PageBand's frame: back link, 26px title, 13px line. */
export function MergeBandSkeleton() {
  return (
    <div className="rounded-xl bg-board px-4 py-3.5 @lg:px-[18px] @lg:py-4 dark:ring-1 dark:ring-board-foreground/10">
      <div className="mb-1.5 flex min-h-6 items-center">
        <span className={cn(BONE, "h-3.5 w-28")} />
      </div>
      <div className="flex h-[29px] items-center">
        <span className={cn(BONE, "h-6 w-64 max-w-full")} />
      </div>
      <div className="mt-1 flex h-5 items-center">
        <span className={cn(BONE, "h-3 w-96 max-w-full")} />
      </div>
    </div>
  );
}

/** The search card: title row, the field, one line under it. */
export function SearchCardSkeleton() {
  return (
    <div className={CARD}>
      <div className="flex min-h-11 items-center border-b border-border px-4 py-2">
        <Skeleton className="h-4 w-28" />
      </div>
      <div className="px-4 py-3">
        <Skeleton className="h-8 w-full @xl:max-w-md" />
      </div>
      <div className="border-t border-border px-4 py-4">
        <Skeleton className="my-[3px] h-3.5 w-56" />
      </div>
    </div>
  );
}

/** Result rows at 44px while the first search runs. */
export function ResultRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Searching">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-11 items-center gap-4 border-b border-border px-4 last:border-b-0">
          <Skeleton className="h-3.5 w-36" />
          <Skeleton className="h-3 w-44" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

/** The comparison card: title row, head row, 34px fact rows, What moves, the action row. */
export function PreviewCardSkeleton() {
  return (
    <div className={CARD} role="status" aria-label="Loading the merge preview">
      <div className="flex min-h-11 items-center border-b border-border px-4 py-2">
        <Skeleton className="h-4 w-32" />
      </div>
      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 px-4 py-2.5">
        <span />
        <Skeleton className="h-9 w-40 max-w-full" />
        <Skeleton className="h-9 w-40 max-w-full" />
      </div>
      {[4, 5].map((count, group) => (
        <div key={group} className="border-t border-border">
          {Array.from({ length: count }, (_, index) => (
            <div
              key={index}
              className="grid h-[34px] grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 border-t border-border/60 px-4 first:border-t-0"
            >
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3.5 w-32 max-w-full" />
              <Skeleton className="h-3.5 w-32 max-w-full" />
            </div>
          ))}
        </div>
      ))}
      <div className="border-t border-border pt-2.5">
        <Skeleton className="mx-4 mb-1.5 h-2.5 w-20" />
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="grid min-h-8 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 border-t border-border/60 px-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3.5 w-64 max-w-full" />
          </div>
        ))}
      </div>
      <div className="flex min-h-12 items-center justify-end gap-2 border-t border-border px-4 py-2">
        <Skeleton className="h-8 w-28" />
        <Skeleton className="h-8 w-40" />
      </div>
    </div>
  );
}

/** The whole page before the person loads. */
export function MergePageSkeleton() {
  return (
    <div className={MERGE_ROOT} role="status" aria-label="Loading merge people">
      <MergeBandSkeleton />
      <SearchCardSkeleton />
    </div>
  );
}
