"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FreshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import { REPORT_TERMS, termHelp } from "@/lib/reporting/definitions";
import { ReportExportMenu } from "../../_components/report-export-menu";
import { FigureZone, REPORT_PAGE, REPORT_PAIR, ReportBand, ReportFigures } from "../../_components/report-ui";
import { AgingCard, BookingReviewsCard, OwedCard, StagesCard } from "./pipeline-cards";
import {
  buildPipelineDocument,
  countFigure,
  formatCount,
  formatDays,
  openDealCount,
  owedFigure,
  stagesProof,
} from "./pipeline-shape";

// Pipeline (docs/reviews/reports-overhaul.html §12): right now, with no
// range. The reader is live Convex, and the minute clock is passed as `asOf`
// so the ages move on while the page stays open.

const LIVE: FreshnessSummary = { kind: "line", label: "Live", live: true, delayedSince: null };

export function PipelinePageClient() {
  usePageTitle("Pipeline");
  const now = useNow();
  const { setting } = useBusinessDay();
  const live = useQuery(api.reports.pipeline.getPipelineNow, { asOf: now });
  // The minute's new arguments keep the last answer on screen until the next one lands.
  const kept = useKeptWhileLoading(live, "now");
  const data = kept.data;
  const today = businessDateForInstant(now, setting);
  const dayLine = businessDayDisclosure(setting);
  const owed = data ? owedFigure(data.owed) : null;

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Pipeline"
        range="Right now"
        freshness={data ? LIVE : null}
        sentence="Open deals and what they owe, not a range"
        actions={
          <ReportExportMenu
            page="pipeline"
            startDate={today}
            endDate={today}
            buildDocument={() => (data ? buildPipelineDocument(data, { generatedAt: Date.now(), dayLine }) : null)}
          />
        }
        figures={
          <ReportFigures columns="grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-5">
            <FigureZone
              label="Open deals"
              help="Deals at Qualified, Booked, Call held or Follow-up right now."
              figure={data ? formatCount(openDealCount(data)) : undefined}
              proof={data ? stagesProof(data) : undefined}
            />
            <FigureZone
              label={REPORT_TERMS.notRecorded.label}
              help={termHelp("notRecorded")}
              figure={owed ? owed.figure : undefined}
              proof={owed?.proof}
            />
            <FigureZone
              label="No next step"
              help="Open deals with no call booked and no task open."
              figure={data ? countFigure(data.noNextStep) : undefined}
              proof={data ? (data.noNextStep.partial ? "at least this many open deals" : "open deals with no task or call") : undefined}
            />
            <FigureZone
              label="Overdue tasks"
              help="Open reminders whose time has passed."
              figure={data ? countFigure(data.overdueTasks) : undefined}
              proof={data ? (data.overdueTasks.count === 0 ? "nothing overdue" : "reminders past their time") : undefined}
            />
            <FigureZone
              label="Booking reviews"
              help="Bookings waiting for someone to check who they belong to."
              figure={data ? countFigure(data.bookingReviews) : undefined}
              proof={
                data
                  ? data.bookingReviews.oldest
                    ? `oldest waiting ${formatDays(data.bookingReviews.oldest.ageDays)}`
                    : "none waiting"
                  : undefined
              }
            />
          </ReportFigures>
        }
      />

      <div className={REPORT_PAIR}>
        <StagesCard data={data} />
        <BookingReviewsCard data={data} />
      </div>
      <div className={REPORT_PAIR}>
        <AgingCard data={data} />
        <OwedCard data={data} />
      </div>
    </div>
  );
}
