import { v, type Infer } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import type { TenantUserResult } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import {
  addBusinessDays,
  calendarDate,
  countBusinessDays,
  validateBusinessDay,
  type BusinessDaySetting,
} from "../../lib/businessDay";
import { browserDay, MAX_ANALYTICS_RANGE_DAYS, type AnalyticsRange } from "../../lib/analyticsRange";
import type { AnalyticsFilters, AnyReportDefinition } from "./definition";
import { findReportDefinition } from "./registry";
import { analyticsRangeValidator } from "./schema";

export const analyticsFiltersValidator = v.record(
  v.string(),
  v.union(v.string(), v.number(), v.boolean(), v.null()),
);

export const reportRequestArgs = {
  reportId: v.string(),
  filters: analyticsFiltersValidator,
  range: analyticsRangeValidator,
  // The viewer's IANA time zone. Used by reports whose days follow the browser.
  timeZone: v.string(),
};

export type ReportRequestArgs = {
  reportId: string;
  filters: AnalyticsFilters;
  range: Infer<typeof analyticsRangeValidator>;
  timeZone: string;
};

/** JSON with sorted keys, so equal arguments always give the same key. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function analyticsArgsKey(args: {
  filters: AnalyticsFilters;
  range: AnalyticsRange;
  day: BusinessDaySetting;
}) {
  return canonicalJson({
    f: args.filters,
    r: args.range,
    tz: args.day.timeZone,
    h: args.day.dayStartHour,
  });
}

function invalid(message: string) {
  return expectedError("analytics.invalid_request", message);
}

/** Checks a range without resolving presets, so queries stay independent of the clock. */
export function assertValidAnalyticsRange(range: AnalyticsRange) {
  if (range.kind === "preset") return;
  try {
    calendarDate(range.startDate);
    calendarDate(range.endDateInclusive);
  } catch {
    throw invalid("Choose valid calendar dates.");
  }
  if (range.startDate > range.endDateInclusive) {
    throw invalid("Choose an end date on or after the start date.");
  }
  const days = countBusinessDays(range.startDate, addBusinessDays(range.endDateInclusive, 1));
  if (days > MAX_ANALYTICS_RANGE_DAYS) {
    throw invalid(`Choose ${MAX_ANALYTICS_RANGE_DAYS} days or fewer.`);
  }
}

export type ResolvedReportRequest = {
  definition: AnyReportDefinition;
  viewer: TenantUserResult;
  filters: AnalyticsFilters;
  filtersJson: string;
  day: BusinessDaySetting;
  argsKey: string;
};

/** The report a request names. Unknown ids are the caller's error. */
export function reportDefinitionFor(reportId: string): AnyReportDefinition {
  const definition = findReportDefinition(reportId);
  if (!definition) throw invalid("Unknown report.");
  return definition;
}

/**
 * Filter validation and the cache key for one report request, after the
 * caller passed the report's role check. Any viewer-scoped filter comes from
 * `viewer`, never from the args.
 */
export async function resolveReportRequest(
  ctx: QueryCtx,
  args: ReportRequestArgs,
  definition: AnyReportDefinition,
  viewer: TenantUserResult,
): Promise<ResolvedReportRequest> {
  assertValidAnalyticsRange(args.range);

  let filters: AnalyticsFilters;
  try {
    filters = await definition.parseFilters(ctx, args.filters, viewer);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "Invalid filter.");
  }

  const day =
    definition.day === "browser"
      ? browserDay(args.timeZone)
      : await getTenantBusinessDay(ctx, viewer.tenantId);
  try {
    validateBusinessDay(day);
  } catch {
    throw invalid("Unknown time zone.");
  }

  return {
    definition,
    viewer,
    filters,
    filtersJson: canonicalJson(filters),
    day,
    argsKey: analyticsArgsKey({ filters, range: args.range, day }),
  };
}
