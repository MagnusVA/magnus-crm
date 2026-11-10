import { v } from "convex/values";
import { businessDateForInstant } from "../../../lib/businessDay";
import { internalQuery } from "../../_generated/server";
import { getMyDaySummaryCore, getOwnLeadGenProfile, leadGenProfileValidator } from "../../leadGen/activity";
import { leadGenBusinessDayBlocked } from "../../lib/businessDayRebuildState";
import { createLiveReadState } from "../../lib/liveQueryBounds";
import { McpProjectionBudget, mcpPersonTextValidator } from "../../lib/respark/mcp";
import { rememberTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { getHeldResparkBatchCore, getMyResparkTodayCore, getResparkPoolCountsCore } from "../../respark/queries";
import { loadLeadGenScheduledHoursForRange } from "../../workSchedules/rangeHours";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { formatLocal } from "../time";

export const todayArgs = {};
export const progressValidator = v.object({ total: v.number(), worked: v.number(), remaining: v.number() });

export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...todayArgs },
  returns: v.object({
    profile: leadGenProfileValidator, dayKey: v.string(), asOf: v.string(), isPartial: v.boolean(), textTruncated: v.boolean(),
    unavailableReason: v.union(v.literal("inactive"), v.literal("none"), v.literal("no_team"), v.literal("rebuilding"), v.null()),
    counts: v.union(v.null(), v.object({
      today: v.number(), unique: v.number(), dupes: v.number(), scheduledHours: v.union(v.number(), v.null()),
      respark: v.object({ batchesDone: v.number(), resparks: v.number(), notAFits: v.number() }),
      openBatch: v.union(v.null(), v.object({ progress: progressValidator, heldUntil: v.string() })),
      pool: v.union(v.array(v.object({ bucket: v.number(), count: v.number() })), v.null()), poolUnavailableReason: v.union(v.string(), v.null()), batchSize: v.number(), heldUntil: v.string(),
      lastOrigin: v.union(v.null(), v.object({ source: v.string(), kind: v.string(), value: v.union(mcpPersonTextValidator, v.null()), usedAt: v.string() })),
    })),
  }),
  handler: async (ctx, { caller }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const asOf = Date.now();
    const dayKey = businessDateForInstant(asOf, rememberTenantBusinessDay(ctx, me.tenant));
    const { worker, profile } = await getOwnLeadGenProfile(ctx, me);
    const budget = new McpProjectionBudget();
    if (profile.team) profile.team.name = budget.text(profile.team.name);
    const unavailableReason = profile.status !== "active" ? profile.status : profile.noTeam ? "no_team" as const
      : await leadGenBusinessDayBlocked(ctx, me.tenantId) ? "rebuilding" as const : null;
    if (unavailableReason || !worker) return { profile, dayKey, asOf: formatLocal(asOf, me.timeZone), isPartial: true, textTruncated: budget.textTruncated, unavailableReason, counts: null };
    const day = await getMyDaySummaryCore(ctx, me, { dayKey });
    const respark = await getMyResparkTodayCore(ctx, me);
    const pool = await getResparkPoolCountsCore(ctx, me);
    const held = await getHeldResparkBatchCore(ctx, me);
    const state = createLiveReadState();
    const hours = await loadLeadGenScheduledHoursForRange(ctx, { tenantId: me.tenantId, workerIds: [worker._id],
      startBusinessDate: dayKey, endBusinessDateInclusive: dayKey, liveReadState: state });
    const last = await ctx.db.query("leadGenSubmissions")
      .withIndex("by_tenantId_and_workerId_and_submittedAt", q => q.eq("tenantId", me.tenantId).eq("workerId", worker._id))
      .order("desc").first();
    const lastOrigin = last ? { source: last.source, kind: last.originKind,
      value: last.originValue ? budget.personText(last.originValue, { mask: false }) : null, usedAt: formatLocal(last.submittedAt, me.timeZone) } : null;
    return { profile, dayKey, asOf: formatLocal(asOf, me.timeZone), unavailableReason: null, isPartial: state.capped || budget.isPartial || pool.isPartial,
      textTruncated: budget.textTruncated,
      counts: { today: day.submissions, unique: day.uniqueProspects, dupes: day.duplicates,
        scheduledHours: hours.get(worker._id) ?? null,
        respark: { batchesDone: respark.batchesDone, resparks: respark.resparks, notAFits: respark.notAFits },
        openBatch: held && held.progress.remaining > 0 ? { progress: held.progress, heldUntil: formatLocal(held.batch.heldUntil, me.timeZone) } : null,
        pool: pool.buckets, poolUnavailableReason: pool.unavailableReason, batchSize: pool.batchSize, heldUntil: formatLocal(pool.heldUntil, me.timeZone), lastOrigin } };
  },
});
