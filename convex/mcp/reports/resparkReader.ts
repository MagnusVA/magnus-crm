import type { ReaderArgs } from "../../analytics/assistantTypes";
import type { Id } from "../../_generated/dataModel";
import { type QueryCtx } from "../../_generated/server";
import { assertLeadGenBusinessDayReady } from "../../lib/businessDayRebuildState";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { createLiveReadState, readLiveDocuments, readLiveQueryRows } from "../../lib/liveQueryBounds";
import { addBusinessDays, businessDateToUtcStart } from "../../reporting/lib/hondurasBusinessTime";
import { DAILY_STATS_READ_LIMIT } from "../../leadGen/reportLimits";
import { loadResparkWorkers, countWorkerResparkResults, RESPARK_CREDIT_READ_LIMIT, buildResparkPerformance } from "../../leadGen/resparkReports";
import type { listResparkPerformance } from "../../leadGen/resparkReports";
// Trusted tenant readers. Copied load steps preserve page semantics; builders stay shared.
export async function readListResparkPerformance(ctx: QueryCtx, tenantId: Id<"tenants">, args: ReaderArgs<typeof listResparkPerformance>) {
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    if (args.startDayKey > args.endDayKey)
        throw new Error("Start date must be on or before end date");
    const setting = await getTenantBusinessDay(ctx, tenantId);
    const startAt = businessDateToUtcStart(args.startDayKey, setting);
    const endAt = businessDateToUtcStart(addBusinessDays(args.endDayKey, 1), setting);
    const workers = await loadResparkWorkers(ctx, tenantId);
    const dailyQuery = args.source
        ? ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_source_and_dayKey", (q) => q
            .eq("tenantId", tenantId)
            .eq("source", args.source!)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey))
        : ctx.db
            .query("leadGenDailyStats")
            .withIndex("by_tenantId_and_dayKey", (q) => q
            .eq("tenantId", tenantId)
            .gte("dayKey", args.startDayKey)
            .lte("dayKey", args.endDayKey));
    const daily = await readLiveQueryRows(dailyQuery, DAILY_STATS_READ_LIMIT);
    const rawByWorker = new Map<Id<"leadGenWorkers">, number>();
    for (const row of daily.rows) {
        rawByWorker.set(row.workerId, (rawByWorker.get(row.workerId) ?? 0) + row.submissions);
    }
    const counts = await countWorkerResparkResults(ctx, tenantId, workers.rows.map((worker) => worker._id), startAt, endAt);
    // Like the conversion table, expose a partial count when this read is capped.
    // The indexed credit read and deal joins each have a live byte budget.
    const creditState = createLiveReadState();
    const credits = await readLiveQueryRows(ctx.db
        .query("dealAttributions")
        .withIndex("by_tenantId_and_source_kind_and_attributedAt", (q) => q
        .eq("tenantId", tenantId)
        .eq("source.kind", "respark")
        .gte("attributedAt", startAt)
        .lt("attributedAt", endAt)), RESPARK_CREDIT_READ_LIMIT, creditState);
    const dealState = createLiveReadState();
    const deals = await readLiveDocuments([...new Set(credits.rows.map((row) => row.opportunityId))], (id) => ctx.db.get("opportunities", id), dealState);
    const bookedIds = new Set(deals.rows
        .filter((deal) => deal.tenantId === tenantId && deal.firstBookedAt !== undefined)
        .map((deal) => deal._id));
    const bookedByWorker = new Map<Id<"leadGenWorkers">, number>();
    for (const credit of credits.rows) {
        if (credit.source.kind !== "respark" ||
            !bookedIds.has(credit.opportunityId))
            continue;
        const id = credit.source.workerId;
        bookedByWorker.set(id, (bookedByWorker.get(id) ?? 0) + 1);
    }
    return await buildResparkPerformance(ctx, workers, {
        rawByWorker: daily.capped ? null : rawByWorker,
        counts,
        bookedByWorker,
        bookedCapped: creditState.capped || dealState.capped,
    });
}
