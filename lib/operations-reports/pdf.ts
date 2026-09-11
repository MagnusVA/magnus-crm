import { createElement as h } from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { assertRenderBudget, formatCell, type ReportDocument } from "./document";

const styles = StyleSheet.create({
  page: { paddingTop: 42, paddingBottom: 44, paddingHorizontal: 34, fontFamily: "Helvetica", fontSize: 8, color: "#17252b" },
  brand: { color: "#13834a", fontSize: 10, marginBottom: 7, letterSpacing: 1.5 },
  title: { fontSize: 22, fontFamily: "Helvetica-Bold", marginBottom: 8 },
  meta: { color: "#62747b", fontSize: 8, marginBottom: 4 },
  cards: { flexDirection: "row", flexWrap: "wrap", marginTop: 12, marginBottom: 14 },
  card: { width: "25%", padding: 10, borderLeftWidth: 2, borderColor: "#13834a", marginBottom: 8 },
  label: { color: "#62747b", fontSize: 8, marginBottom: 6 },
  value: { fontSize: 16, fontFamily: "Helvetica-Bold" },
  tableTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 8, marginTop: 12 },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderColor: "#dfe7e9", paddingVertical: 6 },
  header: { backgroundColor: "#eaf3ef", fontFamily: "Helvetica-Bold" },
  cell: { paddingHorizontal: 5, fontSize: 8, lineHeight: 1.35 },
  footer: { position: "absolute", bottom: 22, left: 34, right: 34, flexDirection: "row", justifyContent: "space-between", color: "#62747b", fontSize: 7 },
});

export async function renderReportPdf(report: ReportDocument): Promise<Uint8Array> {
  assertRenderBudget(report, "pdf");
  const pages = report.tables.length ? report.tables : [{ title: "Summary", columns: [], rows: [] }];
  const document = h(Document, { title: report.title, author: "Magnus CRM", creationDate: new Date(report.generatedAt), modificationDate: new Date(report.generatedAt) }, ...pages.map((table, tableIndex) => {
    // Explicit row groups repeat column headings and avoid oversized single-page rows.
    const groups = Array.from({ length: Math.max(1, Math.ceil(table.rows.length / 8)) }, (_, i) => table.rows.slice(i * 8, (i + 1) * 8));
    return groups.map((rows, groupIndex) => h(Page, { key: `${tableIndex}-${groupIndex}`, size: "A4", orientation: table.columns.length > 6 ? "landscape" : "portrait", style: styles.page },
      h(Text, { style: styles.brand }, "MAGNUS CRM  /  OPERATIONS"),
      h(Text, { style: styles.title }, report.title),
      h(Text, { style: styles.meta }, `${report.period}  •  ${report.boundary}`),
      h(Text, { style: styles.meta }, `${report.filters}  •  Generated ${new Date(report.generatedAt).toISOString()}  •  Part ${report.part}`),
      tableIndex === 0 && groupIndex === 0 ? h(View, { style: styles.cards }, ...report.summary.map((item) => h(View, { key: item.label, style: styles.card }, h(Text, { style: styles.label }, item.label), h(Text, { style: styles.value }, item.value)))) : null,
      h(Text, { style: styles.tableTitle }, table.title),
      h(View, { style: [styles.row, styles.header], wrap: false }, ...table.columns.map((column) => h(Text, { key: column.key, style: [styles.cell, { width: `${100 / table.columns.length}%` }] }, column.label))),
      ...rows.map((row, index) => h(View, { key: index, style: styles.row, wrap: false }, ...table.columns.map((column) => {
        const text = formatCell(row[column.key], column.format);
        return h(Text, { key: column.key, style: [styles.cell, { width: `${100 / table.columns.length}%` }] }, text.length > 72 ? `${text.slice(0, 69)}…` : text);
      }))),
      rows.length === 0 ? h(Text, { style: styles.meta }, "No activity in this period.") : null,
      h(View, { style: styles.footer, fixed: true }, h(Text, {}, "Historical report • Long labels abbreviated; full values in CSV/Excel"), h(Text, { render: ({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}` })),
    ));
  }).flat());
  return new Uint8Array(await renderToBuffer(document));
}
