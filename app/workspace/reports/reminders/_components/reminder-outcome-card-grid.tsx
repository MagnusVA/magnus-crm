"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  formatCount,
  formatPercent,
  OUTCOME_META,
  type ReminderReportData,
} from "./reminders-report-config";

interface ReminderOutcomeCardGridProps {
  outcomeBreakdown: ReminderReportData["outcomeBreakdown"];
}

export function ReminderOutcomeCardGrid({
  outcomeBreakdown,
}: ReminderOutcomeCardGridProps) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-5">
      {outcomeBreakdown.map((entry) => {
        const meta = OUTCOME_META[entry.outcome];

        return (
          <Card key={entry.outcome} size="sm">
            <CardHeader>
              <div
                className="h-1 w-14 rounded-full"
                style={{ backgroundColor: meta.color }}
              />
              <CardTitle>{meta.label}</CardTitle>
              <CardDescription>{meta.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex items-end justify-between gap-4">
              <div className="flex flex-col gap-1">
                <span className="text-3xl font-semibold tabular-nums">
                  {formatCount(entry.count)}
                </span>
                <span className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
                  reminders
                </span>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium">
                  {formatPercent(entry.percentOfCompleted)}
                </div>
                <div className="text-xs text-muted-foreground">
                  of completed
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
