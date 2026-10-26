import { v } from "convex/values";
import { businessDateForInstant, businessDayRange } from "../../lib/businessDay";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { requireTenantUser, type TenantUserResult } from "../requireTenantUser";
import { expectedError } from "../lib/observability/errors";
import { PERMISSIONS } from "../lib/permissions";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { bucketRange, leftPoolReason, personResparkItems, resparkResultsByWorker } from "../lib/respark/items";
import { readResparkSettings } from "../lib/respark/settings";
import { resparkTeamPool } from "../lib/respark/state";
import { RESPARK_BUCKETS } from "../lib/respark/validators";
import { mergedLeadIds } from "../lib/mergedLeads";
import { createLiveReadState } from "../lib/liveQueryBounds";
import {
  bookingTimeZone, instagramHandle, maskContactText, maskEmail, maskPhone, personCard,
  personEvents, readPersonRows, touchSummary, PANEL_EVENT_LIMIT, PERSON_CALL_LIMIT, PERSON_DEAL_LIMIT, PERSON_NOTE_LIMIT,
} from "../lib/respark/people";
import { batchValidator, panelValidator } from "../lib/respark/queryValidators";

/**
 * A lead generator whose lead gen access was turned off can't read their
 * batch, as the actions can't work it. Admins work through a worker profile
 * the claim creates, so only lead generators are checked. Read only.
 */
async function requireActiveLeadGenWorker(ctx: QueryCtx, access: TenantUserResult) {
  const worker = await ctx.db.query("leadGenWorkers")
    .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", access.tenantId).eq("userId", access.userId))
    .unique();
  if (access.role === "lead_generator" && !worker?.isActive) {
    throw expectedError("lead_gen.inactive_worker", "Lead Gen Ops access is not active for this user");
  }
  return worker;
}

export const getMyResparkBatch = query({
  args: {},
  returns: v.union(v.null(), batchValidator),
  handler: async (ctx) => {
    const access = await requireTenantUser(ctx, [...PERMISSIONS["lead-gen:respark"]]);
    const worker = await requireActiveLeadGenWorker(ctx, access);
    const { tenantId, userId } = access;
    const now = Date.now();
    const batch = await ctx.db.query("resparkBatches")
      .withIndex("by_tenantId_and_userId_and_createdAt", (q) => q.eq("tenantId", tenantId).eq("userId", userId))
      .order("desc").first();
    if (!batch || batch.heldUntil <= now) return null;
    // Only a batch from the caller's team's pool; asking for a batch ends any other.
    const teamId = worker?.teamId;
    if (!teamId || batch.teamId !== teamId) return null;
    const items = await ctx.db.query("resparkBatchItems")
      .withIndex("by_batchId_and_position", (q) => q.eq("batchId", batch._id)).take(100);
    const state = createLiveReadState();
    const cards = [];
    for (const item of items) {
      if (item.tenantId !== tenantId || item.userId !== userId) throw new Error("Respark item ownership mismatch");
      const lead = await ctx.db.get("leads", item.leadId);
      const person = lead?.tenantId === tenantId ? lead : null;
      cards.push({ itemId: item._id, position: item.position, bucket: item.bucket,
        result: item.result ?? null, workedAt: item.workedAt ?? null,
        person: person ? await personCard(ctx, person, state) : null,
        blockedReason: (await leftPoolReason(ctx, person)) ??
          (person?.resparkTeamId === teamId ? null : "This person is now in another team's pool.") });
    }
    return { batchId: batch._id, heldUntil: batch.heldUntil, size: batch.size,
      createdAt: batch.createdAt, items: cards, capped: state.capped || cards.some((card) => card.person?.capped) };
  },
});

