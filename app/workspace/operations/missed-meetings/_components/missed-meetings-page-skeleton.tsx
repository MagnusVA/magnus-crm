import { Skeleton } from "@/components/ui/skeleton";

export function MissedMeetingsPageSkeleton() {
  return (
    <div
      className="flex flex-col gap-4"
      role="status"
      aria-label="Loading no-shows and cancellations"
    >
      <div className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton className="h-8 w-[520px] max-w-full" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-52" />
      </div>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-[480px] w-full" />
    </div>
  );
}
