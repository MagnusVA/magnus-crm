import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the review page at its real container steps: the band with
// its summary, the booking card and two person cards, and the 22rem rail.

function CardBones({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={`min-w-0 overflow-hidden rounded-xl border border-border bg-card ${className ?? ""}`}>
      <div className="flex min-h-11 items-center gap-3 border-b border-border px-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3.5 w-40" />
      </div>
      <div className="flex flex-col px-4 py-2">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex min-h-8 items-center gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3.5 w-44 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function BookingReviewPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading booking review"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-28 bg-board-raised" />
            <Skeleton className="h-7 w-80 max-w-full bg-board-raised" />
            <Skeleton className="h-3.5 w-56 bg-board-raised" />
          </div>
          <Skeleton className="h-5 w-16 bg-board-raised" />
        </div>
        <div className="flex flex-col gap-2 border-t border-board-line px-4 pt-3 pb-3.5 @lg:px-[18px]">
          <Skeleton className="h-3.5 w-[44rem] max-w-full bg-board-raised" />
          <Skeleton className="h-3.5 w-[30rem] max-w-full bg-board-raised" />
        </div>
      </div>
      <div className="grid items-start gap-[18px] @4xl:grid-cols-[minmax(0,1fr)_22rem] @6xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="@container/main flex min-w-0 flex-col gap-3.5">
          <CardBones rows={4} />
          <div className="grid items-start gap-3.5 @2xl/main:grid-cols-2">
            <CardBones rows={8} />
            <CardBones rows={8} />
          </div>
        </div>
        <div className="flex flex-col gap-2.5 rounded-xl border-2 border-border bg-card p-4">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="mt-1 h-40 rounded-[7px]" />
          <Skeleton className="h-32 rounded-[7px]" />
        </div>
      </div>
    </div>
  );
}
