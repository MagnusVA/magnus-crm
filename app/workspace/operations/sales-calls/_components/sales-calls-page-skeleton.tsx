import { Skeleton } from "@/components/ui/skeleton";
import { PageBand } from "@/app/workspace/_components/page-band";
import { TextPlaceholder } from "@/app/workspace/_components/text-placeholder";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { SalesFigures } from "./sales-figures";

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
      {/* The real band and figure zones with nothing loaded, so the band is
          the same height when the page replaces this. */}
      <PageBand
        title="Sales calls"
        description={<TextPlaceholder sample="Today · Nov 7 · Live" />}
        actions={<Skeleton className="h-[34px] w-[26rem] max-w-full bg-board-foreground/10" />}
      >
        <SalesFigures stats={undefined} mainCurrency="USD" />
      </PageBand>
      <OperationsHealthBanner />
      <CardSkeleton rows={5} />
      <div className="grid items-start gap-3.5 @5xl:grid-cols-[1fr_1.1fr] short:gap-3">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={4} />
      </div>
    </div>
  );
}
