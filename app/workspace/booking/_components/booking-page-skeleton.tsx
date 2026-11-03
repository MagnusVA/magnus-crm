import { Skeleton } from "@/components/ui/skeleton";
import { BOOKING_ROOT_CLASS } from "./booking-layout";

/** The band at its real height (title, description, tabs) and one card. */
export function BookingPageSkeleton() {
  return (
    <div className={BOOKING_ROOT_CLASS} role="status" aria-label="Loading booking setup">
      <div className="h-[150px] rounded-xl bg-board" />
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="h-11 border-b border-border" />
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="flex h-[88px] items-center gap-4 border-b border-border px-4 last:border-b-0">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
