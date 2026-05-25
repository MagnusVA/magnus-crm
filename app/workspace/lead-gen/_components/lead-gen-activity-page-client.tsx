"use client";

import { useMemo, type ComponentType, type SVGProps } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
  ClipboardCheckIcon,
  RotateCcwIcon,
  SparklesIcon,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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

const HONDURAS_TIME_ZONE = "America/Tegucigalpa";
const BUSINESS_DAY_START_OFFSET_MS = 60 * 60 * 1000;

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

function businessDayKey(timestamp: number) {
  const shifted = new Date(timestamp - BUSINESS_DAY_START_OFFSET_MS);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HONDURAS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(shifted);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const currentBusinessDayKey = businessDayKey(Date.now());

export function LeadGenActivityPageClient() {
  const todayKey = useMemo(() => currentBusinessDayKey, []);
  const daySummary = useQuery(api.leadGen.activity.getMyDaySummary, {
    dayKey: todayKey,
  });
  const recent = usePaginatedQuery(
    api.leadGen.activity.listMyRecentSubmissions,
    {},
    { initialNumItems: 25 },
  );
  const rows = recent.results as ActivityRow[];
  const isInitialLoading = recent.status === "LoadingFirstPage";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal text-pretty">
          My Activity
        </h1>
        <p className="text-sm text-muted-foreground">
          Your recent Lead Gen Ops submissions and duplicate signals.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <ActivityMetric
          label="Today"
          value={daySummary?.submissions}
          icon={ClipboardCheckIcon}
        />
        <ActivityMetric
          label="Unique"
          value={daySummary?.uniqueProspects}
          icon={SparklesIcon}
        />
        <ActivityMetric
          label="Duplicates"
          value={daySummary?.duplicates}
          icon={RotateCcwIcon}
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
            <EmptyTitle>No Submissions Yet</EmptyTitle>
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
  value: number | undefined;
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

function formatSource(source: ActivityRow["source"]) {
  return source === "meta_business" ? "Meta Business" : "Instagram";
}

function formatOrigin(originKind: string) {
  return originKind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
