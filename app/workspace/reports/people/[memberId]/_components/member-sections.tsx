"use client";

import { usePaginatedQuery } from "convex/react";
import type { ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CloserCall } from "@/convex/reports/people";
import type { PeopleRoleItem } from "@/convex/reports/peopleRoles";
import type { MemberRole } from "@/convex/reports/member";
import type { CrmRole } from "@/convex/lib/roleMapping";
import { termHelp } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import {
  AXIS_PROPS,
  ChartLegend,
  ChartSkeleton,
  FIGURE_15,
  GRID_PROPS,
  LABEL,
  ReportCard,
  ReportNote,
  RowsSkeleton,
  SINGLE_SERIES,
  STAGE_FILL,
  StatusWord,
  seriesColor,
  type StatusTone,
} from "../../../_components/report-ui";
import { LIST_PAGE_SIZE, PageRows, ReportPager, useCursorPages, usePagedRows } from "../../../_components/report-paging";
import type { MemberFigure } from "../../_components/people-data";
import { dayLabel, formatCount, formatMoney, formatWhen, humanize } from "../../_components/report-format";
import { RowLink, ROLE_LABEL } from "../../_components/report-parts";

// The member report's pieces (docs/reviews/reports-overhaul.html §10, lower
// part): each role's figures with the team median beside them, a by-day
// chart, the role's items, and the work log. Lists show one page at a time,
// so each card's height comes from the page size, not from the range.

/**
 * The days chart beside its list: the row stretches both cards to the
 * taller one (REPORT_PAIR starts its items), so the chart has no hole under it.
 */
export const DAYS_PAIR_ROW = "items-stretch";

/** Where a call, deal or person opens for this viewer, or null when they can't open it. */
export function recordLinks(viewerRole: CrmRole) {
  const admin = viewerRole === "tenant_master" || viewerRole === "tenant_admin";
  const canOpen = admin || viewerRole === "closer";
  return {
    meeting: (id: string) => (admin ? `/workspace/pipeline/meetings/${id}` : viewerRole === "closer" ? `/workspace/closer/meetings/${id}` : null),
    deal: (id: string | null) => (id && canOpen ? `/workspace/opportunities/${id}` : null),
    person: (id: string | null) => (id && canOpen ? `/workspace/leads/${id}` : null),
  };
}
export type RecordLinks = ReturnType<typeof recordLinks>;

