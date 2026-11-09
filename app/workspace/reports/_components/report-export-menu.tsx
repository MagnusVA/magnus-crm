"use client";

import { useState } from "react";
import { useAction } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { DownloadIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ReportDocument } from "@/lib/operations-reports/document";
import { renderSummaryCsv, reportExportFileName } from "@/lib/reporting/export";
import { BAND_BUTTON } from "./report-ui";

// Export in a report's band (docs/reviews/reports-overhaul.html §13). It
// exports what the page shows: the page builds a `ReportDocument` from the
// answers already on screen, so the file can't disagree with it. The summary
// CSV is made here; Excel and PDF are rendered by a Node action with the
// Operations renderers. A page may add more items, such as a rows export.

export type ReportExportExtra = {
  label: string;
  /** Builds and downloads the file; throws a message safe to show. */
  run: () => Promise<void>;
};

function download(bytes: Uint8Array | ArrayBuffer, fileName: string, type: string) {
  const blob = new Blob([bytes instanceof Uint8Array ? new Uint8Array(bytes) : bytes], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * "Calls · CSV", "Payments · CSV" or "Credits · CSV": every record behind the
 * page for the range, from `reports/rowsExport:exportRows` (ClickHouse for the
 * settled days, Convex for the rest). Pass it to `ReportExportMenu`'s `extra`.
 */
export function useRowsExport(
  kind: "calls" | "payments" | "credits" | "events",
  page: string,
  startDate: string,
  endDate: string,
  /** The page's filters, so the file holds the records the page shows. */
  filters: FunctionArgs<typeof api.reports.rowsExport.exportRows>["filters"] = {},
): ReportExportExtra {
  const exportRows = useAction(api.reports.rowsExport.exportRows);
  const label = { calls: "Calls · CSV", payments: "Payments · CSV", credits: "Credits · CSV", events: "Events · CSV" }[kind];
  return {
    label,
    run: async () => {
      const bytes = await exportRows({ kind, range: { startDate, endDateInclusive: endDate }, filters });
      download(bytes, reportExportFileName(`${page}-${kind}`, startDate, endDate, "csv"), "text/csv;charset=utf-8");
    },
  };
}

export function ReportExportMenu({
  page,
  startDate,
  endDate,
  memberName,
  buildDocument,
  extra = [],
}: {
  /** Part of the file name: `scorecard`, `calls`, `people`, `attribution`. */
  page: string;
  /** The range's first and last business dates, for the file name. */
  startDate: string;
  endDate: string;
  memberName?: string;
  /** The document the page shows, or null while it loads. */
  buildDocument: () => ReportDocument | null;
  extra?: readonly ReportExportExtra[];
}) {
  const renderFile = useAction(api.reports.export.renderReportFile);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The export failed. Try again.");
    } finally {
      setBusy(null);
    }
  }

  function documentOrThrow() {
    const document = buildDocument();
    if (!document) throw new Error("The page is still loading. Try again in a moment.");
    return document;
  }

  const name = (extension: "csv" | "xlsx" | "pdf") =>
    reportExportFileName(page, startDate, endDate, extension, memberName);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={BAND_BUTTON} aria-busy={busy !== null}>
          {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : <DownloadIcon data-icon="inline-start" />}
          {busy ? "Exporting" : "Export"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>What this page shows</DropdownMenuLabel>
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={busy !== null}
            onSelect={() =>
              void run("csv", async () => {
                download(renderSummaryCsv(documentOrThrow()), name("csv"), "text/csv;charset=utf-8");
              })
            }
          >
            Summary · CSV
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy !== null}
            onSelect={() =>
              void run("xlsx", async () => {
                const bytes = await renderFile({ format: "xlsx", document: documentOrThrow() });
                download(bytes, name("xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
              })
            }
          >
            Workbook · Excel
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={busy !== null}
            onSelect={() =>
              void run("pdf", async () => {
                const bytes = await renderFile({ format: "pdf", document: documentOrThrow() });
                download(bytes, name("pdf"), "application/pdf");
              })
            }
          >
            Report · PDF
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {extra.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Every record in the range</DropdownMenuLabel>
            <DropdownMenuGroup>
              {extra.map((item) => (
                <DropdownMenuItem key={item.label} disabled={busy !== null} onSelect={() => void run(item.label, item.run)}>
                  {item.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
