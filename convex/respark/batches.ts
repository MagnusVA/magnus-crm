import { contactAgainHolds, contactAgainWaitReason } from "../lib/contactAgain";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, type MutationCtx, type QueryCtx } from "../_generated/server";
import { businessDateForInstant, businessDayRange } from "../../lib/businessDay";
import { requireOperationalLeadGenWorker } from "../leadGen/capture";
import { emitDomainEvent } from "../lib/domainEvents";
import { advanceLeadLifecycle, resparkSetDisposition } from "../lib/leadLifecycle";
import { rejectRequest } from "../lib/observability/errors";
import { PERMISSIONS } from "../lib/permissions";
import {
  holdState,
  poolOldestFirst,
  insertResparkItem,
  leftPoolReason,
  workResparkItem,
} from "../lib/respark/items";
import { readResparkSettings } from "../lib/respark/settings";
import {
  LEAD_MARKED_NOT_A_FIT,
  LEAD_RESPARKED,
} from "../lib/respark/state";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import type { Provenance } from "../mcp/guard";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";

// Respark batches and the three actions (docs/plans/respark.md §4.5, §5.3).
// Every function takes the tenant, user and worker from the identity.

// A claim reads at most this many people across the buckets, held ones
// included, and stops at this many index reads, whichever comes first, and
// returns a shorter batch rather than read more (D9). A candidate costs its
// lead document and, per person merged into them as well, three index reads
// (the merge walk, an unworked item, today's skips of at most 21 items). The
// read budget leaves about 1,000 of Convex's 4,096 reads per transaction for
// the batch's writes, and 1,000 people stay well under 32,000 documents and
// 16 MiB.
export const CLAIM_READ_LIMIT = 1000;
export const CLAIM_INDEX_READ_BUDGET = 3000;

const RESPARK_ROLES = [...PERMISSIONS["lead-gen:respark"]];

/**
 * Ends a batch now: its unworked people go back to the pool, with nothing
 * recorded on them, as at the end of the business day.
 */
async function endBatchNow(ctx: MutationCtx, batch: Doc<"resparkBatches">, now: number): Promise<void> {
  const items = await ctx.db
    .query("resparkBatchItems")
    .withIndex("by_batchId_and_position", (q) => q.eq("batchId", batch._id))
    .take(batch.size);
  for (const item of items) {
    if (item.result === undefined) await ctx.db.patch("resparkBatchItems", item._id, { heldUntil: now });
  }
  await ctx.db.patch("resparkBatches", batch._id, { heldUntil: now });
}

/** The newest batch the user holds now that still has unworked people. */
async function openBatch(
  ctx: MutationCtx,
  access: TenantUserResult,
  now: number,
): Promise<Doc<"resparkBatches"> | null> {
  const latest = await ctx.db
    .query("resparkBatches")
    .withIndex("by_tenantId_and_userId_and_createdAt", (q) =>
      q.eq("tenantId", access.tenantId).eq("userId", access.userId),
    )
    .order("desc")
    .first();
  if (!latest || latest.heldUntil <= now) return null;
  const items = await ctx.db
    .query("resparkBatchItems")
    .withIndex("by_batchId_and_position", (q) => q.eq("batchId", latest._id))
    .take(latest.size);
  return items.some((item) => item.result === undefined) ? latest : null;
}

/**
 * Asking for a batch (plan §4.5). An unexpired batch with unworked people
 * comes back as it is. Otherwise the claim takes the lead generator's team's
 * pool oldest last touch first, whatever the bucket (`poolOldestFirst`), skipping people someone
 * holds and people this user skipped today, until the batch is full or it
 * has read `CLAIM_READ_LIMIT` people.
 * Two claims at once read the same hold ranges and write into them, so one
 * of them retries and sees the other's items.
 */
export const claimResparkBatch = mutation({
  args: {},
  // An empty pool creates no batch: `batchId` is null and `size` 0. A lead
  // generator with no team has no pool (`noTeam`).
  returns: v.object({
    batchId: v.union(v.id("resparkBatches"), v.null()),
    resumed: v.boolean(),
    size: v.number(),
    noTeam: v.optional(v.boolean()),
  }),
  handler: async (ctx) => {
    const access = await requireTenantUser(ctx, RESPARK_ROLES);
    const now = Date.now();
    const worker = await requireOperationalLeadGenWorker(ctx, access, now);
    const claim = await claimResparkBatchCore(ctx, access, worker, now);
    return {
      batchId: claim.batchId,
      resumed: claim.resumed,
      size: claim.size,
      ...(claim.noTeam && { noTeam: true }),
    };
  },
});

export type ResparkClaim = {
  batchId: Id<"resparkBatches"> | null;
  resumed: boolean;
  size: number;
  noTeam: boolean;
  /** When the batch's people go back to the pool; null with no batch. */
  heldUntil: number | null;
  /** A batch from another team's pool ended to make room for this one. */
  endedOtherTeamBatch: boolean;
};

