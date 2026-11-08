import { Skeleton } from "@/components/ui/skeleton";
import { PageBand } from "@/app/workspace/_components/page-band";

// Stands in for the list at its real container steps: the band's title and
// line, then the card's title row, column heads and 44px rows (two lines
// below @3xl).

export function BookingReviewsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading booking reviews"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      {/* The band's words don't depend on data, so it shows as it will. */}
      <PageBand
        title="Booking Reviews"
        description="Bookings whose email, phone or Instagram handle match more than one person."
      />
      <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-11 items-center gap-2.5 border-b border-border px-4">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3.5 w-44" />
        </div>
        <div className="hidden min-h-7 border-b border-border @3xl:block" />
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            className="flex min-h-[55px] items-center gap-4 border-b border-border px-4 py-2 last:border-b-0 @3xl:h-11 @3xl:min-h-0 @3xl:py-0"
          >
            <Skeleton className="hidden h-3.5 w-24 @3xl:block" />
            <div className="flex flex-1 flex-col gap-1.5 @3xl:flex-row @3xl:gap-4">
              <Skeleton className="h-4 w-40 max-w-full" />
              <Skeleton className="h-3 w-56 max-w-full @3xl:hidden" />
              <Skeleton className="hidden h-3.5 w-[40%] @3xl:block" />
            </div>
            <Skeleton className="h-3.5 w-12" />
          </div>
        ))}
      </div>
    </div>
  );
}
