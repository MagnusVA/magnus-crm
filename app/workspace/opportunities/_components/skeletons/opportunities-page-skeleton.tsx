import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function OpportunitiesPageSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading opportunities"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-32" />
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-8 w-full lg:max-w-md" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-7 w-40" />
          </div>
          <Skeleton className="h-8 w-full max-w-3xl" />
        </div>
      </Card>

      <div className="overflow-hidden rounded-lg border">
        <div className="border-b bg-muted/50 px-4 py-3">
          <div className="flex gap-4">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="hidden h-4 w-24 md:block" />
            <Skeleton className="hidden h-4 w-28 lg:block" />
            <Skeleton className="hidden h-4 w-24 lg:block" />
          </div>
        </div>
        <div className="flex flex-col">
          {Array.from({ length: 8 }).map((_, index) => (
            <div
              key={index}
              className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0"
            >
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-5 w-20 rounded-full" />
              <Skeleton className="hidden h-4 w-28 md:block" />
              <Skeleton className="hidden h-4 w-24 lg:block" />
              <Skeleton className="hidden h-4 w-24 lg:block" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
