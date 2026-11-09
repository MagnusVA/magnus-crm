import { csvCell } from "../operations-reports/csv";
import { formatCell, currencyForCell, type ReportDocument } from "../operations-reports/document";
import { REPORT_TERMS, type ReportTermKey } from "./definitions";

// Exports from the rebuilt Reports (docs/reviews/reports-overhaul.html §13).
// A page exports what it shows: the band's figures and each card's table, in
// the `ReportDocument` the Operations exporter already renders. The summary
// CSV is built here, in the browser; Excel and PDF go through the Node action
// `reports/export:renderReportFile`, which runs the Operations renderers.

export type ReportExportFormat = "summary_csv" | "xlsx" | "pdf";

/** `magnus_<page>_<from>_<to>[_<member>].<ext>`, safe as a file name. */
export function reportExportFileName(
  page: string,
  startDate: string,
  endDate: string,
  extension: "csv" | "xlsx" | "pdf",
  memberName?: string,
): string {
  const member = memberName
    ? `_${memberName.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`
    : "";
  return `magnus_${page}_${startDate}_${endDate}${member}.${extension}`;
}

/** A Definitions table from the dictionary, for the terms a page uses. */
export function definitionsTable(keys: readonly ReportTermKey[]): ReportDocument["tables"][number] {
  return {
    title: "Definitions",
    columns: [
      { key: "term", label: "Term" },
      { key: "definition", label: "Definition" },
      { key: "formula", label: "Formula" },
      { key: "anchor", label: "Counted by" },
    ],
    rows: keys.map((key) => {
      const term = REPORT_TERMS[key];
      return { term: term.label, definition: term.definition, formula: term.formula, anchor: term.anchor };
    }),
  };
}

/**
 * One CSV for the whole page: the header lines, the band's figures, then
 * each card's table as its own block under its title. Money is written as a
 * decimal with its currency, never summed across currencies.
 */
export function renderSummaryCsv(document: ReportDocument): Uint8Array {
  const lines: string[] = [];
  const row = (cells: ReadonlyArray<string | number | boolean | null>) =>
    lines.push(cells.map((cell) => csvCell(cell)).join(","));
  row([document.title]);
  row([document.period]);
  row([document.boundary]);
  row([document.filters]);
  row([`Generated ${new Date(document.generatedAt).toISOString()}`]);
  lines.push("");
  row(["Figure", "Value"]);
  for (const item of document.summary) row([item.label, item.value]);
  for (const table of document.tables) {
    lines.push("");
    row([table.title]);
    row(table.columns.map((column) => column.label));
    for (const record of table.rows) {
      row(
        table.columns.map((column) => {
          const value = record[column.key];
          if (typeof value !== "number") return value ?? null;
          if (column.format === "money") return formatCell(value, "money", currencyForCell(record, column));
          if (column.format === "timestamp") return new Date(value).toISOString();
          if (column.format === "percent") return formatCell(value, "percent");
          return value;
        }),
      );
    }
  }
  return new TextEncoder().encode("﻿" + lines.join("\r\n") + "\r\n");
}