export function FiguresCard({
  role,
  figures,
  loading,
  reloading,
  showTeam,
  note,
}: {
  role: MemberRole;
  figures: MemberFigure[];
  loading: boolean;
  reloading: boolean;
  showTeam: boolean;
  note?: ReactNode;
}) {
  return (
    <ReportCard
      title={ROLE_LABEL[role]}
      meta={showTeam ? "Team median beside each figure" : undefined}
      container="@container/figures"
      reloading={reloading}
    >
      {note}
      {loading ? (
        <RowsSkeleton rows={2} rowHeight="h-20" label={`Loading ${ROLE_LABEL[role].toLowerCase()} figures`} />
      ) : (
        <dl className="-mr-px -mb-px grid grid-cols-2 @2xl/figures:grid-cols-3 @5xl/figures:grid-cols-4">
          {figures.map((figure) => (
            <div key={figure.key} className="flex min-w-0 flex-col gap-1 border-r border-b px-4 py-3">
              <dt className={LABEL}>{figure.term ? <HelpTip tip={termHelp(figure.term)}>{figure.label}</HelpTip> : figure.label}</dt>
              <dd className="flex flex-col gap-0.5">
                <span
                  className={cn(
                    "font-condensed text-[26px] leading-none font-semibold tabular-nums",
                    figure.value === null && "text-muted-foreground",
                  )}
                >
                  {figure.display}
                </span>
                {figure.proof ? <span className="text-[13px] text-muted-foreground">{figure.proof}</span> : null}
                {showTeam && figure.team !== undefined ? (
                  <span className="text-[13px] text-muted-foreground">
                    Team median <span className={cn(FIGURE_15, "text-foreground")}>{figure.team}</span>
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </ReportCard>
  );
}

export type DaySeries = { key: string; label: string; color: string };

/**
 * One role's days as stacked bars. The chart fills the card's height, never
 * less than 220px, so it stands as tall as the list card beside it.
 */
export function DaysCard({
  title,
  meta,
  series,
  days,
  phrase,
  reloading,
}: {
  title: string;
  meta: string;
  series: DaySeries[];
  days: ReadonlyArray<{ dayKey: string; [key: string]: unknown }> | undefined;
  phrase: string;
  reloading: boolean;
}) {
  const config = Object.fromEntries(series.map((entry) => [entry.key, { label: entry.label, color: entry.color }])) satisfies ChartConfig;
  const data = (days ?? []).map((day) => ({
    day: dayLabel(day.dayKey),
    ...Object.fromEntries(series.map((entry) => [entry.key, Number(day[entry.key] ?? 0)])),
  })) as Array<Record<string, string | number>>;
  const any = data.some((day) => series.some((entry) => Number(day[entry.key] ?? 0) > 0));
  return (
    // The body grows to the card's stretched height (`container` is the
    // body's class list), and the chart's box fills what's left.
    <ReportCard title={title} meta={meta} reloading={reloading} container="@container flex flex-1 flex-col">
      {!days ? (
        <ChartSkeleton height="h-[220px]" label={`Loading ${title.toLowerCase()}`} />
      ) : !any ? (
        <SectionEmpty title={`Nothing ${phrase}.`} />
      ) : (
        <>
          <ChartLegend items={series.map((entry) => ({ key: entry.key, label: entry.label, color: entry.color }))} />
          {/* ResponsiveContainer needs a parent with a real height: the box is
              at least 232px (220 + its 12px foot) and grows with the card, and
              the chart is pinned inside it, so it measures a definite size. */}
          <div className="relative min-h-[232px] flex-1">
            <ChartContainer config={config} className="absolute inset-x-2 top-0 bottom-3 aspect-auto">
              <BarChart accessibilityLayer data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="day" {...AXIS_PROPS} tickMargin={8} minTickGap={16} />
                <YAxis allowDecimals={false} width={36} {...AXIS_PROPS} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {series.map((entry) => (
                  <Bar key={entry.key} dataKey={entry.key} stackId="day" fill={`var(--color-${entry.key})`} maxBarSize={44} isAnimationActive={false} />
                ))}
              </BarChart>
            </ChartContainer>
          </div>
        </>
      )}
    </ReportCard>
  );
}

export const CLOSER_DAY_SERIES: DaySeries[] = [
  { key: "held", label: "Held", color: STAGE_FILL.held },
  { key: "noShow", label: "No-show", color: STAGE_FILL.lost },
  { key: "notRecorded", label: "Not recorded", color: STAGE_FILL.owed },
];
export const ROLE_DAY_SERIES: Record<Exclude<MemberRole, "closer">, DaySeries[]> = {
  setter: [{ key: "qualifications", label: "Qualified", color: SINGLE_SERIES }],
  dm_closer: [{ key: "bookings", label: "Bookings", color: SINGLE_SERIES }],
  lead_gen: [
    { key: "captures", label: "Captures", color: SINGLE_SERIES },
    { key: "resparks", label: "Resparks", color: seriesColor(1) },
  ],
};

const CALL_STATUS: Record<CloserCall["status"], { word: string; tone: StatusTone }> = {
  held: { word: "Held", tone: "done" },
  no_show: { word: "No-show", tone: "failed" },
  not_recorded: { word: "Not recorded", tone: "owed" },
  upcoming: { word: "Scheduled", tone: "live" },
  canceled: { word: "Canceled", tone: "done" },
  moved: { word: "Moved", tone: "done" },
};

const MEETING_STATUS: Record<string, { word: string; tone: StatusTone }> = {
  held: { word: "Held", tone: "done" },
  no_show: { word: "No-show", tone: "failed" },
  scheduled: { word: "Scheduled", tone: "live" },
  canceled: { word: "Canceled", tone: "done" },
};

/** The deal's outcome as a word in its stage ink. */
export function OutcomeWord({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-[13px] text-muted-foreground">No deal</span>;
  return (
    <span
      className={cn(
        "font-condensed text-[13px] font-bold tracking-[0.08em] whitespace-nowrap uppercase",
        outcome === "won" ? "text-stage-won-ink" : outcome === "lost" ? "text-stage-lost-ink" : "text-muted-foreground",
      )}
    >
      {outcome === "open" ? "Open" : humanize(outcome)}
    </span>
  );
}

function ItemRow({ children }: { children: ReactNode }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b px-4 py-2 last:border-b-0">{children}</li>
  );
}

/** A phone closer's calls, newest first. */
export function CallsList({
  calls,
  partial,
  currency,
  links,
  phrase,
  reloading,
}: {
  calls: CloserCall[] | undefined;
  partial: boolean;
  currency: string;
  links: RecordLinks;
  phrase: string;
  reloading: boolean;
}) {
  const { rows: shown, pager } = usePagedRows(calls ?? [], { pageSize: LIST_PAGE_SIZE });
  return (
    <ReportCard
      title="Calls"
      // Beside a taller chart the body grows, so the pager stays at the foot.
      container="@container flex-1"
      meta={calls ? `${formatCount(calls.length)} · newest first` : undefined}
      reloading={reloading}
      footer={calls ? <ReportPager pager={pager} noun="calls" /> : undefined}
    >
      {!calls ? (
        <RowsSkeleton rows={6} label="Loading calls" />
      ) : calls.length === 0 ? (
        <SectionEmpty title={`No calls ${phrase}.`} />
      ) : (
        <>
          {partial ? <ReportNote lead="Capped.">Only the newest 300 calls are listed.</ReportNote> : null}
          <PageRows pager={pager}>
            <ul aria-label="Calls" className="flex flex-col">
              {shown.map((call) => {
                const status = CALL_STATUS[call.status];
                const paid = call.paidMinor.find((entry) => entry.currency.toUpperCase() === currency);
                const others = call.paidMinor.filter((entry) => entry.currency.toUpperCase() !== currency);
                return (
                  <ItemRow key={call.meetingId}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <RowLink href={links.meeting(call.meetingId)} className={cn(FIGURE_15, "font-medium")}>
                          {formatWhen(call.scheduledAt)}
                        </RowLink>
                        <RowLink href={links.deal(call.opportunityId)} className="truncate font-semibold">
                          {call.leadName}
                        </RowLink>
                      </p>
                      <p className="truncate text-[13px] text-muted-foreground">
                        {call.programName} · {call.callType === "follow_up" ? "Follow-up call" : "First call"}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="flex items-center gap-2">
                        <StatusWord tone={status.tone}>{status.word}</StatusWord>
                        <OutcomeWord outcome={call.dealOutcome} />
                      </span>
                      <span className={cn(FIGURE_15, !paid && "text-muted-foreground")}>
                        {paid ? formatMoney(paid.paidMinor, currency) : "—"}
                        {others.map((entry) => (
                          <span key={entry.currency} className="ml-1.5 text-[13px] text-muted-foreground">
                            {formatMoney(entry.paidMinor, entry.currency)}
                          </span>
                        ))}
                      </span>
                    </div>
                  </ItemRow>
                );
              })}
            </ul>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}

const ITEM_TITLE: Record<Exclude<MemberRole, "closer">, string> = {
  setter: "Qualifications",
  dm_closer: "Bookings",
  lead_gen: "Captures",
};

/** A setter's qualifications, a DM closer's bookings or a lead generator's captures, newest first. */
export function ItemsList({
  role,
  items,
  links,
  phrase,
  reloading,
}: {
  role: Exclude<MemberRole, "closer">;
  items: PeopleRoleItem[] | undefined;
  links: RecordLinks;
  phrase: string;
  reloading: boolean;
}) {
  const { rows: shown, pager } = usePagedRows(items ?? [], { pageSize: LIST_PAGE_SIZE });
  return (
    <ReportCard
      title={ITEM_TITLE[role]}
      // Beside a taller chart the body grows, so the pager stays at the foot.
      container="@container flex-1"
      meta={items ? `${formatCount(items.length)} · newest first` : undefined}
      reloading={reloading}
      footer={items ? <ReportPager pager={pager} noun={ITEM_TITLE[role].toLowerCase()} /> : undefined}
    >
      {!items ? (
        <RowsSkeleton rows={6} label={`Loading ${ITEM_TITLE[role].toLowerCase()}`} />
      ) : items.length === 0 ? (
        <SectionEmpty title={`No ${ITEM_TITLE[role].toLowerCase()} ${phrase}.`} />
      ) : (
        <>
          {items.length >= 300 ? <ReportNote lead="Capped.">Only the newest 300 are listed.</ReportNote> : null}
          <PageRows pager={pager}>
            <ul aria-label={ITEM_TITLE[role]} className="flex flex-col">
              {shown.map((item) => {
                const meeting = role === "dm_closer" ? MEETING_STATUS[item.result] : undefined;
                return (
                  <ItemRow key={item.id}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className={cn(FIGURE_15, "font-medium")}>{formatWhen(item.at)}</span>
                        <RowLink href={links.person(item.leadId) ?? links.deal(item.opportunityId)} className="truncate font-semibold">
                          {item.personName}
                        </RowLink>
                      </p>
                      <p className="truncate text-[13px] text-muted-foreground">
                        {role === "dm_closer" && item.scheduledAt !== null
                          ? `Call ${formatWhen(item.scheduledAt)}`
                          : humanize(item.result)}
                        {item.opportunityId && links.deal(item.opportunityId) ? (
                          <>
                            {" · "}
                            <RowLink href={links.deal(item.opportunityId)}>Open deal</RowLink>
                          </>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {meeting ? (
                        item.scheduledAt !== null && links.meeting(item.id) ? (
                          <RowLink href={links.meeting(item.id)}>
                            <StatusWord tone={meeting.tone}>{meeting.word}</StatusWord>
                          </RowLink>
                        ) : (
                          <StatusWord tone={meeting.tone}>{meeting.word}</StatusWord>
                        )
                      ) : null}
                      {role !== "lead_gen" ? <OutcomeWord outcome={item.outcome} /> : null}
                    </div>
                  </ItemRow>
                );
              })}
            </ul>
          </PageRows>
        </>
      )}
    </ReportCard>
  );
}

/** Everything the member did in the range, newest first, from the event log. */
export function WorkLog({
  window,
  teamMemberId,
  actorUserId,
  links,
  phrase,
}: {
  window: { startDate: number; endDate: number } | null;
  teamMemberId: Id<"teamMembers">;
  actorUserId: Id<"users"> | null;
  links: RecordLinks;
  phrase: string;
}) {
  const args = window ? { ...window, teamMemberId, ...(actorUserId ? { actorUserId } : {}) } : null;
  const list = usePaginatedQuery(api.reports.log.listMemberLog, args ?? "skip", { initialNumItems: 30 });
  // 15 a page, with one page loaded ahead; new arguments go back to the first.
  const { rows, firstLoad, pager } = useCursorPages(list, { pageSize: 15, resetKey: JSON.stringify(args) });
  const entityHref = (entityType: string, entityId: string) =>
    entityType === "meeting"
      ? links.meeting(entityId)
      : entityType === "opportunity"
        ? links.deal(entityId)
        : entityType === "lead"
          ? links.person(entityId)
          : null;
  return (
    <ReportCard
      title="Work log"
      meta="Newest first"
      footer={firstLoad ? undefined : <ReportPager pager={pager} noun="events" />}
    >
      {firstLoad ? (
        <RowsSkeleton rows={6} rowHeight="h-8" label="Loading the work log" />
      ) : rows.length === 0 ? (
        <SectionEmpty title={`Nothing logged ${phrase}.`} />
      ) : (
        <PageRows pager={pager}>
          <ul aria-label="Work log" className="flex flex-col">
            {rows.map((entry) => {
              const href = entityHref(entry.entityType, entry.entityId);
              return (
                <li key={entry._id} className="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-3 border-b px-4 py-1.5 text-[13px] last:border-b-0">
                  <span className="font-condensed text-[14px] font-semibold text-muted-foreground tabular-nums">{formatWhen(entry.occurredAt)}</span>
                  <span className="min-w-0">
                    <RowLink href={href} className="font-medium">
                      {entry.label}
                    </RowLink>
                    {entry.actorName ? <span className="text-muted-foreground"> · {entry.actorName}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </PageRows>
      )}
    </ReportCard>
  );
}
