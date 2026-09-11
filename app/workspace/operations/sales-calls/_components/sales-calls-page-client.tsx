"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { DashboardDateRangeFilter } from "@/app/workspace/_components/dashboard-date-range-filter";
import {
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import {
  useAllOperationsReportRows,
  useOperationsDashboardReport,
} from "../../_components/use-operations-report-job";
import { PerProgramStatCard } from "./per-program-stat-card";
import { PhoneCloserTable } from "./phone-closer-table";
import {
  buildHistoricalSalesDashboard,
  defaultSalesCurrency,
  listSalesCurrencies,
  type SalesDashboardView,
} from "./sales-calls-data";
import { SalesCallsDetailsList } from "./sales-calls-details-list";
import { SalesCallsStatCards } from "./sales-calls-stat-cards";

export function SalesCallsPageClient() {
  usePageTitle("Phone Sales Ops");

  const { range, setRange, queryRange, rangeLabel, validationMessage } =
    useDashboardRange({
      urlSync: true,
      defaultRange: { kind: "preset", preset: "this_week" },
      validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
    });
  const requiresSnapshot = useMemo(
    () => requiresOperationsReportSnapshot(queryRange),
    [queryRange],
  );
  const dashboard = useQuery(
    api.operations.salesCallsDashboard.getSalesCallsDashboard,
    requiresSnapshot ? "skip" : { range: queryRange },
  );
  const needsSnapshot = requiresSnapshot || dashboard?.capped === true;
  const snapshot = useOperationsDashboardReport({
    reportKind: "sales-calls",
    range: queryRange,
    enabled: needsSnapshot,
  });
  const summaryMoney = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_summary_money",
    enabled: snapshot.summary !== undefined,
  });
  const closerCalls = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_closer",
    enabled: snapshot.summary !== undefined,
  });
  const closerMoney = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_closer_money",
    enabled: snapshot.summary !== undefined,
  });
  const programCalls = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_program",
    enabled: snapshot.summary !== undefined,
  });
  const programMoney = useAllOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_program_money",
    enabled: snapshot.summary !== undefined,
  });
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
  }, [
    closerCalls.rows,
    closerMoney.rows,
    programCalls.rows,
    programMoney.rows,
    snapshot.summary,
    summaryMoney.rows,
  ]);
  const dashboardData: SalesDashboardView | undefined = needsSnapshot
    ? historicalDashboard
    : dashboard;
  const currencies = useMemo(
    () => listSalesCurrencies(dashboardData),
    [dashboardData],
  );
  const [requestedCurrency, setRequestedCurrency] = useState<string | null>(
    null,
  );
  const currency =
    requestedCurrency && currencies.includes(requestedCurrency)
      ? requestedCurrency
      : defaultSalesCurrency(currencies);
  const displayedCurrencies = currencies.length > 0 ? currencies : [currency];
  const sectionError = [
    summaryMoney.error,
    closerCalls.error,
    closerMoney.error,
    programCalls.error,
    programMoney.error,
  ].find((error): error is string => error !== null);
  const closerOptions = useMemo(
    () =>
      dashboardData?.closers.map((closer) => ({
        key: closer.closerId,
        label: closer.label,
      })),
    [dashboardData?.closers],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-[3px] h-7 w-[3px] shrink-0 rounded-full bg-primary/75" />
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">
              Phone Sales Ops
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Sales-call throughput, cash collected, per-program performance,
              and the phone-closer meeting queue.
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 lg:items-end">
          <OperationsReportExportMenu
            reportKind="sales-calls"
            range={queryRange}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              Money currency
            </span>
            <Select value={currency} onValueChange={setRequestedCurrency}>
              <SelectTrigger
                className="min-w-24"
                size="sm"
                aria-label="Money currency"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {displayedCurrencies.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DashboardDateRangeFilter
              validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
              validationMessage={validationMessage}
              value={range}
              onChange={setRange}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Showing: {rangeLabel}
            {currencies.length > 1
              ? ` · Money values: ${currency} of ${currencies.length} currencies`
              : ` · Money values: ${currency}`}
          </p>
        </div>
      </header>

      <OperationsHealthBanner />

      {needsSnapshot ? (
        <OperationsReportJobStatus
          state={
            sectionError
              ? "failed"
              : (snapshot.job?.status ??
                (snapshot.requestError ? "failed" : "queued"))
          }
          generatedAt={snapshot.summary?.generatedAt ?? null}
          errorMessage={
            sectionError ??
            snapshot.requestError ??
            snapshot.job?.failure?.message ??
            null
          }
          onCancel={() => void snapshot.cancel()}
          onRefresh={snapshot.refresh}
          onRetry={snapshot.retry}
        />
      ) : null}

      <SalesCallsStatCards stats={dashboardData?.stats} currency={currency} />
      <PerProgramStatCard
        data={dashboardData?.perProgram}
        rangeLabel={rangeLabel}
        currency={currency}
      />
      <PhoneCloserTable
        rows={dashboardData?.closers}
        teamTotal={dashboardData?.teamTotal}
        currency={currency}
      />
      <SalesCallsDetailsList
        window={dashboardData?.window}
        closerOptions={closerOptions}
      />
    </div>
  );
}
