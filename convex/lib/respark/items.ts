import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../../_generated/api";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { mergedLeadIds } from "../mergedLeads";
import { hasOpenDeal, resparkGroupFor } from "./state";
import { DAY_MS } from "./settings";
import type { ResparkBucket, ResparkGroup, ResparkResult } from "./validators";

// Batches, items and the hold (docs/plans/respark.md §3.2, §4.4, §4.5).

type ReadCtx = QueryCtx | MutationCtx;

// Resparks and not-a-fits per worker, for any range (plan §3.5). The table
// starts empty, so every write is strict from the start.
export const resparkResultsByWorker = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [Id<"leadGenWorkers">, ResparkResult | "pending", number];
  DataModel: DataModel;
  TableName: "resparkBatchItems";
}>(components.resparkResultsByWorker, {
  namespace: (item) => item.tenantId,
  sortKey: (item) => [item.workerId, item.result ?? "pending", item.workedAt ?? 0],
});

export async function insertResparkItem(
  ctx: MutationCtx,
  item: Omit<Doc<"resparkBatchItems">, "_id" | "_creationTime">,
): Promise<Id<"resparkBatchItems">> {
  const itemId = await ctx.db.insert("resparkBatchItems", item);
  await resparkResultsByWorker.insert(ctx, (await ctx.db.get("resparkBatchItems", itemId))!);
  return itemId;
}

/** Records what the lead generator did; an item is worked once. */
export async function workResparkItem(
  ctx: MutationCtx,
  item: Doc<"resparkBatchItems">,
  work: { result: ResparkResult; workedAt: number; eventId?: Id<"domainEvents"> },
): Promise<void> {
  await ctx.db.patch("resparkBatchItems", item._id, work);
  const after = (await ctx.db.get("resparkBatchItems", item._id))!;
  await resparkResultsByWorker.replace(ctx, item, after);
  // The batch is done when this was its last unworked person (a batch holds
  // at most 100).
  const batch = await ctx.db.get("resparkBatches", item.batchId);
  if (batch && batch.completedAt === undefined) {
    const items = await ctx.db
      .query("resparkBatchItems")
      .withIndex("by_batchId_and_position", (q) => q.eq("batchId", item.batchId))
      .take(batch.size);
    if (items.every((row) => row.result !== undefined)) {
      await ctx.db.patch("resparkBatches", batch._id, { completedAt: work.workedAt });
    }
  }
}

export const THIRTY_DAYS_MS = 30 * DAY_MS;

/**
 * One bucket's range on `by_tenantId_and_resparkGroup_and_lastTouchAt`, at
 * `now` with the inactive line at N days (plan §4.4). Each person is in the
 * first bucket they match, so bucket 3 holds `had_call` people past N days and
 * bucket 4 the rest of `had_call` past 30.
 */
export function bucketRange(
  bucket: ResparkBucket,
  now: number,
  inactiveAfterDays: number,
): { group: ResparkGroup; after?: number; atOrBefore: number } {
  const thirtyDaysAgo = now - THIRTY_DAYS_MS;
  const inactiveLine = now - inactiveAfterDays * DAY_MS;
  switch (bucket) {
    case 1:
      return { group: "qualified", atOrBefore: thirtyDaysAgo };
    case 2:
      return { group: "never_qualified", atOrBefore: thirtyDaysAgo };
    case 3:
      return { group: "had_call", atOrBefore: inactiveLine };
    case 4:
      return { group: "had_call", after: inactiveLine, atOrBefore: thirtyDaysAgo };
    case 5:
      return { group: "not_a_fit", atOrBefore: thirtyDaysAgo };
  }
}

// The groups that can be in the pool; `out` never is.
const POOL_GROUPS = ["qualified", "never_qualified", "had_call", "not_a_fit"] as const;

/**
 * The bucket a pool person is in, for the card's reason label: their group,
 * with `had_call` split at the inactive line (plan §4.4).
 */
