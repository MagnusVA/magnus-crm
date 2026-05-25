"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { serializeCsv } from "@/lib/csv";

type ExportRequest =
  | { kind: "summary"; nonce: number }
  | { kind: "raw"; nonce: number };

const DAY_MS = 24 * 60 * 60 * 1000;

function dayKeyToBusinessStartUtc(dayKey: string) {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 7);
}

function addDays(dayKey: string, days: number) {
  const [year, month, day] = dayKey.split("-").map(Number);
  const timestamp = Date.UTC(year, month - 1, day) + days * DAY_MS;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function downloadCsv(filename: string, rows: unknown[][]) {
  const blob = new Blob([serializeCsv(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function LeadGenExportMenu({
  startDayKey,
  endDayKey,
  teamId,
  workerId,
  source,
}: {
  startDayKey: string;
  endDayKey: string;
  teamId?: Id<"attributionTeams">;
  workerId?: Id<"leadGenWorkers">;
  source?: "instagram" | "meta_business";
}) {
  const [request, setRequest] = useState<ExportRequest | null>(null);
  const completedRequestRef = useRef<number | null>(null);
  const rawRange = useMemo(
    () => ({
      startTimestamp: dayKeyToBusinessStartUtc(startDayKey),
      endTimestamp: dayKeyToBusinessStartUtc(addDays(endDayKey, 1)) - 1,
      maxRows: 5000,
      ...(teamId ? { teamId } : {}),
      ...(workerId ? { workerId } : {}),
      ...(source ? { source } : {}),
    }),
    [endDayKey, source, startDayKey, teamId, workerId],
  );

  const summaryRows = useQuery(
    api.leadGen.exports.getSummaryExportRows,
    request?.kind === "summary"
      ? {
          startDayKey,
          endDayKey,
          ...(teamId ? { teamId } : {}),
          ...(workerId ? { workerId } : {}),
          ...(source ? { source } : {}),
        }
      : "skip",
  );
  const rawRows = useQuery(
    api.leadGen.exports.getRawSubmissionExportRows,
    request?.kind === "raw" ? rawRange : "skip",
  );

  useEffect(() => {
    if (request?.kind !== "summary" || summaryRows === undefined) return;
    if (completedRequestRef.current === request.nonce) return;
    completedRequestRef.current = request.nonce;

    downloadCsv(`lead-gen-summary-${startDayKey}-${endDayKey}.csv`, [
      [
        "Day",
        "Worker",
        "Team",
        "Source",
        "Submissions",
        "Unique Prospects",
        "Duplicates",
        "Scheduled Hours",
      ],
      ...summaryRows.map((row) => [
        row.dayKey,
        row.workerDisplayName ?? row.workerEmail ?? "Unknown worker",
        row.teamName ?? "No Team",
        row.source,
        row.submissions,
        row.uniqueProspects,
        row.duplicates,
        row.scheduledHours,
      ]),
    ]);
    toast.success("Summary export ready");
  }, [endDayKey, request, startDayKey, summaryRows]);

  useEffect(() => {
    if (request?.kind !== "raw" || rawRows === undefined) return;
    if (completedRequestRef.current === request.nonce) return;
    completedRequestRef.current = request.nonce;

    downloadCsv(`lead-gen-raw-${startDayKey}-${endDayKey}.csv`, [
      [
        "Submitted At",
        "Worker",
        "Worker Email",
        "Team",
        "Prospect Handle",
        "Raw Handle",
        "Profile URL",
        "Source",
        "Origin Kind",
        "Origin Value",
        "Voided At",
        "Void Reason",
      ],
      ...rawRows.map((row) => [
        new Date(row.submittedAt).toISOString(),
        row.workerDisplayName ?? row.workerEmail ?? "Unknown worker",
        row.workerEmail ?? "",
        row.teamName ?? "No Team",
        row.normalizedHandle ? `@${row.normalizedHandle}` : row.prospectId,
        row.rawHandle ?? "",
        row.profileUrl ?? "",
        row.source,
        row.originKind,
        row.originValue ?? "",
        row.voidedAt ? new Date(row.voidedAt).toISOString() : "",
        row.voidReason ?? "",
      ]),
    ]);
    toast.success("Raw export ready");
  }, [endDayKey, rawRows, request, startDayKey]);

  const isExporting =
    (request?.kind === "summary" && summaryRows === undefined) ||
    (request?.kind === "raw" && rawRows === undefined);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={isExporting} variant="outline">
          {isExporting ? (
            <DownloadIcon data-icon="inline-start" />
          ) : (
            <DownloadIcon data-icon="inline-start" />
          )}
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem
            onSelect={() => setRequest({ kind: "summary", nonce: Date.now() })}
          >
            Summary CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setRequest({ kind: "raw", nonce: Date.now() })}
          >
            Raw Submissions CSV
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
