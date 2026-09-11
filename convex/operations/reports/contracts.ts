import { v } from "convex/values";
import { leadGenSourceValidator } from "../../leadGen/validators";
import {
  addBusinessDays,
  businessDateToUtcStart,
  countBusinessDays,
  timestampToBusinessDateKey,
} from "../../reporting/lib/hondurasBusinessTime";

export const REPORT_DEFINITION_VERSION = "operations-reports-v1";

export const REPORT_LEASE_MS = 60_000;
// Assumes the ten-minute Node action limit, plus one minute for upload settlement.
// A worker lease can expire while its action is still uploading.
export const REPORT_UPLOAD_SETTLE_MS = 11 * 60 * 1_000;
export const REPORT_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
export const REPORT_READY_LIFETIME_MS = 10 * 60 * 1_000;
export const REPORT_JOB_METADATA_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const REPORT_CLEANUP_BATCH_SIZE = 50;
export const REPORT_MAX_COMMIT_CONTRIBUTIONS = 8_192;
export const REPORT_MAX_COMMIT_AFFECTED_ROWS = 500;
export const REPORT_MAX_CHECKPOINT_BYTES = 1_048_576;
export const REPORT_MAX_PUBLIC_PAGE_SIZE = 100;
export const REPORT_MAX_ARTIFACT_BYTES = 16 * 1_048_576;
export const REPORT_MAX_RETRIES = 3;

export const reportKindValidator = v.union(
  v.literal("lead-gen"),
  v.literal("qualifications"),
  v.literal("booked-calls"),
  v.literal("sales-calls"),
);

export type ReportKind =
  | "lead-gen"
  | "qualifications"
  | "booked-calls"
  | "sales-calls";

export const reportPurposeValidator = v.union(
  v.literal("dashboard"),
  v.literal("export"),
);

export type ReportPurpose = "dashboard" | "export";

export const reportFormatValidator = v.union(
  v.literal("summary_csv"),
  v.literal("raw_csv"),
  v.literal("payments_csv"),
  v.literal("xlsx"),
  v.literal("pdf"),
);

export type ReportFormat =
  | "summary_csv"
  | "raw_csv"
  | "payments_csv"
  | "xlsx"
  | "pdf";

export const reportStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("rendering"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("canceled"),
  v.literal("expired"),
);

export type ReportStatus =
  | "queued"
  | "running"
  | "rendering"
  | "ready"
  | "failed"
  | "canceled"
  | "expired";

export const activeReportStatuses = [
  "queued",
  "running",
  "rendering",
] as const satisfies readonly ReportStatus[];

export const reportPhaseValidator = v.union(
  v.literal("queued"),
  v.literal("reading"),
  v.literal("reducing"),
  v.literal("rendering"),
  v.literal("publishing"),
  v.literal("ready"),
  v.literal("cleanup"),
);

export type ReportPhase =
  | "queued"
  | "reading"
  | "reducing"
  | "rendering"
  | "publishing"
  | "ready"
  | "cleanup";

export const reportRangeInputValidator = v.union(
  v.object({
    kind: v.literal("preset"),
    preset: v.union(
      v.literal("today"),
      v.literal("this_week"),
      v.literal("this_month"),
    ),
  }),
  v.object({
    kind: v.literal("custom"),
    startBusinessDate: v.string(),
    endBusinessDateInclusive: v.string(),
  }),
);

export type ReportRangeInput =
  | { kind: "preset"; preset: "today" | "this_week" | "this_month" }
  | {
      kind: "custom";
      startBusinessDate: string;
      endBusinessDateInclusive: string;
    };

export const reportBoundaryValidator = v.union(
  v.literal("honduras_business_day"),
  v.literal("utc_day"),
);

export const normalizedReportRangeValidator = v.object({
  input: reportRangeInputValidator,
  startBusinessDate: v.string(),
  endBusinessDateInclusive: v.string(),
  endBusinessDateExclusive: v.string(),
  startTimestamp: v.number(),
  endTimestampExclusive: v.number(),
  startDayKey: v.string(),
  endDayKeyExclusive: v.string(),
  dayCount: v.number(),
  label: v.string(),
  boundary: reportBoundaryValidator,
});

export type NormalizedReportRange = {
  input: ReportRangeInput;
  startBusinessDate: string;
  endBusinessDateInclusive: string;
  endBusinessDateExclusive: string;
  startTimestamp: number;
  endTimestampExclusive: number;
  startDayKey: string;
  endDayKeyExclusive: string;
  dayCount: number;
  label: string;
  boundary: "honduras_business_day" | "utc_day";
};

export const reportSourceFilterValidator = v.union(
  v.literal("all"),
  leadGenSourceValidator,
);

export type ReportSourceFilter = "all" | "instagram" | "meta_business";

export const scalarValueValidator = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
);

export type ScalarValue = string | number | boolean | null;

export const scalarRecordValidator = v.record(v.string(), scalarValueValidator);

export type ScalarRecord = Record<string, ScalarValue>;

