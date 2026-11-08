"use client";

import { Fragment } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { MemberAvatar } from "@/app/workspace/_components/member-avatar";
import { eventTime } from "@/app/workspace/operations/qualifications/_components/qualifications-format";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, ReportNote, RowsSkeleton, StatusWord } from "../../_components/report-ui";

// Each setter's events, ranked: one 44px ruled line per setter from
// @3xl/setters, two lines narrower. Setters with no events fold into one
// slate line, as on the Split Desk.

type Report = FunctionReturnType<typeof api.reporting.slackQualifications.getQualificationReport>;
export type SetterContributionRow = Report["users"][number];

const count = (value: number) => value.toLocaleString();

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function SetterName({ row }: { row: SetterContributionRow }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <MemberAvatar identity={row.setter} size="sm" />
      <span className="min-w-0 truncate font-semibold">{row.displayName}</span>
      {row.isDeleted ? <StatusWord tone="done">Deactivated</StatusWord> : null}
    </span>
  );
}

export function SetterContributionCard({
  rows,
  settersTruncated,
  rangePhrase,
  reloading,
}: {
  rows: SetterContributionRow[] | undefined;
  settersTruncated: boolean;
  rangePhrase: string;
  reloading: boolean;
}) {
  const { setting } = useBusinessDay();
  const now = useNow();
  const active = rows?.filter((row) => row.qualificationEventCount > 0) ?? [];
  const quiet = rows?.filter((row) => row.qualificationEventCount === 0) ?? [];
  const last = (row: SetterContributionRow) => (row.lastQualifiedAt === null ? "—" : eventTime(row.lastQualifiedAt, now, setting));
  const duplicates = (row: SetterContributionRow) => row.duplicatePendingEvents + row.alreadyBookedEvents;

  return (
    <ReportCard
      title="Setter contributions"
      meta={rows && rows.length > 0 ? "Ranked by events" : undefined}
      container="@container/setters"
      reloading={reloading}
    >
      {rows === undefined ? (
        <RowsSkeleton rows={6} label="Loading setter contributions" />
      ) : (
        <>
          {settersTruncated ? (
            <ReportNote lead="Capped.">
              Showing the first 500 Slack setters. Ask engineering before relying on totals for a larger directory.
            </ReportNote>
          ) : null}
          {rows.length === 0 ? (
            <SectionEmpty title="No Slack setters yet.">Setters appear here after they submit or sync from Slack.</SectionEmpty>
          ) : active.length === 0 ? (
            <SectionEmpty title={`No setter qualified a lead ${rangePhrase}.`} />
          ) : (
            <>
              <table className="hidden w-full border-collapse @3xl/setters:table">
                <caption className="sr-only">Slack qualification events by setter</caption>
                <thead>
                  <tr className="border-b">
                    <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                      Setter
                    </th>
                    <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Events</th>
                    <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Unique opps</th>
                    <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Created</th>
                    <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Duplicate or booked</th>
                    <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>Share</th>
                    <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>Last event</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((row) => (
                    <tr key={row.slackUserId} className="h-11 border-b last:border-b-0">
                      <th scope="row" className="w-[34%] max-w-0 py-1.5 pr-3 pl-4 text-left font-normal">
                        <SetterName row={row} />
                      </th>
                      <td className={cn("px-2.5 text-right", FIGURE_15)}>{count(row.qualificationEventCount)}</td>
                      <td className={cn("px-2.5 text-right", FIGURE_15)}>{count(row.uniqueSlackOpportunityCount)}</td>
                      <td className={cn("px-2.5 text-right", FIGURE_15, row.createdOpportunityEvents === 0 && "text-muted-foreground")}>
                        {count(row.createdOpportunityEvents)}
                      </td>
                      <td className={cn("px-2.5 text-right", FIGURE_15, duplicates(row) === 0 && "text-muted-foreground")}>
                        {count(duplicates(row))}
                      </td>
                      <td className={cn("px-2.5 text-right", FIGURE_15)}>{formatPercent(row.contributionShare)}</td>
                      <td className={cn("pr-4 pl-2.5 text-right whitespace-nowrap", FIGURE_15, "text-muted-foreground")}>{last(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <ul aria-label="Slack qualification events by setter" className="flex flex-col @3xl/setters:hidden">
                {active.map((row) => (
                  <li key={row.slackUserId} className="flex flex-col gap-0.5 border-b px-4 py-2.5 last:border-b-0">
                    <span className="flex items-center gap-3">
                      <span className="min-w-0 flex-1">
                        <SetterName row={row} />
                      </span>
                      <span className={cn(FIGURE_15, "shrink-0")}>
                        {count(row.qualificationEventCount)}
                        <span className="sr-only"> events</span>
                      </span>
                    </span>
                    <p className="pl-[34px] text-[13px] text-muted-foreground">
                      {[
                        `${count(row.uniqueSlackOpportunityCount)} unique`,
                        `${count(row.createdOpportunityEvents)} created`,
                        `${count(duplicates(row))} duplicate or booked`,
                        row.contributionShare === null ? null : `${formatPercent(row.contributionShare)} share`,
                        row.lastQualifiedAt === null ? null : last(row),
                      ]
                        .filter(Boolean)
                        .map((part, index) => (
                          <Fragment key={index}>
                            {index > 0 ? " · " : null}
                            <span className="whitespace-nowrap">{part}</span>
                          </Fragment>
                        ))}
                    </p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {quiet.length > 0 && active.length > 0 ? (
            <p className="border-t px-4 py-2.5 text-[13px] text-muted-foreground">
              No events from <span className="font-medium text-foreground">{quiet.map((row) => row.displayName).join(", ")}</span>
            </p>
          ) : null}
        </>
      )}
    </ReportCard>
  );
}
