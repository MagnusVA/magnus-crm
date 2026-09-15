// Build: npx --yes esbuild@0.27.0 scripts/benchmark-operations-exports.ts --bundle --platform=node --packages=external --outfile=.next/report-benchmark.cjs
// Run each sample in a fresh process: node .next/report-benchmark.cjs pdf 1100 /tmp/report-1100.pdf
import { writeFileSync } from "node:fs";
import { renderReportPdf } from "../lib/operations-reports/pdf";
import { renderReportWorkbook } from "../lib/operations-reports/xlsx";
import { exportSectionDefinition } from "../lib/operations-reports/presentation";
import type { ReportDocument } from "../lib/operations-reports/document";

async function main() {
  const format = process.argv[2] === "xlsx" ? "xlsx" : "pdf";
  const count = Number(process.argv[3] ?? 1100);
  const document: ReportDocument = {
    title: "Lead Gen",
    period: "2026-08-01 to 2026-08-31",
    generatedAt: Date.UTC(2026, 8, 1),
    boundary: "Honduras business days (01:00)",
    filters: "All sources",
    summary: [
      { label: "Submissions", value: "12,345" },
      { label: "Scheduled Hours", value: "720" },
      { label: "Leads/Hr", value: "17.15" },
    ],
    tables: [
      {
        ...exportSectionDefinition("lead_gen_origin", format),
        rows: Array.from({ length: count }, (_, i) => ({
          originKind: i % 2 ? "post" : "reel",
          originValue: `https://instagram.example/p/monthly-post-${String(i).padStart(6, "0")}-long-label-for-wrapping`,
          source: i % 2 ? "instagram" : "meta_business",
          submissions: 100 + i,
          uniqueProspects: 50 + i,
          dayCount: 31,
        })),
      },
    ],
  };
  const started = performance.now();
  const bytes =
    format === "pdf"
      ? await renderReportPdf(document)
      : renderReportWorkbook(document);
  if (process.argv[4]) writeFileSync(process.argv[4], bytes);
  console.log(
    JSON.stringify({
      format,
      rows: count,
      durationMs: Math.round(performance.now() - started),
      outputBytes: bytes.byteLength,
      maxRssMb: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
void main();
