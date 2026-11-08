"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BarList, ReportCard, ReportNote, RowsSkeleton, STAGE_FILL, type BarListRow } from "../../_components/report-ui";
import type { OutcomeKey, TeamOutcomeMix } from "./team-report-types";
import { formatCount, plural } from "./team-report-formatters";

// The meetings in the range by how they ended, as ruled bars (The Programs
// Card's Bars view), coloured from the stage scale by meaning: won lime,
// lost and no-show red, follow-up teal, still to come blue, not recorded
// amber, the rest slate.

const OUTCOMES: Array<{ key: OutcomeKey; label: string; fill: string }> = [
  { key: "sold", label: "Sold", fill: STAGE_FILL.won },
  { key: "lost", label: "Lost", fill: STAGE_FILL.lost },
  { key: "follow_up", label: "Follow-up", fill: STAGE_FILL.followUp },
  { key: "dq", label: "Disqualified", fill: STAGE_FILL.held },
  { key: "no_show", label: "No-show", fill: STAGE_FILL.lost },
  { key: "canceled", label: "Canceled", fill: STAGE_FILL.held },
  { key: "rescheduled", label: "Rescheduled", fill: STAGE_FILL.booked },
  { key: "not_recorded", label: "Not recorded", fill: STAGE_FILL.owed },
  { key: "upcoming", label: "Upcoming", fill: STAGE_FILL.booked },
  { key: "scheduled", label: "Awaiting outcome", fill: STAGE_FILL.booked },
];

export function MeetingOutcomesCard({
  outcomeMix,
  asOfSync,
  rangePhrase,
  reloading,
}: {
  outcomeMix: TeamOutcomeMix | undefined;
  /** The mix reads the whole range from the reporting database, so it lags today's changes. */
  asOfSync: boolean;
  rangePhrase: string;
  reloading: boolean;
}) {
  const counts = outcomeMix?.displayOutcome;
  const total = counts ? OUTCOMES.reduce((sum, outcome) => sum + counts[outcome.key], 0) : 0;
  const rows: BarListRow[] = counts
    ? OUTCOMES.filter((outcome) => counts[outcome.key] > 0).map((outcome) => {
        const count = counts[outcome.key];
        return {
          key: outcome.key,
          label: outcome.label,
          value: count,
          fill: outcome.fill,
          display: (
            <>
              {formatCount(count)}
              <span className="ml-2 inline-block w-10 text-muted-foreground">{Math.round((count / total) * 100)}%</span>
            </>
          ),
        };
      })
    : [];

  return (
    <ReportCard
      title="Meeting outcomes"
      meta={counts && total > 0 ? plural(total, "meeting") : undefined}
      container="@container/outcomes"
      reloading={reloading}
    >
      {outcomeMix === undefined ? (
        <RowsSkeleton rows={7} label="Loading meeting outcomes" />
      ) : (
        <>
          {asOfSync ? (
            <ReportNote lead="As of the last sync.">
              A payment or reschedule today can change an earlier call&apos;s outcome, so this mix updates with each sync.
            </ReportNote>
          ) : null}
          {outcomeMix.isTruncated ? (
            <ReportNote lead="Capped.">Only the first 2,000 meetings are counted. Narrow the range for the full mix.</ReportNote>
          ) : null}
          {rows.length === 0 ? (
            <SectionEmpty title={`No meeting outcomes ${rangePhrase}.`}>
              Outcomes appear as calls in the range are held, missed or canceled.
            </SectionEmpty>
          ) : (
            <BarList rows={rows} label="Meetings by outcome" labelColumn="9rem" />
          )}
        </>
      )}
    </ReportCard>
  );
}
