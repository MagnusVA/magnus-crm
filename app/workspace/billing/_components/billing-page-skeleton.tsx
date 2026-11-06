import { Skeleton } from "@/components/ui/skeleton";

// Stands in for the queue and the payment page at their real heights and
// container steps: the band (with its tabs or figure row), then the
// Payments card, or the facts, proof and history beside the comments rail.

const PAGE = "@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3";
const CARD = "min-w-0 overflow-hidden rounded-xl border bg-card";
const BONE = "bg-board-raised";

function BandTitle({ back = false }: { back?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 px-4 pt-3.5 pb-3 @lg:px-[18px] @lg:pt-4">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {back ? <Skeleton className={`h-4 w-16 ${BONE}`} /> : null}
        <Skeleton className={`h-7 w-48 ${BONE}`} />
        <Skeleton className={`h-3.5 w-96 max-w-full ${BONE}`} />
      </div>
      <Skeleton className={`h-[34px] ${back ? "w-80" : "w-28"} max-w-full ${BONE}`} />
    </div>
  );
}

function CardHead({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-3 border-b px-4 py-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-3.5 w-36" />
      {wide ? <Skeleton className="ml-auto h-[30px] w-full @4xl:w-[36rem]" /> : null}
    </div>
  );
}

function QueueSkeleton() {
  return (
    <div role="status" aria-label="Loading billing queue" className={PAGE}>
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <BandTitle />
        <div className="flex h-10 items-center gap-[22px] border-t border-board-line px-4 @lg:px-[18px]">
          <Skeleton className={`h-3 w-28 ${BONE}`} />
          <Skeleton className={`h-3 w-20 ${BONE}`} />
          <Skeleton className={`h-3 w-20 ${BONE}`} />
        </div>
      </div>
      <div className={`@container/payments ${CARD}`}>
        <CardHead wide />
        <div className="hidden min-h-7 border-b @2xl/payments:block" />
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="flex min-h-[52px] items-center gap-4 border-b px-4 py-2 last:border-b-0">
            <Skeleton className="hidden h-4 w-24 @2xl/payments:block" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40 max-w-full" />
              <Skeleton className="h-3 w-52 max-w-full" />
            </div>
            <Skeleton className="hidden h-3.5 w-28 @2xl/payments:block" />
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-16 @2xl/payments:hidden" />
            </div>
            <Skeleton className="hidden h-3 w-20 @2xl/payments:block" />
          </div>
        ))}
      </div>
    </div>
  );
}

function FactCardSkeleton({ rows }: { rows: number }) {
  return (
    <div className={`mb-3.5 break-inside-avoid ${CARD}`}>
      <CardHead />
      <div className="flex flex-col px-4 py-2">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid h-[31px] grid-cols-[120px_minmax(0,1fr)] items-center gap-3">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3.5 w-36 max-w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function RowsCardSkeleton({ rows }: { rows: number }) {
  return (
    <div className={CARD}>
      <CardHead />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-11 items-center gap-4 border-b px-4 py-2.5 last:border-b-0">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3.5 w-56 max-w-full flex-1" />
          <Skeleton className="hidden h-3.5 w-28 @xl:block" />
        </div>
      ))}
    </div>
  );
}

function PaymentSkeleton() {
  return (
    <div role="status" aria-label="Loading billing payment" className={PAGE}>
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <BandTitle back />
        <div className="grid grid-cols-2 gap-px border-t border-board-line bg-board-line @4xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 bg-board px-4 py-3 @lg:px-[18px] @lg:pb-3.5">
              <Skeleton className={`h-3 w-14 ${BONE}`} />
              <Skeleton className={`h-8 w-28 ${BONE}`} />
              <Skeleton className={`h-3.5 w-36 max-w-full ${BONE}`} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid min-w-0 items-start gap-x-[18px] gap-y-3.5 @4xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-1">
          <div className="@container/facts">
            <div className="-mb-3.5 gap-3.5 @xl/facts:columns-2">
              <FactCardSkeleton rows={8} />
              <FactCardSkeleton rows={3} />
              <FactCardSkeleton rows={2} />
              <FactCardSkeleton rows={5} />
              <FactCardSkeleton rows={2} />
            </div>
          </div>
          <div className={CARD}>
            <CardHead />
            <div className="bg-background p-3">
              <Skeleton className="h-[min(420px,52vh)] w-full" />
            </div>
          </div>
        </div>
        <div className="min-w-0 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1">
          <div className={CARD}>
            <CardHead />
            <div className="flex flex-col gap-3 px-4 py-3">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3.5 @4xl:col-start-1">
          <RowsCardSkeleton rows={6} />
          <RowsCardSkeleton rows={3} />
        </div>
      </div>
    </div>
  );
}

export function BillingPageSkeleton({ detail = false }: { detail?: boolean }) {
  return detail ? <PaymentSkeleton /> : <QueueSkeleton />;
}
