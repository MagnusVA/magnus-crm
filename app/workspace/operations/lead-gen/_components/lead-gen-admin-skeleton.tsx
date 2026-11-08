import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { PageBand } from "@/app/workspace/_components/page-band";
import { LeadGenTotals } from "./lead-gen-band";
import { ConversionStripSkeleton } from "./prospect-conversion-section";
import { SpecialistsSkeleton } from "./specialists-section";
import { PostsSkeleton } from "./top-posts-by-team";

// Lead Gen's first load, at the page's real layout and heights.

function BoardBar({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block animate-pulse rounded-md bg-board-foreground/10 align-middle motion-reduce:animate-none ${className}`}
    />
  );
}

export function LeadGenAdminSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading Lead Gen"
      className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3"
    >
      <PageBand
        title="Lead Gen"
        description={<BoardBar className="h-3.5 w-72 max-w-full" />}
        actions={<BoardBar className="h-[34px] w-[22rem] max-w-full" />}
      >
        {/* The real totals with nothing loaded (the default range is today),
            then the source tabs' row: 40px of tabs under a 1px rule. */}
        <LeadGenTotals totals={undefined} specialistCount={undefined} rangePhrase="today" reloading={false} />
        <div className="-mx-4 flex h-[41px] items-center gap-[22px] border-t border-board-line px-4 @lg:-mx-[18px] @lg:px-[18px]">
          <BoardBar className="h-3 w-20" />
          <BoardBar className="h-3 w-16" />
          <BoardBar className="h-3 w-24" />
        </div>
      </PageBand>
      <DetailCard title="Prospect conversion" className="@container/conv min-w-0">
        <ConversionStripSkeleton />
      </DetailCard>
      <div className="grid items-start gap-3.5 @5xl:grid-cols-[minmax(0,1fr)_24rem] short:gap-3">
        <DetailCard title="Specialists" className="min-w-0">
          <SpecialistsSkeleton />
        </DetailCard>
        <DetailCard title="Top posts & reels" className="min-w-0">
          <PostsSkeleton />
        </DetailCard>
      </div>
    </div>
  );
}
