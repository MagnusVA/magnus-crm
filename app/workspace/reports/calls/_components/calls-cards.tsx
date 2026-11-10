"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import type { CallsSummary } from "@/convex/reports/calls";
import { termHelp } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import {
  AXIS_PROPS,
  BarList,
  ChartLegend,
  ChartSkeleton,
  COLUMN_HEAD,
  FIGURE_15,
  FIGURE_20,
  GRID_PROPS,
  ReportCard,
  ReportNote,
  RowsSkeleton,
  SINGLE_SERIES,
  STAGE_FILL,
  StatusWord,
} from "../../_components/report-ui";
import {
  dayLabel,
  formatCount,
  formatMinutes,
  formatRate,
  formatWhen,
  plural,
  rate,
} from "../../people/_components/report-format";
import { PageRows, ReportPager, usePagedRows } from "../../_components/report-paging";
import { GroupHead, RowLink } from "../../people/_components/report-parts";
import {
  attendanceRates,
  callsLedger,
  LEAD_TIME_LABEL,
  MARKER_LABEL,
  owedWords,
  reasonLabel,
  recordTiming,
  showRateWays,
} from "./calls-data";

// The Calls page's cards (docs/reviews/reports-overhaul.html §09). Each takes
// the summary (undefined while it first loads) and reports its own state.

type CardProps = { summary: CallsSummary | undefined; reloading: boolean; phrase: string };

const LEDGER_FILL: Record<string, string> = {
  moved: "color-mix(in oklab, var(--foreground) 35%, transparent)",
  canceled: "var(--chart-5)",
  upcoming: STAGE_FILL.booked,
  due: SINGLE_SERIES,
  held: STAGE_FILL.held,
  noShow: STAGE_FILL.lost,
  notRecorded: STAGE_FILL.owed,
};

export function PartialNote({ summary }: { summary: CallsSummary | undefined }) {
  return summary?.partial ? (
    <ReportNote lead="Partial.">
      Too many calls in this range to read every one live, so these counts are a lower bound. Narrow the range or the
      filters for exact counts.
    </ReportNote>
  ) : null;
}

/** Where every slot went, as two groups of bars that reconcile. */
export function LedgerCard({ summary, reloading, phrase }: CardProps) {
  const ledger = summary ? callsLedger(summary.counts) : null;
  return (
    <ReportCard
      title="Where every call went"
      meta={ledger ? plural(ledger.slots, "slot") + " on the calendar" : undefined}
      reloading={reloading}
      footer={ledger && ledger.slots > 0 ? <DetailCardFooter className="font-normal">{ledger.sentence}</DetailCardFooter> : null}
    >
      {!summary || !ledger ? (
        <RowsSkeleton rows={7} label="Loading where the calls went" />
      ) : ledger.slots === 0 ? (
        <SectionEmpty title={`No calls scheduled ${phrase}.`}>Calls appear here as people book through Calendly.</SectionEmpty>
      ) : (
        <>
          <PartialNote summary={summary} />
          <GroupHead>Slots · {formatCount(ledger.slots)}</GroupHead>
          <BarList
            label="Slots by what happened to them"
            labelColumn="9rem"
            rows={ledger.slotSteps.map((step) => ({
              key: step.key,
              label: step.label,
              value: step.value,
              display: formatCount(step.value),
              fill: LEDGER_FILL[step.key],
            }))}
          />
          <GroupHead>Calls due · {formatCount(summary.counts.due)}</GroupHead>
          <BarList
            label="Calls due by result"
            labelColumn="9rem"
            rows={ledger.dueSteps.map((step) => ({
              key: step.key,
              label: step.key === "notRecorded" ? <StatusWord tone="owed">Not recorded</StatusWord> : step.label,
              meta: step.key === "notRecorded" && step.value > 0 ? "Still owe a result" : undefined,
              value: step.value,
              display: formatCount(step.value),
              fill: LEDGER_FILL[step.key],
            }))}
          />
        </>
      )}
    </ReportCard>
  );
}

