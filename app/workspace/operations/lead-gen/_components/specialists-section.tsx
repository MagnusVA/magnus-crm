"use client";

import { Fragment } from "react";
import { groupRowsByTeam } from "@/lib/lead-gen/team-rollup";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { MemberAvatar, getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  figureClass,
  formatCount,
  formatHours,
  formatPerHour,
  headClass,
  perHourRate,
  plural,
  reloadingClass,
} from "./lead-gen-format";
import type { ConversionReport } from "./prospect-conversion-section";
import { ScheduleHoursLink, TeamPageLink, teamHref } from "../../_components/team-links";

// Who captured them: specialists grouped by team, busiest team first, each
// with submissions, the rate per scheduled hour, and a small bar of how far
// the people they first captured went (prospects, qualified, customers).

type SpecialistRow = FunctionReturnType<typeof api.leadGen.reporting.listWorkerPerformance>[number];
type ConversionCounts = ConversionReport["rows"][number]["counts"];
type TeamOption = { _id: Id<"attributionTeams">; name: string };


function Rate({ rate }: { rate: number | null }) {
  if (rate === null) return <span className="text-[13px] whitespace-nowrap text-muted-foreground">No schedule</span>;
  return (
    <span className={cn(figureClass, "whitespace-nowrap")}>
      {formatPerHour(rate)}
      <span className="ml-0.5 font-sans text-[13px] font-medium text-muted-foreground">/h</span>
    </span>
  );
}

/**
 * How far a specialist's first captures went, as three nested fills on one
 * track: prospects (light), qualified (slate), customers (ink), each against
 * the busiest specialist's prospects so rows compare; then the counts.
 */
function FunnelBar({ counts, scale }: { counts: ConversionCounts | undefined; scale: number }) {
  if (!counts || counts.prospect === 0) {
    return <span className="text-[13px] text-muted-foreground">No first captures</span>;
  }
  const width = (value: number) => (value > 0 ? `max(2px, ${(value / scale) * 100}%)` : "0");
  return (
    <span className="flex items-center justify-end gap-2.5">
      <span aria-hidden="true" className="relative hidden h-2 w-24 shrink-0 overflow-hidden rounded-full bg-muted @2xl/spec:block">
        <span className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground/50" style={{ width: width(counts.prospect) }} />
        <span className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground" style={{ width: width(counts.qualified) }} />
        <span className="absolute inset-y-0 left-0 rounded-full bg-foreground" style={{ width: width(counts.customer) }} />
      </span>
      <span className="font-condensed text-[14px] font-semibold whitespace-nowrap tabular-nums">
        {formatCount(counts.prospect)}
        <span className="text-muted-foreground"> · </span>
        {formatCount(counts.qualified)}
        <span className="text-muted-foreground"> · </span>
        {formatCount(counts.customer)}
        <span className="sr-only">
          {" "}
          ({plural(counts.prospect, "prospect")}, {formatCount(counts.qualified)} qualified, {plural(counts.customer, "customer")})
        </span>
      </span>
    </span>
  );
}

