import { Skeleton } from "@/components/ui/skeleton";

export function RevenueReportSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading revenue report"
    >
      {/* Date controls placeholder */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* Trend chart */}
      <Skeleton className="h-[260px] rounded-lg" />
      {/* Closer breakdown table + deal distribution */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
      {/* Top deals table */}
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}