export function bucketOf(
  group: (typeof POOL_GROUPS)[number],
  lastTouchAt: number,
  now: number,
  inactiveAfterDays: number,
): ResparkBucket {
  switch (group) {
    case "qualified":
      return 1;
    case "never_qualified":
      return 2;
    case "had_call":
      return lastTouchAt <= now - inactiveAfterDays * DAY_MS ? 3 : 4;
    case "not_a_fit":
      return 5;
  }
}

/**
 * A team's pool, oldest last touch first, whatever the bucket (changed by
 * the tenant admin on 2026-10-25, replacing bucket order and newest first). Each
 * group is read in index order from its oldest person, and the oldest of the
 * four heads comes next, so a claim reads only as far as it needs. Everyone
 * here was last touched at least 30 days ago.
 */
export async function* poolOldestFirst(
  ctx: ReadCtx,
  args: { tenantId: Id<"tenants">; teamId: Id<"attributionTeams">; now: number; inactiveAfterDays: number },
): AsyncGenerator<{ lead: Doc<"leads">; bucket: ResparkBucket }> {
  const atOrBefore = args.now - THIRTY_DAYS_MS;
  const streams = POOL_GROUPS.map((group) => ({
    group,
    rows: ctx.db
      .query("leads")
      .withIndex("by_tenantId_and_resparkTeamId_and_resparkGroup_and_lastTouchAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          // Only the claiming lead generator's team (2026-10-25).
          .eq("resparkTeamId", args.teamId)
          .eq("resparkGroup", group)
          // A missing time sorts below every number; such a person is `out`.
          .gte("lastTouch.occurredAt", 0)
          .lte("lastTouch.occurredAt", atOrBefore),
      )
      .order("asc")
      [Symbol.asyncIterator](),
  }));
  const heads = await Promise.all(streams.map((stream) => stream.rows.next()));
  for (;;) {
    let next = -1;
    for (const [index, head] of heads.entries()) {
      if (head.done) continue;
      const best = next === -1 ? null : heads[next];
      if (
        !best ||
        best.done ||
        head.value.lastTouch!.occurredAt < best.value.lastTouch!.occurredAt ||
        (head.value.lastTouch!.occurredAt === best.value.lastTouch!.occurredAt &&
          head.value._creationTime < best.value._creationTime)
      ) {
        next = index;
      }
    }
    if (next === -1) return;
    const lead = (heads[next] as IteratorResult<Doc<"leads">, undefined> & { done: false }).value;
    yield {
      lead,
      bucket: bucketOf(streams[next].group, lead.lastTouch!.occurredAt, args.now, args.inactiveAfterDays),
    };
    heads[next] = await streams[next].rows.next();
  }
}

// Skips of one person by different lead generators in one business day; past
// it the check fails closed and leaves the person out of the batch.
const SKIPS_PER_PERSON_DAY_LIMIT = 20;

/**
 * Whether the person is held now (an unworked item whose batch hasn't
 * expired), and whether `userId` skipped them in a batch still in its
 * business day. Reads only unworked and skipped items whose `heldUntil` is
 * ahead, which are exactly the items from the current business day, on the
 * person and on every lead merged into them (plan §4.5): items stay on the
 * person they were made for. A claim reads these ranges for each candidate
 * and writes into them, so two claims at once conflict and one retries.
 */