export function SpecialistsSkeleton() {
  return (
    <div role="status" aria-label="Loading specialists" className="flex flex-col">
      <div className="h-7 border-b bg-muted/40" />
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex h-[52px] items-center gap-2.5 border-b px-4 last:border-b-0">
          <Skeleton className="size-6 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function SpecialistsSection({
  rows,
  teams,
  conversions,
  allSources,
  rangePhrase,
  reloading,
}: {
  rows: SpecialistRow[] | undefined;
  teams: TeamOption[] | undefined;
  conversions: ConversionReport | undefined;
  /** False when a source is chosen: the funnel still counts every source. */
  allSources: boolean;
  rangePhrase: string;
  reloading: boolean;
}) {
  const groups = rows === undefined ? [] : groupRowsByTeam(rows, teams);
  const totalSubmissions = groups.reduce((sum, group) => sum + group.submissions, 0);
  const totalHours = groups.reduce((sum, group) => sum + group.scheduledHours, 0);
  const funnelByWorker = new Map((conversions?.rows ?? []).map((row) => [row.workerId as string, row.counts]));
  const scale = Math.max(1, ...(conversions?.rows ?? []).map((row) => row.counts.prospect));
  const specialistCount = rows?.length ?? 0;

  return (
    <DetailCard
      title="Specialists"
      meta={allSources ? "Grouped by team · hours link to each schedule" : "Grouped by team · the funnel counts every source"}
      className="@container/spec min-w-0"
    >
      <div aria-busy={reloading} className={reloadingClass(reloading)}>
        {rows === undefined ? (
          <SpecialistsSkeleton />
        ) : rows.length === 0 ? (
          <SectionEmpty title={`No submissions ${rangePhrase}.`}>
            Specialists appear here once they capture someone.
          </SectionEmpty>
        ) : (
          <table className="w-full border-collapse">
            <caption className="sr-only">Lead gen specialists by team</caption>
            <thead className="hidden @md/spec:table-header-group">
              <tr className="border-b">
                <th scope="col" className={headClass("left")}>Specialist</th>
                <th scope="col" className={headClass()}>Submissions</th>
                <th scope="col" className={cn(headClass(), "@xl/spec:pr-2.5 pr-4")}>Per hour</th>
                <th scope="col" className={cn(headClass(), "hidden pr-4 @xl/spec:table-cell")}>
                  Prospects · qualified · customers
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <tr className="border-b bg-muted/40">
                    <th scope="rowgroup" className="h-7 py-1 pr-3 pl-4 text-left font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                      {group.teamName} · {plural(group.rows.length, "specialist")}
                      {group.teamId ? (
                        <TeamPageLink teamId={group.teamId} teamName={group.teamName} className="ml-2" />
                      ) : null}
                    </th>
                    <td className={cn("px-2.5 text-right", "font-condensed text-[14px] font-semibold tabular-nums")}>
                      {formatCount(group.submissions)}
                      <span className="block text-[13px] font-sans font-normal text-muted-foreground @md/spec:hidden">submissions</span>
                      <span className="sr-only hidden @md/spec:inline"> submissions</span>
                    </td>
                    <td className="hidden pr-4 pl-2.5 text-right @md/spec:table-cell @xl/spec:pr-2.5">
                      <Rate rate={perHourRate(group.submissions, group.scheduledHours)} />
                    </td>
                    <td className="hidden @xl/spec:table-cell" />
                  </tr>
                  {group.rows.map((row) => {
                    const name = getMemberDisplayName(row.worker);
                    return (
                      <tr key={row.workerId} className="border-b">
                        <th scope="row" className="max-w-0 py-2 pr-3 pl-4 text-left font-normal">
                          <span className="flex min-w-0 items-center gap-2.5">
                            <MemberAvatar identity={row.worker} />
                            <span className="min-w-0">
                              <span className="flex min-w-0 items-baseline gap-2">
                                <span className="truncate font-medium">{name}</span>
                                {row.isActive === false ? (
                                  <span className="shrink-0 font-condensed text-[11px] font-bold tracking-[0.1em] text-muted-foreground uppercase">
                                    Inactive
                                  </span>
                                ) : null}
                              </span>
                              <span className="block truncate text-[13px] text-muted-foreground">
                                <ScheduleHoursLink
                                  href={teamHref.worker(row.workerId)}
                                  hours={row.scheduledHours}
                                  name={name}
                                  formatHours={formatHours}
                                />
                                {/* Narrow cards drop the rate column; the rate rides in the meta. */}
                                <span className="@md/spec:hidden">
                                  {row.leadsPerHour !== null ? ` · ${formatPerHour(row.leadsPerHour)}/h` : null}
                                </span>
                              </span>
                            </span>
                          </span>
                        </th>
                        <td className={cn("px-2.5 py-2 text-right", figureClass)}>
                          {formatCount(row.submissions)}
                          <span className="block text-[13px] font-sans font-normal text-muted-foreground @md/spec:hidden">submissions</span>
                      <span className="sr-only hidden @md/spec:inline"> submissions</span>
                        </td>
                        <td className="hidden py-2 pr-4 pl-2.5 text-right @md/spec:table-cell @xl/spec:pr-2.5">
                          <Rate rate={row.leadsPerHour} />
                        </td>
                        <td className="hidden py-2 pr-4 pl-2.5 text-right @xl/spec:table-cell">
                          {conversions === undefined ? (
                            <Skeleton className="ml-auto h-3 w-24" />
                          ) : (
                            <FunnelBar counts={funnelByWorker.get(row.workerId)} scale={scale} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </Fragment>
              ))}
              <tr className="bg-muted/40">
                <th scope="row" className="py-2 pr-3 pl-4 text-left">
                  <span className="font-semibold">Total</span>
                  <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">
                    {plural(specialistCount, "specialist")}
                  </span>
                </th>
                <td className={cn("px-2.5 py-2 text-right", figureClass)}>
                  {formatCount(totalSubmissions)}
                  <span className="block text-[13px] font-sans font-normal text-muted-foreground @md/spec:hidden">submissions</span>
                      <span className="sr-only hidden @md/spec:inline"> submissions</span>
                </td>
                <td className="hidden py-2 pr-4 pl-2.5 text-right @md/spec:table-cell @xl/spec:pr-2.5">
                  <Rate rate={perHourRate(totalSubmissions, totalHours)} />
                </td>
                <td className="hidden @xl/spec:table-cell" />
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </DetailCard>
  );
}
