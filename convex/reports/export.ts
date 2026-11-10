"use node";

import { v } from "convex/values";
import { action } from "../_generated/server";
import { expectedError } from "../lib/observability/errors";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { MEMBER_REPORT_ROLES } from "./lib/access";
import type { ReportDocument } from "../../lib/operations-reports/document";
import { renderReportPdf } from "../../lib/operations-reports/pdf";
import { renderReportWorkbook } from "../../lib/operations-reports/xlsx";
import { ReportSizeLimit } from "../../lib/operations-reports/limits";

// Excel and PDF for a Reports page (docs/reviews/reports-overhaul.html §13).
// The page sends the document it shows, so the file always matches the
// screen; this action only renders it with the Operations renderers, which
// enforce the 20,000-row workbook and 5,000-row PDF budgets. The caller sees
// every figure in the document already, so it carries nothing they can't read.

const cell = v.union(v.string(), v.number(), v.boolean(), v.null());

const documentValidator = v.object({
  title: v.string(),
  period: v.string(),
  generatedAt: v.number(),
  boundary: v.string(),
  filters: v.string(),
  summary: v.array(v.object({ label: v.string(), value: v.string() })),
  tables: v.array(
    v.object({
      title: v.string(),
      columns: v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          format: v.optional(
            v.union(v.literal("number"), v.literal("decimal"), v.literal("percent"), v.literal("money"), v.literal("timestamp")),
          ),
          currencyKey: v.optional(v.string()),
        }),
      ),
      rows: v.array(v.record(v.string(), cell)),
    }),
  ),
});

export const renderReportFile = action({
  args: { format: v.union(v.literal("xlsx"), v.literal("pdf")), document: documentValidator },
  returns: v.bytes(),
  handler: async (ctx, { format, document }) => {
    await requireTenantUserFromAction(ctx, [...MEMBER_REPORT_ROLES]);
    try {
      const bytes =
        format === "xlsx"
          ? renderReportWorkbook(document as ReportDocument)
          : await renderReportPdf(document as ReportDocument);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if (error instanceof ReportSizeLimit) {
        throw expectedError(
          "reports.export_too_large",
          "This page is too large to export in one file. Choose a shorter range.",
        );
      }
      throw error;
    }
  },
});
