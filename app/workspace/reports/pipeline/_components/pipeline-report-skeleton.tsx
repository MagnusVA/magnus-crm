import { Skeleton } from "@/components/ui/skeleton";

export function PipelineReportSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading pipeline report"
    >
      {/* Status distribution chart + velocity card */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-[300px] rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
      </div>
      {/* Current backlog cards */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-28 rounded-lg" />
        <Skeleton className="h-28 rounded-lg" />
      </div>
      {/* Aging table */}
      <Skeleton className="h-48 rounded-lg" />
      {/* Stale pipeline list */}
      <Skeleton className="h-48 rounded-lg" />
      {/* Date diagnostics */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Skeleton className="h-[340px] rounded-lg" />
        <Skeleton className="h-[340px] rounded-lg" />
      </div>
    </div>
  );
}
