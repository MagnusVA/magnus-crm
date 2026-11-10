import { v, type Infer } from "convex/values";
import { analyticsRangeValidator } from "../../analytics/schema";
import { resolvedRangeValidator } from "../../analytics/results";
import { ASSISTANT_METRICS } from "./metrics";
export const rangeValidator = v.union(analyticsRangeValidator, v.object({ kind: v.literal("preset"), preset: v.literal("today") }));
export const numbersArgs = {
    metrics: v.array(v.union(...ASSISTANT_METRICS.map(m => v.literal(m)))),
    range: rangeValidator,
    compareTo: v.optional(v.union(v.literal("previous_period"), v.literal("same_period_last_week"), v.literal("same_period_last_month"), rangeValidator)),
    groupBy: v.optional(v.union(v.literal("closer"), v.literal("program"), v.literal("team"), v.literal("day"))),
    limit: v.optional(v.number()),
};
export const reportArgs = {
    report: v.union(v.literal("scorecard"), v.literal("calls"), v.literal("people"), v.literal("attribution"), v.literal("pipeline"), v.literal("qualifications"), v.literal("lead_gen")),
    memberId: v.optional(v.id("teamMembers")), fieldKey: v.optional(v.string()), callType: v.optional(v.union(v.literal("new"), v.literal("follow_up"))),
    range: v.optional(rangeValidator), programId: v.optional(v.id("tenantPrograms")), closerId: v.optional(v.id("users")), teamId: v.optional(v.id("attributionTeams")), limit: v.optional(v.number()),
};
export const requestValidator = v.union(v.object({ kind: v.literal("numbers"), ...numbersArgs }), v.object({ kind: v.literal("report"), ...reportArgs }));
export type ToolRequest = Infer<typeof requestValidator>;
export const jobValidator = v.object({ key: v.string(), report: v.string(), filtersJson: v.string(), range: analyticsRangeValidator, window: resolvedRangeValidator, syncWatermark: v.number() });
export type ReportJob = Infer<typeof jobValidator>;
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ASSISTANT_DAILY_RUN_ALLOWANCE = 40;
export const ASSISTANT_MINUTE_JOB_ALLOWANCE = 6;
export const ASSISTANT_JOB_TIMEOUT_MS = 11 * 60 * 1000;
export const ASSISTANT_COLD_WAIT_MS = 8000;

/**
 * A failed job may be admitted again a minute after it failed, so a passing
 * warehouse error doesn't stick to the same request until the key expires.
 * A retry still counts against the daily and per-minute allowances.
 */
export const FAILED_JOB_RETRY_MS = 60_000;
export function failedJobRetryable(row: { status: string; finishedAt?: number; createdAt: number }, now: number): boolean {
    return row.status === "failed" && now - (row.finishedAt ?? row.createdAt) >= FAILED_JOB_RETRY_MS;
}
