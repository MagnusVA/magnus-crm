import { Skeleton } from "@/components/ui/skeleton";

export default function BookingReviewLoading() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading booking review">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-16 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-80 rounded-xl" />
      </div>
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