export const getResparkPoolCounts = query({
  args: {},
  returns: v.object({ buckets: v.array(v.object({ bucket: v.number(), count: v.number() })),
    batchSize: v.number(), heldUntil: v.number(), noTeam: v.boolean() }),
  handler: async (ctx) => {
    const access = await requireTenantUser(ctx, [...PERMISSIONS["lead-gen:respark"]]);
    const worker = await requireActiveLeadGenWorker(ctx, access);
    const { tenantId } = access;
    // The caller's team's pool (2026-10-25); no team, no pool.
    const teamId = worker?.teamId;
    const now = Date.now();
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw new Error(`Missing tenant ${tenantId}`);
    const settings = readResparkSettings(tenant);
    const businessDay = await getTenantBusinessDay(ctx, tenantId);
    const counts = teamId ? await resparkTeamPool.countBatch(ctx, RESPARK_BUCKETS.map((bucket) => {
      const range = bucketRange(bucket, now, settings.inactiveAfterDays);
      type Key = [Id<"attributionTeams">, typeof range.group, number];
      return { namespace: tenantId, bounds: {
        lower: { key: [teamId, range.group, range.after ?? Number.NEGATIVE_INFINITY] as Key,
          inclusive: range.after === undefined },
        upper: { key: [teamId, range.group, range.atOrBefore] as Key, inclusive: true },
      } };
    })) : RESPARK_BUCKETS.map(() => 0);
    return { buckets: RESPARK_BUCKETS.map((bucket, index) => ({ bucket, count: counts[index] })),
      batchSize: settings.batchSize,
      heldUntil: businessDayRange(businessDateForInstant(now, businessDay), businessDay).end,
      noTeam: !teamId };
  },
});

export const getMyResparkToday = query({
  args: {},
  returns: v.object({ batchesDone: v.number(), resparks: v.number(), notAFits: v.number(),
    start: v.number(), end: v.number() }),
  handler: async (ctx) => {
    const access = await requireTenantUser(ctx, [...PERMISSIONS["lead-gen:respark"]]);
    await requireActiveLeadGenWorker(ctx, access);
    const { tenantId, userId } = access;
    const businessDay = await getTenantBusinessDay(ctx, tenantId);
    const { start, end } = businessDayRange(businessDateForInstant(Date.now(), businessDay), businessDay);
    const batches = await ctx.db.query("resparkBatches")
      .withIndex("by_tenantId_and_userId_and_createdAt", (q) => q.eq("tenantId", tenantId)
        .eq("userId", userId).gte("createdAt", start).lt("createdAt", end)).take(1001);
    // A runaway should fail visibly rather than report an approximate count.
    if (batches.length > 1000) throw new Error("More than 1000 respark batches in one business day");
    const worker = await ctx.db.query("leadGenWorkers")
      .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", tenantId).eq("userId", userId)).unique();
    const counts = worker ? await resparkResultsByWorker.countBatch(ctx,
      (["resparked", "not_a_fit"] as const).map((result) => ({ namespace: tenantId, bounds: {
        lower: { key: [worker._id, result, start], inclusive: true },
        upper: { key: [worker._id, result, end], inclusive: false },
      } }))) : [0, 0];
    // A batch is done when every person in it was worked (plan §6.1).
    const batchesDone = batches.filter((batch) => batch.completedAt !== undefined).length;
    return { batchesDone, resparks: counts[0], notAFits: counts[1], start, end };
  },
});

