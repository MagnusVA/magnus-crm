import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { timelineEventLabel } from "../../leadCustomers/timeline";
import { mergedLeadIds } from "../mergedLeads";
import { createLiveReadState, LIVE_QUERY_BYTE_BUDGET, readLiveDocuments, readLiveQueryRows, type LiveReadState } from "../liveQueryBounds";
import { getString, isRecord } from "../payloadExtraction";
import { isLastTouchEvent } from "./state";

// All person reads share a byte budget. A capped response explicitly says
// older history exists; no query silently presents a truncated history as all.
export const PANEL_EVENT_LIMIT = 500;
export const PERSON_DEAL_LIMIT = 100;
export const PERSON_NOTE_LIMIT = 100;
export const PERSON_CALL_LIMIT = 100;

/** A row cap in one section must not prevent reading the other sections. */
export async function readPersonRows<T>(rows: AsyncIterable<T>, limit: number, budget: LiveReadState) {
  const state = { bytesRead: budget.bytesRead, capped: budget.capped };
  const read = await readLiveQueryRows(rows, limit, state);
  budget.bytesRead = state.bytesRead;
  budget.capped = state.bytesRead > LIVE_QUERY_BYTE_BUDGET;
  return read;
}

export function instagramHandle(lead: Doc<"leads">) {
  return lead.socialHandles?.find((entry) => entry.type === "instagram")?.handle ?? null;
}

export function eventIsTouch(event: Doc<"domainEvents">) {
  let metadataSource: unknown;
  try {
    const metadata: unknown = JSON.parse(event.metadata ?? "{}");
    metadataSource = isRecord(metadata) ? metadata.source : undefined;
  } catch { /* Older events may have no usable metadata. */ }
  return isLastTouchEvent({ ...event, metadataSource });
}

export function touchSummary(event: Doc<"domainEvents">) {
  return { eventId: event._id, eventType: event.eventType,
    label: timelineEventLabel(event.eventType), occurredAt: event.occurredAt };
}

export async function personEvents(
  ctx: QueryCtx, tenantId: Id<"tenants">, ids: Id<"leads">[], limit: number,
  state: LiveReadState,
) {
  const events: Doc<"domainEvents">[] = [];
  let capped = false;
  for (const leadId of ids) {
    const read = await readPersonRows(ctx.db.query("domainEvents")
      .withIndex("by_tenantId_and_leadId_and_occurredAt", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId)).order("desc"), limit, state);
    events.push(...read.rows);
    capped ||= read.capped;
    if (state.capped) break;
  }
  events.sort((a, b) => b.occurredAt - a.occurredAt || b._creationTime - a._creationTime);
  return { events: events.slice(0, limit), capped: capped || events.length > limit };
}

/** Time zone exists only in a retained booking payload, never on the person. */
export async function bookingTimeZone(
  ctx: QueryCtx, meeting: Doc<"meetings">, state = createLiveReadState(),
) {
  const deliveries = await readPersonRows(ctx.db.query("webhookDeliveries")
    .withIndex("by_tenantId_and_inviteeUri_and_status", (q) => q
      .eq("tenantId", meeting.tenantId).eq("inviteeUri", meeting.calendlyInviteeUri)
      .eq("status", "applied")).order("desc"), 10, state);
  for (const delivery of deliveries.rows) {
    if (delivery.eventType !== "invitee.created" || (delivery.meetingId !== undefined && delivery.meetingId !== meeting._id)) continue;
    const { rows: [raw] } = await readLiveDocuments(
      [delivery.rawEventId], (id) => ctx.db.get("rawWebhookEvents", id), state,
    );
    if (!raw || raw.tenantId !== meeting.tenantId) continue;
    try {
      const envelope: unknown = JSON.parse(raw.payload);
      if (isRecord(envelope) && isRecord(envelope.payload)) {
        const zone = getString(envelope.payload, "timezone");
        if (zone) return zone;
      }
    } catch { /* Retention or a malformed old payload means no time zone. */ }
  }
  return null;
}

