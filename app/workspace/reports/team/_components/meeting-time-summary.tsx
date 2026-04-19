"use client";

import { Clock3Icon, ShieldCheckIcon } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { MeetingTimeKpis } from "./team-report-types";
import { formatDuration, formatRate } from "./team-report-formatters";

interface MeetingTimeSummaryProps {
  meetingTime: MeetingTimeKpis;
}

export function MeetingTimeSummary({
  meetingTime,
}: MeetingTimeSummaryProps) {
  const items = [
    {
      label: "On-Time Start Rate",
      value: formatRate(meetingTime.onTimeStartRate),
      description: `${meetingTime.onTimeStartCount} of ${meetingTime.startedMeetingsCount} started on time`,
    },
    {
      label: "Avg Late Start",
      value: formatDuration(meetingTime.avgLateStartMs),
      description: `${meetingTime.lateStartCount} late start${meetingTime.lateStartCount === 1 ? "" : "s"}`,
    },
    {
      label: "Overran Rate",
      value: formatRate(meetingTime.overranRate),
      description: `${meetingTime.overranCount} of ${meetingTime.completedWithDurationCount} tracked meetings`,
    },
    {
      label: "Avg Overrun",
      value: formatDuration(meetingTime.avgOverrunMs),
      description: `${meetingTime.overranCount} overran meeting${meetingTime.overranCount === 1 ? "" : "s"}`,
    },
    {
      label: "Avg Actual Duration",
      value: formatDuration(meetingTime.avgActualDurationMs),
      description: `${meetingTime.completedWithDurationCount} meetings with both timestamps`,
    },
    {
      label: "Schedule Adherence",
      value: formatRate(meetingTime.scheduleAdherenceRate),
      description: `${meetingTime.scheduleAdherentCount} meetings started and ended on plan`,
    },
    {
      label: "Manually Corrected",
      value: meetingTime.manuallyCorrectedCount.toLocaleString(),
      description: "Meetings with admin-entered verified times",
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock3Icon className="size-4 text-muted-foreground" />
          Meeting Time
        </CardTitle>
        <CardDescription>
          Attendance timing and schedule adherence rolled up from verified
          meeting start and stop timestamps.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {items.map((item) => (
            <div
              key={item.label}
              className="flex min-h-28 flex-col justify-between rounded-lg border bg-muted/20 p-3"
            >
              <div className="flex flex-col gap-1">
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {item.label}
                </p>
                <p className="text-2xl font-semibold tabular-nums">{item.value}</p>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            </div>
          ))}
        </div>

        <Separator />

        <div className="flex items-start gap-2 rounded-lg border bg-background px-3 py-2 text-sm text-muted-foreground">
          <ShieldCheckIcon className="mt-0.5 size-4 shrink-0" />
          <p>
            Review-required meetings stay out of show-up-rate math until a human
            resolves them. Meeting-time KPIs count only meetings with usable
            start or stop timestamps.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
