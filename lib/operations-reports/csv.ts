import type { ReportCell, ReportColumn, ReportRecord } from "./document";

// Spreadsheet programs interpret formulas even in quoted CSV fields.
export function csvCell(value: ReportCell | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = `'${text}`;
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function renderCsv(columns: readonly ReportColumn[], rows: readonly ReportRecord[]): Uint8Array {
  return new TextEncoder().encode("\uFEFF" + [
    columns.map((column) => csvCell(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => csvCell(
      column.format === "timestamp" && typeof row[column.key] === "number"
        ? new Date(row[column.key] as number).toISOString()
        : row[column.key],
    )).join(",")),
  ].join("\r\n") + "\r\n");
}
