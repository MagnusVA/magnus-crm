import {
  ClipboardCheckIcon,
  RotateCcwIcon,
  SparklesIcon,
  TimerIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

type Overview = {
  submissions: number;
  uniqueProspects: number;
  duplicates: number;
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

export function LeadGenSummaryCards({ data }: { data: Overview | undefined }) {
  const cards = [
    {
      label: "Submissions",
      value:
        data === undefined ? undefined : numberFormatter.format(data.submissions),
      icon: ClipboardCheckIcon,
    },
    {
      label: "Unique",
      value:
        data === undefined
          ? undefined
          : numberFormatter.format(data.uniqueProspects),
      icon: SparklesIcon,
    },
    {
      label: "Duplicates",
      value:
        data === undefined ? undefined : numberFormatter.format(data.duplicates),
      icon: RotateCcwIcon,
    },
    {
      label: "Leads/Hr",
      value:
        data === undefined
          ? undefined
          : data.leadsPerHour === null
            ? "-"
            : decimalFormatter.format(data.leadsPerHour),
      icon: TimerIcon,
    },
  ];

  return (
    <div className="grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
      {cards.map(({ label, value, icon: Icon }) => (
        <Card className="min-w-0" key={label} size="sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-0">
            <CardTitle className="truncate text-xs font-medium text-muted-foreground">
              {label}
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
