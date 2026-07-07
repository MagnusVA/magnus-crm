import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenAdminSkeleton() {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      role="status"
      aria-label="Loading Lead Gen Ops dashboard"
    >
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-44" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-8 w-72 max-w-full" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-3 w-28" />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-[420px]" />
      <Skeleton className="h-[360px]" />
      <Skeleton className="h-14" />
    </div>
  );
}
