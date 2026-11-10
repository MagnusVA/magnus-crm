import { loadStaffRedactor } from "../../leadGen/assistantText";
import { contactAgainViewValidator, type ContactAgainView } from "../../leadGen/contactAgain";
import { v } from "convex/values";
import { internalQuery } from "../../_generated/server";
import { getOwnLeadGenProfile, leadGenProfileValidator } from "../../leadGen/activity";
import { dispositionValidator, lifecycleStageValidator } from "../../leads/lifecycle";
import { createLiveReadState } from "../../lib/liveQueryBounds";
import { rejectRequest } from "../../lib/observability/errors";
import { McpProjectionBudget, mcpPersonTextValidator } from "../../lib/respark/mcp";
import { resparkResultValidator } from "../../lib/respark/validators";
import { dealOutcomeValidator, dealStageValidator } from "../../opportunities/stages";
import { getHeldResparkBatchCore, getResparkPersonPanelCore, resparkBatchCardCore } from "../../respark/queries";
import { LEAD_GEN_ROLES, mcpCallerValidator, requireMcpUser } from "../guard";
import { progressValidator } from "./leadGenToday";
import { formatLocal } from "../time";

const contactAgainMcpValidator = v.union(v.object({ date: v.string(), at: v.string(),
  note: contactAgainViewValidator.fields.note, withheldReason: contactAgainViewValidator.fields.withheldReason }), v.null());
function contactAgainMcp(saved: ContactAgainView | null, timeZone: string, budget: McpProjectionBudget) {
  if (!saved) return null;
  budget.textTruncated ||= saved.note?.truncated ?? false;
  const note = saved.note ? budget.personText(saved.note.text) : null;
  return { ...saved, at: formatLocal(saved.at, timeZone),
    note: note ? { ...note, truncated: note.truncated || saved.note!.truncated } : null };
}

const nullableString = v.union(v.string(), v.null());
const text = v.union(mcpPersonTextValidator, v.null());
const resultValidator = v.union(resparkResultValidator, v.null());
const touchValidator = v.object({ eventId: v.id("domainEvents"), eventType: v.string(), label: v.string(), occurredAt: v.string() });
const cardValidator = v.object({ itemId: v.id("resparkBatchItems"), bucket: v.number(), result: resultValidator,
  contactAgain: contactAgainMcpValidator, resparkBlockedReason: nullableString,
  handle: nullableString, stage: v.union(lifecycleStageValidator, v.null()), disposition: v.union(dispositionValidator, v.null()),
  capturedAt: nullableString, capturedBy: v.union(v.literal("you"), v.literal("a teammate"), v.null()),
  newestDealOutcome: v.union(dealOutcomeValidator, v.null()), lastTouches: v.array(touchValidator), blockedReason: nullableString });
export const resparkBatchArgs = { cursor: v.optional(v.string()) };

