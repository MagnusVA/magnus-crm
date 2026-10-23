import { TableAggregate } from "@convex-dev/aggregate";
import { v } from "convex/values";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";

type CaptureAttribution = Doc<"dealAttributions"> & {
  source: Extract<Doc<"dealAttributions">["source"], { kind: "capture" }>;
};

export function isLeadGenDealAggregateEligible(
  row: Doc<"dealAttributions">,
): row is CaptureAttribution {
  return row.role === "lead_gen" && row.source.kind === "capture";
}

// Identity is the attribution row, preserving the report's row count even
// when two rows credit the same deal. attributedAt is the capture time.
export const leadGenDealsByWorker = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"leadGenWorkers">, number];
  DataModel: DataModel;
  TableName: "dealAttributions";
}>(components.leadGenDealsByWorker, {
  namespace: (row) => row.tenantId,
  sortKey: (row) => {
    if (!isLeadGenDealAggregateEligible(row)) {
      throw new Error(`Ineligible attribution ${row._id}`);
    }
    return [row.source.workerId, row.attributedAt];
  },
});

export async function insertLeadGenDealAggregate(
  ctx: MutationCtx,
  row: Doc<"dealAttributions">,
) {
  if (isLeadGenDealAggregateEligible(row)) {
    await leadGenDealsByWorker.insertIfDoesNotExist(ctx, row);
  }
}

export async function deleteLeadGenDealAggregate(
  ctx: MutationCtx,
  row: Doc<"dealAttributions">,
) {
  if (isLeadGenDealAggregateEligible(row)) {
    await leadGenDealsByWorker.deleteIfExists(ctx, row);
  }
}

const differenceValidator = v.object({
  workerId: v.id("leadGenWorkers"),
  sourceCount: v.number(),
  aggregateCount: v.number(),
});

// Offline comparison for a bounded reporting range, normally one month.
export const verifyLeadGenDealsByWorker = internalQuery({
  args: { tenantId: v.id("tenants"), startAt: v.number(), endAt: v.number() },
  returns: v.array(differenceValidator),
  handler: async (ctx, { tenantId, startAt, endAt }) => {
    if (!(startAt < endAt)) throw new Error("Invalid attribution range");
    // eslint-disable-next-line @convex-dev/no-collect-in-query -- Offline parity for one indexed month, normally a few hundred small rows.
    const rows = await ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
        q.eq("tenantId", tenantId).eq("role", "lead_gen")
          .gte("attributedAt", startAt).lt("attributedAt", endAt),
      )
      .collect();
    const expected = new Map<Id<"leadGenWorkers">, number>();
    for (const row of rows) {
      if (isLeadGenDealAggregateEligible(row)) {
        expected.set(row.source.workerId, (expected.get(row.source.workerId) ?? 0) + 1);
      }
    }
    // Every retained worker, not only those with rows in the range, so stale
    // credit for a worker with no rows here still shows as a difference.
    // eslint-disable-next-line @convex-dev/no-collect-in-query -- Offline parity; a tenant has a few dozen workers.
    const retained = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", tenantId))
      .collect();
    const workers = [
      ...new Set([...retained.map((worker) => worker._id), ...expected.keys()]),
    ].sort();
    const counts = await leadGenDealsByWorker.countBatch(
      ctx,
      workers.map((workerId) => ({
        namespace: tenantId,
        bounds: {
          lower: { key: [workerId, startAt], inclusive: true },
          upper: { key: [workerId, endAt], inclusive: false },
        },
      })),
    );
    return workers.flatMap((workerId, index) => {
      const sourceCount = expected.get(workerId) ?? 0;
      const aggregateCount = counts[index];
      return sourceCount === aggregateCount ? [] : [{ workerId, sourceCount, aggregateCount }];
    });
  },
});

export const markLeadGenDealsByWorkerVerified = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    if (!await ctx.db.get("tenants", tenantId)) {
      throw new Error(`Missing tenant ${tenantId}`);
    }
    const names = [
      "migrations:backfillLeadGenDealsByWorker",
      "migrations:assertLeadGenDealsByWorker",
    ];
    const statuses = await ctx.runQuery(components.migrations.lib.getStatus, { names });
    const backfill = statuses.find((status) => status.name === names[0]);
    const assertion = statuses.find((status) => status.name === names[1]);
    // Rerunning the sequence requires reset: true on the assert migration.
    if (
      !backfill?.isDone || backfill.error !== undefined || backfill.state !== "success" ||
      !assertion?.isDone || assertion.error !== undefined || assertion.state !== "success" ||
      backfill.latestEnd === undefined || assertion.latestStart < backfill.latestEnd
    ) {
      throw new Error("Complete backfillLeadGenDealsByWorker and assertLeadGenDealsByWorker before activating reports");
    }
    // A few thousand small tenant rows fit in one read. Rethink this check
    // past ~25,000 rows. The per-row assertion proves every expected entry;
    // matching the total here also rules out extra aggregate entries.
    // eslint-disable-next-line @convex-dev/no-collect-in-query -- One-time activation over a few thousand small tenant rows; revisit past ~25,000.
    const rows = await ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
        q.eq("tenantId", tenantId).eq("role", "lead_gen"),
      )
      .collect();
    const sourceCount = rows.filter(isLeadGenDealAggregateEligible).length;
    const aggregateCount = await leadGenDealsByWorker.count(ctx, { namespace: tenantId });
    if (sourceCount !== aggregateCount) {
      throw new Error(`Attribution aggregate total mismatch ${tenantId}`);
    }
    await ctx.db.patch("tenants", tenantId, { leadGenDealsAggregateVerifiedAt: Date.now() });
    return null;
  },
});
