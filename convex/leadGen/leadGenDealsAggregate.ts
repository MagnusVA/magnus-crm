import { TableAggregate } from "@convex-dev/aggregate";
import { v } from "convex/values";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
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

const PAGE_SIZE = 200;
const differenceValidator = v.object({
  workerId: v.id("leadGenWorkers"),
  sourceCount: v.number(),
  aggregateCount: v.number(),
});

/** Complete offline comparison, including aggregate-only worker credit. */
async function differences(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  startAt: number,
  endAt: number,
  checkEntryKeys = false,
) {
  if (!(startAt < endAt)) throw new Error("Invalid attribution range");
  const expected = new Map<Id<"leadGenWorkers">, number>();
  const expectedKeys = new Map<Id<"dealAttributions">, [Id<"leadGenWorkers">, number]>();
  let cursor: string | null = null;
  while (true) {
    const result = await ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
        q.eq("tenantId", tenantId).eq("role", "lead_gen")
          .gte("attributedAt", startAt).lt("attributedAt", endAt),
      )
      .paginate({ cursor, numItems: PAGE_SIZE });
    for (const row of result.page) {
      if (isLeadGenDealAggregateEligible(row)) {
        expected.set(row.source.workerId, (expected.get(row.source.workerId) ?? 0) + 1);
        if (checkEntryKeys) expectedKeys.set(row._id, [row.source.workerId, row.attributedAt]);
      }
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }

  // Include stale entries even if both the source row and worker were deleted.
  let aggregateCursor: string | undefined;
  while (true) {
    const result = await leadGenDealsByWorker.paginate(ctx, {
      namespace: tenantId,
      cursor: aggregateCursor,
      pageSize: PAGE_SIZE,
    });
    for (const { id, key: [workerId, attributedAt] } of result.page) {
      if (attributedAt < startAt || attributedAt >= endAt) continue;
      if (checkEntryKeys) {
        const key = expectedKeys.get(id);
        if (!key || key[0] !== workerId || key[1] !== attributedAt) {
          throw new Error(`Attribution aggregate mismatch ${workerId}`);
        }
        expectedKeys.delete(id);
      }
      if (!expected.has(workerId)) expected.set(workerId, 0);
    }
    if (result.isDone) break;
    aggregateCursor = result.cursor;
  }

  if (checkEntryKeys && expectedKeys.size > 0) {
    const [workerId] = expectedKeys.values().next().value!;
    throw new Error(`Attribution aggregate mismatch ${workerId}`);
  }

  const workers = [...expected.keys()].sort();
  const result = [];
  for (let offset = 0; offset < workers.length; offset += PAGE_SIZE) {
    const page = workers.slice(offset, offset + PAGE_SIZE);
    const counts = await leadGenDealsByWorker.countBatch(
      ctx,
      page.map((workerId) => ({
        namespace: tenantId,
        bounds: {
          lower: { key: [workerId, startAt], inclusive: true },
          upper: { key: [workerId, endAt], inclusive: false },
        },
      })),
    );
    for (const [index, workerId] of page.entries()) {
      const sourceCount = expected.get(workerId)!;
      const aggregateCount = counts[index];
      if (sourceCount !== aggregateCount) result.push({ workerId, sourceCount, aggregateCount });
    }
  }
  return result;
}

export const verifyLeadGenDealsByWorker = internalQuery({
  args: { tenantId: v.id("tenants"), startAt: v.number(), endAt: v.number() },
  returns: v.array(differenceValidator),
  handler: async (ctx, { tenantId, startAt, endAt }) =>
    await differences(ctx, tenantId, startAt, endAt),
});

// Recheck the complete history in the mutation that enables the reader. A
// caller cannot enable every date range by supplying a clean empty interval.
// Compare row identities and keys too, so offsetting errors across capture
// dates cannot pass just because a worker's all-time total is unchanged.
export const markLeadGenDealsByWorkerVerified = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    if (!await ctx.db.get("tenants", tenantId)) {
      throw new Error(`Missing tenant ${tenantId}`);
    }
    const mismatches = await differences(ctx, tenantId, -Infinity, Infinity, true);
    if (mismatches.length > 0) {
      throw new Error(`Attribution aggregate mismatch ${mismatches[0].workerId}`);
    }
    await ctx.db.patch("tenants", tenantId, { leadGenDealsAggregateVerifiedAt: Date.now() });
    return null;
  },
});
