"use client";

import { useCallback, useMemo, useState } from "react";
import { useConvex } from "convex/react";
import { DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { serializeCsv } from "@/lib/csv";
import { downloadLeadGenExcelReport } from "./lead-gen-excel-report";

type ExportKind = "summary" | "raw" | "excel";

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
  source,
}: {
  startDayKey: string;
  endDayKey: string;
  source?: "instagram" | "meta_business";
}) {
  const convex = useConvex();
  const [exportingKind, setExportingKind] = useState<ExportKind | null>(null);
  const exportFilters = useMemo(
    () => ({
      startDayKey,
      endDayKey,
      ...(source ? { source } : {}),
    }),
    [endDayKey, source, startDayKey],
  );
  const rawRange = useMemo(
    () => ({
      startTimestamp: dayKeyToBusinessStartUtc(startDayKey),
      endTimestamp: dayKeyToBusinessStartUtc(addDays(endDayKey, 1)) - 1,
      maxRows: 5000,
      ...(source ? { source } : {}),
    }),
    [endDayKey, source, startDayKey],
  );

  const handleExport = useCallback(
    async (kind: ExportKind) => {
      if (exportingKind) return;

      setExportingKind(kind);
      try {
        if (kind === "summary") {
          const summaryRows = await convex.query(
            api.leadGen.exports.getSummaryExportRows,
            exportFilters,
          );
          downloadCsv(`lead-gen-summary-${startDayKey}-${endDayKey}.csv`, [
            [
              "Day",
              "Lead Gen Specialist",
              "Team",
              "Source",
              "Submissions",
              "Scheduled Hours",
            ],
            ...summaryRows.map((row) => [
              row.dayKey,
              row.workerDisplayName ?? row.workerEmail ?? "Unknown specialist",
              row.teamName ?? "No Team",
              row.source,
              row.submissions,
              row.scheduledHours,
            ]),
          ]);
          toast.success("Summary export ready");
          return;
        }

        if (kind === "raw") {
          const rawRows = await convex.query(
            api.leadGen.exports.getRawSubmissionExportRows,
            rawRange,
          );
          downloadCsv(`lead-gen-raw-${startDayKey}-${endDayKey}.csv`, [
            [
              "Submitted At",
              "Lead Gen Specialist",
              "Specialist Email",
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
              row.workerDisplayName ?? row.workerEmail ?? "Unknown specialist",
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
          return;
        }

        const excelReport = await convex.query(
          api.leadGen.exports.getExcelReportData,
          exportFilters,
        );
        downloadLeadGenExcelReport(excelReport);
        toast.success("Excel report ready");
      } catch (error) {
        toast.error(getExportErrorMessage(error));
      } finally {
        setExportingKind(null);
      }
    },
    [
      convex,
      endDayKey,
      exportFilters,
      exportingKind,
      rawRange,
      startDayKey,
    ],
  );

  const isExporting = exportingKind !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-busy={isExporting}
          disabled={isExporting}
          size="sm"
          variant="outline"
        >
          <DownloadIcon data-icon="inline-start" />
          {isExporting ? "Exporting..." : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={isExporting}
            onSelect={() => void handleExport("summary")}
          >
            Summary CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isExporting}
            onSelect={() => void handleExport("raw")}
          >
            Raw Submissions CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isExporting}
            onSelect={() => void handleExport("excel")}
          >
            Performance Excel
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getExportErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message.replace(/^Uncaught Error: /, "");
  }

  return "Export failed";
}
