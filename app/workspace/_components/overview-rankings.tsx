"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { mergeOverviewLeaderboard } from "@/convex/analytics/merge/overview";
import { dashboardRangeFromToday, dashboardRangePlan } from "@/lib/analyticsRange";
import { businessDateForInstant } from "@/lib/businessDay";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { ScrollMoreHint } from "@/app/workspace/closer/_components/scroll-more-hint";
import { useExpandInPlace } from "@/app/workspace/closer/_components/use-expand-in-place";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { rangePhrase, type DashboardRangeInput } from "./date-range-picker";
import { MemberAvatar } from "./member-avatar";
import type {
  LeadGenOverviewSection,
  TopDmClosersSection,
  TopQualifiersSection,
} from "./overview-dashboard-types";
import { formatDecimal, formatWholeNumber } from "./overview-formatters";
import { OverviewPartialNote, OverviewSectionState } from "./overview-section-state";
import { SectionErrorBoundary } from "./section-error-boundary";
import { ScheduleHoursLink, teamHref } from "@/app/workspace/operations/_components/team-links";

// Overview's three rankings (DESIGN.md, The Ranking Card): each names its
// leader at full size, then the rest as ruled rows, ranked per scheduled
// hour. "Show all" loads the whole ranking into the same card.

type RankingKind = "lead_gen" | "qualifiers" | "dm_closers";

/** One ranked person, whatever team they are on. */
type RankedPerson = {
  id: string;
  name: string;
  avatar: (size: "default" | "lg") => ReactNode;
  /** "42 submissions"; the hours follow as a link to the person's week. */
  meta: string;
  /** Scheduled hours in the range; 0 when the person has no schedule. */
  hours: number;
  /** The person's week in Team (a member-card alias). */
  scheduleHref: string;
  /** Output per scheduled hour; null when the person has no schedule. */
  rate: number | null;
};

const MAX_TOP_ROWS = 5;

/** The meta line: what they did, then "6 h scheduled" linked to their week (nothing when there's no schedule; the rate says so). */
function PersonMeta({ person }: { person: RankedPerson }) {
  return (
    <>
      {person.meta}
      {person.hours > 0 ? (
        <>
          {" · "}
          <ScheduleHoursLink href={person.scheduleHref} hours={person.hours} name={person.name} />
        </>
      ) : null}
    </>
  );
}

function count(value: number, one: string, many = one) {
  return `${formatWholeNumber(value)} ${value === 1 ? one : many}`;
}

function crmAvatar(id: string, name: string, source: "crm_user" | "dm_closer") {
  function RankedAvatar(size: "default" | "lg") {
    return <MemberAvatar identity={{ id, name, source }} size={size} />;
  }
  return RankedAvatar;
}

function slackAvatar(name: string, imageUrl: string | null) {
  function RankedSlackAvatar(size: "default" | "lg") {
    return (
      <Avatar size={size} aria-hidden="true" className="bg-muted">
        <AvatarImage src={imageUrl ?? undefined} alt="" />
        <AvatarFallback className="font-medium uppercase">{name.slice(0, 1)}</AvatarFallback>
      </Avatar>
    );
  }
  return RankedSlackAvatar;
}

type LeadGenWorker = Extract<LeadGenOverviewSection, { status: "ready" }>["data"]["topWorkers"][number];
type QualifierRow = Extract<TopQualifiersSection, { status: "ready" }>["data"]["rows"][number];
type DmCloserRow = Extract<TopDmClosersSection, { status: "ready" }>["data"]["rows"][number];

function leadGenPerson(worker: LeadGenWorker): RankedPerson {
  return {
    id: worker.workerId,
    name: worker.displayName,
    avatar: crmAvatar(worker.workerId, worker.displayName, "crm_user"),
    meta: count(worker.submissions, "submission", "submissions"),
    hours: worker.scheduledHours,
    scheduleHref: teamHref.worker(worker.workerId, null),
    rate: worker.leadsPerHour,
  };
}

function qualifierPerson(row: QualifierRow): RankedPerson {
  const name = row.displayName ?? row.slackUserId;
  return {
    id: row.slackUserId,
    name,
    avatar: slackAvatar(name, row.avatarUrl),
    meta: `${formatWholeNumber(row.uniqueOpportunityCount)} qualified · ${formatWholeNumber(row.booked)} booked`,
    hours: row.scheduledHours,
    scheduleHref: teamHref.slackUser(row.slackUserId, null),
    rate: row.qualifiedPerHour,
  };
}

function dmCloserPerson(row: DmCloserRow): RankedPerson {
  return {
    id: row.dmCloserId,
    name: row.displayName,
    avatar: crmAvatar(row.dmCloserId, row.displayName, "dm_closer"),
    meta: [row.teamName, `${formatWholeNumber(row.booked)} booked`].filter(Boolean).join(" · "),
    hours: row.scheduledHours,
    scheduleHref: teamHref.dmCloser(row.dmCloserId, null),
    rate: row.bookedPerHour,
  };
}

