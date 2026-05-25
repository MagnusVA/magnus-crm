import { Skeleton } from "@/components/ui/skeleton";

export function LeadGenCaptureSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-xl flex-col gap-5"
      role="status"
      aria-label="Loading Lead Gen capture"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-11 w-full" />
    </div>
  );
}
