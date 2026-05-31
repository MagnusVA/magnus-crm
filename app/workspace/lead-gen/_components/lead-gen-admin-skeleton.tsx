import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenAdminSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      role="status"
      aria-label="Loading Lead Gen Ops dashboard"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-3 w-96 max-w-full" />
      </div>
      <Skeleton className="h-14 w-full" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Skeleton className="h-[360px]" />
        <Skeleton className="h-[360px]" />
      </div>
      <Skeleton className="h-[360px]" />
    </div>
  );
}
