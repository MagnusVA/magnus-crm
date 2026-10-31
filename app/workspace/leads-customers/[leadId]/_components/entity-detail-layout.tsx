"use client";

import { Card } from "@/components/ui/card";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { OpportunityDetailSheet } from "./opportunity-detail-sheet";
import { OpportunitySheetProvider } from "./opportunity-sheet-context";
import { PersonDealCards } from "./person-deal-cards";
import { PersonCard } from "./person-card";
import { BookingAnswersCard } from "./person-rail-cards";
import { PersonStrip } from "./person-strip";
import { PersonTimelineCard } from "./person-timeline-card";

/**
 * The person page at a glance (.impeccable/mocks/person-glance.html): the
 * person as one board row; the open deals with their calls, the closed
 * deals folded into a list, and the booking answers beside the timeline;
 * one dense person card on the right. The page responds to its own width
 * (DESIGN.md, Responsive rules): from @4xl the person card takes a 360px
 * column and the answers and timeline sit side by side; narrower, it is one
 * column in the order strip, deals, answers, timeline, person.
 */
export function EntityDetailFrame() {
  return (
    <OpportunitySheetProvider>
      <div className="@container mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6 short:gap-3">
        <Section what="this person">
          <PersonStrip />
        </Section>
        <div className="grid grid-cols-1 items-start gap-3.5 short:gap-3 @4xl:grid-cols-[minmax(0,1fr)_360px] @4xl:gap-x-[1.125rem]">
          <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
            <Section what="the deals">
              <PersonDealCards />
            </Section>
            <div className="grid grid-cols-1 items-start gap-3.5 short:gap-3 @4xl:grid-cols-2">
              <Section what="the booking answers">
                <BookingAnswersCard />
              </Section>
              <Section what="the timeline">
                <PersonTimelineCard />
              </Section>
            </div>
          </div>
          <Section what="this person's details">
            <PersonCard />
          </Section>
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
