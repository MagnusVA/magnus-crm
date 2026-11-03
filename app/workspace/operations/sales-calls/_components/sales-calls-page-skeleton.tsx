import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the page at its real container steps: the band with its
// five figure zones, Phone closers, then Programs beside Meetings.

function CardSkeleton({ rows, className }: { rows: number; className?: string }) {
  return (
    <div className={className ?? "overflow-hidden rounded-xl border bg-card"}>
      <div className="flex min-h-11 items-center border-b px-4">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="ml-auto h-3.5 w-40" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b px-4 py-2.5 last:border-b-0">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-52 max-w-full" />
          </div>
          <Skeleton className="hidden h-4 w-[45%] @3xl:block" />
        </div>
      ))}
    </div>
  );
}

export function SalesCallsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading sales calls"
      className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3"
    >
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-7 w-36 bg-board-raised" />
            <Skeleton className="h-3.5 w-80 max-w-full bg-board-raised" />
          </div>
          <Skeleton className="h-[34px] w-[26rem] max-w-full bg-board-raised" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-board-line bg-board-line @3xl:grid-cols-3 @5xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className={`flex flex-col gap-1.5 bg-board px-4 py-3 @lg:px-[18px] ${index === 4 ? "col-span-2 @3xl:col-span-2 @5xl:col-span-1" : ""}`}
            >
              <Skeleton className="h-3 w-16 bg-board-raised" />
              <Skeleton className="h-8 w-20 bg-board-raised" />
              <Skeleton className="h-3.5 w-36 max-w-full bg-board-raised" />
            </div>
          ))}
        </div>
      </div>
      <CardSkeleton rows={5} />
      <div className="grid items-start gap-3.5 @5xl:grid-cols-[1fr_1.1fr] short:gap-3">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={4} />
      </div>
    </div>
  );
}
