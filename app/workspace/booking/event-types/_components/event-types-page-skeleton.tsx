import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BOOKING_ROOT } from "../../_components/booking-band";
import {
  COL_LINK,
  COL_PAYMENT,
  COL_PROGRAM,
  COL_USED_IN,
  EVENT_TYPES_DESCRIPTION,
  ROW_GRID,
} from "./event-types-layout";

/** Event types before the coverage loads: the band with its filter row, then the table's rows. */
export function EventTypesPageSkeleton() {
  return (
    <div className={BOOKING_ROOT} role="status" aria-label="Loading event types">
      
      <Card className="@container/et gap-0 py-0">
        <div className="flex min-h-11 items-center border-b px-4">
          <Skeleton className="h-4 w-40" />
        </div>
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className={cn(ROW_GRID, "min-h-11 border-b px-4 py-2 last:border-b-0")}>
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
            <Skeleton className={cn(COL_PROGRAM, "h-4 w-2/3")} />
            <Skeleton className={cn(COL_USED_IN, "h-4 w-1/2")} />
            <Skeleton className={cn(COL_LINK, "h-4 w-16")} />
            <Skeleton className={cn(COL_PAYMENT, "h-4 w-10")} />
            <Skeleton className="size-6" />
          </div>
        ))}
      </Card>
    </div>
  );
}