export const reportContributionValidator = v.union(
  v.object({
    section: v.string(),
    rowKey: v.string(),
    field: v.string(),
    operation: v.union(v.literal("sum"), v.literal("max")),
    value: v.number(),
  }),
  v.object({
    section: v.string(),
    rowKey: v.string(),
    field: v.string(),
    operation: v.literal("set"),
    value: scalarValueValidator,
  }),
  v.object({
    section: v.string(),
    rowKey: v.string(),
    field: v.string(),
    operation: v.literal("uniqueSum"),
    value: v.number(),
    dedupeKey: v.string(),
  }),
);

export type ReportContribution = {
  section: string;
  rowKey: string;
  field: string;
} & (
  | { operation: "sum" | "max"; value: number }
  | { operation: "set"; value: ScalarValue }
  | { operation: "uniqueSum"; value: number; dedupeKey: string }
);

export const reportResultWriteValidator = v.object({
  section: v.string(),
  rowKey: v.string(),
  groupKey: v.optional(v.string()),
  payload: scalarRecordValidator,
  sortValue: v.optional(v.number()),
});

export type ReportResultWrite = {
  section: string;
  rowKey: string;
  groupKey?: string;
  payload: ScalarRecord;
  sortValue?: number;
};

export const reportFailureValidator = v.object({
  category: v.string(),
  message: v.string(),
  retryable: v.boolean(),
});

export const artifactStateValidator = v.union(
  v.literal("reserved"),
  v.literal("attached"),
  v.literal("deleting"),
  v.literal("delete_failed"),
);

export function normalizeReportRange(args: {
  reportKind: ReportKind;
  input: ReportRangeInput;
  now: number;
}): NormalizedReportRange {
  const today = timestampToBusinessDateKey(args.now);
  const startBusinessDate =
    args.input.kind === "custom"
      ? args.input.startBusinessDate
      : args.input.preset === "this_week"
        ? startOfIsoWeek(today)
        : args.input.preset === "this_month"
          ? `${today.slice(0, 7)}-01`
          : today;
  const endBusinessDateInclusive =
    args.input.kind === "custom" ? args.input.endBusinessDateInclusive : today;

  // These helpers validate format and reject impossible calendar dates.
  businessDateToUtcStart(startBusinessDate);
  businessDateToUtcStart(endBusinessDateInclusive);
  if (startBusinessDate > endBusinessDateInclusive) {
    throw new Error("Start date must be on or before end date.");
  }

  const endBusinessDateExclusive = addBusinessDays(
    endBusinessDateInclusive,
    1,
  );
  const dayCount = countBusinessDays(
    startBusinessDate,
    endBusinessDateExclusive,
  );
  const boundary =
    args.reportKind === "sales-calls"
      ? ("utc_day" as const)
      : ("honduras_business_day" as const);
  const startTimestamp =
    boundary === "utc_day"
      ? Date.parse(`${startBusinessDate}T00:00:00.000Z`)
      : businessDateToUtcStart(startBusinessDate);
  const endTimestampExclusive =
    boundary === "utc_day"
      ? Date.parse(`${endBusinessDateExclusive}T00:00:00.000Z`)
      : businessDateToUtcStart(endBusinessDateExclusive);

  if (
    !Number.isFinite(startTimestamp) ||
    !Number.isFinite(endTimestampExclusive) ||
    !Number.isSafeInteger(dayCount) ||
    dayCount < 1
  ) {
    throw new Error("Report range is outside the supported calendar bounds.");
  }

  return {
    input: args.input,
    startBusinessDate,
    endBusinessDateInclusive,
    endBusinessDateExclusive,
    startTimestamp,
    endTimestampExclusive,
    startDayKey: startBusinessDate,
    endDayKeyExclusive: endBusinessDateExclusive,
    dayCount,
    label:
      startBusinessDate === endBusinessDateInclusive
        ? startBusinessDate
        : `${startBusinessDate} to ${endBusinessDateInclusive}`,
    boundary,
  };
}

export function buildReportRequestKey(args: {
  purpose: ReportPurpose;
  reportKind: ReportKind;
  format?: ReportFormat;
  range: NormalizedReportRange;
  sourceFilter: ReportSourceFilter;
}) {
  return [
    REPORT_DEFINITION_VERSION,
    args.purpose,
    args.reportKind,
    args.format ?? "dashboard",
    args.range.startBusinessDate,
    args.range.endBusinessDateInclusive,
    args.sourceFilter,
  ].join(":");
}

export function assertValidReportFormat(
  reportKind: ReportKind,
  format: ReportFormat,
) {
  if (format === "payments_csv" && reportKind !== "sales-calls") {
    throw new Error("Payments CSV is available only for Sales Calls reports.");
  }
}

export function assertValidSourceFilter(
  reportKind: ReportKind,
  sourceFilter: ReportSourceFilter,
) {
  if (reportKind !== "lead-gen" && sourceFilter !== "all") {
    throw new Error("Source filtering is available only for Lead Gen reports.");
  }
}

export function assertBoundedIdentifier(value: string, label: string) {
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new Error(`${label} must contain between 1 and 200 characters.`);
  }
  return trimmed;
}

function startOfIsoWeek(dateKey: string) {
  const timestamp = Date.parse(`${dateKey}T00:00:00.000Z`);
  const date = new Date(timestamp);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - (day - 1));
  return date.toISOString().slice(0, 10);
}