/** Four show rates, each with Recorded for the same calls beside it. */
export function ShowRateCard({ summary, reloading }: CardProps) {
  return (
    <ReportCard title="Show rate, four ways" meta="Recorded beside each: how many of those calls have a result" reloading={reloading}>
      {!summary ? (
        <RowsSkeleton rows={4} label="Loading the show rates" />
      ) : (
        <>
          <div className={cn("grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] border-b", COLUMN_HEAD, "px-4")}>
            <span className="self-end">Calls</span>
            <span className="self-end text-right">Show rate</span>
            <span className="self-end text-right">Recorded</span>
          </div>
          <ul className="flex flex-col">
            {showRateWays(summary).map((way) => (
              <li key={way.key} className="grid min-h-12 grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-center gap-x-2 border-b px-4 py-2 last:border-b-0">
                <div className="min-w-0">
                  <p className="font-medium">
                    <HelpTip tip={termHelp(way.term)}>{way.label}</HelpTip>
                  </p>
                  <p className="text-[13px] text-muted-foreground">{way.question}</p>
                </div>
                <div className="text-right">
                  <p className={cn(FIGURE_20, way.rate === null && "text-muted-foreground")}>{formatRate(way.rate)}</p>
                  <p className="text-[12px] text-muted-foreground">{way.of}</p>
                </div>
                <div className="text-right">
                  <p
                    className={cn(
                      FIGURE_15,
                      way.recordedRate === null ? "text-muted-foreground" : way.recordedRate < 0.95 && "text-warning-ink",
                    )}
                  >
                    {formatRate(way.recordedRate)}
                  </p>
                  <p className="text-[12px] text-muted-foreground">{way.recordedOf}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </ReportCard>
  );
}

/** First calls' show rate by how far ahead they were booked. */
export function LeadTimeCard({ summary, reloading, phrase }: CardProps) {
  const recorded = summary?.leadTime.reduce((sum, row) => sum + row.held + row.noShow + row.notRecorded, 0) ?? 0;
  return (
    <ReportCard title="Booked how far ahead" meta="First calls · show rate by lead time" reloading={reloading}>
      {!summary ? (
        <RowsSkeleton rows={5} label="Loading show rate by lead time" />
      ) : recorded === 0 ? (
        <SectionEmpty title={`No first calls due ${phrase}.`} />
      ) : (
        <BarList
          label="First-call show rate by booking lead time"
          labelColumn="10rem"
          rows={summary.leadTime.map((row) => {
            const rates = attendanceRates(row);
            return {
              key: row.bucket,
              label: LEAD_TIME_LABEL[row.bucket],
              meta: `${plural(rates.recorded, "call")} with a result · Recorded ${formatRate(rates.recordedRate)}`,
              value: rates.showRate ?? 0,
              display: formatRate(rates.showRate),
            };
          })}
        />
      )}
    </ReportCard>
  );
}

/** Who marked the no-shows, and the reasons given. */
export function NoShowCard({ summary, reloading, phrase }: CardProps) {
  const total = summary?.counts.noShow ?? 0;
  return (
    <ReportCard title="Who marked the no-shows" meta={summary ? plural(total, "no-show") : undefined} reloading={reloading}>
      {!summary ? (
        <RowsSkeleton rows={6} label="Loading the no-shows" />
      ) : total === 0 ? (
        <SectionEmpty title={`No no-shows ${phrase}.`} />
      ) : (
        <>
          <BarList
            label="No-shows by who marked them"
            labelColumn="9rem"
            rows={(Object.keys(MARKER_LABEL) as Array<keyof typeof MARKER_LABEL>)
              .filter((key) => key !== "unknown" || summary.noShowMarkers.unknown > 0)
              .map((key) => ({
                key,
                label: MARKER_LABEL[key],
                value: summary.noShowMarkers[key],
                display: formatCount(summary.noShowMarkers[key]),
                fill: STAGE_FILL.lost,
              }))}
          />
          <GroupHead>Why they didn&apos;t show · the reason the closer gave</GroupHead>
          <BarList
            label="No-shows by reason"
            labelColumn="9rem"
            rows={[...summary.noShowReasons]
              .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
              .map((row) => ({ key: row.reason, label: reasonLabel(row.reason), value: row.count, display: formatCount(row.count) }))}
          />
        </>
      )}
    </ReportCard>
  );
}

/** Priority and Standard scheduling side by side. */
export function ModeCard({ summary, reloading }: CardProps) {
  const modes = summary
    ? ([
        ["Priority", summary.mode.priority],
        ["Standard", summary.mode.standard],
      ] as const)
    : null;
  const rows: Array<{ label: string; value: (mode: CallsSummary["mode"]["priority"]) => string; owed?: boolean }> = [
    { label: "Calls due", value: (mode) => formatCount(attendanceRates(mode).due) },
    { label: "Held", value: (mode) => formatCount(mode.held) },
    { label: "No-show", value: (mode) => formatCount(mode.noShow) },
    { label: "Not recorded", value: (mode) => formatCount(mode.notRecorded), owed: true },
    { label: "Show rate", value: (mode) => formatRate(attendanceRates(mode).showRate) },
    { label: "Recorded", value: (mode) => formatRate(attendanceRates(mode).recordedRate) },
  ];
  return (
    <ReportCard title="Priority and Standard" meta="Scheduling mode of the booked event type" reloading={reloading}>
      {!modes ? (
        <RowsSkeleton rows={6} label="Loading scheduling modes" />
      ) : (
        <table className="w-full border-collapse">
          <caption className="sr-only">Calls by scheduling mode</caption>
          <thead>
            <tr className="border-b">
              <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                Calls
              </th>
              {modes.map(([label]) => (
                <th key={label} scope="col" className={cn(COLUMN_HEAD, "text-right last:pr-4")}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b last:border-b-0">
                <th scope="row" className="py-2 pl-4 text-left font-normal">
                  {row.label}
                </th>
                {modes.map(([label, mode]) => (
                  <td
                    key={label}
                    className={cn(FIGURE_15, "px-2.5 text-right last:pr-4", row.owed && mode.notRecorded > 0 && "text-warning-ink")}
                  >
                    {row.value(mode)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </ReportCard>
  );
}

function Fact({ label, value, proof, help }: { label: string; value: string; proof: string; help?: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b px-4 py-2.5 last:border-b-0">
      <p className="text-[13px] text-muted-foreground">{help ? <HelpTip tip={help}>{label}</HelpTip> : label}</p>
      <p className={FIGURE_20}>{value}</p>
      <p className="text-[13px] text-muted-foreground">{proof}</p>
    </div>
  );
}

/** Rebooks after a no-show, and how quickly results get recorded. */
export function HabitsCard({ summary, reloading }: CardProps) {
  const timing = summary ? recordTiming(summary.recordMinutes) : null;
  const counts = summary?.counts;
  return (
    <ReportCard title="Rebooks and recording" reloading={reloading}>
      {!counts || !timing ? (
        <RowsSkeleton rows={2} rowHeight="h-20" label="Loading rebooks and recording" />
      ) : (
        <>
          <Fact
            label="Rebooked after a no-show"
            help={termHelp("rebooked")}
            value={formatCount(counts.rebooked)}
            proof={
              counts.rebooked === 0
                ? "No rebooks in this range"
                : `${formatCount(counts.rebookedHeld)} held · ${formatCount(counts.rebookedNoShow)} missed again · ${formatRate(
                    rate(counts.rebookedHeld, counts.rebookedHeld + counts.rebookedNoShow),
                  )} show rate`
            }
          />
          <Fact
            label="Time to record"
            help={termHelp("timeToRecord")}
            value={formatMinutes(timing.median)}
            proof={
              timing.count === 0
                ? "No results recorded yet"
                : `Median after the call ended · ${plural(timing.count, "result")} · ${formatCount(timing.late)} a day or more later`
            }
          />
        </>
      )}
    </ReportCard>
  );
}

const dayConfig = {
  held: { label: "Held", color: STAGE_FILL.held },
  noShow: { label: "No-show", color: STAGE_FILL.lost },
  notRecorded: { label: "Not recorded", color: STAGE_FILL.owed },
  canceled: { label: "Canceled", color: "var(--chart-5)" },
  moved: { label: "Moved", color: LEDGER_FILL.moved },
} satisfies ChartConfig;

/** Each business day's calls as stacked bars, in the stage scale. */
export function ByDayCard({ summary, reloading, phrase }: CardProps) {
  const data = (summary?.byDay ?? []).map((day) => ({ ...day, day: dayLabel(day.dayKey) }));
  const any = data.some((day) => day.held + day.noShow + day.notRecorded + day.canceled + day.moved > 0);
  return (
    <ReportCard title="By day" meta="Calls by the business day they were scheduled" reloading={reloading}>
      {!summary ? (
        <ChartSkeleton height="h-[240px]" label="Loading calls by day" />
      ) : !any ? (
        <SectionEmpty title={`No past calls ${phrase}.`} />
      ) : (
        <>
          <ChartLegend
            items={(Object.keys(dayConfig) as Array<keyof typeof dayConfig>).map((key) => ({
              key,
              label: dayConfig[key].label,
              color: dayConfig[key].color,
            }))}
          />
          <div className="px-2 pb-3">
            <ChartContainer config={dayConfig} className="aspect-auto h-[240px] w-full">
              <BarChart accessibilityLayer data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_PROPS} />
                <XAxis dataKey="day" {...AXIS_PROPS} tickMargin={8} minTickGap={16} />
                <YAxis allowDecimals={false} width={36} {...AXIS_PROPS} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {(Object.keys(dayConfig) as Array<keyof typeof dayConfig>).map((key) => (
                  <Bar key={key} dataKey={key} stackId="calls" fill={`var(--color-${key})`} maxBarSize={48} isAnimationActive={false} />
                ))}
              </BarChart>
            </ChartContainer>
          </div>
        </>
      )}
    </ReportCard>
  );
}

/**
 * Calls due with no result yet, oldest first, a page of ten at a time; each
 * opens the call and the deal. The summary carries the oldest 200.
 */
export function OwedCard({
  summary,
  reloading,
  phrase,
  now,
  filterKey,
}: CardProps & {
  now: number;
  /** The band's filters, which the list starts over on. */
  filterKey: string;
}) {
  const words = summary ? owedWords(summary.owedTotal, summary.owed.length, phrase) : null;
  const { rows, pager } = usePagedRows(summary?.owed ?? [], { resetKey: filterKey });
  return (
    <ReportCard
      title="Still owed a result"
      meta={words?.meta}
      container="@container/owed"
      reloading={reloading}
      footer={
        summary && words && !words.empty ? (
          <ReportPager pager={pager} noun="calls">
            {/* Only the cap needs saying; the title row already counts the calls. */}
            {summary.owedTotal > summary.owed.length ? <span>{words.footer}</span> : null}
          </ReportPager>
        ) : null
      }
    >
      {!summary || !words ? (
        <RowsSkeleton rows={5} label="Loading the calls still owed a result" />
      ) : words.empty ? (
        <SectionEmpty title={words.empty} />
      ) : (
        <PageRows pager={pager}>
          <ul aria-label="Calls still owed a result" className="flex flex-col">
            {rows.map((row) => {
              const age = ageWords(row.scheduledAt, now);
              return (
                <li
                  key={row.meetingId}
                  className="grid min-h-[52px] grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 border-b px-4 py-1.5 last:border-b-0 @3xl/owed:min-h-11 @3xl/owed:grid-cols-[11rem_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem] @3xl/owed:py-0"
                >
                  <RowLink
                    href={`/workspace/pipeline/meetings/${row.meetingId}`}
                    className={cn(FIGURE_15, "hidden font-medium @3xl/owed:inline")}
                  >
                    {formatWhen(row.scheduledAt)}
                  </RowLink>
                  <RowLink href={`/workspace/opportunities/${row.opportunityId}`} className="truncate font-semibold">
                    {row.leadName}
                  </RowLink>
                  <span className="text-right text-[13px] whitespace-nowrap text-warning-ink @3xl/owed:hidden">{age}</span>
                  <span className="col-span-2 truncate text-[13px] text-muted-foreground @3xl/owed:col-span-1">
                    <RowLink href={`/workspace/pipeline/meetings/${row.meetingId}`} className="@3xl/owed:hidden">
                      {formatWhen(row.scheduledAt)}
                    </RowLink>
                    <span className="@3xl/owed:hidden"> · </span>
                    <RowLink href={`/workspace/pipeline/meetings/${row.meetingId}`}>{row.closerName}</RowLink>
                    <span className="@3xl/owed:hidden"> · {row.programName}</span>
                  </span>
                  <span className="hidden truncate text-[13px] text-muted-foreground @3xl/owed:block">{row.programName}</span>
                  <span className="hidden text-right text-[13px] whitespace-nowrap text-warning-ink @3xl/owed:block">{age}</span>
                </li>
              );
            })}
          </ul>
        </PageRows>
      )}
    </ReportCard>
  );
}

function ageWords(scheduledAt: number, now: number) {
  const days = Math.floor((now - scheduledAt) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${formatCount(days)} days ago`;
}