export const batch = internalQuery({
  args: { caller: mcpCallerValidator, ...resparkBatchArgs },
  returns: v.object({ profile: leadGenProfileValidator, asOf: v.string(), isPartial: v.boolean(), textTruncated: v.boolean(),
    batchId: v.union(v.id("resparkBatches"), v.null()), progress: v.union(progressValidator, v.null()), heldUntil: nullableString,
    items: v.array(cardValidator), cursor: nullableString }),
  handler: async (ctx, { caller, cursor }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    const { profile } = await getOwnLeadGenProfile(ctx, me);
    const budget = new McpProjectionBudget();
    if (profile.team) profile.team.name = budget.text(profile.team.name);
    const empty = { profile, asOf: formatLocal(Date.now(), me.timeZone), isPartial: false, textTruncated: budget.textTruncated,
      batchId: null, progress: null, heldUntil: null, items: [], cursor: null };
    if (profile.status !== "active" || profile.noTeam) return empty;
    const held = await getHeldResparkBatchCore(ctx, me);
    if (!held) {
      if (cursor) throw rejectRequest("respark.expired_cursor", "That batch is no longer held. Read your batch again.");
      return empty;
    }
    let nativeCursor: string | null = null;
    if (cursor) {
      try {
        const decoded: unknown = JSON.parse(cursor);
        if (!decoded || typeof decoded !== "object" || !("batchId" in decoded) || decoded.batchId !== held.batch._id ||
          !("userId" in decoded) || decoded.userId !== me.userId || !("tenantId" in decoded) || decoded.tenantId !== me.tenantId ||
          !("cursor" in decoded) || typeof decoded.cursor !== "string") throw new Error("foreign cursor");
        nativeCursor = decoded.cursor;
      } catch { throw rejectRequest("respark.invalid_cursor", "Use a cursor from your current held batch."); }
    }
    // Page the item index before doing any person/history hydration.
    const page = await ctx.db.query("resparkBatchItems")
      .withIndex("by_batchId_and_position", q => q.eq("batchId", held.batch._id))
      .paginate({ cursor: nativeCursor, numItems: 25 });
    const projection = new McpProjectionBudget(page.page.length);
    const touchLimit = Math.min(3, Math.floor((50 - page.page.length) / Math.max(1, page.page.length)));
    const state = createLiveReadState();
    const redactor = await loadStaffRedactor(ctx, me.tenantId);
    const items = [];
    for (const item of page.page) {
      const card = await resparkBatchCardCore(ctx, me, held.batch.teamId!, item, state, true, redactor);
      const person = card.person;
      const capturedBy = person?.capturedBy === "you" ? "you" as const : person?.capturedBy === "a teammate" ? "a teammate" as const : null;
      items.push({ itemId: item._id, bucket: item.bucket, result: card.result,
        contactAgain: contactAgainMcp(person?.contactAgain ?? null, me.timeZone, projection), resparkBlockedReason: card.resparkBlockedReason,
        handle: person?.handle ? projection.text(person.handle, { mask: false }) : null, stage: person?.stage ?? null,
        disposition: person?.disposition ?? null, capturedAt: person?.capturedAt == null ? null : formatLocal(person.capturedAt, me.timeZone), capturedBy,
        newestDealOutcome: person?.newestDeal?.outcome ?? null,
        lastTouches: projection.take(person?.lastTouches ?? [], touchLimit).map(touch => ({ ...touch, occurredAt: formatLocal(touch.occurredAt, me.timeZone), eventType: projection.text(touch.eventType), label: projection.text(touch.label) })),
        blockedReason: card.blockedReason ? projection.text(card.blockedReason) : null });
      projection.isPartial ||= person?.capped ?? false;
    }
    return { profile, asOf: formatLocal(Date.now(), me.timeZone), batchId: held.batch._id, progress: held.progress, heldUntil: formatLocal(held.batch.heldUntil, me.timeZone),
      items, cursor: page.isDone ? null : JSON.stringify({ batchId: held.batch._id, userId: me.userId, tenantId: me.tenantId, cursor: page.continueCursor }),
      isPartial: !page.isDone || state.capped || projection.isPartial, textTruncated: budget.textTruncated || projection.textTruncated };
  },
});

const panelValidator = v.object({ contactAgain: contactAgainMcpValidator, resparkBlockedReason: nullableString, handle: nullableString, stage: lifecycleStageValidator, disposition: dispositionValidator,
  dispositionReason: text, identity: v.object({ name: text, phone: nullableString, email: nullableString }), timeZone: nullableString,
  timeline: v.array(touchValidator), deals: v.array(v.object({ opportunityId: v.id("opportunities"), stage: dealStageValidator,
    outcome: dealOutcomeValidator, lostReason: text, createdAt: v.string() })),
  calls: v.array(v.object({ meetingId: v.id("meetings"), opportunityId: v.id("opportunities"), scheduledAt: v.string(),
    durationMinutes: v.number(), status: v.union(v.literal("scheduled"), v.literal("held"), v.literal("canceled"), v.literal("no_show")),
    bookingAnswers: v.array(v.object({ question: mcpPersonTextValidator, answer: mcpPersonTextValidator })) })),
  notes: v.array(v.object({ noteId: v.id("leadNotes"), content: mcpPersonTextValidator, createdAt: v.string() })),
  resparkHistory: v.array(v.object({ itemId: v.id("resparkBatchItems"), result: resultValidator, workedAt: nullableString, bucket: v.number() })) });
export const resparkPersonArgs = { itemIds: v.array(v.id("resparkBatchItems")) };

