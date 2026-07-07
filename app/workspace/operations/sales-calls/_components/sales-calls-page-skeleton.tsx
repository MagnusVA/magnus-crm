import { Skeleton } from "@/components/ui/skeleton";

export function SalesCallsPageSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Loading phone sales ops"
    >
      <div className="flex flex-col gap-2 border-b pb-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-[340px] w-full" />
      <Skeleton className="h-[320px] w-full" />
      <Skeleton className="h-[260px] w-full" />
    </div>
  );
}
