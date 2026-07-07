import { Skeleton } from "@/components/ui/skeleton";

export function BookedCallsPageSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Loading booked calls"
    >
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-80 max-w-full" />
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Skeleton className="h-[340px] w-full lg:col-span-2" />
        <Skeleton className="h-[340px] w-full" />
      </div>
      <Skeleton className="h-[300px] w-full" />
      <Skeleton className="h-[260px] w-full" />
    </div>
  );
}
