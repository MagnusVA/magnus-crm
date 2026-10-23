import { v } from "convex/values";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import { opportunityByStage } from "./aggregates";
import { OPEN_PIPELINE_STAGES } from "./pipelineHealth";
import { isPersonLossEligible, openDealAging, personLosses } from "./pipelineHealthAggregates";

const MAX_PERSON_LOSSES = 2_000;
const args = { tenantId: v.id("tenants") };
const difference = v.object({
  scope: v.string(), // Aggregate, stage or deal ID. No person data.
  metric: v.union(v.literal("count"), v.literal("entry")),
  source: v.number(),
  aggregate: v.number(),
});
type Difference = { scope: string; metric: "count" | "entry"; source: number; aggregate: number };

async function verifyTotals(ctx: QueryCtx, tenantId: Id<"tenants">): Promise<Difference[]> {
  const differences: Difference[] = [];
  // The batched assert proves every eligible deal is present at its key.
  // Counts from the already verified, strictly maintained aggregate then
  // prove there are no extra entries under any open stage.
  for (const stage of OPEN_PIPELINE_STAGES) {
    const source = await opportunityByStage.count(ctx, {
      namespace: tenantId, bounds: { prefix: [stage, "open"] },
    });
    const aggregate = await openDealAging.count(ctx, {
      namespace: tenantId, bounds: { prefix: [stage] },
    });
    if (source !== aggregate) differences.push({ scope: stage, metric: "count", source, aggregate });
  }

  // Reject before fetching deals if the reverse membership check would
  // exceed its fixed budget. All dates and actors are covered in one tenant.
  const count = await personLosses.count(ctx, { namespace: tenantId });
  if (count > MAX_PERSON_LOSSES) {
    differences.push({ scope: "personLosses.limit", metric: "count", source: MAX_PERSON_LOSSES, aggregate: count });
    return differences;
  }
  const seen = new Set<Id<"opportunities">>();
  for await (const entry of personLosses.iter(ctx, { namespace: tenantId, pageSize: 200 })) {
    const deal = await ctx.db.get("opportunities", entry.id);
    if (seen.has(entry.id) || !deal || deal.tenantId !== tenantId || !isPersonLossEligible(deal)
      || entry.key[0] !== deal.lostAt || entry.key[1] !== (deal.lostByUserId ?? "")) {
      differences.push({ scope: entry.id, metric: "entry", source: 1, aggregate: 0 });
    }
    seen.add(entry.id);
  }
  return differences;
}

/** Bounded reverse membership and count checks. Returns differences only. */
export const verifyPipelineHealthAggregateTotals = internalQuery({
  args,
  returns: v.array(difference),
  handler: async (ctx, { tenantId }) => verifyTotals(ctx, tenantId),
});

/** Read trusted migration status and recheck totals in this transaction. */
export const markPipelineHealthAggregatesVerified = internalMutation({
  args,
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const names = [
      "migrations:backfillOpenDealAging",
      "migrations:backfillPersonLosses",
      "migrations:assertPipelineHealthAggregates",
    ];
    const statuses = await ctx.runQuery(components.migrations.lib.getStatus, { names });
    for (const name of names) {
      const status = statuses.find((status) => status.name === name);
      if (!status?.isDone || status.state !== "success" || status.error !== undefined) {
        throw new Error(`Pipeline health migration incomplete: ${name}`);
      }
    }
    const differences = await verifyTotals(ctx, tenantId);
    if (differences.length) throw new Error(`Pipeline health aggregate mismatch: ${JSON.stringify(differences)}`);
    await ctx.db.patch("tenants", tenantId, { pipelineHealthAggregatesVerifiedAt: Date.now() });
    return null;
  },
});
