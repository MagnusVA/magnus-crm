import { Skeleton } from "@/components/ui/skeleton";

// Stands in for a Whop payment's page at its real heights: the band, then
// Where it stands and Link beside the rail of What Whop reports and Not CRM
// money (one column on a narrow screen).

const PAGE = "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";
const CARD = "min-w-0 overflow-hidden rounded-xl border bg-card";
const BONE = "bg-board-raised";

function CardHead() {
  return (
    <div className="flex min-h-11 items-center gap-3 border-b px-4 py-2">
      <Skeleton className="h-4 w-36" />
    </div>
  );
}

function FactRows({ rows }: { rows: number }) {
  return (
    <div className="py-1">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid min-h-8 grid-cols-[6.875rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3.5 w-36 max-w-full" />
        </div>
      ))}
    </div>
  );
}

export function WhopPaymentSkeleton() {
  return (
    <div role="status" aria-label="Loading Whop payment" className={PAGE}>
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="flex flex-col gap-2 px-4 pt-3.5 pb-3.5 @lg:px-[18px] @lg:pt-4 @lg:pb-4">
          <Skeleton className={`h-4 w-20 ${BONE}`} />
          <Skeleton className={`h-7 w-56 max-w-full ${BONE}`} />
          <Skeleton className={`h-3.5 w-80 max-w-full ${BONE}`} />
        </div>
      </div>
      <div className="grid min-w-0 items-start gap-x-[18px] gap-y-3.5 @4xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-1 @4xl:row-start-1">
          <div className={CARD}>
            <CardHead />
            <div className="flex flex-col gap-2 px-4 py-3">
              <Skeleton className="h-4 w-72 max-w-full" />
              <Skeleton className="h-3.5 w-56 max-w-full" />
            </div>
          </div>
          <div className={CARD}>
            <CardHead />
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="flex min-h-12 items-center gap-3 border-b px-4 py-2 last:border-b-0">
                <Skeleton className="size-4 rounded-full" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3.5 w-48 max-w-full flex-1" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-2 @4xl:row-start-1">
          <div className={CARD}>
            <CardHead />
            <FactRows rows={9} />
          </div>
          <div className={CARD}>
            <CardHead />
            <div className="flex flex-col gap-2 px-4 py-3">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-24" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
