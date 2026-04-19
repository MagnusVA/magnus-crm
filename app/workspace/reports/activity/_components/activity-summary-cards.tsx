"use client";

import { useMemo } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";
import {
  ChartNoAxesColumnIcon,
  CpuIcon,
  GitBranchIcon,
  ShieldIcon,
  UserIcon,
} from "lucide-react";

interface ActivitySummaryCardsProps {
  summary: {
    totalEvents: number;
    isTruncated: boolean;
    bySource: Record<string, number>;
    byEventType: Record<string, number>;
    byOutcome: Record<string, number>;
    actorBreakdown: Array<{
      actorUserId: string;
      actorName: string;
      actorRole: string;
      count: number;
    }>;
  };
  dateRange: {
    startDate: number;
    endDate: number;
  };
}

const SOURCE_CARDS = [
  {
    label: "Closer",
    key: "closer",
    icon: UserIcon,
  },
  {
    label: "Admin",
    key: "admin",
    icon: ShieldIcon,
  },
  {
    label: "Pipeline",
    key: "pipeline",
    icon: GitBranchIcon,
  },
  {
    label: "System",
    key: "system",
    icon: CpuIcon,
  },
] as const;

const DAY_MS = 86_400_000;

function formatOutcomeLabel(key: string) {
  const [prefix, rawValue] = key.startsWith("review_resolved_")
    ? (["Review", key.slice("review_resolved_".length)] as const)
    : key.startsWith("reminder_")
      ? (["Reminder", key.slice("reminder_".length)] as const)
      : (["Outcome", key] as const);

  const humanizedValue = rawValue
    .replaceAll("follow_up", "follow-up")
    .replaceAll("no_show", "no-show")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

  return `${prefix}: ${humanizedValue}`;
}

export function ActivitySummaryCards({
  summary,
  dateRange,
}: ActivitySummaryCardsProps) {
  const topEventTypes = useMemo(
    () =>
      Object.entries(summary.byEventType)
        .toSorted((left, right) => {
          if (right[1] !== left[1]) {
            return right[1] - left[1];
          }
          return left[0].localeCompare(right[0]);
        })
        .slice(0, 5),
    [summary.byEventType],
  );

  const outcomeMix = useMemo(
    () =>
      Object.entries(summary.byOutcome)
        .filter(([, count]) => count > 0)
        .toSorted((left, right) => {
          if (right[1] !== left[1]) {
            return right[1] - left[1];
          }
          return left[0].localeCompare(right[0]);
        }),
    [summary.byOutcome],
  );

  const {
    actionsPerCloserPerDay,
    daySpanDays,
    distinctCloserActors,
    mostActiveCloser,
  } = useMemo(() => {
    const closerActors = summary.actorBreakdown
      .filter((actor) => actor.actorRole === "closer")
      .toSorted(
        (left, right) =>
          right.count - left.count ||
          left.actorName.localeCompare(right.actorName),
      );
    const totalCloserActions = closerActors.reduce(
      (sum, actor) => sum + actor.count,
      0,
    );
    const distinctCount = closerActors.length;
    const days = Math.max(
      1,
      Math.ceil((dateRange.endDate - dateRange.startDate) / DAY_MS),
    );

    return {
      mostActiveCloser: closerActors[0] ?? null,
      actionsPerCloserPerDay:
        distinctCount > 0 ? totalCloserActions / distinctCount / days : null,
      distinctCloserActors: distinctCount,
      daySpanDays: days,
    };
  }, [
    dateRange.endDate,
    dateRange.startDate,
    summary.actorBreakdown,
  ]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {SOURCE_CARDS.map(({ label, key, icon: Icon }) => {
          const count = summary.bySource[key] ?? 0;
          return (
            <Card
              key={key}
              size="sm"
              aria-label={`${label} activity count`}
            >
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Icon className="h-4 w-4" />
                  {label}
                </CardTitle>
                <CardDescription>
                  Events attributed to the {label.toLowerCase()} stream
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-bold tabular-nums">{count}</p>
              </CardContent>
            </Card>
          );
        })}

        <Card className="md:col-span-2" aria-label="Top event types">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ChartNoAxesColumnIcon className="h-4 w-4 text-muted-foreground" />
              Top Event Types
            </CardTitle>
            <CardDescription>
              Most frequent activity in the selected window
            </CardDescription>
          </CardHeader>
          <CardContent>
            {topEventTypes.length > 0 ? (
              <div className="flex flex-col gap-3">
                {topEventTypes.map(([eventType, count]) => (
                  <div
                    key={eventType}
                    className="flex items-start justify-between gap-3"
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <p className="text-sm font-medium">
                        {getEventLabel(eventType).verb}
                      </p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">
                        {eventType}
                      </p>
                    </div>
                    <Badge variant="secondary">{count}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No event-type activity in this range.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2" aria-label="Outcome mix">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ChartNoAxesColumnIcon className="h-4 w-4 text-muted-foreground" />
              Outcome Mix
            </CardTitle>
            <CardDescription>
              Reminder completions and review resolutions with structured outcomes
            </CardDescription>
          </CardHeader>
          <CardContent>
            {outcomeMix.length > 0 ? (
              <div className="flex flex-col gap-3">
                {outcomeMix.map(([outcomeKey, count]) => (
                  <div
                    key={outcomeKey}
                    className="flex items-start justify-between gap-3"
                  >
                    <p className="min-w-0 text-sm font-medium">
                      {formatOutcomeLabel(outcomeKey)}
                    </p>
                    <Badge variant="outline">{count}</Badge>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                No structured outcomes in this range.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card size="sm" aria-label="Most active closer">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <UserIcon className="h-4 w-4" />
              Most Active Closer
            </CardTitle>
            <CardDescription>
              Derived from closer-attributed activity only.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold">
              {mostActiveCloser ? mostActiveCloser.actorName : "\u2014"}
            </div>
            <p className="text-xs text-muted-foreground">
              {mostActiveCloser
                ? `${mostActiveCloser.count.toLocaleString()} actions in range`
                : "No closer activity in range"}
            </p>
          </CardContent>
        </Card>

        <Card size="sm" aria-label="Actions per closer per day">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ChartNoAxesColumnIcon className="h-4 w-4" />
              Actions / Closer / Day
            </CardTitle>
            <CardDescription>
              Local derivation from actor activity over the selected range.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold tabular-nums">
              {actionsPerCloserPerDay === null
                ? "\u2014"
                : actionsPerCloserPerDay.toFixed(1)}
            </div>
            <p className="text-xs text-muted-foreground">
              {distinctCloserActors.toLocaleString()} active closer(s) over{" "}
              {daySpanDays.toLocaleString()}d
              {summary.isTruncated ? " • summary scan truncated" : ""}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
