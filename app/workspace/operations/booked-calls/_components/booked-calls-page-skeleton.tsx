import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { PageBand } from "@/app/workspace/_components/page-band";
import { Skeleton } from "@/components/ui/skeleton";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { BookedCallsBandLinks } from "./booked-calls-band-links";
import { DmClosersByTeamSkeleton } from "./dm-closers-by-team";
import { TeamGoalsSkeletonRows } from "./team-goals-card";

// Booked calls' first load, at the page's real layout and heights.

export function BookedCallsPageSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading booked calls"
      className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3"
    >
      <PageBand
        title="Booked Calls"
        description={
          // The band sets its description in a <p>, so the placeholder is an inline span.
          <span
            aria-hidden="true"
            className="inline-block h-3 w-64 max-w-full animate-pulse rounded-md bg-board-foreground/10 align-middle"
          />
        }
        actions={<Skeleton className="h-[34px] w-[30rem] max-w-full bg-board-foreground/10" />}
      >
        <BookedCallsBandLinks />
      </PageBand>
      <OperationsHealthBanner />
      <DetailCard title="Team goals" className="min-w-0">
        <TeamGoalsSkeletonRows />
      </DetailCard>
      <div className="grid min-w-0 items-start gap-3.5 @5xl:grid-cols-[1.2fr_1fr] short:gap-3">
        <DmClosersByTeamSkeleton />
        <DetailCard title="Bookings" className="min-w-0">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="flex h-[54px] items-center gap-3 border-b px-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-64 max-w-full" />
              </div>
              <Skeleton className="h-3.5 w-16" />
            </div>
          ))}
        </DetailCard>
      </div>
    </div>
  );
}
