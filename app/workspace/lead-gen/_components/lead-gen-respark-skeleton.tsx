import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BandZones, RESPARK_CARD, RESPARK_ROOT, TITLE_ROW, Zone, ZoneBone } from "./respark-ui";

/**
 * The start state at its real heights: the band with its three zones, then
 * the Next batch card with its five 36px bucket rows.
 */
export function LeadGenResparkSkeleton({ label = "Loading Respark" }: { label?: string }) {
  return (
    <div className={RESPARK_ROOT} role="status" aria-label={label}>
      <div className="overflow-hidden rounded-xl bg-board dark:ring-1 dark:ring-board-foreground/10">
        <div className="dark flex flex-col gap-3 px-4 pt-3.5 @lg:px-[18px] @lg:pt-4">
          <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3">
            <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
              <Skeleton className="h-7 w-28 bg-board-raised" />
              <Skeleton className="h-3.5 w-full max-w-md bg-board-raised" />
            </div>
            <Skeleton className="h-[34px] w-28 rounded-[7px] bg-board-raised" />
          </div>
          <BandZones label="Today" className="grid-cols-3">
            {["Batches today", "Entries today", "Not a fit today"].map((zone) => (
              <Zone key={zone} label={zone}>
                <ZoneBone />
              </Zone>
            ))}
          </BandZones>
        </div>
      </div>
      <div className={RESPARK_CARD}>
        <div className={TITLE_ROW}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-3.5 w-36" />
        </div>
        <div className="flex min-h-7 items-end px-4 pt-2 pb-1.5">
          <Skeleton className="h-2.5 w-28" />
        </div>
        <div className="border-t border-border">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className={cn("flex min-h-9 items-center gap-2.5 border-b border-border px-4 last:border-b-0")}>
              <Skeleton className="size-2.5 rounded-[3px]" />
              <Skeleton className="h-3.5 w-48 max-w-[60%]" />
              <Skeleton className="ml-auto h-3.5 w-10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
