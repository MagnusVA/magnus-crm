"use client";

import { useMemo, useState } from "react";
import { api } from "@/convex/_generated/api";
import { mergeSalesCallsDashboard } from "@/convex/analytics/merge/operations";
import {
  AnalyticsFreshnessAlert,
  FreshnessWords,
  freshnessSummary,
} from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport, useAnalyticsSource } from "@/app/workspace/_components/analytics/use-analytics-report";
import {
  dashboardRangeToDayKeys,
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import {
  DateRangePicker,
  formatBusinessDateSpan,
  rangePhrase,
  type DashboardRangeInput,
} from "@/app/workspace/_components/date-range-picker";
import { BusinessDayRebuildingState } from "@/app/workspace/_components/day-definition";
import { PageBand } from "@/app/workspace/_components/page-band";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { dashboardRangeFromToday, dashboardRangePlan } from "@/lib/analyticsRange";
import { businessDateForInstant, businessDayDisclosure } from "@/lib/businessDay";
import { cn } from "@/lib/utils";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import { useAllOperationsReportRows, useOperationsDashboardReport } from "../../_components/use-operations-report-job";
import { DefinitionsCard } from "./definitions-card";
import { MeetingsCard } from "./meetings-card";
import { PhoneClosersCard } from "./phone-closers-card";
import { ProgramsCard } from "./programs-card";
import {
  buildHistoricalSalesDashboard,
  listSalesCurrencies,
  mainSalesCurrency,
  performanceMoneyForCurrency,
  summaryMoneyForCurrency,
  type SalesDashboardView,
} from "./sales-calls-data";
import { SalesFigures } from "./sales-figures";

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

/** "This week · Oct 27 – Nov 2", "Today · Nov 2", or a custom range's dates. */
function rangeWords(range: DashboardRangeInput, now: number, todayBusinessDate: string, setting: Parameters<typeof dashboardRangeToDayKeys>[2]) {
  const { startDayKey, endDayKey } = dashboardRangeToDayKeys(range, now, setting);
  const dates = formatBusinessDateSpan(startDayKey, endDayKey, todayBusinessDate);
  return range.kind === "custom" ? dates : `${PRESET_WORDS[range.preset]} · ${dates}`;
}

/**
 * The band's controls take the picker's board tone: the export menu's
 * outline button is restyled from here so the shared menu stays untouched.
 */
const BOARD_BUTTON =
  "[&>button]:h-[34px] [&>button]:rounded-[7px] [&>button]:border-board-foreground/15 [&>button]:bg-board-raised [&>button]:px-3 [&>button]:text-[13px] [&>button]:text-board-foreground [&>button:hover]:bg-board-foreground/10 [&>button:hover]:text-board-foreground";

export function SalesCallsPageClient() {
  const { setting, rebuilding, loaded } = useBusinessDay();
  const now = useNow();
  usePageTitle("Sales calls");

  const { range, setRange, queryRange, validationMessage } = useDashboardRange({
    urlSync: true,
    defaultRange: { kind: "preset", preset: "today" },
    validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  });
  const requiresSnapshot = useMemo(
    () => requiresOperationsReportSnapshot(queryRange, setting, now),
    [queryRange, now, setting],
  );
  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched, and then
  // need no snapshot job. Until then ranges over 7 days use the snapshot
  // (docs/agents/reporting.md).
  const todayBusinessDate = businessDateForInstant(now, setting);
  const plan = dashboardRangePlan(queryRange, todayBusinessDate);
  const source = useAnalyticsSource("sales_calls", plan);
  const report = useAnalyticsReport({
    page: "sales_calls",
    reportId: "sales_calls.dashboard",
    plan,
    live: api.operations.salesCallsDashboard.getSalesCallsDashboard,
    merge: mergeSalesCallsDashboard,
    todayArgs: rebuilding || !loaded ? "skip" : { range: dashboardRangeFromToday(queryRange, todayBusinessDate) },
    liveArgs: rebuilding || !loaded || (source !== "warehouse" && requiresSnapshot) ? "skip" : { range: queryRange },
  });
  const dashboard = report.data;
  const needsSnapshot = source === "live" && (requiresSnapshot || dashboard?.capped === true);
  const snapshot = useOperationsDashboardReport({ reportKind: "sales-calls", range: queryRange, enabled: needsSnapshot });
  const snapshotReady = snapshot.summary !== undefined;
  const summaryMoney = useAllOperationsReportRows({ jobId: snapshot.jobId, section: "sales_summary_money", enabled: snapshotReady });
  const closerCalls = useAllOperationsReportRows({ jobId: snapshot.jobId, section: "sales_closer", enabled: snapshotReady });
  const closerMoney = useAllOperationsReportRows({ jobId: snapshot.jobId, section: "sales_closer_money", enabled: snapshotReady });
  const programCalls = useAllOperationsReportRows({ jobId: snapshot.jobId, section: "sales_program", enabled: snapshotReady });
  const programMoney = useAllOperationsReportRows({ jobId: snapshot.jobId, section: "sales_program_money", enabled: snapshotReady });
  const historicalDashboard = useMemo(() => {
    if (
      !snapshot.summary ||
      !summaryMoney.rows ||
      !closerCalls.rows ||
      !closerMoney.rows ||
      !programCalls.rows ||
      !programMoney.rows
    ) {
      return undefined;
    }
    return buildHistoricalSalesDashboard({
      summary: snapshot.summary.payload,
      summaryMoneyRows: summaryMoney.rows,
      closerRows: closerCalls.rows,
      closerMoneyRows: closerMoney.rows,
      programRows: programCalls.rows,
      programMoneyRows: programMoney.rows,
    });
  }, [closerCalls.rows, closerMoney.rows, programCalls.rows, programMoney.rows, snapshot.summary, summaryMoney.rows]);
  const current: SalesDashboardView | undefined = needsSnapshot ? historicalDashboard : dashboard;

  // A new range keeps the last one's numbers on screen, dimmed, until it
  // arrives (DESIGN.md, Kept Data While Reloading). The kept numbers keep
  // their own range, so the band's words and empty lines still match them.
  const [kept, setKept] = useState(current && { data: current, range: queryRange });
  if (current !== undefined && current !== kept?.data) setKept({ data: current, range: queryRange });
  const dashboardData = current ?? kept?.data;
  const reloading = current === undefined && kept !== undefined;
  const shownRange = current === undefined && kept ? kept.range : queryRange;
  const phrase = rangePhrase(shownRange);

  const currencies = useMemo(() => listSalesCurrencies(dashboardData), [dashboardData]);
  const mainCurrency = mainSalesCurrency(dashboardData?.stats, currencies);
  const [requestedCurrency, setRequestedCurrency] = useState<string | null>(null);
  const tableCurrency = requestedCurrency && currencies.includes(requestedCurrency) ? requestedCurrency : mainCurrency;
  const unattributedMinor =
    dashboardData === undefined
      ? 0
      : Math.max(
          0,
          summaryMoneyForCurrency(dashboardData.stats, tableCurrency).cashCollectedMinor -
            performanceMoneyForCurrency(dashboardData.teamTotal, tableCurrency).paymentRevenueMinor,
        );

  const sectionError = [summaryMoney.error, closerCalls.error, closerMoney.error, programCalls.error, programMoney.error].find(
    (error): error is string => error !== null,
  );
  const closerOptions = useMemo(
    () => dashboardData?.closers.map((closer) => ({ key: closer.closerId, label: closer.label })),
    [dashboardData?.closers],
  );
  const freshness = freshnessSummary([report.freshness], now);

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="Sales calls"
        description={
          <>
            <span className="font-medium text-board-foreground">{rangeWords(shownRange, now, todayBusinessDate, setting)}</span>
            {dashboard !== undefined && !needsSnapshot && freshness.kind === "line" ? (
              <>
                {" · "}
                <FreshnessWords summary={freshness} />
              </>
            ) : null}
            <span className="hidden @3xl:inline"> · {businessDayDisclosure(setting)}</span>
          </>
        }
        actions={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DateRangePicker
              tone="board"
              value={range}
              onChange={setRange}
              validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
              todayBusinessDate={todayBusinessDate}
            />
            {currencies.length > 1 ? (
              <Select value={tableCurrency} onValueChange={setRequestedCurrency}>
                <SelectTrigger
                  aria-label="Currency for the closers and programs tables"
                  className="h-[34px]! rounded-[7px] border-board-foreground/15 bg-board-raised font-condensed text-[14px] font-semibold tracking-[0.02em] text-board-foreground dark:bg-board-raised dark:hover:bg-board-foreground/10"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <div className={BOARD_BUTTON}>
              <OperationsReportExportMenu reportKind="sales-calls" range={queryRange} />
            </div>
          </div>
        }
      >
        {rebuilding ? null : (
          <div aria-busy={reloading} className={cn("transition-opacity duration-200", reloading && "opacity-60")}>
            <SalesFigures
              stats={dashboardData?.stats}
              mainCurrency={mainCurrency}
              attendanceCountsPartial={dashboardData?.attendanceCountsPartial}
            />
          </div>
        )}
      </PageBand>

      {validationMessage ? <p className="text-[13px] text-danger-ink">{validationMessage}</p> : null}
      {needsSnapshot ? null : <AnalyticsFreshnessAlert summary={freshness} />}
      <OperationsHealthBanner />

      {rebuilding ? (
        <BusinessDayRebuildingState />
      ) : (
        <>
          {needsSnapshot ? (
            <OperationsReportJobStatus
              state={sectionError ? "failed" : (snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued"))}
              generatedAt={snapshot.summary?.generatedAt ?? null}
              errorMessage={sectionError ?? snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
              onCancel={() => void snapshot.cancel()}
              onRefresh={snapshot.refresh}
              onRetry={snapshot.retry}
            />
          ) : null}

          <div
            aria-busy={reloading}
            className={cn("flex flex-col gap-3.5 transition-opacity duration-200 short:gap-3", reloading && "opacity-60")}
          >
            <PhoneClosersCard
              rows={dashboardData?.closers}
              teamTotal={dashboardData?.teamTotal}
              currency={tableCurrency}
              attendanceCountsPartial={dashboardData?.attendanceCountsPartial}
              unattributedMinor={unattributedMinor}
              rangePhrase={phrase}
            />
            <div className="grid items-start gap-3.5 @5xl:grid-cols-[1fr_1.1fr] short:gap-3">
              <ProgramsCard data={dashboardData?.perProgram} currency={tableCurrency} rangePhrase={phrase} />
              <MeetingsCard window={dashboardData?.window} closerOptions={closerOptions} rangePhrase={phrase} />
            </div>
          </div>
          <DefinitionsCard />
        </>
      )}
    </div>
  );
}
