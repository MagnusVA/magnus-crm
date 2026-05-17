"use client";

import {
  AlertTriangleIcon,
  GaugeIcon,
  MessageSquareTextIcon,
  TargetIcon,
  UsersIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type SetterQualificationSummaryCardsProps = {
  totals: {
    totalQualified: number;
    businessDayCount: number;
    averagePerBusinessDay: number | null;
    dailyTeamQualificationGoal: number | null;
    expectedTeamQualified: number | null;
    teamGoalDelta: number | null;
    teamGoalAttainment: number | null;
    underGoalPeriods: number;
    setterCount: number;
  };
  filteredToSetter: boolean;
};

export function SetterQualificationSummaryCards({
  totals,
  filteredToSetter,
}: SetterQualificationSummaryCardsProps) {
  const hasTeamGoal =
    !filteredToSetter && totals.expectedTeamQualified !== null;

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Qualified
            </CardTitle>
            <MessageSquareTextIcon className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {totals.totalQualified.toLocaleString()}
          </div>
          <p className="text-xs text-muted-foreground">
            Slack-sourced opportunities in range
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg / Business Day
            </CardTitle>
            <GaugeIcon className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {formatNumber(totals.averagePerBusinessDay)}
          </div>
          <p className="text-xs text-muted-foreground">
            Across {totals.businessDayCount.toLocaleString()} Honduras buckets
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Team Daily Goal
            </CardTitle>
            <UsersIcon className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {formatNullableInteger(totals.dailyTeamQualificationGoal)}
          </div>
          <p className="text-xs text-muted-foreground">
            One shared target for all Slack setters
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Team Attainment
            </CardTitle>
            <TargetIcon className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {formatPercent(totals.teamGoalAttainment)}
          </div>
          <p className="text-xs text-muted-foreground">
            {filteredToSetter
              ? "All setters view only"
              : totals.expectedTeamQualified === null
                ? "No team goal set"
                : `${totals.expectedTeamQualified.toLocaleString()} expected`}
          </p>
        </CardContent>
      </Card>

      <Card size="sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Under-Goal Days
            </CardTitle>
            <AlertTriangleIcon className="size-4 text-muted-foreground" />
          </div>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {hasTeamGoal ? totals.underGoalPeriods.toLocaleString() : "-"}
          </div>
          <p className="text-xs text-muted-foreground">
            {filteredToSetter
              ? "Hidden for setter drilldowns"
              : totals.expectedTeamQualified === null
                ? "No team goal set"
              : `${totals.setterCount.toLocaleString()} setters in view`}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function formatNumber(value: number | null): string {
  return value === null
    ? "-"
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function formatNullableInteger(value: number | null): string {
  return value === null ? "Not set" : value.toLocaleString();
}

function formatPercent(value: number | null): string {
  return value === null
    ? "-"
    : `${(value * 100).toLocaleString(undefined, {
        maximumFractionDigits: 1,
      })}%`;
}
