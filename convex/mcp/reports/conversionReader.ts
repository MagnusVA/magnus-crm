import type { ReaderArgs } from "../../analytics/assistantTypes";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import type { Id } from "../../_generated/dataModel";
import { type QueryCtx } from "../../_generated/server";
import { LIFECYCLE_STAGES } from "../../leads/lifecycle";
import { createLiveReadState, readLiveQueryRows } from "../../lib/liveQueryBounds";
import { countProspectConversions } from "../../lib/prospectConversions";
import { addBusinessDays, businessDateToUtcStart } from "../../reporting/lib/hondurasBusinessTime";
import { leadGenDealsByWorker } from "../../leadGen/leadGenDealsAggregate";
import { loadConversionWorkers, CONVERSION_DEALS_READ_LIMIT, ProspectConversionCounts, buildProspectConversions } from "../../leadGen/conversions";
import type { listProspectConversions } from "../../leadGen/conversions";
// Trusted tenant readers. Copied load steps preserve page semantics; builders stay shared.
const CONVERSION_DEALS_BYTE_BUDGET = 2 * 1024 * 1024;
async function countLeadGenDeals(ctx: QueryCtx, tenantId: Id<"tenants">, startAt: number, endAt: number, workerIds: Id<"leadGenWorkers">[]): Promise<{
    byWorker: Map<Id<"leadGenWorkers">, number>;
    capped: boolean;
}> {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (tenant?.leadGenDealsAggregateVerifiedAt !== undefined) {
        const counts = await leadGenDealsByWorker.countBatch(ctx, workerIds.map((workerId) => ({
            namespace: tenantId,
            bounds: {
                lower: { key: [workerId, startAt], inclusive: true },
                upper: { key: [workerId, endAt], inclusive: false },
            },
        })));
        return {
            byWorker: new Map(workerIds.map((id, index) => [id, counts[index]])),
            capped: false,
        };
    }
    const read = await readLiveQueryRows(ctx.db
        .query("dealAttributions")
        .withIndex("by_tenantId_and_role_and_attributedAt", (q) => q
        .eq("tenantId", tenantId)
        .eq("role", "lead_gen")
        .gte("attributedAt", startAt)
        .lt("attributedAt", endAt)), CONVERSION_DEALS_READ_LIMIT, createLiveReadState(), CONVERSION_DEALS_BYTE_BUDGET);
    const byWorker = new Map<Id<"leadGenWorkers">, number>();
    for (const row of read.rows) {
        if (row.source.kind !== "capture")
            continue;
        const workerId = row.source.workerId;
        byWorker.set(workerId, (byWorker.get(workerId) ?? 0) + 1);
    }
    return { byWorker, capped: read.capped };
}
export async function readListProspectConversions(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof listProspectConversions>) {
    if (args.startDayKey > args.endDayKey) {
        throw new Error("Start date must be on or before end date");
    }
    const startAt = businessDateToUtcStart(args.startDayKey, await getTenantBusinessDay(ctx, tenantId));
    const endAt = businessDateToUtcStart(addBusinessDays(args.endDayKey, 1), await getTenantBusinessDay(ctx, tenantId));
    const workers = await loadConversionWorkers(ctx, tenantId);
    const workerIds = workers.page.map((worker) => worker._id);
    const deals = await countLeadGenDeals(ctx, tenantId, startAt, endAt, workerIds);
    const counts = new Map<Id<"leadGenWorkers">, ProspectConversionCounts>();
    for (const workerId of workerIds) {
        const workerCounts = {} as ProspectConversionCounts;
        for (const stage of LIFECYCLE_STAGES) {
            workerCounts[stage] = await countProspectConversions(ctx, tenantId, workerId, stage, startAt, endAt);
        }
        counts.set(workerId, workerCounts);
    }
    return await buildProspectConversions(ctx, workers, { counts, deals });
}
