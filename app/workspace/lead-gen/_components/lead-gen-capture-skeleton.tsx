import { Skeleton } from "@/components/ui/skeleton";
import { CARD } from "@/app/workspace/team/_components/team-ui";
import { cn } from "@/lib/utils";
import { CaptureBand } from "./capture-band";
import { CAPTURE_ROOT } from "./setter-ui";

/** Capture at its real heights: the band with its zones and tabs, the Origin card and the capture card. */
export function LeadGenCaptureSkeleton() {
  return (
    <div className={CAPTURE_ROOT} role="status" aria-label="Loading Capture">
      <CaptureBand day={undefined} source="instagram" />
      <div className={CARD}>
        <div className="flex min-h-11 items-center border-b border-border px-4 py-2">
          <Skeleton className="h-4 w-14" />
        </div>
        <div className="flex flex-col gap-3 px-4 py-3.5">
          <Skeleton className="h-11 w-full" />
          <div className="flex flex-col gap-1.5">
            <Skeleton className="my-[3px] h-3 w-40" />
            <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-8" />
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className={cn(CARD, "@container/capture flex flex-col gap-1.5 px-4 py-3.5")}>
        <Skeleton className="my-[3px] h-3 w-20" />
        <div className="grid gap-2 @md/capture:grid-cols-[minmax(0,1fr)_7rem]">
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
        </div>
        <Skeleton className="my-[3px] h-3 w-32" />
      </div>
    </div>
  );
}
