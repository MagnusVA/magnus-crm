import { Skeleton } from "@/components/ui/skeleton";

export function LeadsReportSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading leads report"
    >
      {/* Date controls placeholder */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      {/* Conversion table */}
      <Skeleton className="h-48 rounded-lg" />
      {/* Form insights */}
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
