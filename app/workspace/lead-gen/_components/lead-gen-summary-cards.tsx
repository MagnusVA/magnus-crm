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
      label: "Unique Prospects",
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
      label: "Leads/Hour",
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
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {cards.map(({ label, value, icon: Icon }) => (
        <Card key={label}>
          <CardHeader className="flex flex-row items-center justify-between gap-3 pb-2">
            <CardTitle className="text-sm font-medium">{label}</CardTitle>
            <Icon aria-hidden="true" className="text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {value === undefined ? (
              <Skeleton className="h-9 w-24" />
            ) : (
              <p className="text-3xl font-semibold tracking-normal tabular-nums">
                {value}
              </p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
