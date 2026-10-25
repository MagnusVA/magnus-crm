import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { assertLeadGenBusinessDayReady } from "../lib/businessDayRebuildState";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import {
  createLiveReadState,
  readLiveDocuments,
  readLiveQueryRows,
} from "../lib/liveQueryBounds";
import {
  memberAvatarIdentityValidator,
  leadGenWorkerMemberIdentity,
} from "../lib/memberIdentity";
import { resparkResultsByWorker } from "../lib/respark/items";
import {
  addBusinessDays,
  businessDateToUtcStart,
} from "../reporting/lib/hondurasBusinessTime";
import { DAILY_STATS_READ_LIMIT } from "./reportLimits";
import { leadGenSourceValidator } from "./validators";

export const RESPARK_CREDIT_READ_LIMIT = 5_000;
const WORKER_LIMIT = 500;

export async function countWorkerResparkResults(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  workerIds: Id<"leadGenWorkers">[],
  startAt: number,
  endAt: number,
) {
  const counts = await resparkResultsByWorker.countBatch(
    ctx,
    workerIds.flatMap((workerId) =>
      (["resparked", "not_a_fit"] as const).map((result) => ({
        namespace: tenantId,
        bounds: {
          lower: {
            key: [workerId, result, startAt] as [
              Id<"leadGenWorkers">,
              typeof result,
              number,
            ],
            inclusive: true,
          },
          upper: {
            key: [workerId, result, endAt] as [
              Id<"leadGenWorkers">,
              typeof result,
              number,
            ],
            inclusive: false,
          },
        },
      })),
    ),
  );
  return new Map(
    workerIds.map((workerId, index) => [
      workerId,
      {
        resparks: counts[index * 2],
        notAFit: counts[index * 2 + 1],
      },
    ]),
  );
}

export const listResparkPerformance = query({
  args: {
    startDayKey: v.string(),
    endDayKey: v.string(),
    source: v.optional(leadGenSourceValidator),
  },
  returns: v.object({
    rows: v.array(
      v.object({
        workerId: v.id("leadGenWorkers"),
        worker: memberAvatarIdentityValidator,
        rawLeads: v.union(v.number(), v.null()),
        resparks: v.number(),
        entries: v.union(v.number(), v.null()),
        notAFit: v.number(),
        notAFitShare: v.union(v.number(), v.null()),
        resparkedThenBooked: v.number(),
      }),
    ),
    capped: v.boolean(),
    rawLeadsCapped: v.boolean(),
    bookedCapped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    await assertLeadGenBusinessDayReady(ctx, tenantId);
    if (args.startDayKey > args.endDayKey)
      throw new Error("Start date must be on or before end date");
    const setting = await getTenantBusinessDay(ctx, tenantId);
    const startAt = businessDateToUtcStart(args.startDayKey, setting);
    const endAt = businessDateToUtcStart(
      addBusinessDays(args.endDayKey, 1),
      setting,
    );
    const workers = await readLiveQueryRows(
      ctx.db
        .query("leadGenWorkers")
        .withIndex("by_tenantId_and_isActive", (q) =>
          q.eq("tenantId", tenantId),
        ),
      WORKER_LIMIT,
    );
    const dailyQuery = args.source
      ? ctx.db
          .query("leadGenDailyStats")
          .withIndex("by_tenantId_and_source_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("source", args.source!)
              .gte("dayKey", args.startDayKey)
              .lte("dayKey", args.endDayKey),
          )
      : ctx.db
          .query("leadGenDailyStats")
          .withIndex("by_tenantId_and_dayKey", (q) =>
            q
              .eq("tenantId", tenantId)
              .gte("dayKey", args.startDayKey)
              .lte("dayKey", args.endDayKey),
          );
    const daily = await readLiveQueryRows(dailyQuery, DAILY_STATS_READ_LIMIT);
    const rawByWorker = new Map<Id<"leadGenWorkers">, number>();
    for (const row of daily.rows) {
      rawByWorker.set(
        row.workerId,
        (rawByWorker.get(row.workerId) ?? 0) + row.submissions,
      );
    }
    const counts = await countWorkerResparkResults(
      ctx,
      tenantId,
      workers.rows.map((worker) => worker._id),
      startAt,
      endAt,
    );
    // Like the conversion table, expose a partial count when this read is capped.
    // The indexed credit read and deal joins each have a live byte budget.
    const creditState = createLiveReadState();
    const credits = await readLiveQueryRows(
      ctx.db
        .query("dealAttributions")
        .withIndex("by_tenantId_and_source_kind_and_attributedAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("source.kind", "respark")
            .gte("attributedAt", startAt)
            .lt("attributedAt", endAt),
        ),
      RESPARK_CREDIT_READ_LIMIT,
      creditState,
    );
    const dealState = createLiveReadState();
    const deals = await readLiveDocuments(
      [...new Set(credits.rows.map((row) => row.opportunityId))],
      (id) => ctx.db.get("opportunities", id),
      dealState,
    );
    const bookedIds = new Set(
      deals.rows
        .filter(
          (deal) =>
            deal.tenantId === tenantId && deal.firstBookedAt !== undefined,
        )
        .map((deal) => deal._id),
    );
    const bookedByWorker = new Map<Id<"leadGenWorkers">, number>();
    for (const credit of credits.rows) {
      if (
        credit.source.kind !== "respark" ||
        !bookedIds.has(credit.opportunityId)
      )
        continue;
      const id = credit.source.workerId;
      bookedByWorker.set(id, (bookedByWorker.get(id) ?? 0) + 1);
    }
    const rows = await Promise.all(
      workers.rows.map(async (worker) => {
        const { resparks, notAFit } = counts.get(worker._id)!;
        const rawLeads = daily.capped
          ? null
          : (rawByWorker.get(worker._id) ?? 0);
        return {
          workerId: worker._id,
          worker: await leadGenWorkerMemberIdentity(ctx, worker),
          rawLeads,
          resparks,
          notAFit,
          entries: rawLeads === null ? null : rawLeads + resparks,
          notAFitShare:
            resparks + notAFit > 0 ? notAFit / (resparks + notAFit) : null,
          resparkedThenBooked: bookedByWorker.get(worker._id) ?? 0,
        };
      }),
    );
    return {
      rows,
      capped: workers.capped,
      rawLeadsCapped: daily.capped,
      bookedCapped: creditState.capped || dealState.capped,
    };
  },
});
