"use client";

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { DashboardDateRangeFilter } from "@/app/workspace/_components/dashboard-date-range-filter";
import {
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  requiresOperationsReportSnapshot,
} from "@/app/workspace/_components/dashboard-date-utils";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { formatAmountMinor } from "@/lib/format-currency";
import { OperationsHealthBanner } from "../../_components/operations-health-banner";
import { OperationsReportExportMenu } from "../../_components/operations-report-export-menu";
import { OperationsReportJobStatus } from "../../_components/report-job-status";
import { OperationsReportSnapshotTable } from "../../_components/report-snapshot-table";
import {
  useOperationsDashboardReport,
  useOperationsReportRows,
} from "../../_components/use-operations-report-job";
import { PerProgramStatCard } from "./per-program-stat-card";
import { PhoneCloserTable } from "./phone-closer-table";
import { SalesCallsDetailsList } from "./sales-calls-details-list";
import { SalesCallsStatCards } from "./sales-calls-stat-cards";

const percentFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

function formatMoney(value: string | number | boolean | null) {
  return typeof value === "number"
    ? formatAmountMinor(Math.round(value), "USD")
    : "—";
}

function formatPercent(value: string | number | boolean | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? percentFormatter.format(value)
    : "—";
}

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
  const closerSnapshot = useOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_closer",
    enabled: snapshot.summary !== undefined,
  });
  const programSnapshot = useOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_program",
    enabled: snapshot.summary !== undefined,
  });
  const reconciliationSnapshot = useOperationsReportRows({
    jobId: snapshot.jobId,
    section: "sales_reconciliation",
    enabled: snapshot.summary !== undefined,
  });
  const dashboardData = needsSnapshot ? undefined : dashboard;

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
          <DashboardDateRangeFilter
            validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
            validationMessage={validationMessage}
            value={range}
            onChange={setRange}
          />
          <p className="text-xs text-muted-foreground">
            Showing: {rangeLabel}
          </p>
        </div>
      </header>

      <OperationsHealthBanner />

      {needsSnapshot ? (
        <OperationsReportJobStatus
          state={snapshot.job?.status ?? (snapshot.requestError ? "failed" : "queued")}
          generatedAt={snapshot.summary?.generatedAt ?? null}
          errorMessage={snapshot.requestError ?? snapshot.job?.failure?.message ?? null}
          onCancel={() => void snapshot.cancel()}
          onRefresh={snapshot.refresh}
          onRetry={snapshot.retry}
        />
      ) : null}

      {snapshot.summary ? (
        <>
          <OperationsReportSnapshotTable
            title="Historical sales-call summary"
            description={`Materialized for ${rangeLabel}.`}
            columns={[
              { key: "totalCalls", label: "Calls", align: "right" },
              { key: "showed", label: "Showed", align: "right" },
              { key: "paymentSalesCount", label: "Sales", align: "right" },
              {
                key: "cashCollectedMinor",
                label: "Cash collected",
                align: "right",
                render: formatMoney,
              },
              {
                key: "showUpRate",
                label: "Show-up rate",
                align: "right",
                render: formatPercent,
              },
              {
                key: "closeRate",
                label: "Close rate",
                align: "right",
                render: formatPercent,
              },
              {
                key: "avgCashPerSaleMinor",
                label: "Avg cash / sale",
                align: "right",
                render: formatMoney,
              },
            ]}
            rows={[{ rowKey: "main", payload: snapshot.summary.payload }]}
          />
          <OperationsReportSnapshotTable
            title="Phone closer performance"
            description="Completed historical report; use the arrows to page through closers."
            columns={[
              { key: "label", label: "Phone closer" },
              { key: "showed", label: "Showed", align: "right" },
              { key: "paymentSales", label: "Sales", align: "right" },
              {
                key: "paymentRevenueMinor",
                label: "Revenue",
                align: "right",
                render: formatMoney,
              },
              {
                key: "paymentCloseRate",
                label: "Close rate",
                align: "right",
                render: formatPercent,
              },
              {
                key: "avgPaymentDealMinor",
                label: "Avg deal",
                align: "right",
                render: formatMoney,
              },
            ]}
            rows={closerSnapshot.rows}
            isLoading={closerSnapshot.isLoading}
            hasPreviousPage={closerSnapshot.hasPreviousPage}
            hasNextPage={closerSnapshot.hasNextPage}
            onPreviousPage={closerSnapshot.previousPage}
            onNextPage={closerSnapshot.nextPage}
          />
          <OperationsReportSnapshotTable
            title="Program performance"
            description="Completed historical report; use the arrows to page through programs."
            columns={[
              { key: "label", label: "Program" },
              { key: "calls", label: "Calls", align: "right" },
              { key: "showed", label: "Showed", align: "right" },
              { key: "paymentSales", label: "Sales", align: "right" },
              {
                key: "paymentRevenueMinor",
                label: "Revenue",
                align: "right",
                render: formatMoney,
              },
            ]}
            rows={programSnapshot.rows}
            isLoading={programSnapshot.isLoading}
            hasPreviousPage={programSnapshot.hasPreviousPage}
            hasNextPage={programSnapshot.hasNextPage}
            onPreviousPage={programSnapshot.previousPage}
            onNextPage={programSnapshot.nextPage}
          />
          <OperationsReportSnapshotTable
            title="Payment reconciliation"
            description="Completed historical report by payment currency."
            columns={[
              { key: "currency", label: "Currency" },
              { key: "paymentSales", label: "Payments", align: "right" },
              {
                key: "paymentRevenueMinor",
                label: "Revenue",
                align: "right",
                render: formatMoney,
              },
              { key: "attributedSales", label: "Attributed", align: "right" },
              { key: "unattributedSales", label: "Unattributed", align: "right" },
              {
                key: "unattributedRevenueMinor",
                label: "Unattributed revenue",
                align: "right",
                render: formatMoney,
              },
            ]}
            rows={reconciliationSnapshot.rows}
            isLoading={reconciliationSnapshot.isLoading}
            hasPreviousPage={reconciliationSnapshot.hasPreviousPage}
            hasNextPage={reconciliationSnapshot.hasNextPage}
            onPreviousPage={reconciliationSnapshot.previousPage}
            onNextPage={reconciliationSnapshot.nextPage}
          />
        </>
      ) : null}

      {!needsSnapshot ? (
        <>
          <SalesCallsStatCards stats={dashboardData?.stats} />
          <PerProgramStatCard data={dashboardData?.perProgram} rangeLabel={rangeLabel} />
          <PhoneCloserTable
            rows={dashboardData?.closers}
            teamTotal={dashboardData?.teamTotal}
          />
        </>
      ) : null}

      <SalesCallsDetailsList
        window={
          snapshot.summary &&
          typeof snapshot.summary.payload.start === "number" &&
          typeof snapshot.summary.payload.end === "number"
            ? {
                start: snapshot.summary.payload.start,
                end: snapshot.summary.payload.end,
              }
            : dashboardData?.window
        }
        closerOptions={closerOptions}
      />
    </div>
  );
}
