import { describe, expect, it } from "vitest";
import {
  assertBoundedIdentifier,
  type ReportFormat,
  type ReportKind,
  type ReportSourceFilter,
} from "@/convex/operations/reports/contracts";
import {
  dashboardRequestToken,
  exportRequestToken,
  reportScopeKey,
} from "./request-tokens";

const kinds: ReportKind[] = ["lead-gen", "qualifications", "booked-calls", "sales-calls"];
const formats: ReportFormat[] = ["summary_csv", "raw_csv", "payments_csv", "xlsx", "pdf"];
const sources: ReportSourceFilter[] = ["all", "instagram", "meta_business"];
const customRange = {
  kind: "custom",
  startBusinessDate: "2026-10-19",
  endBusinessDateInclusive: "2026-10-25",
} as const;

describe("operations report request tokens", () => {
  it("accepts a lead-gen Summary CSV export for a custom week", () => {
    const scopeKey = reportScopeKey({ reportKind: "lead-gen", range: customRange, version: 1 });
    const token = exportRequestToken(scopeKey, "summary_csv", 1793030843000);
    expect(assertBoundedIdentifier(token, "Request token")).toBe(token);
  });

  it("stays within the server limit for every kind, format, and source", () => {
    for (const reportKind of kinds) {
      for (const sourceFilter of sources) {
        const scopeKey = reportScopeKey({
          reportKind,
          range: customRange,
          sourceFilter,
          version: Number.MAX_SAFE_INTEGER,
        });
        for (const format of formats) {
          const token = exportRequestToken(scopeKey, format, Number.MAX_SAFE_INTEGER);
          expect(() => assertBoundedIdentifier(token, "Request token")).not.toThrow();
        }
        const dashboardToken = dashboardRequestToken(crypto.randomUUID(), scopeKey, Number.MAX_SAFE_INTEGER);
        expect(() => assertBoundedIdentifier(dashboardToken, "Request token")).not.toThrow();
      }
    }
  });

  it("gives different scopes different tokens", () => {
    const week = reportScopeKey({ reportKind: "lead-gen", range: customRange, version: 1 });
    const today = reportScopeKey({ reportKind: "lead-gen", range: { kind: "preset", preset: "today" }, version: 1 });
    expect(exportRequestToken(week, "pdf", 1)).not.toBe(exportRequestToken(today, "pdf", 1));
  });
});
