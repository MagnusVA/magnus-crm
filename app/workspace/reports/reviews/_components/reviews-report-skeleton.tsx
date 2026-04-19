import { Skeleton } from "@/components/ui/skeleton";

export function ReviewsReportSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading review ops report"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>

      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 5 }).map((_, index) => (
          <Skeleton key={index} className="h-8 w-24 rounded-lg" />
        ))}
        <Skeleton className="h-8 w-44 rounded-lg" />
      </div>

      <Skeleton className="h-20 rounded-xl" />

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-36" />
          <Skeleton className="h-5 w-20 rounded-4xl" />
        </div>
        <Skeleton className="h-56 rounded-xl" />
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-5 w-28 rounded-4xl" />
        </div>
        <Skeleton className="h-16 rounded-xl" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-30 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <Skeleton className="h-[320px] rounded-xl" />
          <Skeleton className="h-[320px] rounded-xl" />
        </div>
        <Skeleton className="h-[320px] rounded-xl" />
      </div>
    </div>
  );
}
