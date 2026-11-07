import { Skeleton } from "@/components/ui/skeleton";

/** What sits under the band while Review loads: one section of decision rows. */
export function ReviewSkeleton() {
  return (
    <div role="status" aria-label="Loading review">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex h-11 items-center gap-3 border-b border-border px-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3.5 w-48" />
        </div>
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2.5 border-b border-border px-4 py-3.5 last:border-b-0">
            <div className="flex items-center gap-4">
              <Skeleton className="h-[50px] flex-1 rounded-lg" />
              <Skeleton className="h-[50px] flex-1 rounded-lg" />
              <Skeleton className="h-7 w-40" />
            </div>
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    </div>
  );
}
