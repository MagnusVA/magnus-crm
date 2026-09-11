// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx-js-style";
import { csvCell, renderCsv } from "./csv";
import { renderReportPdf } from "./pdf";
import { renderReportWorkbook } from "./xlsx";
import { assertRenderBudget, formatCell, type ReportDocument } from "./document";
import { buildLeadGenWorkbook } from "./lead-gen-workbook";
import { exportSectionDefinition } from "./presentation";

const report: ReportDocument = {
  title: "Qualifications", period: "2026-01-01 to 2026-01-31", generatedAt: 1769904000000,
  boundary: "Honduras business days (01:00)", filters: "All qualifiers", part: 1,
  summary: [{ label: "Qualifications", value: "8,400" }],
  tables: [{ title: "Qualifier performance", columns: [{ key: "label", label: "Qualifier" }, { key: "count", label: "Qualifications", format: "number" }], rows: [{ label: "Ana, María", count: 8400 }] }],
};

describe("report formats", () => {
  it("quotes CSV and neutralizes spreadsheet formulas without changing numeric negatives", () => {
    expect(csvCell('hello,"world"\nnext')).toBe('"hello,""world""\nnext"');
    expect(csvCell(" =HYPERLINK(\"x\")")).toBe('"\' =HYPERLINK(""x"")"');
    expect(csvCell(-42)).toBe("-42");
    const csv = new TextDecoder().decode(renderCsv(report.tables[0].columns, report.tables[0].rows));
    expect(csv).toContain('"Ana, María",8400\r\n');
  });
  it("renders numeric workbook cells and usable PDF bytes", async () => {
    const bytes = renderReportWorkbook(report);
    const book = XLSX.read(bytes, { type: "array", cellStyles: true });
    expect(book.Sheets[book.SheetNames[1]].B2).toMatchObject({ t: "n", v: 8400 });
    const pdf = await renderReportPdf(report);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });
  it("rejects oversized render input before allocating workbook or PDF layout", () => {
    const oversized = { ...report, tables: [{ ...report.tables[0], rows: Array.from({ length: 501 }, () => ({ count: 1 })) }] };
    expect(() => assertRenderBudget(oversized, "pdf")).toThrow("rendering budget");
  });
  it("keeps mixed-currency Excel money and rates numeric with row currency labels", () => {
    const definition = exportSectionDefinition("sales_closer_money", "xlsx");
    const book = XLSX.read(renderReportWorkbook({ ...report, tables: [{ ...definition, rows: [
      { label: "Ana", currency: "USD", paymentRevenueMinor: 125050, paymentCloseRate: 1.25 },
      { label: "Jo", currency: "JPY", paymentRevenueMinor: 125050, paymentCloseRate: 0.5 },
    ] }] }), { type: "array", cellNF: true });
    const sheet = book.Sheets[book.SheetNames[1]];
    const cellFor = (key: string, row = 1) => sheet[XLSX.utils.encode_cell({ r: row, c: definition.columns.findIndex(column => column.key === key) })];
    expect(cellFor("paymentRevenueMinor")).toMatchObject({ t: "n", v: 1250.5, z: '"USD" #,##0.00' });
    expect(cellFor("paymentRevenueMinor", 2)).toMatchObject({ t: "n", v: 1250.5, z: '"JPY" #,##0' });
    expect(cellFor("paymentCloseRate")).toMatchObject({ t: "n", v: 1.25, z: "0.0%" });
    expect(exportSectionDefinition("sales_closer_money", "summary_csv").columns.find(column => column.key === "paymentRevenueMinor")?.label).toContain("stored hundredths");
  });
  it("keeps malformed currency buckets visible instead of throwing", () => {
    expect(formatCell(12345, "money", "bad code")).toBe("123.45 BAD CODE");
  });
  it("labels mixed-currency CSV rows and renders them in PDF", async () => {
    const csvDefinition = exportSectionDefinition(
      "sales_summary_money",
      "summary_csv",
    );
    const rows = [
      { currency: "EUR", cashCollectedMinor: 45000 },
      { currency: "USD", cashCollectedMinor: 125050 },
    ];
    const csv = new TextDecoder().decode(
      renderCsv(csvDefinition.columns, rows),
    );
    expect(csv).toContain("Currency");
    expect(csv).toContain("Cash Collected (stored hundredths)");
    expect(csv).toContain("EUR");
    expect(csv).toContain("USD");

    const pdfDefinition = exportSectionDefinition(
      "sales_summary_money",
      "pdf",
    );
    const pdf = await renderReportPdf({
      ...report,
      tables: [{ ...pdfDefinition, rows }],
    });
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
  });
  it("preserves existing Lead Gen team workbook sections", () => {
    const worker = { displayName: "Ana", email: "ana@example.test", teamName: "Team A", isActive: true, submissions: 12, uniqueProspects: 10, duplicates: 2, scheduledHours: 4, leadsPerHour: 3 };
    const workbook = buildLeadGenWorkbook({ generatedAt: report.generatedAt, reportTitle: "Lead Gen Performance", filters: { startDayKey: "2026-01-01", endDayKey: "2026-01-31", source: null, teamName: null, workerName: null }, sheets: [{ sheetKey: "a", sheetName: "Team A", scopeKind: "team", scopeLabel: "Team A", summary: worker, topLeadGenerators: [worker], topPosts: [], workerPerformance: [worker], sourcePerformance: [], postDetail: [] }] });
    const cells = Object.values(workbook.Sheets["Team A"]).filter((cell) => cell && typeof cell === "object" && "v" in cell).map((cell) => cell.v);
    expect(cells).toEqual(expect.arrayContaining(["Top 3 Lead Gen Specialists", "Top 3 Posts/Reels", "Specialist Performance", "Source Split", "Posts/Reels Detail"]));
  });
});
