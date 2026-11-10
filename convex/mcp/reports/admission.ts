import { v } from "convex/values";
import { vOnCompleteArgs, type WorkId } from "@convex-dev/workpool";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { analyticsPool } from "../../analytics/pool";
import { readSyncRow } from "../../analytics/results";
import { requireMcpAdmin, mcpCallerValidator } from "../guard";
import { ASSISTANT_DAILY_RUN_ALLOWANCE, ASSISTANT_MINUTE_JOB_ALLOWANCE, ASSISTANT_JOB_TIMEOUT_MS, SYNC_INTERVAL_MS, jobValidator, type ReportJob } from "./contracts";
/** Serializes admission across tenants through indexed status range reads (Convex OCC).
 * Only running rows are dispatched. Two waiting rows stay outside the shared pool.
 */
async function recoverAndDispatch(ctx: MutationCtx) {
    const now = Date.now();
    const running = await ctx.db.query("mcpReportRequests").withIndex("by_status_and_createdAt", q => q.eq("status", "running")).take(4);
    let active = false;
    for (const row of running) {
        if (now - (row.executingAt ?? row.startedAt ?? row.createdAt) < ASSISTANT_JOB_TIMEOUT_MS) {
            active = true;
            continue;
        }
        if (row.workId)
            await analyticsPool.cancel(ctx, row.workId as WorkId);
        await ctx.db.patch("mcpReportRequests", row._id, { status: "failed", error: "abandoned_job", finishedAt: now });
    }
    if (active)
        return;
    const waiting = await ctx.db.query("mcpReportRequests").withIndex("by_status_and_createdAt", q => q.eq("status", "waiting")).take(3);
    for (const row of waiting) {
        if (row.expiresAt <= now) {
            await ctx.db.patch("mcpReportRequests", row._id, { status: "failed", error: "expired", finishedAt: now });
            continue;
        }
        const runToken = `${now}-${Math.random().toString(36).slice(2)}`;
        const workId = await analyticsPool.enqueueAction(ctx, internal.mcp.reports.runner.run, { requestId: row._id, runToken }, { retry: false, onComplete: internal.mcp.reports.admission.onComplete, context: { requestId: row._id, runToken } });
        await ctx.db.patch("mcpReportRequests", row._id, { status: "running", startedAt: now, runToken, workId });
        // Recovery also runs if the action times out before it can call finish.
        await ctx.scheduler.runAfter(ASSISTANT_JOB_TIMEOUT_MS, internal.mcp.reports.admission.recover, {});
        break;
    }
}
export const recover = internalMutation({ args: {}, returns: v.null(), handler: async (ctx) => { await recoverAndDispatch(ctx); return null; } });
export const admit = internalMutation({
    args: { caller: mcpCallerValidator, jobs: v.array(jobValidator) },
    returns: v.object({ status: v.union(v.literal("pending"), v.literal("unavailable")), reason: v.union(v.string(), v.null()) }),
    handler: async (ctx, { caller, jobs }) => {
        const me = await requireMcpAdmin(ctx, caller, { permission: "reports:view" });
        if (jobs.length > 60)
            throw new Error("Too many report jobs.");
        await recoverAndDispatch(ctx);
        const now = Date.now();
        const day = new Date(now).toISOString().slice(0, 10);
        const budgetKey = `allowance:${day}`;
        let allowance = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key", q => q.eq("tenantId", me.tenantId).eq("key", budgetKey)).unique();
        let used = allowance?.runCount ?? 0;
        const minuteStartedAt = allowance?.minuteStartedAt !== undefined && now - allowance.minuteStartedAt < 60000 ? allowance.minuteStartedAt : now;
        let minuteCount = minuteStartedAt === allowance?.minuteStartedAt ? allowance.minuteCount ?? 0 : 0;
        let waiting = (await ctx.db.query("mcpReportRequests").withIndex("by_status_and_createdAt", q => q.eq("status", "waiting")).take(3)).length;
        let running = (await ctx.db.query("mcpReportRequests").withIndex("by_status_and_createdAt", q => q.eq("status", "running")).take(2)).length;
        const activeKeys = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_expiresAt", q => q.eq("tenantId", me.tenantId).gt("expiresAt", now)).take(32);
        let keyCount = activeKeys.filter(r => r.kind !== "allowance").length;
        let reason: string | null = null;
        for (const job of jobs) {
            const existing = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key", q => q.eq("tenantId", me.tenantId).eq("key", job.key)).unique();
            if (existing && existing.expiresAt > now)
                continue;
            if (used >= ASSISTANT_DAILY_RUN_ALLOWANCE) {
                reason = "assistant_daily_allowance_spent";
                break;
            }
            if (minuteCount >= ASSISTANT_MINUTE_JOB_ALLOWANCE) {
                reason = "assistant_minute_allowance_spent";
                break;
            }
            if (keyCount >= 30) {
                reason = "assistant_key_limit";
                break;
            }
            if (running + waiting >= 3)
                break;
            const fields = { tenantId: me.tenantId, userId: me.userId, key: job.key, report: job.report, paramsJson: JSON.stringify(job), status: "waiting" as const, createdAt: now, expiresAt: now + SYNC_INTERVAL_MS, kind: "job" as const };
            if (existing)
                await ctx.db.patch("mcpReportRequests", existing._id, { ...fields, resultJson: undefined, error: undefined, finishedAt: undefined, executingAt: undefined, runToken: undefined, workId: undefined });
            else
                await ctx.db.insert("mcpReportRequests", fields);
            used++;
            minuteCount++;
            keyCount++;
            waiting++;
            if (!running) {
                await recoverAndDispatch(ctx);
                running = 1;
                waiting--;
            }
        }
        if (used !== (allowance?.runCount ?? 0)) {
            if (!allowance) {
                const id = await ctx.db.insert("mcpReportRequests", { tenantId: me.tenantId, userId: me.userId, key: budgetKey, report: "allowance", kind: "allowance", paramsJson: "{}", status: "ready", createdAt: now, expiresAt: Date.parse(`${day}T00:00:00Z`) + 2 * 86400000, runCount: used, minuteStartedAt, minuteCount });
                allowance = await ctx.db.get("mcpReportRequests", id);
            }
            else
                await ctx.db.patch("mcpReportRequests", allowance._id, { runCount: used, minuteStartedAt, minuteCount });
        }
        return { status: reason ? "unavailable" as const : "pending" as const, reason };
    },
});
export const begin = internalMutation({
    args: { requestId: v.id("mcpReportRequests"), runToken: v.string() }, returns: v.union(v.object({ job: jobValidator, tenantId: v.id("tenants") }), v.null()),
    handler: async (ctx, args) => {
        const row = await ctx.db.get("mcpReportRequests", args.requestId);
        if (!row || row.status !== "running" || row.runToken !== args.runToken || row.expiresAt <= Date.now())
            return null;
        await ctx.db.patch("mcpReportRequests", row._id, { executingAt: Date.now() });
        await ctx.scheduler.runAfter(ASSISTANT_JOB_TIMEOUT_MS, internal.mcp.reports.admission.recover, {});
        return { job: JSON.parse(row.paramsJson) as ReportJob, tenantId: row.tenantId };
    },
});
export const finish = internalMutation({
    args: { requestId: v.id("mcpReportRequests"), runToken: v.string(), resultJson: v.optional(v.string()), watermark: v.optional(v.number()), error: v.optional(v.string()) }, returns: v.null(),
    handler: async (ctx, args) => {
        const row: Doc<"mcpReportRequests"> | null = await ctx.db.get("mcpReportRequests", args.requestId);
        if (!row || row.runToken !== args.runToken || row.status !== "running")
            return null;
        const sync = await readSyncRow(ctx);
        const job = JSON.parse(row.paramsJson) as ReportJob;
        const expired = (sync?.watermark ?? 0) > job.syncWatermark && (sync?.watermark ?? 0) > (args.watermark ?? 0);
        await ctx.db.patch("mcpReportRequests", row._id, { resultJson: args.error || expired ? undefined : args.resultJson, error: args.error ?? (expired ? "sync_changed" : undefined), watermark: args.watermark, finishedAt: Date.now() });
        return null;
    },
});
/** Release the permit only after Workpool has finished the action. Releasing
 * inside the action's last mutation could briefly occupy both web workers. */
export const onComplete = internalMutation({
    args: vOnCompleteArgs(v.object({ requestId: v.id("mcpReportRequests"), runToken: v.string() }), v.null()),
    returns: v.null(),
    handler: async (ctx, { workId, context, result }) => {
        const row = await ctx.db.get("mcpReportRequests", context.requestId);
        if (!row || row.status !== "running" || row.runToken !== context.runToken || row.workId !== workId)
            return null;
        const ready = result.kind === "success" && !row.error && row.resultJson !== undefined;
        await ctx.db.patch("mcpReportRequests", row._id, { status: ready ? "ready" : "failed", error: ready ? undefined : row.error ?? "warehouse_failed", finishedAt: Date.now() });
        await recoverAndDispatch(ctx);
        return null;
    },
});
