"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { plural } from "@/app/workspace/team/_components/team-ui";
import {
  BarList,
  FigureZone,
  FigureUnit,
  REPORT_PAIR,
  ReportCard,
  ReportFigures,
  RowsSkeleton,
} from "@/app/workspace/reports/_components/report-ui";

// The summary: who acted, as the band's figure zones, and what happened, as
// two ruled bar cards (most frequent events, reminder outcomes).

type ActivitySummary = FunctionReturnType<typeof api.reporting.activityFeed.getActivitySummary>;

const ADMIN_ROLES = new Set(["tenant_admin", "tenant_master"]);

function closerFigures(summary: ActivitySummary, days: number) {
  const closers = summary.actorBreakdown
    .filter((actor) => actor.actorRole === "closer")
    .toSorted((left, right) => right.count - left.count || left.actorName.localeCompare(right.actorName));
  const total = closers.reduce((sum, actor) => sum + actor.count, 0);
  return {
    mostActive: closers[0] ?? null,
    closerCount: closers.length,
    days,
    perCloserPerDay: closers.length > 0 ? total / closers.length / days : null,
  };
}

const count = (value: number) => value.toLocaleString();

/** EVENTS · CLOSERS · ADMINS · AUTOMATIC · PER CLOSER / DAY, in the band. */
export function ActivityFigures({
  summary,
  days,
  rangePhrase,
  reloading,
}: {
  summary: ActivitySummary | undefined;
  /** Business days in the range the summary was loaded for. */
  days: number;
  rangePhrase: string;
  reloading: boolean;
}) {
  const closers = summary ? closerFigures(summary, days) : null;
  const pipeline = summary?.bySource.pipeline ?? 0;
  const system = summary?.bySource.system ?? 0;
  const admins = summary ? summary.actorBreakdown.filter((actor) => ADMIN_ROLES.has(actor.actorRole)).length : 0;
  const people = summary ? summary.actorBreakdown.filter((actor) => actor.actorUserId !== "removed").length : 0;

  return (
    <ReportFigures columns="grid-cols-2 @3xl:grid-cols-5" reloading={reloading}>
      <FigureZone
        className="col-span-2 @3xl:col-span-1"
        label="Events"
        figure={summary ? count(summary.totalEvents) : undefined}
        proof={
          summary === undefined
            ? undefined
            : summary.isTruncated
              ? "Capped at 10,000 · narrow the range"
              : summary.totalEvents === 0
                ? `No activity ${rangePhrase}`
                : `${plural(people, "person", "people")} acted`
        }
      />
      <FigureZone
        label="By closers"
        figure={summary ? count(summary.bySource.closer ?? 0) : undefined}
        proof={
          closers?.mostActive
            ? `Most: ${closers.mostActive.actorName} · ${count(closers.mostActive.count)}`
            : "No closer activity"
        }
      />
      <FigureZone
        label="By admins"
        figure={summary ? count(summary.bySource.admin ?? 0) : undefined}
        proof={admins > 0 ? `${plural(admins, "admin")} acted` : "No admin activity"}
      />
      <FigureZone
        label="Automatic"
        help="Pipeline: Calendly bookings and other incoming events. System: the app's own jobs, such as expiring reminders."
        figure={summary ? count(pipeline + system) : undefined}
        proof={`${count(pipeline)} pipeline · ${count(system)} system`}
      />
      <FigureZone
        label="Per closer"
        help="Closer actions ÷ closers who acted ÷ days in the range."
        figure={
          closers === null ? undefined : closers.perCloserPerDay === null ? (
            "—"
          ) : (
            <>
              {closers.perCloserPerDay.toFixed(1)}
              <FigureUnit>/day</FigureUnit>
            </>
          )
        }
        proof={
          closers && closers.closerCount > 0
            ? `${plural(closers.closerCount, "closer")} over ${plural(closers.days, "day")}`
            : "No closer activity"
        }
      />
    </ReportFigures>
  );
}

function humanize(raw: string) {
  const text = raw.replaceAll("follow_up", "follow-up").replaceAll("no_show", "no-show").replaceAll("_", " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Most frequent events and reminder outcomes, side by side from @5xl. */
export function ActivityBreakdown({
  summary,
  rangePhrase,
  reloading,
}: {
  summary: ActivitySummary | undefined;
  rangePhrase: string;
  reloading: boolean;
}) {
  const eventTypes = summary
    ? Object.entries(summary.byEventType).toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    : [];
  const topEvents = eventTypes.slice(0, 5);
  const outcomes = summary
    ? Object.entries(summary.byOutcome)
        .filter(([, value]) => value > 0)
        .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    : [];
  const outcomeTotal = outcomes.reduce((sum, [, value]) => sum + value, 0);

  return (
    <div className={REPORT_PAIR}>
      <ReportCard
        title="Most frequent"
        meta={eventTypes.length > 5 ? `Top 5 of ${eventTypes.length} kinds` : undefined}
        container="@container/top"
        reloading={reloading}
      >
        {summary === undefined ? (
          <RowsSkeleton rows={5} label="Loading the most frequent events" />
        ) : topEvents.length === 0 ? (
          <SectionEmpty title={`No events ${rangePhrase}.`} />
        ) : (
          <BarList
            label="Most frequent events"
            labelColumn="16rem"
            rows={topEvents.map(([eventType, value]) => ({
              key: eventType,
              label: humanize(getEventLabel(eventType).verb),
              value,
              display: count(value),
            }))}
          />
        )}
      </ReportCard>
      <ReportCard
        title="Reminder outcomes"
        meta={outcomeTotal > 0 ? `${plural(outcomeTotal, "completed reminder")}` : "From completed reminders"}
        container="@container/outcomes"
        reloading={reloading}
      >
        {summary === undefined ? (
          <RowsSkeleton rows={5} label="Loading reminder outcomes" />
        ) : outcomes.length === 0 ? (
          <SectionEmpty title={`No reminders completed with an outcome ${rangePhrase}.`} />
        ) : (
          <BarList
            label="Reminder outcomes"
            labelColumn="16rem"
            rows={outcomes.map(([key, value]) => ({
              key,
              label: humanize(key.startsWith("reminder_") ? key.slice("reminder_".length) : key),
              value,
              display: count(value),
            }))}
          />
        )}
      </ReportCard>
    </div>
  );
}
