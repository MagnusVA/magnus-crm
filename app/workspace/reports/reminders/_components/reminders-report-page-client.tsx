"use client";

import { useState } from "react";
import { addDays, startOfDay } from "date-fns";
import { AlertTriangleIcon, BellIcon } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { reportRangePlan, reportWindowFromToday } from "@/lib/analyticsRange";
import { mergeReminderOutcomeFunnel } from "@/convex/analytics/merge/reminders";
import { AnalyticsFreshnessLine } from "@/app/workspace/_components/analytics/analytics-freshness";
import { useAnalyticsReport } from "@/app/workspace/_components/analytics/use-analytics-report";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import { ReportProgramFilter } from "../../_components/report-program-filter";
import {
  ReportPaymentTypeFilter,
  type PaymentType,
} from "../../_components/report-payment-type-filter";
import { ReminderChainLengthHistogram } from "./reminder-chain-length-histogram";
import { ReminderDrivenRevenueCard } from "./reminder-driven-revenue-card";
import { ReminderFunnelChart } from "./reminder-funnel-chart";
import { ReminderOutcomeCardGrid } from "./reminder-outcome-card-grid";
import { RemindersReportSkeleton } from "./reminders-report-skeleton";
import { PerCloserReminderConversionTable } from "./per-closer-reminder-conversion-table";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(now).getTime(),
    endDate: startOfDay(addDays(now, 1)).getTime(),
  };
}

export function RemindersReportPageClient() {
  usePageTitle("Reminder Outcomes — Reports");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>();

  const queryArgs = {
    ...dateRange,
    ...(programId ? { programId } : {}),
    ...(paymentType ? { paymentType } : {}),
  };

  // Today reads Convex live, and so does today's part of a longer range; the
  // days before today read ClickHouse once the page is switched
  // (docs/agents/reporting.md).
  const now = useNow();
  const report = useAnalyticsReport({
    page: "reminders",
    reportId: "reminders.funnel",
    plan: reportRangePlan(dateRange, now),
    filters: { programId, paymentType },
    live: api.reporting.remindersReporting.getReminderOutcomeFunnel,
    liveArgs: queryArgs,
    todayArgs: { ...queryArgs, ...reportWindowFromToday(dateRange, now) },
    merge: mergeReminderOutcomeFunnel,
  });
  const data = report.data;

  // A ClickHouse range can take a while to load; keep the controls and its
  // status on screen instead of the full-page skeleton.
  if (data === undefined && report.freshness.source === "live") {
    return <RemindersReportSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-2">
          <Badge variant="outline" className="w-fit">
            Manual reminders only
          </Badge>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Reminder Outcome Funnel
            </h1>
            <p className="text-sm text-muted-foreground">
              Trace reminder performance from creation through completion,
              outcome mix, and follow-up chain depth.
            </p>
          </div>
        </div>
      </div>

      <ReportDateControls value={dateRange} onChange={setDateRange} />
      <AnalyticsFreshnessLine items={[report.freshness]} />

      <div className="flex flex-wrap items-center gap-3">
        <ReportProgramFilter value={programId} onChange={setProgramId} />
        <ReportPaymentTypeFilter
          value={paymentType}
          onChange={setPaymentType}
        />
      </div>

      {data === undefined ? (
        <Skeleton className="h-[360px] rounded-lg" />
      ) : (
        <RemindersReportBody data={data} />
      )}
    </div>
  );
}

function RemindersReportBody({
  data,
}: {
  data: FunctionReturnType<
    typeof api.reporting.remindersReporting.getReminderOutcomeFunnel
  >;
}) {
  const isEmpty = data.totalCreated === 0;

  return (
    <>
      {data.isTruncated ? (
        <Alert>
          <AlertTriangleIcon className="size-4 text-amber-600" />
          <AlertTitle>Results capped for performance</AlertTitle>
          <AlertDescription>
            This report hit the 2,000 reminder scan limit. Narrow the date range
            to inspect the full funnel.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(18rem,0.5fr)]">
        {isEmpty ? (
          <Empty className="min-h-[360px] border bg-card/70">
            <EmptyMedia variant="icon">
              <BellIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No manual reminders in this range</EmptyTitle>
              <EmptyDescription>
                Adjust the date window to inspect reminder completion outcomes,
                closer conversion, and chain-length behavior once reminders are
                created.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ReminderFunnelChart data={data} />
        )}

        <ReminderDrivenRevenueCard data={data} />
      </div>

      {isEmpty ? null : (
        <>
          <ReminderOutcomeCardGrid outcomeBreakdown={data.outcomeBreakdown} />
          <ReminderChainLengthHistogram
            chainLengthHistogram={data.chainLengthHistogram}
            opportunitiesWithReminderChains={data.opportunitiesWithReminderChains}
          />
          <PerCloserReminderConversionTable data={data} />
        </>
      )}
    </>
  );
}