/** The claim, for the web and for the agent. The caller resolves the worker. */
export async function claimResparkBatchCore(
  ctx: MutationCtx,
  access: TenantUserResult,
  worker: Doc<"leadGenWorkers">,
  now: number,
): Promise<ResparkClaim> {
  // The pool is the lead generator's team's (2026-10-25); no team, no pool.
  const teamId = worker.teamId;
  const existing = await openBatch(ctx, access, now);
  if (existing && teamId && existing.teamId === teamId) {
    return {
      batchId: existing._id,
      resumed: true,
      size: existing.size,
      noTeam: false,
      heldUntil: existing.heldUntil,
      endedOtherTeamBatch: false,
    };
  }
  // A batch from another team's pool, or from before team pools, ends.
  if (existing) await endBatchNow(ctx, existing, now);
  const endedOtherTeamBatch = existing !== null;
  const none = { batchId: null, resumed: false, size: 0, heldUntil: null, endedOtherTeamBatch };
  if (!teamId) return { ...none, noTeam: true };

  const tenant = await ctx.db.get("tenants", access.tenantId);
  if (!tenant) throw new Error(`Missing tenant ${access.tenantId}`);
  const settings = readResparkSettings(tenant);
  const businessDay = await getTenantBusinessDay(ctx, access.tenantId);
  const heldUntil = businessDayRange(businessDateForInstant(now, businessDay), businessDay).end;

  const picked: { lead: Doc<"leads">; bucket: number }[] = [];
  let read = 0;
  let indexReads = 0;
  const full = () =>
    picked.length >= settings.batchSize || read >= CLAIM_READ_LIMIT || indexReads >= CLAIM_INDEX_READ_BUDGET;
  // One index read per pool group, then the hold checks per candidate.
  indexReads += 4;
  for await (const { lead, bucket } of poolOldestFirst(ctx, {
    tenantId: access.tenantId,
    teamId,
    now,
    inactiveAfterDays: settings.inactiveAfterDays,
  })) {
    read += 1;
    if (contactAgainHolds(lead, now)) {
      if (full()) break;
      continue;
    }
    const hold = await holdState(ctx, {
      tenantId: access.tenantId,
      leadId: lead._id,
      userId: access.userId,
      now,
    });
    indexReads += hold.reads;
    if (!hold.held && !hold.skippedByUser) picked.push({ lead, bucket });
    if (full()) break;
  }

  if (picked.length === 0) return { ...none, noTeam: false };
  const batchId = await ctx.db.insert("resparkBatches", {
    tenantId: access.tenantId,
    userId: access.userId,
    workerId: worker._id,
    createdAt: now,
    heldUntil,
    size: picked.length,
    requestedSize: settings.batchSize,
    teamId,
  });
  for (const [position, { lead, bucket }] of picked.entries()) {
    await insertResparkItem(ctx, {
      tenantId: access.tenantId,
      batchId,
      leadId: lead._id,
      userId: access.userId,
      workerId: worker._id,
      position,
      bucket,
      heldUntil,
    });
  }
  return { batchId, resumed: false, size: picked.length, noTeam: false, heldUntil, endedOtherTeamBatch };
}

/** The caller's unworked item in an unexpired batch, or a rejection. */
async function workableItem(
  ctx: MutationCtx,
  access: TenantUserResult,
  itemId: Id<"resparkBatchItems">,
  now: number,
): Promise<Doc<"resparkBatchItems">> {
  const item = await ctx.db.get("resparkBatchItems", itemId);
  if (!item || item.tenantId !== access.tenantId || item.userId !== access.userId) {
    throw rejectRequest("respark.item_not_found", "This person isn't in your batch.", {
      tenantId: access.tenantId,
      userId: access.userId,
      itemId,
    });
  }
  if (item.result !== undefined) {
    throw rejectRequest("respark.item_worked", "This person was already worked in this batch.", {
      tenantId: access.tenantId,
      itemId,
    });
  }
  if (item.heldUntil <= now) {
    throw rejectRequest("respark.batch_expired", "This batch ended with the business day.", {
      tenantId: access.tenantId,
      itemId,
    });
  }
  return item;
}

/** Why a held person can't be resparked or marked now, or null. */
export async function resparkLeftPoolReason(
  ctx: QueryCtx | MutationCtx,
  item: Doc<"resparkBatchItems">,
  worker: Doc<"leadGenWorkers">,
): Promise<string | null> {
  const lead = await ctx.db.get("leads", item.leadId);
  // A merge or a voided capture can move a held person to another team.
  return (
    (await leftPoolReason(ctx, lead)) ??
    (lead && worker.teamId && lead.resparkTeamId === worker.teamId
      ? null
      : "This person is now in another team's pool.")
  );
}