function Rate({ rate, size }: { rate: number | null; size: "lead" | "row" }) {
  if (rate === null) {
    return <span className="text-[13px] whitespace-nowrap text-muted-foreground">No schedule</span>;
  }
  return (
    <span
      className={cn(
        "font-condensed leading-none font-semibold whitespace-nowrap tabular-nums",
        size === "lead" ? "text-[32px]" : "text-[17px]",
      )}
    >
      {formatDecimal(rate)}
      <span className="ml-0.5 font-sans text-[13px] font-medium text-muted-foreground">/h</span>
    </span>
  );
}

/** The ranked rows: the leader at full size when they have a rate, then the rest. */
function RankingList({ people, label }: { people: RankedPerson[]; label: string }) {
  const first = people[0];
  // A leader only when their rate reads above 0.0 at one decimal; nobody is
  // crowned for a quiet day.
  const leads = first !== undefined && first.rate !== null && first.rate >= 0.05;
  return (
    <ol aria-label={label} className="flex flex-col">
      {people.map((person, index) =>
        index === 0 && leads ? (
          <li
            key={person.id}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b px-4 py-3.5 last:border-b-0"
          >
            {person.avatar("lg")}
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">
                <span className="sr-only">1. </span>
                {person.name}
              </p>
              <p className="text-[13px] text-muted-foreground">
                <PersonMeta person={person} />
              </p>
            </div>
            <Rate rate={person.rate} size="lead" />
          </li>
        ) : (
          <li
            key={person.id}
            className="grid grid-cols-[1.125rem_minmax(0,1fr)_auto] items-center gap-2.5 border-b px-4 py-[7px] last:border-b-0"
          >
            <span className="font-condensed text-[15px] font-semibold text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0">
              <p className="truncate font-medium">{person.name}</p>
              <p className="truncate text-[13px] text-muted-foreground">
                <PersonMeta person={person} />
              </p>
            </div>
            <Rate rate={person.rate} size="row" />
          </li>
        ),
      )}
    </ol>
  );
}

