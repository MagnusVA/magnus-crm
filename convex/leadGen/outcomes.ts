import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { addBusinessDays, businessDateForInstant, businessDayStart } from "../../lib/businessDay";
import { LIFECYCLE_STAGES, lifecycleStageValidator, type LifecycleStage } from "../leads/lifecycle";
import { visibleContactAgain } from "../lib/contactAgain";
import { createLiveReadState, LIVE_QUERY_BYTE_BUDGET, readLiveDocuments, readLiveQueryRows } from "../lib/liveQueryBounds";
import { rejectRequest } from "../lib/observability/errors";
import { countProspectConversions, decodeProspectConversionEntryId, prospectConversionStages } from "../lib/prospectConversions";
import { McpProjectionBudget, mcpPersonTextValidator } from "../lib/respark/mcp";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { prospectConversions } from "../reporting/aggregates";
import { stableJson } from "../mcp/confirm";
import { resolveLeadGenRange, type LeadGenRangeArgs } from "../mcp/leadGenShared";
import { formatLocal } from "../mcp/time";
import { requireOwnLeadGenWorker, type LeadGenAssistantCaller } from "./assistantAccess";
import { loadStaffRedactor, type SafeNoteResult } from "./assistantText";

const nullableString = v.union(v.string(), v.null());
const safeNoteFields = { note: v.union(mcpPersonTextValidator, v.null()), withheld: v.union(v.literal("staff_roster_too_large"), v.null()) };
export const outcomesResultValidator = v.object({
  asOf: v.string(), timeZone: v.string(), startDate: v.string(), endDate: v.string(), stage: lifecycleStageValidator,
  counts: v.object({ prospect: v.number(), in_conversation: v.number(), qualified: v.number(), booked: v.number(), showed: v.number(), customer: v.number() }),
  people: v.array(v.object({
    prospectId: v.id("leadGenProspects"), handle: v.string(), stage: lifecycleStageValidator, capturedAt: v.string(), historyPartial: v.boolean(),
    noShows: v.array(v.object({ date: v.string(), category: v.union(v.literal("no_response"), v.literal("late_cancel"), v.literal("technical_issues"), v.literal("other"), v.null()), ...safeNoteFields })),
    contactAgain: v.union(v.object({ date: v.string(), at: v.string(), ...safeNoteFields }), v.null()),
  })),
  cursor: nullableString, isPartial: v.boolean(), textTruncated: v.boolean(),
});

