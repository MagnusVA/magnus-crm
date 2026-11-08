import { Skeleton } from "@/components/ui/skeleton";
import { PageBand } from "@/app/workspace/_components/page-band";
import { TextPlaceholder } from "@/app/workspace/_components/text-placeholder";

// Stands in for the page at its real container steps: the band with its
// title, range line, picker and the 40px kind tabs, then the Deals card's
// title row, column heads and 44px rows (two lines below @3xl of the card).

export function MissedMeetingsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading no-shows and cancellations"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      {/* The real band, so the title and range lines are as tall as the
          page's; the kind tabs' row is 40px of tabs under a 1px rule. */}
      <PageBand
        title="No-shows & Cancellations"
        description={<TextPlaceholder sample="Last 30 days · Oct 9 – Nov 7 · Deals closed as a no-show" />}
        actions={<Skeleton className="h-[34px] w-[30rem] max-w-full bg-board-foreground/10" />}
      >
        <div className="-mx-4 flex h-[41px] items-center gap-[22px] border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
          <Skeleton className="h-3.5 w-12 bg-board-raised" />
          <Skeleton className="h-3.5 w-20 bg-board-raised" />
          <Skeleton className="h-3.5 w-20 bg-board-raised" />
        </div>
      </PageBand>

      <div className="@container/missed min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
          <Skeleton className="mr-auto h-4 w-40" />
          <Skeleton className="h-5 w-52" />
        </div>
        <div className="hidden min-h-7 border-b border-border @3xl/missed:block" />
        {Array.from({ length: 10 }, (_, index) => (
          <div
            key={index}
            className="flex min-h-[55px] flex-col justify-center gap-1.5 border-b border-border px-4 py-2 last:border-b-0 @3xl/missed:h-11 @3xl/missed:min-h-0 @3xl/missed:flex-row @3xl/missed:items-center @3xl/missed:gap-3 @3xl/missed:py-0"
          >
            <Skeleton className="hidden h-3.5 w-[7.5rem] @3xl/missed:block" />
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-48 max-w-full @3xl/missed:hidden" />
            <Skeleton className="hidden h-3.5 w-[30%] @3xl/missed:block" />
            <Skeleton className="ml-auto hidden h-3.5 w-14 @3xl/missed:block" />
          </div>
        ))}
      </div>
    </div>
  );
}
