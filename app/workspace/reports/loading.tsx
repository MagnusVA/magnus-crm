import { Skeleton } from "@/components/ui/skeleton";

export default function ReportsLoading() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading reports"
    >
      {/* Date controls placeholder */}
      <div className="flex gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24" />
        ))}
      </div>
      {/* KPI summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      {/* Main content area */}
      <Skeleton className="h-64 rounded-lg" />
    </div>
  );
}
