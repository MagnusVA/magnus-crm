import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../../_generated/api";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { mergedLeadIds } from "../mergedLeads";
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

// A person is in a few batches a day at most; one more than this means a
// runaway, and the check fails closed.
const ITEMS_PER_PERSON_DAY_LIMIT = 50;

/**
 * Whether the person is held now (an unworked item whose batch hasn't
 * expired), and whether `userId` skipped them in a batch still in its
 * business day. Reads the items whose `heldUntil` is still ahead, which are
 * exactly the items from the current business day. A claim reads this range
 * for each candidate and writes into it, so two claims at once conflict and
 * one retries (plan §4.5).
 */
export async function holdState(
  ctx: ReadCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; userId: Id<"users">; now: number },
): Promise<{ held: boolean; skippedByUser: boolean }> {
  const items = await ctx.db
    .query("resparkBatchItems")
    .withIndex("by_tenantId_and_leadId_and_heldUntil", (q) =>
      q.eq("tenantId", args.tenantId).eq("leadId", args.leadId).gt("heldUntil", args.now),
    )
    .take(ITEMS_PER_PERSON_DAY_LIMIT + 1);
  if (items.length > ITEMS_PER_PERSON_DAY_LIMIT) return { held: true, skippedByUser: true };
  return {
    held: items.some((item) => item.result === undefined),
    skippedByUser: items.some((item) => item.result === "skipped" && item.userId === args.userId),
  };
}

// Far above the resparks one person can have (one per 30 days at most).
const PERSON_ITEM_LIMIT = 200;

/**
 * The person's items, across every lead merged into them (plan §4.5): items
 * stay on the person they were made for. Newest hold first.
 */
export async function personResparkItems(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
): Promise<Doc<"resparkBatchItems">[]> {
  const items: Doc<"resparkBatchItems">[] = [];
  for (const id of await mergedLeadIds(ctx, tenantId, leadId)) {
    const page = await ctx.db
      .query("resparkBatchItems")
      .withIndex("by_tenantId_and_leadId_and_heldUntil", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", id),
      )
      .order("desc")
      .take(PERSON_ITEM_LIMIT + 1);
    items.push(...page);
    if (items.length > PERSON_ITEM_LIMIT) {
      throw new Error(`Lead ${leadId} has more than ${PERSON_ITEM_LIMIT} respark items`);
    }
  }
  return items.sort((a, b) => b.heldUntil - a.heldUntil || b._creationTime - a._creationTime);
}