/** Read the same cohort membership as the conversions report, then authorize every join. */
export async function readMyOutcomesCore(
  ctx: QueryCtx,
  caller: LeadGenAssistantCaller & { timeZone: string },
  args: LeadGenRangeArgs & { stage?: LifecycleStage; cursor?: string },
) {
  const worker = await requireOwnLeadGenWorker(ctx, caller);
  const setting = await getTenantBusinessDay(ctx, caller.tenantId);
  const tenant = await ctx.db.get("tenants", caller.tenantId);
  const now = Date.now();
  const range = resolveLeadGenRange(args, businessDateForInstant(now, setting));
  const stage = args.stage ?? "prospect";
  const startAt = businessDayStart(range.startDayKey, setting);
  const endAt = businessDayStart(addBusinessDays(range.endDayKey, 1), setting);
  const binding = { version: 1, tenantId: caller.tenantId, userId: caller.userId, workerId: worker._id,
    startAt, endAt, stage, setting, businessDayVersion: tenant?.businessDayVersion ?? 0 };
  let nativeCursor: string | undefined;
  if (args.cursor) {
    try {
      const decoded = JSON.parse(args.cursor);
      if (stableJson(decoded.binding) !== stableJson(binding) || typeof decoded.cursor !== "string") throw new Error();
      nativeCursor = decoded.cursor;
    } catch {
      throw rejectRequest("outcomes.invalid_cursor", "Use a cursor from your outcomes for this range and stage.");
    }
  }
  const counts = { prospect: 0, in_conversation: 0, qualified: 0, booked: 0, showed: 0, customer: 0 };
  for (const key of LIFECYCLE_STAGES) counts[key] = await countProspectConversions(ctx, caller.tenantId, worker._id, key, startAt, endAt);
  const page = await prospectConversions.paginate(ctx, { namespace: caller.tenantId,
    bounds: { lower: { key: [worker._id, stage, startAt], inclusive: true }, upper: { key: [worker._id, stage, endAt], inclusive: false } },
    pageSize: 25, cursor: nativeCursor });
  const state = createLiveReadState();
  const hydrated: { prospect: Doc<"leadGenProspects">; lead: Doc<"leads"> }[] = [];
  const badEntry = () => rejectRequest("outcomes.stale_entry", "These outcomes need to be refreshed. Ask an admin to check the conversions report.");
  // Hydrate the entire cohort page before optional history, so its cursor never skips a person.
  for (const entry of page.page) {
    const decoded = decodeProspectConversionEntryId(entry.id);
    const id = decoded && ctx.db.normalizeId("leadGenProspects", decoded.prospectId);
    if (!id || decoded?.stage !== stage) throw badEntry();
    const { rows: [prospect] } = await readLiveDocuments([id], id => ctx.db.get("leadGenProspects", id), state);
    if (!prospect || prospect.tenantId !== caller.tenantId || prospect.firstCapturedByWorkerId !== worker._id ||
        prospect.firstCapturedAt < startAt || prospect.firstCapturedAt >= endAt ||
        stableJson(entry.key) !== stableJson([worker._id, stage, prospect.firstCapturedAt])) throw badEntry();
    const { rows: [lead] } = await readLiveDocuments([prospect.leadId], id => ctx.db.get("leads", id), state);
    if (!lead || lead.tenantId !== caller.tenantId || lead.status === "merged" || !prospectConversionStages(prospect, lead).includes(stage)) throw badEntry();
    hydrated.push({ prospect, lead });
  }
  const redactor = await loadStaffRedactor(ctx, caller.tenantId);
  const budget = new McpProjectionBudget(hydrated.length);
  // JSON escapes control characters to six bytes. Charge that encoded size
  // as well as the shared text budget, keeping the whole response below 64 KiB.
  let jsonTextBytesLeft = 24_000;
  const projectedText = (value: string) => {
    const projected = budget.text(value);
    let result = "";
    for (const char of projected) {
      const size = new TextEncoder().encode(JSON.stringify(char)).byteLength - 2;
      if (size > jsonTextBytesLeft) break;
      jsonTextBytesLeft -= size;
      result += char;
    }
    budget.isPartial ||= result !== projected;
    budget.textTruncated ||= result !== projected;
    return result;
  };
  const handles = new Map(hydrated.map(({ prospect }) => [prospect._id, projectedText(prospect.normalizedHandle)]));
  const safeNote = (value: string | undefined, lead: Doc<"leads">): SafeNoteResult | { note: null; withheld: null } => {
    if (!value) return { note: null, withheld: null };
    const safe = redactor.safeNote(value, [lead]);
    if (!safe.note) return safe;
    const text = projectedText(safe.note.text);
    const truncated = safe.note.truncated || text !== safe.note.text;
    budget.textTruncated ||= truncated;
    return { note: { ...safe.note, text, truncated }, withheld: null };
  };
  // A local row sentinel marks only that history as partial. It must not
  // exhaust the shared byte budget or hide the rows already read.
  const readHistory = async <T>(query: AsyncIterable<T>, limit: number) => {
    const local = { ...state };
    const result = await readLiveQueryRows(query, limit, local);
    state.bytesRead = local.bytesRead;
    state.capped = state.bytesRead > LIVE_QUERY_BYTE_BUDGET;
    return result;
  };
  let noShowsLeft = 25;
  const historyCache = new Map<string, { calls: Doc<"meetings">[]; partial: boolean }>();
  const people = [];
  for (const { prospect, lead } of hydrated) {
    let history = historyCache.get(`${lead._id}:${prospect.firstCapturedAt}`);
    if (!history) {
      const deals = state.capped ? { rows: [], capped: true } : await readHistory(ctx.db.query("opportunities")
        .withIndex("by_tenantId_and_leadId_and_createdAt", q => q.eq("tenantId", caller.tenantId).eq("leadId", lead._id)).order("desc"), 10);
      let partial = deals.capped;
      const calls: Doc<"meetings">[] = [];
      for (const deal of deals.rows) {
        if (state.capped) { partial = true; break; }
        if (deal.tenantId !== caller.tenantId || deal.leadId !== lead._id) throw badEntry();
        const read = await readHistory(ctx.db.query("meetings")
          .withIndex("by_opportunityId_and_status_and_scheduledAt", q => q.eq("opportunityId", deal._id).eq("status", "no_show")
            .gte("scheduledAt", prospect.firstCapturedAt)).order("desc"), 3);
        partial ||= read.capped;
        for (const call of read.rows) {
          if (call.tenantId !== caller.tenantId || call.opportunityId !== deal._id) throw badEntry();
          calls.push(call);
        }
      }
      calls.sort((a, b) => b.scheduledAt - a.scheduledAt || b._id.localeCompare(a._id));
      history = { calls: calls.slice(0, 3), partial: partial || calls.length > 3 };
      historyCache.set(`${lead._id}:${prospect.firstCapturedAt}`, history);
    }
    const shown = budget.take(history.calls, noShowsLeft);
    noShowsLeft -= shown.length;
    const contact = visibleContactAgain(lead);
    people.push({ prospectId: prospect._id, handle: handles.get(prospect._id)!, stage: lead.lifecycleStage,
      capturedAt: formatLocal(prospect.firstCapturedAt, caller.timeZone), historyPartial: history.partial || shown.length < history.calls.length,
      noShows: shown.map(call => ({ date: formatLocal(call.scheduledAt, caller.timeZone), category: call.noShowReason ?? null, ...safeNote(call.noShowNote, lead) })),
      contactAgain: contact ? { date: contact.date, at: formatLocal(contact.at, caller.timeZone), ...safeNote(contact.note, lead) } : null });
  }
  return { asOf: formatLocal(now, caller.timeZone), timeZone: caller.timeZone, startDate: range.startDayKey, endDate: range.endDayKey, stage, counts, people,
    cursor: page.isDone ? null : JSON.stringify({ binding, cursor: page.cursor }),
    isPartial: !page.isDone || state.capped || budget.isPartial || people.some(person => person.historyPartial), textTruncated: budget.textTruncated };
}