export async function holdState(
  ctx: ReadCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; userId: Id<"users">; now: number },
): Promise<{ held: boolean; skippedByUser: boolean; reads: number }> {
  const leadIds = await mergedLeadIds(ctx, args.tenantId, args.leadId);
  // The merge walk reads once per person; each person then costs two reads.
  let reads = leadIds.length;
  for (const leadId of leadIds) {
    reads += 1;
    const unworked = await ctx.db
      .query("resparkBatchItems")
      .withIndex("by_tenantId_and_leadId_and_result_and_heldUntil", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", leadId).eq("result", undefined).gt("heldUntil", args.now),
      )
      .first();
    if (unworked) return { held: true, skippedByUser: false, reads };
    reads += 1;
    const skips = await ctx.db
      .query("resparkBatchItems")
      .withIndex("by_tenantId_and_leadId_and_result_and_heldUntil", (q) =>
        q.eq("tenantId", args.tenantId).eq("leadId", leadId).eq("result", "skipped").gt("heldUntil", args.now),
      )
      .take(SKIPS_PER_PERSON_DAY_LIMIT + 1);
    if (skips.length > SKIPS_PER_PERSON_DAY_LIMIT || skips.some((item) => item.userId === args.userId)) {
      return { held: false, skippedByUser: true, reads };
    }
  }
  return { held: false, skippedByUser: false, reads };
}

/**
 * The person's earliest Resparked item, across every lead merged into them:
 * the only one that can set a stage time (plan §5.3).
 */
export async function firstResparkedItem(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"resparkBatchItems"> | null> {
  let first: Doc<"resparkBatchItems"> | null = null;
  for (const id of await mergedLeadIds(ctx, tenantId, leadId)) {
    const item = await ctx.db
      .query("resparkBatchItems")
      .withIndex("by_tenantId_and_leadId_and_result_and_workedAt", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", id).eq("result", "resparked"),
      )
      .first();
    if (item && (!first || (item.workedAt ?? 0) < (first.workedAt ?? 0))) first = item;
  }
  return first;
}

/**
 * The person's latest Resparked item worked in `(after, before)`, across
 * every lead merged into them: the respark that started a deal (plan §4.6).
 */
export async function latestResparkedItemBetween(
  ctx: ReadCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; after?: number; before: number },
): Promise<Doc<"resparkBatchItems"> | null> {
  let latest: Doc<"resparkBatchItems"> | null = null;
  for (const id of await mergedLeadIds(ctx, args.tenantId, args.leadId)) {
    const item = await ctx.db
      .query("resparkBatchItems")
      .withIndex("by_tenantId_and_leadId_and_result_and_workedAt", (q) => {
        const resparked = q.eq("tenantId", args.tenantId).eq("leadId", id).eq("result", "resparked");
        return args.after === undefined
          ? resparked.lt("workedAt", args.before)
          : resparked.gt("workedAt", args.after).lt("workedAt", args.before);
      })
      .order("desc")
      .first();
    if (item && (!latest || (item.workedAt ?? 0) > (latest.workedAt ?? 0))) latest = item;
  }
  return latest;
}

/**
 * The person's newest items, up to `limit`, across every lead merged into
 * them, for respark history. Newest hold first.
 */
export async function personResparkItems(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  limit = 50,
): Promise<Doc<"resparkBatchItems">[]> {
  const items: Doc<"resparkBatchItems">[] = [];
  for (const id of await mergedLeadIds(ctx, tenantId, leadId)) {
    items.push(
      ...(await ctx.db
        .query("resparkBatchItems")
        .withIndex("by_tenantId_and_leadId_and_heldUntil", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", id),
        )
        .order("desc")
        .take(limit)),
    );
  }
  return items
    .sort((a, b) => b.heldUntil - a.heldUntil || b._creationTime - a._creationTime)
    .slice(0, limit);
}

/**
 * Why the person can no longer be resparked or marked not a fit, or null
 * (plan §4.5, D6): they left the pool during the hold.
 */
export async function leftPoolReason(ctx: ReadCtx, lead: Doc<"leads"> | null): Promise<string | null> {
  if (!lead || lead.status === "merged") return "This person was merged into another record.";
  if (lead.lifecycleStage === "customer") return "This person became a customer.";
  if (lead.disposition === "do_not_contact") return "This person is marked do not contact.";
  const openDeal = await hasOpenDeal(ctx, lead.tenantId, lead._id);
  if (openDeal) return "This person has an open deal now.";
  return resparkGroupFor(lead, openDeal) === "out" ? "This person left the respark pool." : null;
}
