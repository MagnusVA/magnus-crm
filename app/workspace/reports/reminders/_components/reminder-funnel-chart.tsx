"use client";

import {
  ArrowRightIcon,
  BarChart3Icon,
  BellIcon,
  CheckCircle2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  formatCount,
  formatPercent,
  getPendingReminderCount,
  OUTCOME_META,
  type ReminderReportData,
} from "./reminders-report-config";

function FunnelStage({
  caption,
  children,
  label,
  value,
}: {
  caption: string;
  children: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex h-full flex-col gap-4 rounded-2xl border bg-muted/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-[0.24em] text-muted-foreground">
            {caption}
          </span>
          <h3 className="font-heading text-base font-medium">{label}</h3>
        </div>
        <span className="text-3xl font-semibold tabular-nums">{value}</span>
      </div>
      {children}
    </div>
  );
}

interface ReminderFunnelChartProps {
  data: ReminderReportData;
}

export function ReminderFunnelChart({ data }: ReminderFunnelChartProps) {
  const pendingCount = getPendingReminderCount(data);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Reminder Funnel</CardTitle>
        <CardDescription>
          Manual reminders created in the selected window, tracked through
          completion and final structured outcome.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-6">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_auto_minmax(0,0.9fr)_auto_minmax(0,1.35fr)] xl:items-stretch">
          <FunnelStage
            caption="Stage 1"
            label="Created"
            value={formatCount(data.totalCreated)}
          >
            <div className="flex flex-col gap-3">
              <Badge variant="outline" className="w-fit">
                <BellIcon className="mr-1 size-3.5" />
                Manual reminders
              </Badge>
              <Progress value={100} />
              <p className="text-sm text-muted-foreground">
                Every manual reminder created in the selected time window.
              </p>
            </div>
          </FunnelStage>

          <div className="flex items-center justify-center py-1 text-muted-foreground">
            <ArrowRightIcon className="size-4 rotate-90 xl:rotate-0" />
          </div>

          <FunnelStage
            caption="Stage 2"
            label="Completed"
            value={formatCount(data.totalCompleted)}
          >
            <div className="flex flex-col gap-3">
              <Badge variant="secondary" className="w-fit">
                <CheckCircle2Icon className="mr-1 size-3.5" />
                {formatPercent(data.completionRate)} completion rate
              </Badge>
              <Progress
                value={
                  data.completionRate === null ? 0 : data.completionRate * 100
                }
              />
              <div className="flex items-center justify-between gap-4 text-sm">
                <span className="text-muted-foreground">Still open</span>
                <span className="font-medium tabular-nums">
                  {formatCount(pendingCount)}
                </span>
              </div>
            </div>
          </FunnelStage>

          <div className="flex items-center justify-center py-1 text-muted-foreground">
            <ArrowRightIcon className="size-4 rotate-90 xl:rotate-0" />
          </div>

          <FunnelStage
            caption="Stage 3"
            label="Outcome Breakdown"
            value={formatCount(data.totalCompleted)}
          >
            <div className="flex flex-col gap-3">
              <Badge variant="outline" className="w-fit">
                <BarChart3Icon className="mr-1 size-3.5" />
                Exact completed mix
              </Badge>
              <div className="grid gap-3">
                {data.outcomeBreakdown.map((entry) => {
                  const meta = OUTCOME_META[entry.outcome];
                  return (
                    <div
                      key={entry.outcome}
                      className="flex flex-col gap-2 rounded-xl border bg-background/80 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span
                              className="size-2.5 rounded-full"
                              style={{ backgroundColor: meta.color }}
                            />
                            <span className="font-medium">{meta.label}</span>
                          </div>
                          <p className="text-xs leading-5 text-muted-foreground">
                            {meta.description}
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-lg font-semibold tabular-nums">
                            {formatCount(entry.count)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {formatPercent(entry.percentOfCompleted)}
                          </div>
                        </div>
                      </div>
                      <Progress
                        value={
                          entry.percentOfCompleted === null
                            ? 0
                            : entry.percentOfCompleted * 100
                        }
                        className="h-1.5"
                      />
                    </div>
                  );
                })}
              </div>
              {data.completedWithoutOutcomeCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {formatCount(data.completedWithoutOutcomeCount)} completed
                  reminders are still missing a structured outcome tag.
                </p>
              ) : null}
            </div>
          </FunnelStage>
        </div>
      </CardContent>
    </Card>
  );
}
