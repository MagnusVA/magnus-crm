import { stream } from "convex-helpers/server/stream";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "../_generated/server";
import schema from "../schema";
import { assertValidDateRange } from "./lib/helpers";
import { isPersonLoss } from "./lib/outcomeDerivation";
import { OPEN_PIPELINE_STAGES } from "./pipelineHealth";
import { openDealAging, personLosses } from "./pipelineHealthAggregates";

const STALE_MS = 14 * 86400000;
const FIRST_MONTH = Date.UTC(2026, 3, 1);
const args = { tenantId: v.id("tenants"), startDate: v.number(), endDate: v.number() };
const difference = v.object({
  scope: v.string(), // Stage, or month start and actor ID. No person data.
  metric: v.union(v.literal("count"), v.literal("createdAtSum"), v.literal("staleCount")),
  source: v.number(),
  aggregate: v.number(),
});
type Difference = { scope: string; metric: "count" | "createdAtSum" | "staleCount"; source: number; aggregate: number };

// The caller can verify one month or a range. Split longer ranges into
// months so errors in different months cannot cancel each other out.
function monthRanges(startDate: number, endDate: number) {
  assertValidDateRange(startDate, endDate);
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = startDate; start < endDate;) {
    const date = new Date(start);
    const end = Math.min(endDate, Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    ranges.push({ start, end });
    start = end;
  }
  return ranges;
}

async function verify(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<Difference[]> {
  const ranges = monthRanges(startDate, endDate);
  const differences: Difference[] = [];
  const compare = (scope: string, metric: Difference["metric"], source: number, aggregate: number) => {
    if (source !== aggregate) differences.push({ scope, metric, source, aggregate });
  };
  const now = Date.now();
  // stream's keyset pagination allows multiple 200-row pages/index ranges
  // in one snapshot without Convex's single native paginate restriction.
  const db = stream(ctx.db, schema);
  for (const stage of OPEN_PIPELINE_STAGES) {
    let count = 0;
    let sum = 0;
    let stale = 0;
    let cursor: string | null = null;
    const query = db.query("opportunities")
      .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("stage", stage).eq("outcome", "open"));
    while (true) {
      const page = await query.paginate({ cursor, numItems: 200 });
      for (const deal of page.page) {
        count += 1;
        sum += deal.createdAt;
        if (deal.nextMeetingAt === undefined || deal.nextMeetingAt < now - STALE_MS) stale += 1;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const opts = { namespace: tenantId, bounds: { prefix: [stage] as [typeof stage] } };
    compare(stage, "count", count, await openDealAging.count(ctx, opts));
    compare(stage, "createdAtSum", sum, await openDealAging.sum(ctx, opts));
    compare(stage, "staleCount", stale, await openDealAging.count(ctx, {
      namespace: tenantId,
      bounds: { lower: { key: [stage, Number.NEGATIVE_INFINITY], inclusive: true }, upper: { key: [stage, now - STALE_MS], inclusive: false } },
    }));
  }

  const expected = ranges.map(() => new Map<string, number>());
  const actual = ranges.map(() => new Map<string, number>());
  let cursor: string | null = null;
  const closedLost = db.query("opportunities")
    .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
      q.eq("tenantId", tenantId).eq("stage", "closed").eq("outcome", "lost"));
  while (true) {
    const page = await closedLost.paginate({ cursor, numItems: 200 });
    for (const deal of page.page) {
      if (deal.lostAt === undefined || !isPersonLoss(deal)) continue;
      const index = ranges.findIndex(({ start, end }) => deal.lostAt! >= start && deal.lostAt! < end);
      if (index < 0) continue;
      const actor = deal.lostByUserId ?? "";
      expected[index].set(actor, (expected[index].get(actor) ?? 0) + 1);
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  for (const [index, { start, end }] of ranges.entries()) {
    for await (const entry of personLosses.iter(ctx, {
      namespace: tenantId,
      bounds: { lower: { key: [start, ""], inclusive: true }, upper: { key: [end, ""], inclusive: false } },
      pageSize: 200,
    })) {
      const actor = entry.key[1];
      actual[index].set(actor, (actual[index].get(actor) ?? 0) + 1);
    }
    for (const actor of new Set([...expected[index].keys(), ...actual[index].keys()])) {
      compare(`${start}:${actor}`, "count", expected[index].get(actor) ?? 0, actual[index].get(actor) ?? 0);
    }
  }
  return differences;
}

/** Returns differences only. A complete snapshot, including every Closed-lost
 * deal, never the live report's capped sample. Run one month or all months. */
export const verifyPipelineHealthAggregates = internalQuery({
  args,
  returns: v.array(difference),
  handler: async (ctx, { tenantId, startDate, endDate }) => verify(ctx, tenantId, startDate, endDate),
});

/** Recompute the supplied verification range inside this transaction. A
 * caller cannot forge a clean result, reuse stale proof, or omit a month. */
export const markPipelineHealthAggregatesVerified = internalMutation({
  args,
  returns: v.null(),
  handler: async (ctx, { tenantId, startDate, endDate }) => {
    const now = new Date(Date.now());
    const requiredEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    if (startDate > FIRST_MONTH || endDate < requiredEnd) {
      throw new Error("Verification must include every month from 2026-04 through the current month");
    }
    const differences = await verify(ctx, tenantId, startDate, endDate);
    if (differences.length) throw new Error(`Pipeline health aggregate mismatch: ${JSON.stringify(differences)}`);
    await ctx.db.patch("tenants", tenantId, { pipelineHealthAggregatesVerifiedAt: Date.now() });
    return null;
  },
});
