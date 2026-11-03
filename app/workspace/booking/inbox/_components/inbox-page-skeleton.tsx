import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { BOOKING_ROOT } from "../../_components/booking-band";
import { BookingBandSkeleton } from "../../_components/booking-band-skeleton";
import { INBOX_DESCRIPTION, INBOX_DESK } from "./inbox-layout";

/** The inbox before the coverage loads: the band, then the desk with its queue and focused card. */
export function InboxPageSkeleton() {
  return (
    <div className={BOOKING_ROOT} role="status" aria-label="Loading the inbox">
      <BookingBandSkeleton active="Inbox" description={INBOX_DESCRIPTION} />
      <Card className={INBOX_DESK}>
        <div className="order-2 flex max-h-[22rem] min-h-0 flex-col overflow-hidden border-t @4xl:order-none @4xl:max-h-none @4xl:border-t-0 @4xl:border-r">
          <div className="flex min-h-11 items-center border-b px-4">
            <Skeleton className="h-4 w-28" />
          </div>
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="flex flex-col gap-1.5 border-b px-4 py-2.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
        <div className="order-1 flex flex-col gap-4 p-4 @4xl:order-none @4xl:p-5">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-9" />
            ))}
          </div>
          <Skeleton className="mt-2 h-24" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-56" />
            <Skeleton className="h-9 w-36" />
          </div>
        </div>
      </Card>
    </div>
  );
}
