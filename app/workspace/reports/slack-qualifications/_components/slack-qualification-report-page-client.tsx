"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangleIcon, ListChecksIcon, TargetIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  getInclusiveEndBusinessDate,
  getInitialSlackQualificationFilters,
  getRangeValidationMessage,
  type SlackQualificationFilters,
} from "./business-date-utils";
import { useReportAnalytics } from "../../_components/use-report-analytics";
import { TeamGoalDialog } from "./team-goal-dialog";
import { SetterQualificationControls } from "./setter-qualification-controls";
import { SetterQualificationSummaryCards } from "./setter-qualification-summary-cards";
import { SetterQualificationTrend } from "./setter-qualification-trend";
import { SetterContributionTable } from "./setter-contribution-table";
import { SlackQualificationReportSkeleton } from "./slack-qualification-report-skeleton";

export function SlackQualificationReportPageClient() {
  usePageTitle("Slack Qualifications - Reports");
  const { captureViewed, captureFiltersChanged } = useReportAnalytics(
    "slack_qualifications",
  );

  const [filters, setFilters] = useState<SlackQualificationFilters>(() =>
    getInitialSlackQualificationFilters(),
  );
  const [isTeamGoalDialogOpen, setIsTeamGoalDialogOpen] = useState(false);
  const rangeError = getRangeValidationMessage(filters);

  const queryArgs = useMemo(() => {
    if (rangeError) {
      return "skip" as const;
    }

    const base = {
      startBusinessDate: filters.startBusinessDate,
      endBusinessDateExclusive: filters.endBusinessDateExclusive,
      granularity: filters.granularity,
    };

    return filters.slackUserId
      ? { ...base, slackUserId: filters.slackUserId }
      : base;
  }, [filters, rangeError]);

  const report = useQuery(
    api.reporting.slackQualifications.getQualificationReport,
    queryArgs,
  );

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  const operationsHref = useMemo(() => {
    const params = new URLSearchParams({
      range: "custom",
      from: filters.startBusinessDate,
      to: getInclusiveEndBusinessDate(filters.endBusinessDateExclusive),
    });
    return `/workspace/operations/qualifications?${params.toString()}`;
  }, [filters]);

  if (report === undefined && !rangeError) {
    return <SlackQualificationReportSkeleton />;
  }

  const setters = report?.setters ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Slack Qualifications
          </h1>
          <p className="text-sm text-muted-foreground">
            Qualification events, unique Slack-sourced opportunities, and setter
            contribution by Honduras 1am-to-1am business day.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild type="button" variant="outline" size="sm">
            <Link href={operationsHref}>
              <ListChecksIcon data-icon="inline-start" />
              View Events
            </Link>
          </Button>
          {report ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsTeamGoalDialogOpen(true)}
            >
              <TargetIcon data-icon="inline-start" />
              Team Goal
            </Button>
          ) : null}
        </div>
      </div>

      <SetterQualificationControls
        setters={setters}
        value={filters}
        onChange={(next) => {
          setFilters(next);
          captureFiltersChanged({
            date_range_preset: "custom",
            has_slack_setter_filter: Boolean(next.slackUserId),
          });
        }}
      />

      {rangeError ? (
        <Alert variant="destructive">
          <AlertTriangleIcon />
          <AlertTitle>Invalid report range</AlertTitle>
          <AlertDescription>{rangeError}</AlertDescription>
        </Alert>
      ) : null}

      {report ? (
        <>
          {report.settersTruncated ? (
            <Alert>
              <AlertTriangleIcon />
              <AlertTitle>Setter list capped</AlertTitle>
              <AlertDescription>
                Showing the first 500 Slack setters. Contact engineering before
                relying on contribution totals for larger Slack directories.
              </AlertDescription>
            </Alert>
          ) : null}

          {report.totals.eventsTruncated ? (
            <Alert>
              <AlertTriangleIcon />
              <AlertTitle>Qualification event sample capped</AlertTitle>
              <AlertDescription>
                Showing the first 1,000 qualification events in this range.
                Narrow the date range before using these totals for parity
                checks.
              </AlertDescription>
            </Alert>
          ) : null}

          <SetterQualificationSummaryCards
            totals={report.totals}
            filteredToSetter={report.selectedSlackUserId !== null}
          />

          <SetterQualificationTrend
            periods={report.periods}
            filteredToSetter={report.selectedSlackUserId !== null}
          />

          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-lg font-medium">Setter Contributions</h2>
              <p className="text-sm text-muted-foreground">
                Individual rows count qualification events. Unique opportunity
                counts show entity conversion separately.
              </p>
            </div>
            <SetterContributionTable rows={report.users} />
          </section>

          <Separator />

          <p className="text-xs text-muted-foreground">
            Business timezone: {report.timezone}. Daily cutoff:{" "}
            {report.businessDayStartsAtHour}:00am local time.
          </p>
        </>
      ) : null}

      {report ? (
        <TeamGoalDialog
          currentGoal={report.teamGoal.dailyTeamQualificationGoal}
          open={isTeamGoalDialogOpen}
          onOpenChange={setIsTeamGoalDialogOpen}
        />
      ) : null}
    </div>
  );
}