export async function personCard(ctx: QueryCtx, lead: Doc<"leads">, state = createLiveReadState()) {
  const ids = await mergedLeadIds(ctx, lead.tenantId, lead._id);
  const captures: Doc<"leadGenProspects">[] = [];
  const deals: Doc<"opportunities">[] = [];
  let capped = false;
  for (const leadId of ids) {
    const read = await readPersonRows(ctx.db.query("leadGenProspects")
      .withIndex("by_tenantId_and_leadId", (q) => q.eq("tenantId", lead.tenantId).eq("leadId", leadId)), 20, state);
    captures.push(...read.rows);
    capped ||= read.capped;
    const dealRead = await readPersonRows(ctx.db.query("opportunities")
      .withIndex("by_tenantId_and_leadId_and_createdAt", (q) =>
        q.eq("tenantId", lead.tenantId).eq("leadId", leadId)).order("desc"), 10, state);
    deals.push(...dealRead.rows);
    capped ||= dealRead.capped;
    if (state.capped) break;
  }
  const capture = captures.sort((a, b) => a.firstCapturedAt - b.firstCapturedAt)[0];
  const worker = capture ? await ctx.db.get("leadGenWorkers", capture.firstCapturedByWorkerId) : null;
  const newestDeal = deals.sort((a, b) => b.createdAt - a.createdAt)[0];
  let timeZone: string | null = null;
  // Older bookings may be the only ones that supplied a time zone.
  for (const deal of deals) {
    if (state.capped) break;
    const calls = await readPersonRows(ctx.db.query("meetings")
      .withIndex("by_opportunityId_and_scheduledAt", (q) => q.eq("opportunityId", deal._id))
      .order("desc"), 10, state);
    capped ||= calls.capped;
    for (const call of calls.rows) {
      if (call.tenantId === lead.tenantId) timeZone = await bookingTimeZone(ctx, call, state);
      if (timeZone) break;
    }
    if (timeZone) break;
  }
  const history = await personEvents(ctx, lead.tenantId, ids, 40, state);
  return {
    handle: instagramHandle(lead), stage: lead.lifecycleStage, disposition: lead.disposition,
    capturedAt: capture?.firstCapturedAt ?? null,
    capturedBy: worker?.tenantId === lead.tenantId ? worker.displayName ?? "Lead generator" : null,
    qualifiedAt: lead.lifecycleStageEnteredAt.qualified ?? null,
    newestDeal: newestDeal ? { opportunityId: newestDeal._id, stage: newestDeal.stage,
      outcome: newestDeal.outcome, lostReason: newestDeal.lostReason ?? null,
      createdAt: newestDeal.createdAt } : null,
    timeZone,
    lastTouches: history.events.filter(eventIsTouch).slice(0, 3).map(touchSummary),
    capped: capped || history.capped,
  };
}

export function maskEmail(value: string | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  return at > 0 ? `${value[0]}•••${value.slice(at)}` : "•••";
}

export function maskPhone(value: string | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4) return "•••";
  // Keep the country prefix when it can be separated from a national number.
  const prefix = value.trim().startsWith("+") && digits.length > 10
    ? `+${digits.slice(0, digits.length - 8)} ` : "";
  return `${prefix}••• ••${digits.slice(-2)}`;
}

/** Notes and booking answers can also repeat contact details. Mask those too. */
export function maskContactText(text: string, people: Doc<"leads">[]) {
  for (const person of people) {
    for (const [value, masked] of [[person.email, maskEmail(person.email)], [person.phone, maskPhone(person.phone)]]) {
      if (value && masked) text = text.split(value).join(masked);
    }
  }
  return text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => maskEmail(email)!)
    .replace(/\+?\d[\d ().-]{5,}\d/g, (phone) => maskPhone(phone)!);
}
