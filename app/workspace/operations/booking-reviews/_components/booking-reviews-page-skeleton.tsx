import { Skeleton } from "@/components/ui/skeleton";

export function BookingReviewsPageSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading booking reviews">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
