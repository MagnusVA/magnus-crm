import { Skeleton } from "@/components/ui/skeleton";

/** The inbox while it loads: the focused card on the left, Up next on the right from `@4xl`. */
export function InboxPageSkeleton() {
  return (
    <div className="@container min-w-0" role="status" aria-label="Loading the inbox">
      <div className="grid items-start gap-3.5 @4xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-card px-5 py-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-11" />
            ))}
          </div>
          <Skeleton className="h-32 rounded-[10px]" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-64" />
            <Skeleton className="h-9 w-48" />
          </div>
          <Skeleton className="h-6 w-80" />
        </div>
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex min-h-11 items-center border-b border-border px-4">
            <Skeleton className="h-4 w-24" />
          </div>
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 border-b border-border px-4 py-2.5 last:border-b-0">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
