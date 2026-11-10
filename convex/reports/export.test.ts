import { describe, expect, it } from "vitest";
import { api } from "../_generated/api";
import { getErrorCode, getErrorMessage } from "../../lib/errors";
import { MAX_PDF_ROWS } from "../../lib/operations-reports/document";
import { scorecardFixture, identity } from "../../tests/scorecardFixtures";

describe("renderReportFile", () => {
  it("refuses a page too large for one file with a message production shows", async () => {
    const f = await scorecardFixture();
    const document = {
      title: "Log",
      period: "This year",
      generatedAt: 0,
      boundary: "Business days start at midnight",
      filters: "Every member and record",
      summary: [],
      tables: [
        {
          title: "Events",
          columns: [{ key: "n", label: "N", format: "number" as const }],
          rows: Array.from({ length: MAX_PDF_ROWS + 1 }, (_, n) => ({ n })),
        },
      ],
    };
    const error = await f.t
      .withIdentity(identity)
      .action(api.reports.export.renderReportFile, { format: "pdf", document })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    // A plain Error would reach the browser as "Server Error" in production.
    expect(getErrorCode(error)).toBe("reports.export_too_large");
    expect(getErrorMessage(error, "Server Error")).toBe(
      "This page is too large to export in one file. Choose a shorter range.",
    );
  });
});
