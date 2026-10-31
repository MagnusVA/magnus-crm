"use client";

import { Card } from "@/components/ui/card";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { OpportunityDetailSheet } from "./opportunity-detail-sheet";
import { OpportunitySheetProvider } from "./opportunity-sheet-context";
import { PersonDealCards } from "./person-deal-cards";
import { PersonRecordCard } from "./person-record-card";
import { BookingAnswersCard, SourceCard } from "./person-rail-cards";
import { PersonStrip } from "./person-strip";
import { PersonTimelineCard } from "./person-timeline-card";

/**
 * The person page, as the approved sketch lays it out: the person as one
 * board row, then a card per deal, beside a rail of booking answers, source,
 * the person's timeline and the rest of the record. In a narrow container
 * it is one column: deals, then the rail in that order.
 */
export function EntityDetailFrame() {
  return (
    <OpportunitySheetProvider>
      <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6">
        <Section what="this person">
          <PersonStrip />
        </Section>
        <div className="grid grid-cols-1 items-start gap-3.5 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:gap-x-[1.125rem] @5xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-3.5">
            <Section what="the deals">
              <PersonDealCards />
            </Section>
          </div>
          <aside aria-label="About this person" className="flex min-w-0 flex-col gap-3.5">
            <Section what="the booking answers">
              <BookingAnswersCard />
            </Section>
            <Section what="the source">
              <SourceCard />
            </Section>
            <Section what="the timeline">
              <PersonTimelineCard />
            </Section>
            <Section what="the record">
              <PersonRecordCard />
            </Section>
          </aside>
        </div>
      </div>
      <OpportunityDetailSheet />
    </OpportunitySheetProvider>
  );
}

/** A section that fails says so in place, and the rest of the page stays. */
function Section({
  what,
  children,
}: {
  what: string;
  children: React.ReactNode;
}) {
  return (
    <SectionErrorBoundary
      sectionName={what}
      fallback={
        <Card className="gap-0 py-0">
          <SectionError what={what} />
        </Card>
      }
    >
      {children}
    </SectionErrorBoundary>
  );
}
