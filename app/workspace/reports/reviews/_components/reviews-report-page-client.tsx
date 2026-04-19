"use client";

import { useState } from "react";
import { endOfDay, startOfDay, subDays } from "date-fns";
import { useQuery } from "convex/react";
import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import { AvgResolveLatencyCard } from "./avg-resolve-latency-card";
import { CloserResponseMixChart } from "./closer-response-mix-chart";
import { DisputeRateCard } from "./dispute-rate-card";
import { DisputedRevenueCard } from "./disputed-revenue-card";
import { ManualTimeCorrectionRateCard } from "./manual-time-correction-rate-card";
import { ResolutionMixChart } from "./resolution-mix-chart";
import { ReviewBacklogCard } from "./review-backlog-card";
import { ReviewerWorkloadTable } from "./reviewer-workload-table";
import { ReviewsReportSkeleton } from "./reviews-report-skeleton";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: startOfDay(subDays(now, 30)).getTime(),
    endDate: endOfDay(now).getTime(),
  };
}

export function ReviewsReportPageClient() {
  usePageTitle("Review Ops — Reports");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const data = useQuery(
    api.reporting.reviewsReporting.getReviewReportingMetrics,
    dateRange,
  );

  if (data === undefined) {
    return <ReviewsReportSkeleton />;
  }

  const hasResolutionTruncation =
    data.isResolvedRangeTruncated || data.isDisputedRevenueTruncated;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Review Ops</h1>
          <Badge variant="outline">Admin Report</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Backlog, resolution mix, reviewer workload, disputes, and
          closer-response signals for meeting-overrun reviews.
        </p>
      </div>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      <Alert className="border-dashed bg-muted/15">
        <InfoIcon aria-hidden />
        <AlertTitle>Read this report in two lenses</AlertTitle>
        <AlertDescription>
          <p>
            <span className="font-medium text-foreground">Current Backlog</span>{" "}
            is a live queue metric and ignores the date picker.
          </p>
          <p>
            <span className="font-medium text-foreground">
              Resolution Analytics
            </span>{" "}
            includes only reviews whose <code>resolvedAt</code> falls inside the
            selected range.
          </p>
        </AlertDescription>
      </Alert>

      <section
        aria-labelledby="review-backlog-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="review-backlog-heading"
            className="text-lg font-medium tracking-tight"
          >
            Current Backlog
          </h2>
          <Badge variant="secondary">Live queue</Badge>
        </div>
        <ReviewBacklogCard backlog={data.backlog} />
      </section>

      <section
        aria-labelledby="resolution-analytics-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2
            id="resolution-analytics-heading"
            className="text-lg font-medium tracking-tight"
          >
            Resolution Analytics
          </h2>
          <Badge variant="outline">Resolved in selected range</Badge>
        </div>

        {hasResolutionTruncation ? (
          <Alert>
            <CircleAlertIcon aria-hidden />
            <AlertDescription>
              Resolution analytics are capped for performance. Narrow the date
              range if you need exact totals beyond the scan limit.
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <ManualTimeCorrectionRateCard
            rate={data.manualTimeCorrectionRate}
            count={data.manualTimeCorrectionCount}
            resolvedCount={data.resolvedCount}
          />
          <DisputeRateCard
            rate={data.disputeRate}
            count={data.resolutionMix.disputed}
            resolvedCount={data.resolvedCount}
          />
          <DisputedRevenueCard
            amountMinor={data.disputedRevenueMinor}
            count={data.disputedPaymentsCount}
            isTruncated={data.isDisputedRevenueTruncated}
          />
          <AvgResolveLatencyCard latencyMs={data.avgResolveLatencyMs} />
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <ResolutionMixChart
            resolutionMix={data.resolutionMix}
            resolvedCount={data.resolvedCount}
            unclassified={data.unclassifiedResolved}
            isTruncated={data.isResolvedRangeTruncated}
          />
          <CloserResponseMixChart closerResponseMix={data.closerResponseMix} />
        </div>

        <ReviewerWorkloadTable reviewers={data.reviewerWorkload} />
      </section>
    </div>
  );
}
