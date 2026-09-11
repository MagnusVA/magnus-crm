/** Generate local QA artifacts; never reads tenant data. Run through esbuild or a TS runner. */
import { writeFile, mkdir } from "node:fs/promises";
import { renderReportPdf } from "../lib/operations-reports/pdf";
import { renderReportWorkbook } from "../lib/operations-reports/xlsx";
import type { ReportDocument } from "../lib/operations-reports/document";
import { exportSectionDefinition } from "../lib/operations-reports/presentation";

const directory = process.argv[2];
if (!directory) throw new Error("Provide an output directory for QA artifacts.");
const report: ReportDocument = {
  title: "Sales Calls Performance", period: "2026-01-01 to 2026-01-31", generatedAt: Date.UTC(2026, 1, 1),
  boundary: "UTC days (00:00)", filters: "All closers", part: 1,
  summary: [{ label: "Calls", value: "14,215" }, { label: "Sales", value: "1,507" }, { label: "Cash Collected", value: "$720,514" }, { label: "Close Rate", value: "24.8%" }],
  tables: [{ ...exportSectionDefinition("sales_closer", "pdf"), rows: Array.from({ length: 300 }, (_, index) => ({
    label: index % 9 === 0 ? "Long specialist name for wrapping verification – Ana María del Carmen" : `Specialist ${index + 1}`,
    booked: 100, showed: 70, canceled: 10, noShows: 20, showUpRate: 70 / 90, paymentSales: 25, paymentRevenueMinor: 1000000,
    paymentCloseRate: 25 / 70, avgPaymentDealMinor: 40000,
  })) }],
};
await mkdir(directory, { recursive: true });
const started = Date.now();
const pdf = await renderReportPdf(report);
const xlsx = renderReportWorkbook(report);
await writeFile(`${directory}/operations-report.pdf`, pdf);
await writeFile(`${directory}/operations-report.xlsx`, xlsx);
console.log(JSON.stringify({ pdfBytes: pdf.byteLength, xlsxBytes: xlsx.byteLength, elapsedMs: Date.now() - started, rssMiB: process.memoryUsage().rss / 1024 / 1024 }));