/** Missing, foreign and expired items all return null. Worked items remain readable. */
export const getResparkPersonPanel = query({
  args: { itemId: v.id("resparkBatchItems") },
  returns: v.union(v.null(), panelValidator),
  handler: async (ctx, { itemId }) => {
    const access = await requireTenantUser(ctx, [...PERMISSIONS["lead-gen:respark"]]);
    const worker = await requireActiveLeadGenWorker(ctx, access);
    const { tenantId, userId } = access;
    const item = await ctx.db.get("resparkBatchItems", itemId);
    if (!item || item.tenantId !== tenantId || item.userId !== userId) return null;
    const batch = await ctx.db.get("resparkBatches", item.batchId);
    if (!batch || batch.tenantId !== tenantId || batch.userId !== userId || batch.heldUntil <= Date.now()) return null;
    // Only people in the caller's team's pool, from a batch of that pool.
    const teamId = worker?.teamId;
    if (!teamId || batch.teamId !== teamId) return null;
    const lead = await ctx.db.get("leads", item.leadId);
    if (!lead || lead.tenantId !== tenantId || lead.resparkTeamId !== teamId) return null;
    const ids = await mergedLeadIds(ctx, tenantId, lead._id);
    const people: Doc<"leads">[] = [lead];
    for (const id of ids.slice(1)) {
      const person = await ctx.db.get("leads", id);
      if (person?.tenantId === tenantId) people.push(person);
    }
    const safe = (value: string) => maskContactText(value, people);
    const state = createLiveReadState();
    const history = await personEvents(ctx, tenantId, ids, PANEL_EVENT_LIMIT, state);
    let capped = history.capped;
    const deals: Doc<"opportunities">[] = [];
    const notes: Doc<"leadNotes">[] = [];
    for (const leadId of ids) {
      const dealRead = await readPersonRows(ctx.db.query("opportunities")
        .withIndex("by_tenantId_and_leadId_and_createdAt", (q) => q.eq("tenantId", tenantId)
          .eq("leadId", leadId)).order("desc"), Math.max(0, PERSON_DEAL_LIMIT - deals.length), state);
      deals.push(...dealRead.rows);
      const noteRead = await readPersonRows(ctx.db.query("leadNotes")
        .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", tenantId).eq("leadId", leadId))
        .order("desc"), Math.max(0, PERSON_NOTE_LIMIT - notes.length), state);
      notes.push(...noteRead.rows);
      capped ||= dealRead.capped || noteRead.capped;
      if (state.capped) break;
    }
    const calls: { meetingId: Doc<"meetings">["_id"]; opportunityId: Doc<"opportunities">["_id"];
      scheduledAt: number; durationMinutes: number; status: Doc<"meetings">["status"];
      bookingAnswers: { question: string; answer: string }[] }[] = [];
    let timeZone: string | null = null;
    for (const deal of deals.sort((a, b) => b.createdAt - a.createdAt)) {
      const read = await readPersonRows(ctx.db.query("meetings")
        .withIndex("by_opportunityId_and_scheduledAt", (q) => q.eq("opportunityId", deal._id))
        .order("desc"), Math.max(0, PERSON_CALL_LIMIT - calls.length), state);
      capped ||= read.capped;
      for (const call of read.rows) {
        if (call.tenantId !== tenantId) continue;
        const answers = await readPersonRows(ctx.db.query("meetingFormResponses")
          .withIndex("by_meetingId", (q) => q.eq("meetingId", call._id)), 100, state);
        capped ||= answers.capped;
        timeZone ??= await bookingTimeZone(ctx, call, state);
        calls.push({ meetingId: call._id, opportunityId: deal._id, scheduledAt: call.scheduledAt,
          durationMinutes: call.durationMinutes, status: call.status,
          bookingAnswers: answers.rows.filter((answer) => answer.tenantId === tenantId).map((answer) => ({
            question: safe(answer.questionLabelSnapshot), answer: safe(answer.answerText),
          })) });
      }
      if (state.capped) break;
    }
    const resparks = await personResparkItems(ctx, tenantId, lead._id);
    return {
      handle: safe(instagramHandle(lead) ?? "") || null,
      stage: lead.lifecycleStage, disposition: lead.disposition,
      dispositionReason: lead.dispositionReason ? safe(lead.dispositionReason) : null,
      identity: { name: lead.fullName ? safe(lead.fullName) : null,
        phone: maskPhone(lead.phone), email: maskEmail(lead.email) },
      timeZone: timeZone ? safe(timeZone) : null,
      timeline: history.events.filter((event) => event.entityType !== "payment" &&
        !event.eventType.startsWith("payment.")).map(touchSummary),
      deals: deals.map((deal) => ({ opportunityId: deal._id, stage: deal.stage, outcome: deal.outcome,
        lostReason: deal.lostReason ? safe(deal.lostReason) : null, createdAt: deal.createdAt })),
      calls,
      notes: notes.filter((note) => note.deletedAt === undefined).map((note) => ({ noteId: note._id,
        content: safe(note.content), createdAt: note.createdAt })),
      resparkHistory: resparks.map((entry) => ({ itemId: entry._id, result: entry.result ?? null,
        workedAt: entry.workedAt ?? null, bucket: entry.bucket })),
      capped: capped || state.capped,
    };
  },
});
