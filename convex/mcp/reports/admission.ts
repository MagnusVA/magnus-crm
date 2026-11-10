import { v } from "convex/values";
import { vOnCompleteArgs, type WorkId } from "@convex-dev/workpool";
import type { MutationCtx } from "../../_generated/server";
import { internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { analyticsPool } from "../../analytics/pool";
import { readSyncRow } from "../../analytics/results";
import { requireMcpAdmin, mcpCallerValidator } from "../guard";
import { ASSISTANT_JOB_TIMEOUT_MS, SYNC_INTERVAL_MS, failedJobRetryable, jobValidator, type ReportJob } from "./contracts";
/** Parts deleted per transaction: 6 × 900 KB stays well under a mutation's reads. */
const PART_DELETE_BATCH = 6;
/** A run's parts are deleted in scheduled batches, never inline with other work. */
async function scheduleDeleteParts(ctx: MutationCtx, requestId: Id<"mcpReportRequests">, runToken: string | undefined) {
    if (runToken !== undefined)
        await ctx.scheduler.runAfter(0, internal.mcp.reports.admission.deleteParts, { requestId, runToken });
}
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
        // Clear a published answer too, or its parts would be kept from deletion.
        await ctx.db.patch("mcpReportRequests", row._id, { status: "failed", error: "abandoned_job", payloadParts: undefined, payloadRunToken: undefined, finishedAt: now });
        await scheduleDeleteParts(ctx, row._id, row.runToken);
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
    returns: v.object({ status: v.literal("pending"), reason: v.null() }),
    handler: async (ctx, { caller, jobs }) => {
        const me = await requireMcpAdmin(ctx, caller, { permission: "reports:view" });
        if (jobs.length > 60)
            throw new Error("Too many report jobs.");
        await recoverAndDispatch(ctx);
        const now = Date.now();
        let waiting = (await ctx.db.query("mcpReportRequests").withIndex("by_status_and_createdAt", q => q.eq("status", "waiting")).take(3)).length;
        let running = (await ctx.db.query("mcpReportRequests").withIndex("by_status_and_createdAt", q => q.eq("status", "running")).take(2)).length;
        for (const job of jobs) {
            const existing = await ctx.db.query("mcpReportRequests").withIndex("by_tenantId_and_key", q => q.eq("tenantId", me.tenantId).eq("key", job.key)).unique();
            if (existing && existing.expiresAt > now && !failedJobRetryable(existing, now))
                continue;
            if (running + waiting >= 3)
                break;
            const fields = { tenantId: me.tenantId, userId: me.userId, key: job.key, report: job.report, paramsJson: JSON.stringify(job), status: "waiting" as const, createdAt: now, expiresAt: now + SYNC_INTERVAL_MS, kind: "job" as const };
            if (existing) {
                // The old run's parts go in their own batches; the new run writes under a new token.
                await scheduleDeleteParts(ctx, existing._id, existing.runToken);
                if (existing.payloadRunToken !== existing.runToken)
                    await scheduleDeleteParts(ctx, existing._id, existing.payloadRunToken);
                await ctx.db.patch("mcpReportRequests", existing._id, { ...fields, resultJson: undefined, payloadParts: undefined, payloadRunToken: undefined, error: undefined, finishedAt: undefined, executingAt: undefined, runToken: undefined, workId: undefined });
            }
            else
                await ctx.db.insert("mcpReportRequests", fields);
            waiting++;
            if (!running) {
                await recoverAndDispatch(ctx);
                running = 1;
                waiting--;
            }
        }
        return { status: "pending" as const, reason: null };
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
/** One part of a running request's answer, written only under its current run. */
export const storePart = internalMutation({
    args: { requestId: v.id("mcpReportRequests"), runToken: v.string(), index: v.number(), json: v.string() }, returns: v.boolean(),
    handler: async (ctx, args) => {
        const row = await ctx.db.get("mcpReportRequests", args.requestId);
        if (!row || row.status !== "running" || row.runToken !== args.runToken || row.expiresAt <= Date.now())
            return false;
        const existing = await ctx.db.query("mcpReportPayloads").withIndex("by_requestId_and_runToken_and_index", q => q.eq("requestId", args.requestId).eq("runToken", args.runToken).eq("index", args.index)).unique();
        if (existing)
            await ctx.db.replace("mcpReportPayloads", existing._id, { tenantId: row.tenantId, requestId: args.requestId, runToken: args.runToken, index: args.index, json: args.json });
        else
            await ctx.db.insert("mcpReportPayloads", { tenantId: row.tenantId, requestId: args.requestId, runToken: args.runToken, index: args.index, json: args.json });
        return true;
    },
});
/** Publishes a run's parts, or records its failure and schedules its parts' deletion. */
export const finish = internalMutation({
    // resultJson: accepted for one release so a run started before the deploy fails cleanly.
    args: { requestId: v.id("mcpReportRequests"), runToken: v.string(), parts: v.optional(v.number()), resultJson: v.optional(v.string()), watermark: v.optional(v.number()), error: v.optional(v.string()) }, returns: v.null(),
    handler: async (ctx, args) => {
        const row: Doc<"mcpReportRequests"> | null = await ctx.db.get("mcpReportRequests", args.requestId);
        if (!row || row.runToken !== args.runToken || row.status !== "running") {
            await scheduleDeleteParts(ctx, args.requestId, args.runToken);
            return null;
        }
        const sync = await readSyncRow(ctx);
        const job = JSON.parse(row.paramsJson) as ReportJob;
        const expired = (sync?.watermark ?? 0) > job.syncWatermark && (sync?.watermark ?? 0) > (args.watermark ?? 0);
        const published = !args.error && !expired && args.parts !== undefined;
        // A run started before parts existed still finishes with its inline answer.
        const inline = !args.error && !expired && args.parts === undefined ? args.resultJson : undefined;
        if (!published)
            await scheduleDeleteParts(ctx, row._id, args.runToken);
        await ctx.db.patch("mcpReportRequests", row._id, { resultJson: inline, payloadParts: published ? args.parts : undefined, payloadRunToken: published ? args.runToken : undefined, error: args.error ?? (expired ? "sync_changed" : published || inline !== undefined ? undefined : "warehouse_failed"), watermark: args.watermark, finishedAt: Date.now() });
        return null;
    },
});
/** Deletes one run's parts a few at a time, rescheduling until none remain. */
export const deleteParts = internalMutation({
    args: { requestId: v.id("mcpReportRequests"), runToken: v.string() }, returns: v.null(),
    handler: async (ctx, args) => {
        const row = await ctx.db.get("mcpReportRequests", args.requestId);
        // A published answer of this run is still in use.
        if (row && row.payloadRunToken === args.runToken)
            return null;
        const parts = await ctx.db.query("mcpReportPayloads").withIndex("by_requestId_and_runToken_and_index", q => q.eq("requestId", args.requestId).eq("runToken", args.runToken)).take(PART_DELETE_BATCH);
        for (const part of parts)
            await ctx.db.delete("mcpReportPayloads", part._id);
        if (parts.length === PART_DELETE_BATCH)
            await ctx.scheduler.runAfter(PART_DELETE_SPACING_MS, internal.mcp.reports.admission.deleteParts, args);
        return null;
    },
});
/** Pause between deletion batches, so cleanup never spends the write budget in a burst. */
const PART_DELETE_SPACING_MS = 1_000; // the web's DELETE_BATCH_DELAY_MS
/** Release the permit only after Workpool has finished the action. Releasing
 * inside the action's last mutation could briefly occupy both web workers. */
export const onComplete = internalMutation({
    args: vOnCompleteArgs(v.object({ requestId: v.id("mcpReportRequests"), runToken: v.string() }), v.null()),
    returns: v.null(),
    handler: async (ctx, { workId, context, result }) => {
        const row = await ctx.db.get("mcpReportRequests", context.requestId);
        if (!row || row.status !== "running" || row.runToken !== context.runToken || row.workId !== workId)
            return null;
        const ready = result.kind === "success" && !row.error && (row.resultJson !== undefined || row.payloadParts !== undefined);
        await ctx.db.patch("mcpReportRequests", row._id, { status: ready ? "ready" : "failed", error: ready ? undefined : row.error ?? "warehouse_failed", ...(ready ? {} : { payloadParts: undefined, payloadRunToken: undefined }), finishedAt: Date.now() });
        if (!ready)
            await scheduleDeleteParts(ctx, row._id, context.runToken);
        await recoverAndDispatch(ctx);
        return null;
    },
});
