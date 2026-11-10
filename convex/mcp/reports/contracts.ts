import { v, type Infer } from "convex/values";
import { analyticsRangeValidator } from "../../analytics/schema";
import { resolvedRangeValidator } from "../../analytics/results";
import { ASSISTANT_METRICS } from "./metrics";
export const rangeValidator = v.union(analyticsRangeValidator, v.object({ kind: v.literal("preset"), preset: v.union(v.literal("today"), v.literal("last_week"), v.literal("year_to_date")) }));
export const roleValidator = v.union(v.literal("everyone"), v.literal("closers"), v.literal("setters"), v.literal("dm_closers"), v.literal("lead_gen"), v.literal("closer"), v.literal("setter"), v.literal("dm_closer"), v.literal("dm_team"));
// Tool arguments take IDs as strings, so a malformed or wrong-table ID gets a
// readable error (normalizeRequestIds) instead of a failed argument check.
const idArgs = { memberId: v.optional(v.id("teamMembers")), programId: v.optional(v.id("tenantPrograms")), closerId: v.optional(v.id("users")) };
const idStringArgs = { memberId: v.optional(v.string()), programId: v.optional(v.string()), closerId: v.optional(v.string()) };
const numbersFields = {
    role: v.optional(roleValidator), currency: v.optional(v.string()),
    scope: v.optional(v.union(v.literal("booked_program_activity"), v.literal("sold_program"), v.literal("first_payment_closer"))),
    metrics: v.array(v.union(...ASSISTANT_METRICS.map(m => v.literal(m)))),
    range: rangeValidator,
    compareTo: v.optional(v.union(v.literal("previous_period"), v.literal("same_period_last_week"), v.literal("same_period_last_month"), rangeValidator)),
    groupBy: v.optional(v.union(v.literal("closer"), v.literal("program"), v.literal("team"), v.literal("day"))),
    limit: v.optional(v.number()),
};
const reportFields = {
    panel: v.optional(v.string()), role: v.optional(roleValidator), currency: v.optional(v.string()),
    report: v.union(v.literal("scorecard"), v.literal("calls"), v.literal("people"), v.literal("attribution"), v.literal("pipeline"), v.literal("qualifications"), v.literal("lead_gen")),
    fieldKey: v.optional(v.string()), callType: v.optional(v.union(v.literal("new"), v.literal("follow_up"))),
    range: v.optional(rangeValidator), limit: v.optional(v.number()),
};
export const numbersArgs = { ...numbersFields, ...idStringArgs };
export const reportArgs = { ...reportFields, ...idStringArgs, teamId: v.optional(v.string()) };
export const requestIdArgs = { ...idStringArgs, teamId: v.optional(v.string()) };
export const requestIdsValidator = v.object({ ...idArgs, teamId: v.optional(v.id("attributionTeams")) });
export const requestValidator = v.union(v.object({ kind: v.literal("numbers"), ...numbersFields, ...idArgs }), v.object({ kind: v.literal("report"), ...reportFields, ...idArgs, teamId: v.optional(v.id("attributionTeams")) }));
export type ToolRequest = Infer<typeof requestValidator>;
export const jobValidator = v.object({ key: v.string(), report: v.string(), filtersJson: v.string(), range: analyticsRangeValidator, window: resolvedRangeValidator, syncWatermark: v.number() });
export type ReportJob = Infer<typeof jobValidator>;
export const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const ASSISTANT_JOB_TIMEOUT_MS = 11 * 60 * 1000;
export const ASSISTANT_COLD_WAIT_MS = 8000;

/**
 * A failed job may be admitted again a minute after it failed, so a passing
 * warehouse error doesn't stick to the same request until the key expires.
 */
export const FAILED_JOB_RETRY_MS = 60_000;
export function failedJobRetryable(row: { status: string; error?: string; finishedAt?: number; createdAt: number }, now: number): boolean {
    // Too large stays too large until the key expires with the next sync.
    if (row.error === "range_too_large")
        return false;
    return row.status === "failed" && now - (row.finishedAt ?? row.createdAt) >= FAILED_JOB_RETRY_MS;
}
