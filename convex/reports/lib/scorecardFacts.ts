import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { LIFECYCLE_STAGES, type LifecycleStage } from "../../leads/lifecycle";
import { createLiveReadState, readLiveDocuments, readLiveQueryRows } from "../../lib/liveQueryBounds";
import { getTenantBusinessDay } from "../../lib/tenantBusinessDay";
import { leadStageEntries } from "../../reporting/aggregates";
import { resolveAnalyticsRange, type ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import { validateBusinessDay } from "../../../lib/businessDay";

export const scorecardRangeValidator = v.object({
  startDate: v.string(), endDateInclusive: v.string(), fromMs: v.number(), toMs: v.number(),
  timeZone: v.string(), dayStartHour: v.number(),
});
export type ScorecardFilters = { programId?: Id<"tenantPrograms"> | null };
export type LifecycleCounts = {
  stages: Record<LifecycleStage, number>;
  cohort: { entered: number; qualified: number; booked: number; showed: number; customer: number };
};
export type ScorecardFacts = {
  payments: Doc<"paymentRecords">[];
  deals: Doc<"opportunities">[];
  meetings: Doc<"meetings">[];
};
export const inRange = (at: number | undefined, range: ResolvedAnalyticsRange) =>
  at !== undefined && at >= range.fromMs && at < range.toMs;
export const emptyFacts = (): ScorecardFacts => ({ payments: [], deals: [], meetings: [] });
export const emptyLifecycle = (): LifecycleCounts => ({
  stages: Object.fromEntries(LIFECYCLE_STAGES.map(stage => [stage, 0])) as Record<LifecycleStage, number>,
  cohort: { entered: 0, qualified: 0, booked: 0, showed: 0, customer: 0 },
});
export function buildLifecycle(people: readonly Doc<"leads">[], range: ResolvedAnalyticsRange): LifecycleCounts {
  const result = emptyLifecycle();
  for (const person of people) {
    if (person.status === "merged" || person.mergedIntoLeadId) continue;
    const times = person.lifecycleStageEnteredAt;
    for (const stage of LIFECYCLE_STAGES) if (inRange(times[stage], range)) result.stages[stage]++;
    if (inRange(times.in_conversation, range)) {
      result.cohort.entered++;
      for (const stage of ["qualified", "booked", "showed", "customer"] as const) {
        if (times[stage] !== undefined) result.cohort[stage]++;
      }
    }
  }
  return result;
}

// Share a byte budget across source scans and joins, and reject partial answers.
export function liveReader() {
  const state = createLiveReadState();
  const checked = <T>(result: { rows: T[]; capped: boolean }) => {
    if (result.capped) throw new Error("Choose a shorter range");
    return result.rows;
  };
  return {
    rows: async <T>(source: AsyncIterable<T>, limit = 2500) => checked(await readLiveQueryRows(source, limit, state)),
    documents: async <K, T>(keys: readonly K[], load: (key: K) => Promise<T | null>) => checked(await readLiveDocuments(keys, load, state)),
  };
}
export type LiveReader = ReturnType<typeof liveReader>;

export async function assertScorecardRange(ctx: QueryCtx, tenantId: Id<"tenants">, range: ResolvedAnalyticsRange) {
  validateBusinessDay(range);
  const day = await getTenantBusinessDay(ctx, tenantId);
  const expected = resolveAnalyticsRange({ kind: "custom", startDate: range.startDate, endDateInclusive: range.endDateInclusive }, day, 0);
  if (range.timeZone !== day.timeZone || range.dayStartHour !== day.dayStartHour ||
    range.fromMs !== expected.fromMs || range.toMs !== expected.toMs) {
    throw new Error("Choose a valid business date range.");
  }
}

export async function loadScorecardFacts(
  ctx: QueryCtx, tenantId: Id<"tenants">, range: ResolvedAnalyticsRange,
  withMeetings: boolean, reader = liveReader(),
): Promise<ScorecardFacts> {
  const payments = await reader.rows(ctx.db.query("paymentRecords").withIndex("by_tenantId_and_recordedAt", q =>
    q.eq("tenantId", tenantId).gte("recordedAt", range.fromMs).lt("recordedAt", range.toMs)));
  // A first payment in this range gives a time-indexed candidate for a won deal.
  // Keep disputed candidates too; the builder applies cash's dispute exclusion.
  const deals = await reader.documents([...new Set(payments.flatMap(p => p.opportunityId ? [p.opportunityId] : []))],
    id => ctx.db.get("opportunities", id));
  let meetings: Doc<"meetings">[] = [];
  if (withMeetings) {
    const created = await reader.rows(ctx.db.query("meetings").withIndex("by_tenantId_and_createdAt", q =>
      q.eq("tenantId", tenantId).gte("createdAt", range.fromMs).lt("createdAt", range.toMs)));
    const scheduled = await reader.rows(ctx.db.query("meetings").withIndex("by_tenantId_and_scheduledAt", q =>
      q.eq("tenantId", tenantId).gte("scheduledAt", range.fromMs).lt("scheduledAt", range.toMs)));
    meetings = [...new Map([...created, ...scheduled].map(m => [m._id, m])).values()];
  }
  return { payments, deals: deals.filter(d => d.tenantId === tenantId), meetings };
}

export async function loadLifecycle(ctx: QueryCtx, tenantId: Id<"tenants">, range: ResolvedAnalyticsRange, reader = liveReader()) {
  const ids = new Set<Id<"leads">>();
  // Stage events use processing time, omit initial stages and same-stage time
  // corrections. The maintained aggregate indexes actual entry times and removes
  // merged people, so it also covers late evidence without scanning all people.
  for (const stage of LIFECYCLE_STAGES) {
    const page = await leadStageEntries.paginate(ctx, { namespace: tenantId, pageSize: 2501, bounds: {
      lower: { key: [stage, range.fromMs], inclusive: true },
      upper: { key: [stage, range.toMs], inclusive: false },
    } });
    if (!page.isDone || page.page.length > 2500) throw new Error("Choose a shorter range");
    for (const item of page.page) ids.add(item.id.slice(0, item.id.lastIndexOf(":")) as Id<"leads">);
  }
  const people = await reader.documents([...ids], id => ctx.db.get("leads", id));
  return buildLifecycle(people.filter(p => p.tenantId === tenantId), range);
}

export async function loadReminders(ctx: QueryCtx, tenantId: Id<"tenants">, range: ResolvedAnalyticsRange, reader = liveReader()) {
  const users = await reader.rows(ctx.db.query("users").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)), 500);
  const reminders: Doc<"followUps">[] = [];
  for (const user of users) for (const status of ["pending", "booked", "completed", "expired"] as const) {
    reminders.push(...await reader.rows(ctx.db.query("followUps").withIndex("by_tenantId_and_closerId_and_type_and_status_reminderScheduledAt", q =>
      q.eq("tenantId", tenantId).eq("closerId", user._id).eq("type", "manual_reminder").eq("status", status)
        .gte("reminderScheduledAt", range.fromMs).lt("reminderScheduledAt", range.toMs))));
  }
  return { reminders, users };
}