async function requirePersonInPool(
  ctx: MutationCtx,
  item: Doc<"resparkBatchItems">,
  worker: Doc<"leadGenWorkers">,
): Promise<void> {
  const reason = await resparkLeftPoolReason(ctx, item, worker);
  if (reason) {
    throw rejectRequest("respark.person_left_pool", `${reason} Skip them instead.`, {
      tenantId: item.tenantId,
      itemId: item._id,
      leadId: item.leadId,
    });
  }
}

async function emitResparkTouch(
  ctx: MutationCtx,
  access: TenantUserResult,
  item: Doc<"resparkBatchItems">,
  eventType: typeof LEAD_RESPARKED | typeof LEAD_MARKED_NOT_A_FIT,
  now: number,
  provenance: Provenance,
): Promise<Id<"domainEvents">> {
  return await emitDomainEvent(ctx, {
    tenantId: access.tenantId,
    entityType: "lead",
    entityId: item.leadId,
    eventType,
    source: "pipeline",
    actorUserId: access.userId,
    metadata: {
      itemId: item._id,
      batchId: item.batchId,
      bucket: item.bucket,
      ...(provenance.via === "mcp" && { via: "mcp", agentClient: provenance.agentClient }),
    },
    occurredAt: now,
    leadId: item.leadId,
  });
}

/** The three results a held person can get. */
export type ResparkMark = "resparked" | "not_a_fit" | "skipped";

/**
 * Records one result on the caller's held item, for the web and for the
 * agent's list (plan §5.3, §4.5). The caller resolves the worker.
 *
 * Resparked: a `lead.resparked` touch, a not a fit reopened to Open, and In
 * conversation if the person is behind it. Credit comes later, when the
 * person gets a deal (§4.6). Not a fit: a `lead.marked_not_a_fit` touch, and
 * the disposition, unless an admin set the current one. Skipped: back in the
 * pool for everyone else, and not offered to this user again until the
 * business day ends; it writes nothing on the person.
 */
export async function markResparkItemCore(
  ctx: MutationCtx,
  access: TenantUserResult,
  worker: Doc<"leadGenWorkers">,
  args: { itemId: Id<"resparkBatchItems">; result: ResparkMark },
  now: number,
  provenance: Provenance = { via: "web" },
): Promise<void> {
  const item = await workableItem(ctx, access, args.itemId, now);
  if (args.result === "skipped") {
    await workResparkItem(ctx, item, { result: "skipped", workedAt: now });
    return;
  }
  await requirePersonInPool(ctx, item, worker);
  if (args.result === "resparked") {
    const person = await ctx.db.get("leads", item.leadId);
    if (person && contactAgainHolds(person, now)) {
      throw rejectRequest("respark.contact_again", contactAgainWaitReason(person)!);
    }
    const eventId = await emitResparkTouch(ctx, access, item, LEAD_RESPARKED, now, provenance);
    // The item is the stage evidence, so it is worked before the stage moves.
    await workResparkItem(ctx, item, { result: "resparked", workedAt: now, eventId });
    const lead = (await ctx.db.get("leads", item.leadId))!;
    await resparkSetDisposition(ctx, lead, "open", { actorUserId: access.userId, at: now });
    await advanceLeadLifecycle(ctx, item.leadId, { stage: "in_conversation", at: now, cause: "respark" });
    return;
  }
  const eventId = await emitResparkTouch(ctx, access, item, LEAD_MARKED_NOT_A_FIT, now, provenance);
  await workResparkItem(ctx, item, { result: "not_a_fit", workedAt: now, eventId });
  const lead = (await ctx.db.get("leads", item.leadId))!;
  await resparkSetDisposition(ctx, lead, "not_a_fit", { actorUserId: access.userId, at: now });
}

async function markFromWeb(
  ctx: MutationCtx,
  access: TenantUserResult,
  itemId: Id<"resparkBatchItems">,
  result: ResparkMark,
) {
  const now = Date.now();
  // A lead generator whose lead gen access was turned off can't work on.
  const worker = await requireOperationalLeadGenWorker(ctx, access, now);
  await markResparkItemCore(ctx, access, worker, { itemId, result }, now);
  return null;
}

export const markResparked = mutation({
  args: { itemId: v.id("resparkBatchItems") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const access = await requireTenantUser(ctx, RESPARK_ROLES);
    return await markFromWeb(ctx, access, itemId, "resparked");
  },
});

export const markNotAFit = mutation({
  args: { itemId: v.id("resparkBatchItems") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const access = await requireTenantUser(ctx, RESPARK_ROLES);
    return await markFromWeb(ctx, access, itemId, "not_a_fit");
  },
});

export const skipResparkItem = mutation({
  args: { itemId: v.id("resparkBatchItems") },
  returns: v.null(),
  handler: async (ctx, { itemId }) => {
    const access = await requireTenantUser(ctx, RESPARK_ROLES);
    return await markFromWeb(ctx, access, itemId, "skipped");
  },
});
