import { describe, expect, it } from "vitest";
import type { ReportDocument } from "../operations-reports/document";
import { definitionsTable, renderSummaryCsv, reportExportFileName } from "./export";

const document: ReportDocument = {
  title: "Scorecard",
  period: "This week · Nov 2 – Nov 8",
  generatedAt: Date.parse("2026-11-08T18:00:00Z"),
  boundary: "Business days start at 01:00 in America/Tegucigalpa",
  filters: "All programs",
  summary: [{ label: "Cash", value: "$5,000 · €900" }],
  tables: [
    {
      title: "Cash by program",
      columns: [
        { key: "program", label: "Program" },
        { key: "currency", label: "Currency" },
        { key: "cash", label: "Cash", format: "money", currencyKey: "currency" },
      ],
      rows: [
        { program: "=HYPERLINK(\"x\")", currency: "USD", cash: 500000 },
        { program: "Euro program", currency: "EUR", cash: 90000 },
      ],
    },
  ],
};

describe("renderSummaryCsv", () => {
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(renderSummaryCsv(document));

  it("starts with a BOM and writes the header lines, the figures and each table", () => {
    expect(text.startsWith("﻿Scorecard\r\n")).toBe(true);
    expect(text).toContain('Figure,Value\r\nCash,"$5,000 · €900"');
    expect(text).toContain("Cash by program\r\nProgram,Currency,Cash\r\n");
  });

  it("writes each amount in its own currency and guards formula cells", () => {
    expect(text).toContain(`"'=HYPERLINK(""x"")",USD,"$5,000.00"`);
    expect(text).toContain("Euro program,EUR,€900.00");
  });
});

describe("reportExportFileName", () => {
  it("names the page, the dates and the member", () => {
    expect(reportExportFileName("people", "2026-11-01", "2026-11-08", "pdf", "Marco Reyes")).toBe(
      "magnus_people_2026-11-01_2026-11-08_marco-reyes.pdf",
    );
    expect(reportExportFileName("calls", "2026-10-01", "2026-10-31", "csv")).toBe("magnus_calls_2026-10-01_2026-10-31.csv");
  });
});

describe("definitionsTable", () => {
  it("reads each term from the dictionary", () => {
    expect(definitionsTable(["showRate"]).rows).toEqual([
      expect.objectContaining({ term: "Show rate", formula: "held ÷ (held + no-show)" }),
    ]);
  });
});
