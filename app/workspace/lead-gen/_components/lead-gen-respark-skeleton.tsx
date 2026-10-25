import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenResparkSkeleton() {
  return (
    <div
      className="flex flex-col gap-5"
      role="status"
      aria-label="Loading Respark"
    >
      <div className="flex flex-col gap-2 border-b pb-5">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="flex flex-col gap-4 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-36" />
            <Skeleton className="h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-9 w-32" />
        </div>
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-10 w-full" />
          ))}
        </div>
        <Skeleton className="h-4 w-64" />
      </div>
    </div>
  );
}