export const person = internalQuery({
  args: { caller: mcpCallerValidator, ...resparkPersonArgs },
  returns: v.object({ profile: leadGenProfileValidator, asOf: v.string(), isPartial: v.boolean(), textTruncated: v.boolean(),
    people: v.array(v.object({ itemId: v.id("resparkBatchItems"), panel: v.union(panelValidator, v.null()) })) }),
  handler: async (ctx, { caller, itemIds }) => {
    const me = await requireMcpUser(ctx, caller, LEAD_GEN_ROLES);
    if (itemIds.length < 1 || itemIds.length > 5) throw rejectRequest("respark.item_limit", "Pass 1 to 5 itemIds from your held batch.");
    const { profile } = await getOwnLeadGenProfile(ctx, me);
    const budget = new McpProjectionBudget(itemIds.length);
    if (profile.team) profile.team.name = budget.text(profile.team.name);
    const redactor = await loadStaffRedactor(ctx, me.tenantId);
    // Notes, disposition reasons and loss reasons are written by staff, so
    // they can name a closer or an amount: the same redaction as a no-show note.
    const staffText = (value: string) => {
      const safe = redactor.safeNote(value);
      if (!safe.note) return { text: "[withheld]", personSupplied: true as const, truncated: true };
      const projected = budget.personText(safe.note.text, { mask: false });
      if (safe.note.truncated) budget.textTruncated = budget.isPartial = true;
      return { ...projected, truncated: projected.truncated || safe.note.truncated };
    };
    const people = [];
    const limit = Math.max(1, Math.floor((50 - itemIds.length) / itemIds.length / 8));
    for (const itemId of itemIds) {
      const panel = profile.status === "active" && !profile.noTeam ? await getResparkPersonPanelCore(ctx, me, itemId, redactor) : null;
      if (!panel) { people.push({ itemId, panel: null }); continue; }
      budget.isPartial ||= panel.capped;
      // Give each section space before taking nested booking answers.
      const timeline = budget.take(panel.timeline, limit).map(touch => ({ ...touch, occurredAt: formatLocal(touch.occurredAt, me.timeZone), eventType: budget.text(touch.eventType), label: budget.text(touch.label) }));
      const deals = budget.take(panel.deals, limit);
      const calls = budget.take(panel.calls, limit);
      const notes = budget.take(panel.notes, limit);
      const resparkHistory = budget.take(panel.resparkHistory, limit);
      people.push({ itemId, panel: {
        contactAgain: contactAgainMcp(panel.contactAgain, me.timeZone, budget), resparkBlockedReason: panel.resparkBlockedReason,
        handle: panel.handle ? budget.text(panel.handle, { mask: false }) : null, stage: panel.stage, disposition: panel.disposition,
        dispositionReason: panel.dispositionReason ? staffText(panel.dispositionReason) : null,
        identity: { name: panel.identity.name ? budget.personText(panel.identity.name) : null,
          phone: panel.identity.phone ? budget.text(panel.identity.phone) : null, email: panel.identity.email ? budget.text(panel.identity.email) : null },
        timeZone: panel.timeZone ? budget.text(panel.timeZone, { mask: false }) : null, timeline,
        deals: deals.map(deal => ({ ...deal, createdAt: formatLocal(deal.createdAt, me.timeZone), lostReason: deal.lostReason ? staffText(deal.lostReason) : null })),
        calls: calls.map(call => ({ ...call, scheduledAt: formatLocal(call.scheduledAt, me.timeZone), bookingAnswers: budget.take(call.bookingAnswers, limit).map(answer => ({
          question: budget.personText(answer.question), answer: budget.personText(answer.answer) })) })),
        notes: notes.map(note => ({ ...note, createdAt: formatLocal(note.createdAt, me.timeZone), content: staffText(note.content) })),
        resparkHistory: resparkHistory.map(entry => ({ ...entry,
          workedAt: entry.workedAt === null ? null : formatLocal(entry.workedAt, me.timeZone) })),
      } });
    }
    return { profile, asOf: formatLocal(Date.now(), me.timeZone), people, isPartial: budget.isPartial, textTruncated: budget.textTruncated };
  },
});
