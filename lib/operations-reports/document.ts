import { ReportSizeLimit } from "./limits";
import { formatAmountMinor } from "../format-currency";

export type ReportCell = string | number | boolean | null;
export type ReportRecord = Record<string, ReportCell>;
export type ReportColumn = {
  key: string;
  label: string;
  format?: "number" | "decimal" | "percent" | "money" | "timestamp";
  currencyKey?: string;
};
export type ReportTable = {
  title: string;
  columns: ReportColumn[];
  rows: ReportRecord[];
};
export type ReportDocument = {
  title: string;
  period: string;
  generatedAt: number;
  boundary: string;
  filters: string;
  part?: number;
  summary: { label: string; value: string }[];
  tables: ReportTable[];
};

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const MAX_RENDER_INPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RENDER_CELLS = 200_000;
export const MAX_PDF_ROWS = 5_000;
export const MAX_XLSX_ROWS = 20_000;

export function formatCell(
  value: ReportCell | undefined,
  format?: ReportColumn["format"],
  currency = "USD",
) {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return String(value);
  if (format === "timestamp") return new Date(value).toISOString();
  if (format === "percent") return `${(value * 100).toFixed(1)}%`;
  if (format === "money") return formatAmountMinor(value, currency);
  if (format === "decimal") return value.toFixed(2);
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

export function currencyForCell(row: ReportRecord, column: ReportColumn) {
  if (!column.currencyKey) return "USD";
  const currency = row[column.currencyKey];
  return typeof currency === "string" && currency.trim()
    ? currency.trim().toUpperCase()
    : "USD";
}

export function assertRenderBudget(document: ReportDocument, format: "pdf" | "xlsx") {
  let cells = 0;
  let rows = 0;
  for (const table of document.tables) {
    cells += table.rows.length * table.columns.length;
    rows += table.rows.length;
  }
  if (cells > MAX_RENDER_CELLS || rows > (format === "pdf" ? MAX_PDF_ROWS : MAX_XLSX_ROWS) ||
    new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_RENDER_INPUT_BYTES) {
    throw new ReportSizeLimit();
  }
}
