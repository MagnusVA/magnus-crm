import PDFDocument from "pdfkit";
import {
  assertRenderBudget,
  currencyForCell,
  formatCell,
  MAX_ARTIFACT_BYTES,
  type ReportDocument,
  type ReportTable,
} from "./document";
import { ReportSizeLimit } from "./limits";

const MARGIN = 34;
const INK = "#17252b";
const MUTED = "#62747b";
const GREEN = "#13834a";
type LayoutRow = { cells: string[]; height: number };
type LayoutPage = {
  table: ReportTable;
  rows: LayoutRow[];
  summary: boolean;
  headerHeight: number;
  width: number;
  height: number;
};

// Measure once, then draw and flush each page. There is no retained React/Yoga
// layout tree, so large monthly tables do not multiply the renderer's memory.
export async function renderReportPdf(
  report: ReportDocument,
): Promise<Uint8Array> {
  assertRenderBudget(report, "pdf");
  const pdf = new PDFDocument({
    autoFirstPage: false,
    bufferPages: false,
    compress: true,
    info: {
      Title: report.title,
      Author: "Magnus CRM",
      CreationDate: new Date(report.generatedAt),
      ModDate: new Date(report.generatedAt),
    },
  });
  const chunks: Buffer[] = [];
  let byteSize = 0;
  const output = new Promise<Uint8Array>((resolve, reject) => {
    pdf.on("data", (chunk: Buffer) => {
      byteSize += chunk.length;
      if (byteSize > MAX_ARTIFACT_BYTES) {
        pdf.destroy(new ReportSizeLimit());
        return;
      }
      chunks.push(chunk);
    });
    pdf.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    pdf.on("error", reject);
  });
  const tables = report.tables.length
    ? report.tables
    : [{ title: "Summary", columns: [], rows: [] }];
  const pages: LayoutPage[] = [];
  try {
    for (const [tableIndex, table] of tables.entries()) {
      const landscape = table.columns.length > 6;
      const width = landscape ? 841.89 : 595.28;
      const height = landscape ? 595.28 : 841.89;
      const cellWidth =
        (width - 2 * MARGIN) / Math.max(1, table.columns.length);
      // PDFKit measurement needs an initial page for its font/text context.
      if (!pdf.page) pdf.addPage({ size: [width, height], margin: MARGIN });
      pdf.font("Helvetica-Bold").fontSize(8);
      const measure = (text: string) =>
        pdf.heightOfString(text, { width: cellWidth - 10, lineGap: 2 });
      const headerHeight =
        Math.max(12, ...table.columns.map((column) => measure(column.label))) +
        12;
      const summaryHeight =
        tableIndex === 0 ? Math.ceil(report.summary.length / 4) * 58 : 0;
      let page: LayoutPage = {
        table,
        rows: [],
        summary: tableIndex === 0,
        headerHeight,
        width,
        height,
      };
      let used = 151 + headerHeight + summaryHeight;
      pdf.font("Helvetica").fontSize(8);
      for (const row of table.rows) {
        const cells = table.columns.map((column) => {
          const text = formatCell(
            row[column.key],
            column.format,
            currencyForCell(row, column),
          );
          return text.length > 72 ? `${text.slice(0, 69)}…` : text;
        });
        const rowHeight = Math.max(12, ...cells.map(measure)) + 12;
        if (used + rowHeight > height - 50 && page.rows.length) {
          pages.push(page);
          page = {
            table,
            rows: [],
            summary: false,
            headerHeight,
            width,
            height,
          };
          used = 151 + headerHeight;
        }
        page.rows.push({ cells, height: rowHeight });
        used += rowHeight;
      }
      pages.push(page);
    }
    for (const [pageIndex, page] of pages.entries()) {
      if (pageIndex > 0)
        pdf.addPage({ size: [page.width, page.height], margin: MARGIN });
      const contentWidth = page.width - 2 * MARGIN;
      const cellWidth = contentWidth / Math.max(1, page.table.columns.length);
      pdf
        .fillColor(GREEN)
        .font("Helvetica-Bold")
        .fontSize(10)
        .text("MAGNUS CRM  /  OPERATIONS", MARGIN, 32);
      pdf.fillColor(INK).fontSize(22).text(report.title, MARGIN, 51);
      pdf
        .fillColor(MUTED)
        .font("Helvetica")
        .fontSize(8)
        .text(`${report.period}  •  ${report.boundary}`, MARGIN, 83);
      pdf.text(
        `${report.filters}  •  Generated ${new Date(report.generatedAt).toISOString()}${report.part ? `  •  Part ${report.part}` : ""}`,
        MARGIN,
        97,
      );
      let y = 124;
      if (page.summary) {
        report.summary.forEach((item, index) => {
          const x = MARGIN + ((index % 4) * contentWidth) / 4;
          const top = y + Math.floor(index / 4) * 58;
          pdf.rect(x, top, 2, 42).fill(GREEN);
          pdf
            .fillColor(MUTED)
            .font("Helvetica")
            .fontSize(8)
            .text(item.label, x + 10, top + 3, {
              width: contentWidth / 4 - 16,
            });
          pdf
            .fillColor(INK)
            .font("Helvetica-Bold")
            .fontSize(16)
            .text(item.value, x + 10, top + 20, {
              width: contentWidth / 4 - 16,
            });
        });
        y += Math.ceil(report.summary.length / 4) * 58;
      }
      pdf
        .fillColor(INK)
        .font("Helvetica-Bold")
        .fontSize(12)
        .text(page.table.title, MARGIN, y);
      y += 27;
      pdf.rect(MARGIN, y, contentWidth, page.headerHeight).fill("#eaf3ef");
      pdf.fillColor(INK).font("Helvetica-Bold").fontSize(8);
      page.table.columns.forEach((column, index) =>
        pdf.text(column.label, MARGIN + index * cellWidth + 5, y + 6, {
          width: cellWidth - 10,
          lineGap: 2,
        }),
      );
      y += page.headerHeight;
      pdf.font("Helvetica");
      for (const row of page.rows) {
        row.cells.forEach((text, index) =>
          pdf.text(text, MARGIN + index * cellWidth + 5, y + 6, {
            width: cellWidth - 10,
            lineGap: 2,
          }),
        );
        y += row.height;
        pdf
          .moveTo(MARGIN, y)
          .lineTo(page.width - MARGIN, y)
          .lineWidth(0.5)
          .stroke("#dfe7e9");
      }
      if (!page.rows.length)
        pdf
          .fillColor(MUTED)
          .text("No activity in this period.", MARGIN, y + 10);
      pdf
        .fillColor(MUTED)
        .fontSize(7)
        .text(
          "Historical report • Long labels abbreviated; full values in CSV/Excel",
          MARGIN,
          page.height - 29,
          { lineBreak: false },
        );
      const pageLabel = `${pageIndex + 1} / ${pages.length}`;
      pdf.text(
        pageLabel,
        page.width - MARGIN - pdf.widthOfString(pageLabel),
        page.height - 29,
        { lineBreak: false },
      );
    }
    pdf.end();
  } catch (error) {
    pdf.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return await output;
}