// Match analytics.form_answers, including configured contact labels.
export function privateAnswer(answer: string, label: string, contactLabels: readonly string[]) {
  return answer.trim() && (contactLabels.includes(label) || /[^@\s]+@[^@\s]+\.[A-Za-z]{2,}|[0-9](?:[ ().-]?[0-9]){6,}|(?:^|\s)@[A-Za-z0-9._]{2,}|(?:instagram\.com|tiktok\.com|facebook\.com|fb\.com|twitter\.com|x\.com\/|wa\.me|t\.me\/)/i.test(answer))
    ? "Hidden contact detail" : answer.trim();
}
export type AnswerFacts = {
  responses: Doc<"meetingFormResponses">[]; deals: Doc<"opportunities">[];
  heldDealIds: string[]; contactLabels: string[];
};
export async function loadAnswers(ctx: QueryCtx, tenantId: Id<"tenants">, range: ResolvedAnalyticsRange, filters: ScorecardFilters, fieldKey: string): Promise<AnswerFacts> {
  const reader = liveReader();
  const configs = await reader.rows(ctx.db.query("eventTypeConfigs").withIndex("by_tenantId", q => q.eq("tenantId", tenantId)), 500);
  const contactLabels = configs.flatMap(c => [c.customFieldMappings?.phoneField, c.customFieldMappings?.socialHandleField].filter((s): s is string => !!s));
  const bookings = await reader.rows(ctx.db.query("meetings").withIndex("by_tenantId_and_createdAt", q =>
    q.eq("tenantId", tenantId).gte("createdAt", range.fromMs).lt("createdAt", range.toMs)));
  const responses: Doc<"meetingFormResponses">[] = [];
  for (const meeting of bookings) {
    if (filters.programId && meeting.bookingProgramId !== filters.programId) continue;
    responses.push(...(await reader.rows(ctx.db.query("meetingFormResponses").withIndex("by_meetingId", q => q.eq("meetingId", meeting._id))))
      .filter(r => r.tenantId === tenantId && r.fieldKey === fieldKey));
  }
  // All deals of the answering people, including later deals, determine held/won now.
  const deals: Doc<"opportunities">[] = [];
  for (const id of new Set(responses.map(r => r.leadId))) {
    const person = await ctx.db.get("leads", id);
    if (!person || person.tenantId !== tenantId || person.status === "merged") continue;
    deals.push(...await reader.rows(ctx.db.query("opportunities").withIndex("by_tenantId_and_leadId", q => q.eq("tenantId", tenantId).eq("leadId", id))));
  }
  const heldDealIds: string[] = [];
  for (const deal of deals) {
    const held = await ctx.db.query("meetings").withIndex("by_opportunityId_and_status_and_scheduledAt", q =>
      q.eq("opportunityId", deal._id).eq("status", "held")).first();
    if (held?.tenantId === tenantId) heldDealIds.push(deal._id);
  }
  const validPeople = new Set(deals.map(d => d.leadId));
  return { responses: responses.filter(r => validPeople.has(r.leadId)), deals, heldDealIds, contactLabels };
}
