"use client";

import { useMemo, useState } from "react";
import { AlertTriangleIcon, TargetIcon } from "lucide-react";
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
  getInitialSlackQualificationFilters,
  getRangeValidationMessage,
  type SlackQualificationFilters,
} from "./business-date-utils";
import { TeamGoalDialog } from "./team-goal-dialog";
import { SetterQualificationControls } from "./setter-qualification-controls";
import { SetterQualificationSummaryCards } from "./setter-qualification-summary-cards";
import { SetterQualificationTrend } from "./setter-qualification-trend";
import { SetterContributionTable } from "./setter-contribution-table";
import { SlackQualificationReportSkeleton } from "./slack-qualification-report-skeleton";

export function SlackQualificationReportPageClient() {
  usePageTitle("Slack Qualifications - Reports");

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
            Team qualification pace and setter contribution by Honduras
            1am-to-1am business day.
          </p>
        </div>
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

      <SetterQualificationControls
        setters={setters}
        value={filters}
        onChange={setFilters}
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
                Individual rows explain who contributed to the visible total.
                No individual goals are assigned.
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
