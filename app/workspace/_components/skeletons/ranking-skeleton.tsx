import { Skeleton } from "@/components/ui/skeleton";

// A ranking card's rows while they load. Kept out of overview-rankings.tsx so
// the workspace loading.tsx doesn't pull the rankings' client code (and the
// date range picker behind it) into every workspace route's first load.

export function RankingSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading the ranking" className="flex flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-8 w-14" />
      </div>
      {Array.from({ length: rows - 1 }, (_, index) => (
        <div key={index} className="flex h-[52px] items-center gap-2.5 border-b px-4 last:border-b-0">
          <Skeleton className="h-3 w-3" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}
