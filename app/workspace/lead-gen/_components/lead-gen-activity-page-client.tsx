"use client";

import { useState, type ComponentType, type SVGProps } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
  ClipboardCheckIcon,
  GaugeIcon,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DashboardDateRangeFilter,
  type DashboardRangeInput,
} from "../../_components/dashboard-date-range-filter";
import { validateCustomDashboardRange } from "../../_components/dashboard-date-utils";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type ActivityRow = {
  _id: string;
  submittedAt: number;
  source: "instagram" | "meta_business";
  originKind: string;
  originValue?: string;
  originRankable?: boolean;
  prospect?: {
    normalizedHandle?: string;
    profileUrl?: string;
  } | null;
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const wholeNumberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

export function LeadGenActivityPageClient() {
  const [range, setRange] = useState<DashboardRangeInput>({
    kind: "preset",
    preset: "today",
  });
  const [queryRange, setQueryRange] = useState<DashboardRangeInput>({
    kind: "preset",
    preset: "today",
  });
  const rangeValidationMessage =
    range.kind === "custom"
      ? validateCustomDashboardRange({
          startBusinessDate: range.startBusinessDate,
          endBusinessDateInclusive: range.endBusinessDateInclusive,
        })
      : null;
  const summary = useQuery(api.leadGen.activity.getMyActivitySummary, {
    range: queryRange,
  });
  const recent = usePaginatedQuery(
    api.leadGen.activity.listMyRecentSubmissions,
    { range: queryRange },
    { initialNumItems: 25 },
  );
  const rows = recent.results as ActivityRow[];
  const isInitialLoading = recent.status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-normal text-pretty">
            My Activity
          </h1>
          <p className="text-sm text-muted-foreground">
            {summary?.range.label ?? "Loading activity range"}
          </p>
        </div>
        <DashboardDateRangeFilter
          value={range}
          onChange={(nextRange) => {
            setRange(nextRange);
            if (
              nextRange.kind === "preset" ||
              validateCustomDashboardRange({
                startBusinessDate: nextRange.startBusinessDate,
                endBusinessDateInclusive: nextRange.endBusinessDateInclusive,
              }) === null
            ) {
              setQueryRange(nextRange);
            }
          }}
          validationMessage={rangeValidationMessage}
        />
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <ActivityMetric
          label="Raw Leads"
          value={formatWholeNumber(summary?.submissions)}
          icon={ClipboardCheckIcon}
        />
        <ActivityMetric
          label="Leads/hr"
          value={formatLeadsPerHour(summary?.leadsPerHour)}
          icon={GaugeIcon}
        />
      </div>

      {isInitialLoading ? (
        <Skeleton className="h-[360px] w-full" />
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ClipboardCheckIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No Submissions In This Range</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>Captured prospects will appear here.</EmptyContent>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Submitted</TableHead>
                  <TableHead>Prospect</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Origin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((submission) => (
                  <TableRow key={submission._id}>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {dateTimeFormatter.format(submission.submittedAt)}
                    </TableCell>
                    <TableCell className="min-w-48 max-w-64">
                      <span className="block truncate font-medium">
                        {submission.prospect?.normalizedHandle
                          ? `@${submission.prospect.normalizedHandle}`
                          : "Prospect"}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {formatSource(submission.source)}
                      </Badge>
                    </TableCell>
                    <TableCell className="min-w-48 max-w-72">
                      <span className="block truncate">
                        {submission.originValue ??
                          formatOrigin(submission.originKind)}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {recent.status === "CanLoadMore" ? (
            <Button
              className="self-start"
              variant="outline"
              onClick={() => recent.loadMore(25)}
            >
              Load More
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ActivityMetric({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | undefined;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}) {
  return (
    <div className="flex min-h-20 min-w-0 flex-col justify-between rounded-lg border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-muted-foreground">
          {label}
        </span>
        <Icon aria-hidden="true" className="text-muted-foreground" />
      </div>
      <span className="text-2xl font-semibold tabular-nums">
        {value ?? "-"}
      </span>
    </div>
  );
}

function formatWholeNumber(value: number | undefined) {
  return value === undefined ? undefined : wholeNumberFormatter.format(value);
}

function formatLeadsPerHour(value: number | null | undefined) {
  if (value === undefined) return undefined;
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
}

function formatSource(source: ActivityRow["source"]) {
  return source === "meta_business" ? "Meta Business" : "Instagram";
}

function formatOrigin(originKind: string) {
  if (originKind === "source_only") return "No Origin";

  return originKind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
