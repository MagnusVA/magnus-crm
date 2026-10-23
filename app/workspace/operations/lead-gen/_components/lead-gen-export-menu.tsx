"use client";
import { useBusinessDay } from "@/hooks/use-business-day";
import { businessDayStart, addBusinessDays as addDays } from "@/lib/businessDay";

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
import { reportClientError } from "@/lib/observability/report-client-error";
import { downloadLeadGenExcelReport } from "./lead-gen-excel-report";
import { getErrorMessage } from "@/lib/errors";

type ExportKind = "summary" | "raw" | "excel";

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
  const { setting, rebuilding } = useBusinessDay("lead-gen");
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
      startTimestamp: businessDayStart(startDayKey, setting),
      endTimestamp: businessDayStart(addDays(endDayKey, 1), setting) - 1,
      maxRows: 5000,
      ...(source ? { source } : {}),
    }),
    [endDayKey, source, startDayKey, setting],
  );

  const handleExport = useCallback(
    async (kind: ExportKind) => {
      if (exportingKind || rebuilding) return;

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
        reportClientError(error, { flow: "lead_gen_export", exportKind: kind });
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
      rebuilding,
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
          disabled={isExporting || rebuilding}
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
            disabled={isExporting || rebuilding}
            onSelect={() => void handleExport("summary")}
          >
            Summary CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isExporting || rebuilding}
            onSelect={() => void handleExport("raw")}
          >
            Raw Submissions CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={isExporting || rebuilding}
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
  return getErrorMessage(error, "Export failed").replace(/^Uncaught Error: /, "");
}
