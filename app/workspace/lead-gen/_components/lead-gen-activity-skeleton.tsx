import { Skeleton } from "@/components/ui/skeleton";
import { PageBand } from "@/app/workspace/_components/page-band";
import { ActivitySubmissionsCardSkeleton } from "./activity-submissions-card";
import { ActivityZones } from "./activity-zones";
import { ACTIVITY_ROOT } from "./setter-ui";

/** My activity at its real heights: the band with the picker and five zones, then the Submissions card. */
export function LeadGenActivitySkeleton() {
  return (
    <div className={ACTIVITY_ROOT} role="status" aria-label="Loading My activity">
      <PageBand
        title="My activity"
        description={
          <span aria-hidden="true" className="inline-block h-3 w-44 animate-pulse rounded-md bg-board-raised align-middle motion-reduce:animate-none" />
        }
        actions={
          <div className="flex items-center gap-2 @max-xl:w-full">
            <Skeleton className="h-[34px] w-64 max-w-full bg-board-raised" />
            <Skeleton className="h-[34px] w-10 bg-board-raised @xl:w-32" />
          </div>
        }
      >
        <ActivityZones summary={undefined} />
      </PageBand>
      <ActivitySubmissionsCardSkeleton />
    </div>
  );
}
