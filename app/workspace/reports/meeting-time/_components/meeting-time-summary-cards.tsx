import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  CalendarClockIcon,
  Clock3Icon,
  ShieldCheckIcon,
  TimerIcon,
  TriangleAlertIcon,
  VideoIcon,
  WrenchIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type {
  FathomCompliance,
  MeetingTimeTotals,
} from "./meeting-time-report-helpers";
import {
  formatDuration,
  formatRate,
} from "./meeting-time-report-helpers";

interface MeetingTimeSummaryCardsProps {
  totals: MeetingTimeTotals;
  compliance: FathomCompliance;
}

interface SummaryCardItem {
  label: string;
  value: string;
  description: string;
  icon: LucideIcon;
}

export function MeetingTimeSummaryCards({
  totals,
  compliance,
}: MeetingTimeSummaryCardsProps) {
  const items: SummaryCardItem[] = [
    {
      label: "On-Time Start Rate",
      value: formatRate(totals.onTimeStartRate),
      description: `${totals.onTimeStartCount} of ${totals.startedMeetingsCount} started on time`,
      icon: Clock3Icon,
    },
    {
      label: "Avg Late Start",
      value: formatDuration(totals.avgLateStartMs),
      description: `${totals.lateStartCount} late start${totals.lateStartCount === 1 ? "" : "s"}`,
      icon: TimerIcon,
    },
    {
      label: "Overran Rate",
      value: formatRate(totals.overranRate),
      description: `${totals.overranCount} of ${totals.completedWithDurationCount} meetings ran long`,
      icon: ActivityIcon,
    },
    {
      label: "Avg Overrun",
      value: formatDuration(totals.avgOverrunMs),
      description: `${totals.overranCount} overran meeting${totals.overranCount === 1 ? "" : "s"}`,
      icon: TriangleAlertIcon,
    },
    {
      label: "Avg Actual Duration",
      value: formatDuration(totals.avgActualDurationMs),
      description: `${totals.completedWithDurationCount} meetings with both timestamps`,
      icon: CalendarClockIcon,
    },
    {
      label: "Schedule Adherence",
      value: formatRate(totals.scheduleAdherenceRate),
      description: "Started on time and ended within the scheduled window",
      icon: ShieldCheckIcon,
    },
    {
      label: "Manually Corrected Count",
      value: totals.manuallyCorrectedCount.toLocaleString(),
      description: "Meetings with admin-entered start or stop times",
      icon: WrenchIcon,
    },
    {
      label: "Fathom Compliance Rate",
      value: formatRate(compliance.rate),
      description: `${compliance.provided} of ${compliance.required} evidence-ready meetings include a link`,
      icon: VideoIcon,
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {items.map((item) => {
        const Icon = item.icon;

        return (
          <Card key={item.label} size="sm">
            <CardHeader className="gap-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {item.label}
                  </CardTitle>
                  <CardDescription>{item.description}</CardDescription>
                </div>
                <Icon className="size-4 shrink-0 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-semibold tracking-tight tabular-nums">
                {item.value}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
