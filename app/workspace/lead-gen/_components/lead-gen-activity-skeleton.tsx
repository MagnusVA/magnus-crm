import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenActivitySkeleton() {
  return (
    <div
      className="flex flex-col gap-5"
      role="status"
      aria-label="Loading Lead Gen activity"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-[360px] w-full" />
    </div>
  );
}
