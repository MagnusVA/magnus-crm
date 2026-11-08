"use client";

import { format } from "date-fns";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { getMemberDisplayName, type MemberAvatarIdentity } from "@/app/workspace/_components/member-avatar";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import type { DealPosition } from "@/convex/opportunities/stages";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, RowsSkeleton, StatusWord, type StatusTone } from "../../_components/report-ui";
import { formatCount } from "./pipeline-figures";

// The stalest open deals, oldest first: one 44px line each from
// `@3xl/stale` (lead, stage word, closer, age, booked call), two lines
// narrower. The count itself is the band's Stale deals figure.

type StaleOpp = {
  opportunityId: string;
  position: DealPosition;
  ageDays: number;
  nextMeetingAt: number | null;
  assignedCloser: MemberAvatarIdentity | null;
  leadName: string | null;
};

/** The stage as one status word, coloured by meaning (rule 6). */
const POSITION_TONE: Record<DealPosition, StatusTone> = {
  qualified: "live",
  booked: "live",
  call_held: "live",
  follow_up: "live",
  won: "done",
  lost: "failed",
};

const ROW = "@3xl/stale:grid-cols-[minmax(0,1fr)_7rem_minmax(0,11rem)_6.5rem_7rem]";

function callDate(timestamp: number) {
  const date = new Date(timestamp);
  return format(date, date.getFullYear() === new Date().getFullYear() ? "MMM d" : "MMM d, yyyy");
}

function ageWords(ageDays: number) {
  const rounded = Math.round(ageDays);
  return `${formatCount(rounded)} day${rounded === 1 ? "" : "s"}`;
}

export function StalePipelineList({ staleCount, staleOpps }: { staleCount: number | undefined; staleOpps: StaleOpp[] | undefined }) {
  const loaded = staleOpps !== undefined && staleCount !== undefined;
  const meta = !loaded
    ? undefined
    : staleOpps.length < staleCount
      ? `Stalest ${formatCount(staleOpps.length)} of ${formatCount(staleCount)} · oldest first`
      : staleOpps.length > 0
        ? "Oldest first"
        : undefined;

  return (
    <ReportCard title="Stale deals" meta={meta} container="@container/stale">
      {!loaded ? (
        <RowsSkeleton rows={6} label="Loading stale deals" />
      ) : staleOpps.length === 0 ? (
        <SectionEmpty title="No stale deals.">Every open deal has a call booked in the last 14 days or ahead.</SectionEmpty>
      ) : (
        <div role="table" aria-label="Stale deals, oldest first">
          <div role="row" className={cn("hidden min-h-7 items-end border-b @3xl/stale:grid", ROW)}>
            <span role="columnheader" className={cn(COLUMN_HEAD, "pl-4")}>
              Lead
            </span>
            <span role="columnheader" className={COLUMN_HEAD}>
              Stage
            </span>
            <span role="columnheader" className={COLUMN_HEAD}>
              Closer
            </span>
            <span role="columnheader" className={cn(COLUMN_HEAD, "text-right")}>
              Age
            </span>
            <span role="columnheader" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
              Booked call
            </span>
          </div>
          {staleOpps.map((opp) => {
            const lead = opp.leadName || "Unknown";
            const closer = opp.assignedCloser ? getMemberDisplayName(opp.assignedCloser) : "Unassigned";
            const call = opp.nextMeetingAt === null ? "None" : callDate(opp.nextMeetingAt);
            return (
              <div
                key={opp.opportunityId}
                role="row"
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b px-4 py-2 last:border-b-0 @3xl/stale:min-h-11 @3xl/stale:gap-y-0 @3xl/stale:px-0 @3xl/stale:py-0",
                  ROW,
                )}
              >
                <span role="cell" className="min-w-0 truncate font-medium @3xl/stale:pl-4" title={lead}>
                  {lead}
                </span>
                <span role="cell" className="text-right @3xl/stale:px-2.5 @3xl/stale:text-left">
                  <StatusWord tone={POSITION_TONE[opp.position]}>{dealPositionLabel(opp.position)}</StatusWord>
                </span>
                <span
                  role="cell"
                  className={cn(
                    "col-span-2 min-w-0 truncate text-[13px] text-muted-foreground @3xl/stale:col-span-1 @3xl/stale:px-2.5 @3xl/stale:text-sm",
                    opp.assignedCloser ? "@3xl/stale:text-foreground" : null,
                  )}
                >
                  {closer}
                  <span className="@3xl/stale:hidden">
                    {" · "}
                    {ageWords(opp.ageDays)} old · booked call {call === "None" ? "none" : call}
                  </span>
                </span>
                <span role="cell" className={cn(FIGURE_15, "hidden px-2.5 text-right @3xl/stale:block")}>
                  {ageWords(opp.ageDays)}
                </span>
                <span
                  role="cell"
                  className={cn(
                    FIGURE_15,
                    "hidden pr-4 pl-2.5 text-right @3xl/stale:block",
                    opp.nextMeetingAt === null && "text-muted-foreground",
                  )}
                >
                  {call}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </ReportCard>
  );
}
