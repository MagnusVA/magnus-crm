import * as XLSX from "xlsx-js-style";
import { assertRenderBudget, type ReportDocument } from "./document";

export function renderReportWorkbook(report: ReportDocument): Uint8Array {
  assertRenderBudget(report, "xlsx");
  const workbook = XLSX.utils.book_new();
  const summary = XLSX.utils.aoa_to_sheet([
    [report.title], [report.period], [report.boundary], [report.filters],
    [`Generated ${new Date(report.generatedAt).toISOString()} · Part ${report.part}`], [],
    ["Metric", "Value"], ...report.summary.map((item) => [item.label, item.value]),
  ]);
  summary["!cols"] = [{ wch: 42 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(workbook, summary, "Summary");
  report.tables.forEach((table, index) => {
    const sheet = XLSX.utils.aoa_to_sheet([
      table.columns.map((column) => column.label),
      ...table.rows.map((row) => table.columns.map((column) => {
        const value = row[column.key];
        if (typeof value === "number" && column.format === "timestamp") return new Date(value).toISOString();
        if (typeof value === "number" && column.format === "money") return value / 100;
        return value;
      })),
    ]);
    sheet["!cols"] = table.columns.map(() => ({ wch: 23 }));
    sheet["!autofilter"] = { ref: sheet["!ref"] ?? "A1" };
    table.columns.forEach((column, columnIndex) => {
      const header = sheet[XLSX.utils.encode_cell({ r: 0, c: columnIndex })];
      header.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "13834A" }, patternType: "solid" } };
      table.rows.forEach((_, rowIndex) => {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex })];
        if (!cell) return;
        if (rowIndex % 2 === 0) cell.s = { fill: { fgColor: { rgb: "F2F7F5" }, patternType: "solid" } };
        if (typeof cell.v === "number") {
          cell.z = column.format === "money" ? '"$"#,##0.00' : column.format === "percent" ? "0.0%" : column.format === "decimal" ? "#,##0.00" : "#,##0.##";
        }
      });
    });
    const name = `${index + 1} ${table.title}`.replace(/[\[\]:*?/\\]/gu, " ").slice(0, 31);
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  });
  return new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx", cellStyles: true, compression: true }));
}
