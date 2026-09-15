import type {
  NormalizedReportRange,
  ReportContribution,
  ReportResultWrite,
  ScalarRecord,
} from "./contracts";
import { REPORT_FINALIZATION_ORDER } from "./catalog";
import { finalizeReportRow, summaryDefaults } from "./finalizeRow";

import { ReportSizeLimit } from "../../../lib/operations-reports/limits";
export { ReportSizeLimit } from "../../../lib/operations-reports/limits";

// Bounded by distinct aggregate keys, dedupe keys, and serialized input size.
// Raw CSV pages use a short-lived instance so raw records are never staged.
export class ReportAggregate {
  readonly sections = new Map<string, Map<string, ScalarRecord>>();
  private readonly seen = new Set<string>();
  private bytes = 0;
  private keys = 0;

  release() {
    this.sections.clear();
    this.seen.clear();
    this.bytes = 0;
    this.keys = 0;
  }

  apply(contributions: ReportContribution[]) {
    for (const c of contributions) {
      if (c.operation === "uniqueSum") {
        const key = JSON.stringify([c.section, c.rowKey, c.field, c.dedupeKey]);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        this.bytes += key.length * 2;
      }
      let section = this.sections.get(c.section);
      if (!section) {
        section = new Map();
        this.sections.set(c.section, section);
      }
      let row = section.get(c.rowKey);
      if (!row) {
        row = {};
        section.set(c.rowKey, row);
        this.keys++;
        this.bytes += c.rowKey.length * 2;
      }
      const old = row[c.field];
      if (c.operation === "set") {
        this.bytes +=
          JSON.stringify(c.value).length * 2 -
          (old === undefined ? 0 : JSON.stringify(old).length * 2);
        row[c.field] = c.value;
      } else {
        if (old !== undefined && typeof old !== "number")
          throw new Error("Non-numeric report aggregate.");
        row[c.field] =
          c.operation === "max"
            ? Math.max(old ?? c.value, c.value)
            : (old ?? 0) + c.value;
      }
      if (
        this.keys > 100_000 ||
        this.seen.size > 200_000 ||
        this.bytes > 24 * 1024 * 1024
      )
        throw new ReportSizeLimit();
    }
  }

  async finalize(
    kind: keyof typeof REPORT_FINALIZATION_ORDER,
    range: NormalizedReportRange,
    onlySections?: string[],
  ): Promise<ReportResultWrite[]> {
    const results: ReportResultWrite[] = [];
    for (const section of onlySections ?? REPORT_FINALIZATION_ORDER[kind]) {
      const rows =
        this.sections.get(section) ?? new Map<string, ScalarRecord>();
      if (!rows.size && summaryDefaults[section]) rows.set("main", {});
      for (const [rowKey, fields] of rows) {
        const result = await finalizeReportRow(
          section,
          { rowKey, fields },
          range,
          async (name, key) =>
            typeof key === "string"
              ? (this.sections.get(name)?.get(key) ?? {})
              : {},
        );
        if (!result) continue;
        // Later sections use finalized values, exactly as the persisted dashboard does.
        rows.set(rowKey, result.payload);
        results.push(result);
        if (
          section === "booking_team" &&
          typeof result.payload.target === "number"
        )
          this.apply([
            {
              section: "booked_calls_summary",
              rowKey: "main",
              field: "totalTarget",
              operation: "sum",
              value: result.payload.target,
            },
          ]);
      }
      this.sections.set(section, rows);
    }
    return results;
  }
}