export function RankingSkeleton({ rows = MAX_TOP_ROWS }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading the ranking" className="flex flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3.5 last:border-b-0">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-1 flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-8 w-14" />
      </div>
      {Array.from({ length: rows - 1 }, (_, index) => (
        <div key={index} className="flex h-[52px] items-center gap-2.5 border-b px-4 last:border-b-0">
          <Skeleton className="h-3 w-3" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

type ExpandedLeaderboard = Exclude<
  FunctionReturnType<typeof api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows>,
  { status: "rebuilding" }
>;

function expandedPeople(data: ExpandedLeaderboard): RankedPerson[] {
  if (data.kind === "lead_gen") return data.rows.map(leadGenPerson);
  if (data.kind === "qualifiers") return data.rows.map(qualifierPerson);
  return data.rows.map(dmCloserPerson);
}

function ExpandedRanking({ kind, range, label }: { kind: RankingKind; range: DashboardRangeInput; label: string }) {
  const { setting } = useBusinessDay();
  const now = useNow();
  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse (docs/agents/reporting.md).
  const todayBusinessDate = businessDateForInstant(now, setting);
  const report = useAnalyticsReport({
    page: "overview",
    reportId: "overview.leaderboard",
    plan: dashboardRangePlan(range, todayBusinessDate),
    filters: { kind },
    live: api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
    liveArgs: { kind, range },
    todayArgs: { kind, range: dashboardRangeFromToday(range, todayBusinessDate) },
    merge: mergeOverviewLeaderboard,
  });
  const data = report.data;

  if (data === undefined) {
    return (
      <>
        {report.source === "warehouse" ? (
          <div className="border-b px-4 py-3">
            <AnalyticsFreshnessLine items={[report.freshness]} />
          </div>
        ) : null}
        <RankingSkeleton rows={8} />
      </>
    );
  }
  if ("status" in data) return <OverviewSectionState section={{ status: "rebuilding", message: null }} emptyTitle="" />;
  if (data.cappedMessage) {
    return <OverviewSectionState section={{ status: "capped", message: data.cappedMessage }} emptyTitle="" />;
  }
  if (data.rows.length === 0) {
    return <OverviewSectionState section={{ status: "empty", message: null }} emptyTitle={`Nobody to rank ${rangePhrase(range)}.`} />;
  }
  return (
    <>
      {data.truncated ? <OverviewPartialNote /> : null}
      <RankingList people={expandedPeople(data)} label={`All of ${label}`} />
    </>
  );
}

type RankingSection = LeadGenOverviewSection | TopQualifiersSection | TopDmClosersSection;

/**
 * One ranking: a ruled card titled with the team and its unit, the leader
 * and the next four, and a footer with the team's total and Show all.
 */
function RankingCard({
  kind,
  title,
  unit,
  label,
  emptyTitle,
  section,
  people,
  total,
  range,
}: {
  kind: RankingKind;
  title: string;
  unit: string;
  /** The list's accessible name, such as "Lead generators". */
  label: string;
  /** What is absent, without the range: "No submissions" (+ " today."). */
  emptyTitle: string;
  section: RankingSection;
  people: RankedPerson[];
  total: { label: string; value: number } | null;
  range: DashboardRangeInput;
}) {
  const listId = `ranking-${kind}`;
  // A ranking where nobody did anything says so instead of ranking zeros.
  const quiet =
    section.status === "empty" ||
    (section.status === "ready" && (total?.value ?? 0) === 0 && people.every((person) => !person.rate));
  // The top list holds at most five; only a full one can have more behind it.
  const canExpand = section.status === "ready" && !quiet && people.length >= MAX_TOP_ROWS;
  // Show all keeps the card at its five-row height and scrolls the rest
  // inside it, so the rankings beside it keep theirs (DESIGN.md, Today's
  // cards keep their height).
  const { expanded, toggle, listProps, hintProps } = useExpandInPlace<HTMLDivElement>(canExpand);

  return (
    <DetailCard title={title} meta={unit} className="min-w-0">
      <div className="relative">
      <div
        id={listId}
        {...listProps}
        {...(expanded ? { role: "region", "aria-label": `All of ${label}`, tabIndex: 0 } : {})}
        className={cn(
          listProps.className,
          "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        )}
      >
        {section.status === "ready" && !quiet ? (
          expanded ? (
            <SectionErrorBoundary
              key={JSON.stringify(range)}
              sectionName="expanded leaderboard"
              fallback={<OverviewSectionState section={{ status: "error", message: null }} emptyTitle="" />}
            >
              <ExpandedRanking kind={kind} range={range} label={label} />
            </SectionErrorBoundary>
          ) : (
            <>
              {section.truncated ? <OverviewPartialNote /> : null}
              <RankingList people={people.slice(0, MAX_TOP_ROWS)} label={label} />
            </>
          )
        ) : (
          <OverviewSectionState
            section={quiet || section.status === "ready" ? { status: "empty", message: null } : section}
            emptyTitle={`${emptyTitle} ${rangePhrase(range)}.`}
          />
        )}
      </div>
      <ScrollMoreHint {...hintProps} />
      </div>
      {section.status === "ready" && !quiet ? (
        <div className="mt-auto flex min-h-10 items-center gap-1.5 border-t px-4 text-[13px] text-muted-foreground">
          {total ? (
            <>
              {total.label}
              <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
                {formatWholeNumber(total.value)}
              </span>
            </>
          ) : null}
          {canExpand ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={toggle}
              className={cn(detailLinkClass, "ml-auto text-[13px]")}
            >
              {expanded ? `Show top ${MAX_TOP_ROWS}` : "Show all"}
            </button>
          ) : null}
        </div>
      ) : null}
    </DetailCard>
  );
}

export function LeadGenRanking({ section, range }: { section: LeadGenOverviewSection; range: DashboardRangeInput }) {
  return (
    <RankingCard
      kind="lead_gen"
      title="Lead Gen"
      unit="Submissions per scheduled hour"
      label="Lead generators"
      emptyTitle="No submissions"
      section={section}
      people={section.status === "ready" ? section.data.topWorkers.map(leadGenPerson) : []}
      total={section.data ? { label: "Total submissions", value: section.data.totalSubmissions } : null}
      range={range}
    />
  );
}

export function QualifiersRanking({ section, range }: { section: TopQualifiersSection; range: DashboardRangeInput }) {
  return (
    <RankingCard
      kind="qualifiers"
      title="Top Qualifiers"
      unit="Qualified per scheduled hour"
      label="Slack qualifiers"
      emptyTitle="Nobody qualified"
      section={section}
      people={section.status === "ready" ? section.data.rows.map(qualifierPerson) : []}
      total={section.data ? { label: "Total qualified", value: section.data.totalQualified } : null}
      range={range}
    />
  );
}

export function DmClosersRanking({ section, range }: { section: TopDmClosersSection; range: DashboardRangeInput }) {
  return (
    <RankingCard
      kind="dm_closers"
      title="Top DM Closers"
      unit="Bookings per scheduled hour"
      label="DM closers"
      emptyTitle="No bookings by DM closers"
      section={section}
      people={section.status === "ready" ? section.data.rows.map(dmCloserPerson) : []}
      total={section.data ? { label: "Total booked", value: section.data.totalBooked } : null}
      range={range}
    />
  );
}
