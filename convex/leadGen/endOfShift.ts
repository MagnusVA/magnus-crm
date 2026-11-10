import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { businessDateForInstant, businessDayRange } from "../../lib/businessDay";
import { assertLeadGenBusinessDayReady } from "../lib/businessDayRebuildState";
import { createLiveReadState, LIVE_QUERY_BYTE_BUDGET, readLiveQueryRows } from "../lib/liveQueryBounds";
import { rejectRequest } from "../lib/observability/errors";
import { resparkResultsByWorker } from "../lib/respark/items";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { hoursOn } from "../lib/workSchedule";
import { readScheduleRows } from "../workSchedules/datedRows";
import { requireOwnLeadGenWorker, type LeadGenAssistantCaller } from "./assistantAccess";
import { leadGenShiftNumbersValidator } from "./endOfShiftSchema";

export const SHIFT_POST_LEASE_MS = 120_000;
export const hoursStatusValidator = v.union(v.literal("known"), v.literal("unknown"));
export const hoursUnknownReasonValidator = v.union(v.literal("row_limit"), v.literal("byte_limit"), v.literal("incomplete"));
export const shiftSlackStatusValidator = v.union(v.literal("pending"), v.literal("posted"), v.literal("failed"), v.literal("not_configured"));
type ShiftNumbers = Infer<typeof leadGenShiftNumbersValidator>;
type HoursReason = Infer<typeof hoursUnknownReasonValidator>;

export function shiftText(value: string | undefined): string | undefined {
  if (value !== undefined && value.length > 500) throw rejectRequest("shift.text_too_long", "Each report text must be at most 500 characters.");
  return value?.trim() || undefined;
}

/** Whole business-day hours, independent of whether any capture bucket exists. */
export async function buildShiftNumbers(ctx: QueryCtx, caller: LeadGenAssistantCaller,
  worker: Doc<"leadGenWorkers">, dayKey: string, start: number, end: number,
): Promise<{ numbers: ShiftNumbers; hoursStatus: "known" | "unknown"; hoursUnknownReason?: HoursReason }> {
  await assertLeadGenBusinessDayReady(ctx, caller.tenantId);
  const state = createLiveReadState();
  const stats = await readLiveQueryRows(ctx.db.query("leadGenDailyStats")
    .withIndex("by_tenantId_and_workerId_and_dayKey", q => q.eq("tenantId", caller.tenantId).eq("workerId", worker._id).eq("dayKey", dayKey)), 100, state);
  if (stats.capped) throw rejectRequest("shift.counts_incomplete", "Magnus couldn't count this day in full. Nothing was saved. Ask an admin.");
  let rawLeads = 0;
  for (const row of stats.rows) {
    if (row.tenantId !== caller.tenantId || row.workerId !== worker._id || row.userId !== caller.userId || row.dayKey !== dayKey ||
        !Number.isSafeInteger(row.submissions) || row.submissions < 0) throw rejectRequest("shift.counts_incomplete", "Magnus couldn't verify this day's counts. Nothing was saved. Ask an admin.");
    rawLeads += row.submissions;
  }
  const counts = await resparkResultsByWorker.countBatch(ctx, (["resparked", "not_a_fit"] as const).map(result => ({
    namespace: caller.tenantId,
    bounds: { lower: { key: [worker._id, result, start], inclusive: true }, upper: { key: [worker._id, result, end], inclusive: false } },
  })));
  const schedule = await readScheduleRows(ctx, caller.tenantId, { table: "leadGenWorkerSchedules", workerId: worker._id }, state);
  let hoursUnknownReason: HoursReason | undefined = schedule.capped
    ? state.bytesRead > LIVE_QUERY_BYTE_BUDGET ? "byte_limit" : "row_limit"
    : undefined;
  if (schedule.rows.some(row => row.tenantId !== caller.tenantId || row.workerId !== worker._id || row.userId !== caller.userId ||
      !Number.isFinite(row.scheduledHours) || row.scheduledHours < 0 || row.scheduledHours > 24)) hoursUnknownReason = "incomplete";
  const scheduledHours = hoursUnknownReason ? null : hoursOn(schedule.rows, dayKey);
  return { numbers: { rawLeads, resparks: counts[0], entries: rawLeads + counts[0], notAFit: counts[1], scheduledHours,
    leadsPerHour: scheduledHours !== null && scheduledHours > 0 ? rawLeads / scheduledHours : null },
    hoursStatus: hoursUnknownReason ? "unknown" : "known", ...(hoursUnknownReason && { hoursUnknownReason }) };
}

