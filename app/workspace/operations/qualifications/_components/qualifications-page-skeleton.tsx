import { Skeleton } from "@/components/ui/skeleton";

export function QualificationsPageSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Loading qualified leads"
    >
      <div className="flex flex-col gap-2 border-b pb-3">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-72 max-w-full" />
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
