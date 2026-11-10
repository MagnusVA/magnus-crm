"use client";

import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { mergeCallsSummary } from "@/convex/analytics/merge/calls";
import { AnalyticsFreshnessAlert, freshnessSummary } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { termHelp } from "@/lib/reporting/definitions";
import { cn } from "@/lib/utils";
import { currentAnswers } from "@/lib/reporting/export";
import { ReportExportMenu, useRowsExport } from "../../_components/report-export-menu";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import { BAND_SELECT, FigureZone, REPORT_PAGE, REPORT_PAIR, ReportBand, ReportFigures } from "../../_components/report-ui";
import { ReportRangeMessage, ReportRangePicker, useReportRange } from "../../_components/use-report-range";
import { formatCount, formatRate, plural } from "../../people/_components/report-format";
import { DefinitionsCard } from "../../people/_components/report-parts";
import { captureReportFilters, useKept, useReportViewed } from "../../_components/use-report-page";
import {
  ByDayCard,
  HabitsCard,
  LeadTimeCard,
  LedgerCard,
  ModeCard,
  NoShowCard,
  OwedCard,
  ShowRateCard,
} from "./calls-cards";
import { attendanceRates, buildCallsDocument, CALLS_TERMS } from "./calls-data";

// Calls: every booked call accounted for (docs/reviews/reports-overhaul.html
// §09). One summary answers the whole page, so the band's filters scope every
// card. Today reads Convex live and earlier days read ClickHouse once the page
// is switched; a split joins the two with the summary's merge.

type CallType = "new" | "follow_up";
const ALL = "__all__";
const CALL_TYPE_LABEL: Record<CallType, string> = { new: "First calls", follow_up: "Follow-up calls" };

