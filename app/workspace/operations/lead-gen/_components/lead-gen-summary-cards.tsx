import {
  ClipboardCheckIcon,
  ClockIcon,
  TimerIcon,
  UsersIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { OverviewHelpTooltip } from "@/app/workspace/_components/overview-help-tooltip";

type Overview = {
  submissions: number;
  scheduledHours: number;
  leadsPerHour: number | null;
};

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

export function LeadGenSummaryCards({
  data,
  specialistCount,
}: {
  data: Overview | undefined;
  specialistCount: number | undefined;
}) {
  const cards = [
    {
      label: "Total Submissions",
      description:
        "All raw lead form submissions in the selected range, including duplicate prospects.",
      value:
        data === undefined
          ? undefined
          : numberFormatter.format(data.submissions),
      icon: ClipboardCheckIcon,
    },
    {
      label: "Specialists Active",
      description:
        "Lead gen specialists with at least one submission in the selected range.",
      value:
        specialistCount === undefined
          ? undefined
          : numberFormatter.format(specialistCount),
      icon: UsersIcon,
    },
    {
      label: "Scheduled Hours",
      description:
        "Total scheduled specialist hours across the selected range.",
      value:
        data === undefined
          ? undefined
          : decimalFormatter.format(data.scheduledHours),
      icon: ClockIcon,
    },
    {
      label: "Leads/Hr",
      description:
        "Total submissions divided by total scheduled hours. Shows — when no schedule is configured.",
      value:
        data === undefined
          ? undefined
          : data.leadsPerHour === null
            ? "—"
            : decimalFormatter.format(data.leadsPerHour),
      icon: TimerIcon,
    },
  ];

  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
      {cards.map(({ label, description, value, icon: Icon }) => (
        <Card className="min-w-0" key={label} size="sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-0">
            <CardTitle className="min-w-0 truncate text-xs font-medium text-muted-foreground">
              <OverviewHelpTooltip description={description} label={label}>
                {label}
              </OverviewHelpTooltip>
            </CardTitle>
            <Icon aria-hidden="true" className="text-muted-foreground" />
          </CardHeader>
          <CardContent className="pt-0">
            {value === undefined ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              <p className="truncate text-2xl font-semibold tracking-normal tabular-nums">
                {value}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