export async function shiftContext(ctx: QueryCtx, caller: LeadGenAssistantCaller, now: number) {
  const worker = await requireOwnLeadGenWorker(ctx, caller);
  const tenant = await ctx.db.get("tenants", caller.tenantId);
  if (!tenant) throw rejectRequest("shift.unavailable", "Workspace not found.");
  const setting = await getTenantBusinessDay(ctx, caller.tenantId);
  const dayKey = businessDateForInstant(now, setting);
  const range = businessDayRange(dayKey, setting);
  const existing = await ctx.db.query("leadGenShiftReports")
    .withIndex("by_tenantId_and_workerId_and_dayKey", q => q.eq("tenantId", caller.tenantId).eq("workerId", worker._id).eq("dayKey", dayKey)).unique();
  if (existing && (existing.tenantId !== caller.tenantId || existing.workerId !== worker._id || existing.userId !== caller.userId)) {
    throw rejectRequest("shift.unavailable", "This report could not be verified. Ask an admin.");
  }
  const installation = await ctx.db.query("slackInstallations").withIndex("by_tenantId", q => q.eq("tenantId", caller.tenantId)).first();
  const channelId = installation?.status === "active" ? installation.leadGenNotifyChannelId : undefined;
  return { worker, dayKey, periodStart: range.start, dayEnd: range.end, timeZone: setting.timeZone, dayStartHour: setting.dayStartHour,
    businessDayVersion: tenant.businessDayVersion ?? 0, existing, channelId: channelId ?? null,
    channelName: channelId ? installation?.leadGenNotifyChannelName ?? null : null };
}
export type ShiftContext = Awaited<ReturnType<typeof shiftContext>>;

/** Pending without a started lease is already queued. Never queue it twice. */
export function shiftDeliveryRetryable(report: Doc<"leadGenShiftReports">, now: number) {
  return report.slackStatus === "failed" || report.slackStatus === "not_configured" ||
    (report.slackStatus === "pending" && now - (report.slackPostStartedAt ?? report.createdAt) >= SHIFT_POST_LEASE_MS);
}

/** Delivery-only updates preserve the immutable saved numbers and text. */
export async function retryShiftDeliveryCore(ctx: MutationCtx, current: ShiftContext, now: number) {
  const report = current.existing!;
  if (!current.channelId || !shiftDeliveryRetryable(report, now)) return report;
  await ctx.db.patch("leadGenShiftReports", report._id, {
    slackStatus: "pending", slackError: undefined, slackPostStartedAt: now, slackPostAttempt: undefined,
    slackChannelId: current.channelId, slackChannelName: current.channelName ?? undefined,
  });
  await ctx.scheduler.runAfter(0, internal.slack.leadGenShiftReports.post, { reportId: report._id });
  return (await ctx.db.get("leadGenShiftReports", report._id))!;
}

/** Caller has rebuilt and checked the preview in this transaction. */
export async function endLeadGenShiftCore(ctx: MutationCtx, caller: LeadGenAssistantCaller,
  current: ShiftContext, summary: Awaited<ReturnType<typeof buildShiftNumbers>>,
  options: { narrative?: string; note?: string; via: "mcp" | "web"; agentClient?: string }, now: number,
) {
  // The indexed absence read in shiftContext makes concurrent tokens converge.
  if (current.existing) return await retryShiftDeliveryCore(ctx, current, now);
  const reportId = await ctx.db.insert("leadGenShiftReports", {
    tenantId: caller.tenantId, userId: caller.userId, workerId: current.worker._id, dayKey: current.dayKey,
    periodStart: current.periodStart, periodEnd: now, asOf: now, timeZone: current.timeZone, dayStartHour: current.dayStartHour,
    businessDayVersion: current.businessDayVersion, ...summary, narrative: shiftText(options.narrative), note: shiftText(options.note),
    via: options.via, agentClient: options.agentClient, createdAt: now,
    slackStatus: current.channelId ? "pending" : "not_configured", slackChannelId: current.channelId ?? undefined,
    slackChannelName: current.channelName ?? undefined,
  });
  if (current.channelId) await ctx.scheduler.runAfter(0, internal.slack.leadGenShiftReports.post, { reportId });
  return (await ctx.db.get("leadGenShiftReports", reportId))!;
}