export function CallsPageClient() {
  usePageTitle("Calls — Reports");
  useReportViewed("calls");
  const range = useReportRange();
  const now = useNow();
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [closerId, setCloserId] = useState<Id<"users"> | undefined>();
  const [callType, setCallType] = useState<CallType | undefined>();
  const rowsExport = useRowsExport("calls", "calls", range.dates.startBusinessDate, range.dates.endBusinessDateInclusive, {
    programId,
    closerId,
    callType,
  });
  const closers = useQuery(api.users.queries.listActiveClosers, {});
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, { includeArchived: true });

  const filters = { programId, closerId, callType };
  const ready = range.loaded;
  // The minute clock moves calls from upcoming to not recorded as they end.
  const report = useAnalyticsReport({
    page: "calls",
    reportId: "calls.summary",
    plan: range.plan,
    filters,
    live: api.reports.calls.getCallsSummary,
    liveArgs: ready ? { ...range.window, ...filters, asOf: now } : "skip",
    todayArgs: ready ? { ...range.todayWindow, ...filters, asOf: now } : "skip",
    merge: mergeCallsSummary,
  });
  const key = JSON.stringify([range.window, filters]);
  const kept = useKept(report.data, key, range.phrase);
  const summary = kept.data;
  const freshness = freshnessSummary([report.freshness], now);

  const closerName = closers?.find((closer) => closer._id === closerId);
  const filterWords = [
    programId ? `Program: ${programs?.find((program) => program._id === programId)?.name ?? "one program"}` : null,
    closerName ? `Closer: ${closerName.fullName ?? closerName.email}` : null,
    callType ? CALL_TYPE_LABEL[callType] : null,
  ].filter(Boolean);

  const changeFilters = (next: Partial<typeof filters>) => {
    const merged = { ...filters, ...next };
    captureReportFilters("calls", {
      has_program_filter: Boolean(merged.programId),
      has_closer_filter: Boolean(merged.closerId),
      call_type: merged.callType ?? "all",
    });
  };

  const counts = summary?.counts;
  const overall = counts ? attendanceRates({ ...counts }) : null;
  const props = { summary, reloading: kept.reloading, phrase: kept.phrase };

  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title="Calls"
        range={range.words}
        freshness={report.data !== undefined ? freshness : null}
        dayLine={range.dayLine}
        actions={
          <>
            <ReportRangePicker range={range} />
            <ReportExportMenu
              page="calls"
              startDate={range.dates.startBusinessDate}
              endDate={range.dates.endBusinessDateInclusive}
              extra={[rowsExport]}
              buildDocument={() => {
                const current = currentAnswers({ summary: kept });
                return current
                  ? buildCallsDocument({
                      summary: current.summary,
                      period: range.words,
                      boundary: range.dayLine,
                      filters: filterWords.length > 0 ? filterWords.join(" · ") : "Every program, closer and call type",
                      generatedAt: Date.now(),
                    })
                  : null;
              }}
            />
          </>
        }
        figures={
          <ReportFigures columns="grid-cols-2 @3xl:grid-cols-4 @5xl:grid-cols-7" reloading={kept.reloading}>
            <FigureZone
              label="Calls scheduled"
              help={termHelp("callsScheduled")}
              figure={counts ? formatCount(counts.scheduled) : undefined}
              proof={counts ? `${plural(counts.scheduled + counts.moved, "slot")} · ${formatCount(counts.upcoming)} upcoming` : undefined}
            />
            <FigureZone
              label="Calls due"
              help={termHelp("callsDue")}
              figure={counts ? formatCount(counts.due) : undefined}
              proof={counts ? `${formatCount(counts.held)} held · ${formatCount(counts.noShow)} no-show` : undefined}
            />
            <FigureZone
              label="Show rate"
              help={termHelp("showRate")}
              figure={overall ? formatRate(overall.showRate) : undefined}
              proof={
                counts && overall
                  ? overall.recorded > 0
                    ? `${formatCount(counts.held)} held of ${formatCount(overall.recorded)} recorded`
                    : "No call has a result yet"
                  : undefined
              }
            />
            <FigureZone
              label="Recorded"
              help={termHelp("recorded")}
              figure={overall ? formatRate(overall.recordedRate) : undefined}
              proof={
                counts
                  ? counts.due === 0
                    ? "No calls due yet"
                    : counts.notRecorded > 0
                      ? `${plural(counts.notRecorded, "call")} still ${counts.notRecorded === 1 ? "owes" : "owe"} a result`
                      : "Every call due has a result"
                  : undefined
              }
            />
            <FigureZone
              label="Not recorded"
              help={termHelp("notRecorded")}
              figure={counts ? formatCount(counts.notRecorded) : undefined}
              figureClassName={counts && counts.notRecorded > 0 ? "text-warning" : undefined}
              proof={counts ? (counts.due > 0 ? `${formatRate(counts.notRecorded / counts.due)} of calls due` : "No calls due yet") : undefined}
            />
            <FigureZone
              label="Moved"
              help={termHelp("moved")}
              figure={counts ? formatCount(counts.moved) : undefined}
              proof={counts ? "Slots given up in a reschedule" : undefined}
            />
            <FigureZone
              label="Canceled"
              help={termHelp("canceled")}
              className="col-span-2 @5xl:col-span-1"
              figure={counts ? formatCount(counts.canceled) : undefined}
              proof={counts ? "Canceled and not moved" : undefined}
            />
          </ReportFigures>
        }
        filters={
          <>
            <ReportProgramFilter
              label="Program"
              value={programId}
              onChange={(next) => {
                setProgramId(next);
                changeFilters({ programId: next });
              }}
            />
            <Select
              value={closerId ?? ALL}
              onValueChange={(next) => {
                const value = next === ALL ? undefined : (next as Id<"users">);
                setCloserId(value);
                changeFilters({ closerId: value });
              }}
              disabled={closers === undefined}
            >
              <SelectTrigger aria-label="Closer" className={cn(BAND_SELECT, "w-[184px] max-w-full")}>
                <SelectValue placeholder="Closer" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All closers</SelectItem>
                {(closers ?? []).map((closer) => (
                  <SelectItem key={closer._id} value={closer._id}>
                    {closer.fullName ?? closer.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={callType ?? ALL}
              onValueChange={(next) => {
                const value = next === ALL ? undefined : (next as CallType);
                setCallType(value);
                changeFilters({ callType: value });
              }}
            >
              <SelectTrigger aria-label="Call type" className={cn(BAND_SELECT, "w-[164px] max-w-full")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All calls</SelectItem>
                <SelectItem value="new">{CALL_TYPE_LABEL.new}</SelectItem>
                <SelectItem value="follow_up">{CALL_TYPE_LABEL.follow_up}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[13px] text-board-muted @3xl:ml-auto">Filters scope every card on this page.</p>
          </>
        }
      />
      <ReportRangeMessage range={range} />
      <AnalyticsFreshnessAlert summary={freshness} />

      {/* Each row pairs cards of about one height: the ledger beside the two
          short rate cards, then the two bar lists, then the chart beside the
          narrow mode table. */}
      <div className={cn(REPORT_PAIR, "@5xl:grid-cols-[1.15fr_1fr]")}>
        <LedgerCard {...props} />
        <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
          <ShowRateCard {...props} />
          <HabitsCard {...props} />
        </div>
      </div>
      <div className={REPORT_PAIR}>
        <LeadTimeCard {...props} />
        <NoShowCard {...props} />
      </div>
      <div className={cn(REPORT_PAIR, "@5xl:grid-cols-[2fr_1fr]")}>
        <ByDayCard {...props} />
        <ModeCard {...props} />
      </div>
      <OwedCard {...props} now={now} />
      <DefinitionsCard terms={CALLS_TERMS} />
    </div>
  );
}
