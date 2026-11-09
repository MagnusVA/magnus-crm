"use client";

import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { reportExportFileName } from "@/lib/reporting/export";
import { cn } from "@/lib/utils";
import { BAND_SELECT } from "../../_components/report-ui";
import type { ReportExportExtra } from "../../_components/report-export-menu";

/**
 * The band's currency select (the Sales calls one), shown only when the range
 * has more than one currency. Money is never added across currencies, so the
 * page shows one at a time (reports-decisions D8).
 */
export function CurrencySelect({
  currencies,
  value,
  onChange,
}: {
  currencies: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  if (currencies.length < 2) return null;
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label="Currency"
        className={cn(BAND_SELECT, "w-auto font-condensed text-[14px] font-semibold tracking-[0.02em]")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {currencies.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function downloadCsv(bytes: ArrayBuffer, fileName: string) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The export menu's rows item: one line per payment or credit in the range,
 * built by the rows export action (ClickHouse for the days before today,
 * Convex for today).
 */
export function useRowsExport({
  kind,
  label,
  page,
  startDate,
  endDate,
}: {
  kind: "payments" | "credits";
  label: string;
  page: string;
  startDate: string;
  endDate: string;
}): ReportExportExtra {
  const exportRows = useAction(api.reports.rowsExport.exportRows);
  return {
    label,
    run: async () => {
      const bytes = await exportRows({ kind, range: { startDate, endDateInclusive: endDate } });
      downloadCsv(bytes, reportExportFileName(`${page}_${kind}`, startDate, endDate, "csv"));
    },
  };
}
