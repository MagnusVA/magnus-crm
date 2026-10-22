"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePaginatedQuery } from "convex/react";
import { addDays, format, startOfDay, subDays } from "date-fns";
import { CalendarXIcon, DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { MissedMeetingRow } from "@/convex/operations/missedMeetings";
import type { MissedMeeting } from "@/convex/opportunities/dealState";
import { SYSTEM_LOSS_REASON_LABELS } from "@/convex/opportunities/stages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ReportDateControls,
  type DateRange,
} from "@/app/workspace/reports/_components/report-date-controls";
import {
  DEAL_SOURCE_LABELS,
  MISSED_MEETINGS_EXPORT_CAP,
  capMissedMeetingRows,
  missedMeetingsCsv,
  needsMoreMissedMeetingRows,
} from "@/lib/operations-reports/missed-meetings-export";

// Deals read per page; the server reads at most 100 a call.
const PAGE_SIZE = 100;

type KindFilter = MissedMeeting | "all";

function lastThirtyDays(): DateRange {
  const today = startOfDay(new Date());
  return {
    startDate: subDays(today, 29).getTime(),
    endDate: addDays(today, 1).getTime(),
  };
}

function formatTime(timestamp: number | null) {
  return timestamp === null ? "—" : format(timestamp, "MMM d, yyyy h:mm a");
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function MissedMeetingsPageClient() {
  usePageTitle("No-shows & Cancellations");

  const [dateRange, setDateRange] = useState<DateRange>(lastThirtyDays);
  const [kind, setKind] = useState<KindFilter>("all");
  const [hideBookedAgain, setHideBookedAgain] = useState(true);

  const { results, status, loadMore } = usePaginatedQuery(
    api.operations.missedMeetings.listMissedMeetings,
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      hideBookedAgain,
      ...(kind === "all" ? {} : { kind }),
    },
    { initialNumItems: PAGE_SIZE },
  );

  // The list and its export are the same rows, so the page reads every page
  // of the range, up to one row past the export's cap.
  useEffect(() => {
    if (status === "CanLoadMore" && needsMoreMissedMeetingRows(results.length)) {
      loadMore(PAGE_SIZE);
    }
  }, [loadMore, results.length, status]);

  const { rows, truncated } = useMemo(() => capMissedMeetingRows(results), [results]);
  const isComplete = status === "Exhausted" || truncated;

  const handleExport = () => {
    const first = format(dateRange.startDate, "yyyy-MM-dd");
    const last = format(dateRange.endDate - 1, "yyyy-MM-dd");
    downloadCsv(`no-shows-and-cancellations-${first}-to-${last}.csv`, missedMeetingsCsv(rows));
    toast.success(
      truncated
        ? `Exported ${MISSED_MEETINGS_EXPORT_CAP.toLocaleString()} deals. The range holds more; narrow it for the rest.`
        : `Exported ${rows.length.toLocaleString()} ${rows.length === 1 ? "deal" : "deals"}.`,
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-4 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            No-shows & Cancellations
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Deals a no-show or a cancellation closed, newest first, with the
            person&apos;s contact details and who worked the deal. Export the
            list for outreach.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={!isComplete || rows.length === 0}
          onClick={handleExport}
        >
          <DownloadIcon data-icon="inline-start" />
          Export CSV
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ReportDateControls value={dateRange} onChange={setDateRange} />
        <Select
          value={kind}
          onValueChange={(value) =>
            setKind(value === "no_show" || value === "canceled" ? value : "all")
          }
        >
          <SelectTrigger aria-label="Filter by missed meeting" className="w-48" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">No-shows and cancellations</SelectItem>
              <SelectItem value="no_show">No-shows</SelectItem>
              <SelectItem value="canceled">Cancellations</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch
            id="hide-booked-again"
            checked={hideBookedAgain}
            onCheckedChange={setHideBookedAgain}
          />
          <Label htmlFor="hide-booked-again" className="text-sm font-normal">
            Hide people who booked again
          </Label>
        </div>
      </div>

      <div className="flex flex-col gap-1 text-sm text-muted-foreground" role="status">
        {isComplete ? (
          <p>
            {rows.length.toLocaleString()} {rows.length === 1 ? "deal" : "deals"}
          </p>
        ) : (
          <p className="flex items-center gap-2">
            <Spinner data-icon="inline-start" />
            Loading… {rows.length.toLocaleString()} so far
          </p>
        )}
        {truncated ? (
          <p className="text-foreground">
            This range holds more than {MISSED_MEETINGS_EXPORT_CAP.toLocaleString()} deals.
            The list and the export hold {MISSED_MEETINGS_EXPORT_CAP.toLocaleString()} of
            them; narrow the range for the rest.
          </p>
        ) : null}
      </div>

      {status === "LoadingFirstPage" ? (
        <Skeleton
          className="h-[480px] w-full"
          role="status"
          aria-label="Loading no-shows and cancellations"
        />
      ) : rows.length === 0 && isComplete ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarXIcon />
            </EmptyMedia>
            <EmptyTitle>No missed meetings in this range</EmptyTitle>
            <EmptyDescription>
              {hideBookedAgain
                ? "No deal closed on a no-show or a cancellation, apart from people who booked again."
                : "No deal closed on a no-show or a cancellation."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <MissedMeetingsTable rows={rows} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MissedMeetingsTable({ rows }: { rows: MissedMeetingRow[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-4">Person</TableHead>
          <TableHead>Contact</TableHead>
          <TableHead>Missed</TableHead>
          <TableHead>Meeting</TableHead>
          <TableHead>Source</TableHead>
          <TableHead>Closer</TableHead>
          <TableHead>Setter</TableHead>
          <TableHead className="pr-4">DM closer</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.opportunityId}>
            <TableCell className="pl-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <Link
                  className="font-medium hover:underline"
                  href={`/workspace/leads-customers/${row.leadId}?opportunityId=${row.opportunityId}`}
                >
                  {row.personName ?? row.email ?? row.instagramHandle ?? "Unnamed person"}
                </Link>
                {row.instagramHandle ? (
                  <span className="text-xs text-muted-foreground">@{row.instagramHandle}</span>
                ) : null}
                {row.bookedAgain ? (
                  <Badge variant="outline" className="w-fit">
                    Booked again
                  </Badge>
                ) : null}
              </div>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-0.5 text-sm">
                <span>{row.email ?? "—"}</span>
                <span className="text-muted-foreground tabular-nums">{row.phone ?? "—"}</span>
              </div>
            </TableCell>
            <TableCell>
              <Badge variant={row.missedMeeting === "no_show" ? "destructive" : "muted"}>
                {SYSTEM_LOSS_REASON_LABELS[row.missedMeeting]}
              </Badge>
            </TableCell>
            <TableCell className="whitespace-nowrap tabular-nums">
              {formatTime(row.meetingAt)}
            </TableCell>
            <TableCell>{DEAL_SOURCE_LABELS[row.source]}</TableCell>
            <TableCell>{row.closerName ?? "—"}</TableCell>
            <TableCell>{row.setterName ?? "—"}</TableCell>
            <TableCell className="pr-4">
              <div className="flex flex-col gap-0.5">
                <span>{row.dmCloserName ?? "—"}</span>
                {row.dmTeamName ? (
                  <span className="text-xs text-muted-foreground">{row.dmTeamName}</span>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
