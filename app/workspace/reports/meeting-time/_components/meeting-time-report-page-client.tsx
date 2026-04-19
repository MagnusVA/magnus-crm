"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { subDays } from "date-fns";
import { AlertTriangleIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  ReportDateControls,
  type DateRange,
} from "../../_components/report-date-controls";
import { FathomCompliancePanel } from "./fathom-compliance-panel";
import { LateStartHistogram } from "./late-start-histogram";
import { MeetingTimeReportSkeleton } from "./meeting-time-report-skeleton";
import { MeetingTimeSummaryCards } from "./meeting-time-summary-cards";
import { OverrunHistogram } from "./overrun-histogram";
import { SourceSplitPanel } from "./source-split-panel";

function getDefaultDateRange(): DateRange {
  const now = new Date();
  return {
    startDate: subDays(now, 30).getTime(),
    endDate: now.getTime(),
  };
}

export function MeetingTimeReportPageClient() {
  usePageTitle("Meeting Time Audit");

  const [dateRange, setDateRange] = useState<DateRange>(getDefaultDateRange);
  const metrics = useQuery(
    api.reporting.meetingTime.getMeetingTimeMetrics,
    dateRange,
  );

  if (metrics === undefined) {
    return <MeetingTimeReportSkeleton />;
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Meeting Time Audit
        </h1>
        <p className="text-sm text-muted-foreground">
          Start and stop accuracy, late-start and overrun distribution, source
          attribution, and attendance evidence coverage.
        </p>
      </div>

      <ReportDateControls value={dateRange} onChange={setDateRange} />

      {metrics.isTruncated ? (
        <Alert>
          <AlertTriangleIcon className="size-4" />
          <AlertTitle>Meeting sample capped</AlertTitle>
          <AlertDescription>
            Only the first 2,000 meetings scheduled in this range are included.
            Narrow the date range for a full audit.
          </AlertDescription>
        </Alert>
      ) : null}

      <MeetingTimeSummaryCards
        totals={metrics.totals}
        compliance={metrics.fathomCompliance}
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <LateStartHistogram buckets={metrics.lateStartHistogram} />
        <OverrunHistogram buckets={metrics.overrunHistogram} />
      </div>

      <SourceSplitPanel
        startedAtSource={metrics.startedAtSource}
        stoppedAtSource={metrics.stoppedAtSource}
        noShowSource={metrics.noShowSource}
      />

      <FathomCompliancePanel compliance={metrics.fathomCompliance} />
    </div>
  );
}
