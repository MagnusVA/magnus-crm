/**
 * Reproduces three blocked production Calendly deliveries with sanitized
 * fixtures. Names, emails and IDs are fake; URI shapes, event ordering and
 * provider timestamps follow the production timeline.
 *
 * Incident A (2026-10-12): an invitee rescheduled a booking whose original
 * invitee.created was received on 2026-10-08 but never tracked. Calendly sent
 * invitee.canceled (rescheduled: true, new_invitee) and, three seconds later,
 * invitee.created (old_invitee). They blocked as `booking_not_tracked` and
 * `previous_booking_missing`. The host is a Calendly org member who is not
 * linked to any CRM user, so both follow-ups now block as `host_not_linked`,
 * the same outcome the original booking gets.
 *
 * Incident B (2026-10-09): a linked closer's booking was canceled. Its
 * invitee.created was received on 2026-10-07 under the legacy pipeline, never
 * produced a meeting, and was adopted as `legacy_delivery_requires_review`.
 * The cancellation blocked as `booking_not_tracked`.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, mapEventTypeToProgram } from "../../tests/bookingHarness";
import { adoptRawDelivery } from "./receipts";
import { writtenBesideStatus } from "../../tests/bookingRuleFixtures";
import { namedStatus } from "../../tests/stopStatusFixtures";
import { forceOpportunityState } from "../../tests/opportunityFixtures";
import { transitionOpportunity } from "../lib/opportunityActivity";

afterEach(() => vi.useRealTimers());

const CLOSER = {
  user: "https://api.calendly.com/users/closer",
  user_email: "closer@example.com",
  user_name: "Closer",
};
const UNLINKED_MEMBER = {
  user: "https://api.calendly.com/users/UNLINKEDHOST0001",
  user_email: "coach.unlinked@example.com",
  user_name: "Coach Unlinked",
};
const CRM_ADMIN = {
  user: "https://api.calendly.com/users/admin",
  user_email: "admin@example.com",
  user_name: "Admin",
};
type Host = typeof CLOSER;

const event = (id: string) => `https://api.calendly.com/scheduled_events/${id}`;
const invitee = (eventId: string, inviteeId: string) =>
  `${event(eventId)}/invitees/${inviteeId}`;

/** Shape of a Calendly invitee webhook payload (only fields the pipeline reads, plus reschedule links). */
const INCIDENT_EVENT_TYPE = "https://api.calendly.com/event_types/00000000-0000-4000-8000-0000000000e1";

function inviteePayload(args: {
  eventId: string;
  inviteeId: string;
  host: Host;
  email: string;
  name: string;
  start: string;
  end: string;
  canceled?: { at: string; rescheduledTo?: string };
  oldInvitee?: string;
}) {
  const canceled = args.canceled;
  return {
    uri: invitee(args.eventId, args.inviteeId),
    event: event(args.eventId),
    email: args.email,
    name: args.name,
    status: canceled ? "canceled" : "active",
    rescheduled: Boolean(canceled?.rescheduledTo),
    new_invitee: canceled?.rescheduledTo ?? null,
    old_invitee: args.oldInvitee ?? null,
    cancellation: canceled
      ? { canceled_by: args.name, canceler_type: "invitee", created_at: canceled.at, reason: "Schedule conflict" }
      : undefined,
    questions_and_answers: [{ question: "What problem do you want to solve?", answer: "Catch up", position: 0 }],
    tracking: { utm_campaign: null, utm_source: null, utm_medium: null, utm_content: null, utm_term: null },
    scheduled_event: {
      uri: event(args.eventId),
      event_type: INCIDENT_EVENT_TYPE,
      name: "Check In Call",
      status: canceled ? "canceled" : "active",
      start_time: args.start,
      end_time: args.end,
      event_memberships: [args.host],
    },
  };
}
type Payload = ReturnType<typeof inviteePayload>;
type EventType = "invitee.created" | "invitee.canceled" | "invitee_no_show.created" | "invitee_no_show.deleted";

async function setup() {
  vi.useFakeTimers();
  // Start before the incident timeline so the clock never runs backwards.
  vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  const harness = await bookingHarness();
  const { t, tenantId } = harness;
  await t.run(async (ctx) => {
    // A Calendly org member with no CRM user (production: calendlyRole "user", no matchedUserId).
    await ctx.db.insert("calendlyOrgMembers", {
      tenantId,
      calendlyUserUri: UNLINKED_MEMBER.user,
      calendlyRole: "user",
      email: UNLINKED_MEMBER.user_email,
      name: UNLINKED_MEMBER.user_name,
      lastSyncedAt: Date.parse("2026-10-01T00:00:00Z"),
    });
    const adminUser = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_admin")).unique();
    await ctx.db.patch("users", adminUser!._id, { calendlyUserUri: CRM_ADMIN.user });
    // The incident's event type is a program's sales call, so an unlinked host's booking is held.
    await mapEventTypeToProgram(ctx, tenantId, INCIDENT_EVENT_TYPE);
  });

  /** A live webhook: Calendly's envelope created_at is `createdAt`; we receive it ~0.6s later.
   * Workpool timers may have advanced the fake clock, so time only moves forward;
   * provider time (occurredAt) still comes from the envelope. */
  async function deliver(eventType: EventType, payload: Payload, createdAt: string) {
    vi.setSystemTime(Math.max(Date.now(), Date.parse(createdAt) + 600));
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ created_at: createdAt, event: eventType, payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  /** A raw row stored by the pre-Workpool pipeline, which never produced a meeting. */
  async function seedLegacyRaw(eventType: EventType, payload: Payload, createdAt: string, processed: boolean) {
    return await t.run((ctx) => ctx.db.insert("rawWebhookEvents", {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ created_at: createdAt, event: eventType, payload }),
      processed,
      receivedAt: Date.parse(createdAt) + 1000,
    }));
  }

  /** The rollout's `adoptWebhookDeliveryReceipts` migration (prod: 2026-10-09T07:18–07:19Z). */
  async function runReceiptAdoption(rawIds: Id<"rawWebhookEvents">[]) {
    vi.setSystemTime(Math.max(Date.now(), Date.parse("2026-10-09T07:19:00Z")));
    await t.run(async (ctx) => {
      for (const id of rawIds) await adoptRawDelivery(ctx, (await ctx.db.get("rawWebhookEvents", id))!);
    });
  }

  async function receipt(eventType: EventType, payload: Payload) {
    return await t.run(async (ctx) => {
      const rows = await ctx.db.query("webhookDeliveries")
        .withIndex("by_tenantId_and_receivedAt", (q) => q.eq("tenantId", tenantId)).take(100);
      const row = rows.find((r) => r.eventType === eventType && r.inviteeUri === payload.uri);
      if (!row) throw new Error(`No receipt for ${eventType} ${payload.uri}`);
      return row;
    });
  }

  async function meetingFor(payload: Payload) {
    return await t.run((ctx) => ctx.db.query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", tenantId).eq("calendlyEventUri", payload.scheduled_event.uri))
      .unique());
  }

  async function counts() {
    return await t.run(async (ctx) => ({
      meetings: (await ctx.db.query("meetings").take(100)).length,
      opportunities: (await ctx.db.query("opportunities").take(100)).length,
      leads: (await ctx.db.query("leads").take(100)).length,
    }));
  }

  async function retry(deliveryId: Id<"webhookDeliveries">) {
    const manifest = await harness.admin.query(api.pipeline.recovery.preview, { deliveryIds: [deliveryId] });
    await harness.admin.mutation(api.pipeline.recovery.retry, { manifest });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  return { ...harness, deliver, seedLegacyRaw, runReceiptAdoption, receipt, meetingFor, counts, retry };
}

// ---------------------------------------------------------------------------
// Incident A: Calendly reschedule of an untracked booking (unlinked host)
// ---------------------------------------------------------------------------

const LEAD_A = { email: "lead.alpha@example.com", name: "Lead Alpha" };
const A_OLD = { eventId: "11111111-aaaa-4aaa-8aaa-000000000001", inviteeId: "11111111-bbbb-4bbb-8bbb-000000000001" };
const A_NEW = { eventId: "22222222-aaaa-4aaa-8aaa-000000000002", inviteeId: "22222222-bbbb-4bbb-8bbb-000000000002" };

function incidentAPayloads(host: Host) {
  const original = inviteePayload({
    ...A_OLD, ...LEAD_A, host,
    start: "2026-10-15T19:30:00Z", end: "2026-10-15T20:00:00Z",
  });
  const canceled = inviteePayload({
    ...A_OLD, ...LEAD_A, host,
    start: "2026-10-15T19:30:00Z", end: "2026-10-15T20:00:00Z",
    canceled: { at: "2026-10-12T16:27:12.713Z", rescheduledTo: invitee(A_NEW.eventId, A_NEW.inviteeId) },
  });
  const replacement = inviteePayload({
    ...A_NEW, ...LEAD_A, host,
    start: "2026-10-16T17:00:00Z", end: "2026-10-16T17:30:00Z",
    oldInvitee: original.uri,
  });
  return { original, canceled, replacement };
}

it("incident A: the reschedule of a legacy, unlinked-host booking blocks as host_not_linked", async () => {
  const h = await setup();
  const { original, canceled, replacement } = incidentAPayloads(UNLINKED_MEMBER);

  // 2026-10-08T04:27:46Z: legacy pipeline stores invitee.created. Its host resolves to
  // org_member_unmatched, so the legacy handler dropped it without a lead or meeting.
  const legacyRaw = await h.seedLegacyRaw("invitee.created", original, "2026-10-08T04:27:44Z", true);
  // 2026-10-09T07:19Z: receipt adoption. processed=true without a matching meeting is not
  // proof of success, so the receipt is blocked for review and nothing is replayed.
  await h.runReceiptAdoption([legacyRaw]);
  expect(await h.receipt("invitee.created", original)).toMatchObject({
    generation: 0, status: "blocked", reason: "legacy_delivery_requires_review",
  });
  expect(await h.t.run((ctx) => ctx.db.get("rawWebhookEvents", legacyRaw))).toMatchObject({ processed: false });

  // 2026-10-12T16:27:13Z: Calendly reschedule, part 1: the old invitee is canceled.
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  // 2026-10-12T16:27:16Z: Calendly reschedule, part 2: the new invitee is created.
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");

  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({
    generation: 1, status: "blocked", reason: "host_not_linked",
  });
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({
    generation: 1, status: "blocked", reason: "host_not_linked",
  });
  // The cancellation is retained as a provider fact; nothing else was written.
  expect(await h.t.run((ctx) => ctx.db.query("calendlyBookingFacts").take(10))).toMatchObject([
    { eventUri: original.scheduled_event.uri, inviteeUri: original.uri, canceledAt: Date.parse("2026-10-12T16:27:13Z") },
  ]);
  expect(await h.counts()).toEqual({ meetings: 0, opportunities: 0, leads: 0 });

  // Manual recovery of the original cannot help: the current pipeline blocks the host.
  await h.retry((await h.receipt("invitee.created", original))._id);
  expect(await h.receipt("invitee.created", original)).toMatchObject({ status: "blocked", reason: "host_not_linked" });
  expect(await h.counts()).toEqual({ meetings: 0, opportunities: 0, leads: 0 });
});

it("incident A variant: the reschedule blocks like its original when the current pipeline saw the original", async () => {
  const h = await setup();
  const { original, canceled, replacement } = incidentAPayloads(UNLINKED_MEMBER);
  await h.deliver("invitee.created", original, "2026-10-08T04:27:44Z");
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");

  for (const [eventType, payload] of [
    ["invitee.created", original], ["invitee.canceled", canceled], ["invitee.created", replacement],
  ] as const) {
    const row = await h.receipt(eventType, payload);
    expect(row).toMatchObject({ status: "blocked", reason: "host_not_linked" });
    expect(await h.t.run((ctx) => ctx.db.get("rawWebhookEvents", row.rawEventId))).toMatchObject({ processed: false });
  }
  expect(await h.counts()).toEqual({ meetings: 0, opportunities: 0, leads: 0 });
});

it("control: the same reschedule of a tracked closer booking moves the opportunity to the new meeting", async () => {
  const h = await setup();
  const { original, canceled, replacement } = incidentAPayloads(CLOSER);
  await h.deliver("invitee.created", original, "2026-10-08T04:27:44Z");
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  const created = await h.receipt("invitee.created", original);
  // The cancel is flagged `rescheduled`, so it cancels the meeting and leaves
  // the deal scheduled (it used to pass the deal through canceled).
  expect(await h.t.run((ctx) => ctx.db.get("opportunities", created.opportunityId!))).toMatchObject({
    stage: "booked",
    outcome: "open",
  });
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");

  expect(created).toMatchObject({ status: "applied" });
  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({ status: "applied" });
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({
    status: "applied", opportunityId: created.opportunityId,
  });
  const oldMeeting = await h.meetingFor(original);
  const newMeeting = await h.meetingFor(replacement);
  expect(oldMeeting).toMatchObject({ status: "canceled" });
  expect(newMeeting).toMatchObject({
    status: "scheduled", opportunityId: created.opportunityId, rescheduledFromMeetingId: oldMeeting!._id,
  });
  expect(await h.t.run((ctx) => ctx.db.get("opportunities", created.opportunityId!))).toMatchObject({
    stage: "booked", outcome: "open", calendlyEventUri: replacement.scheduled_event.uri,
  });
  expect(await h.counts()).toEqual({ meetings: 2, opportunities: 1, leads: 1 });
});

// A follow-up of an untracked booking gets the outcome its host gives the original: a known
// non-closer host is ignored, not sent to the blocked review queue.
it("reschedule of an ignored non-closer booking is ignored, not blocked", async () => {
  const h = await setup();
  const { original, canceled, replacement } = incidentAPayloads(CRM_ADMIN);
  await h.deliver("invitee.created", original, "2026-10-08T04:27:44Z");
  expect(await h.receipt("invitee.created", original)).toMatchObject({ status: "ignored", reason: "non_closer_host" });
  const before = await h.counts();
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");
  for (const [eventType, payload] of [["invitee.canceled", canceled], ["invitee.created", replacement]] as const) {
    const row = await h.receipt(eventType, payload);
    expect(row).toMatchObject({ status: "ignored", reason: "non_closer_host" });
    expect(await h.t.run((ctx) => ctx.db.get("rawWebhookEvents", row.rawEventId))).toMatchObject({
      processed: true, processingReason: "non_closer_host",
    });
  }
  expect(await h.counts()).toEqual(before);
  expect(before).toMatchObject({ meetings: 0, opportunities: 0 });
});

it.each(["invitee.canceled", "invitee_no_show.created", "invitee_no_show.deleted"] as const)(
  "%s of an ignored non-closer booking is ignored, not blocked",
  async (eventType) => {
    const h = await setup();
    const { original, canceled } = incidentAPayloads(CRM_ADMIN);
    await h.deliver("invitee.created", original, "2026-10-08T04:27:44Z");
    await h.deliver(eventType, eventType === "invitee.canceled" ? canceled : original, "2026-10-12T16:27:13Z");
    const row = await h.receipt(eventType, original);
    expect(row).toMatchObject({ status: "ignored", reason: "non_closer_host" });
    expect(await h.t.run((ctx) => ctx.db.get("rawWebhookEvents", row.rawEventId))).toMatchObject({
      processed: true, processingReason: "non_closer_host",
    });
  },
);

it("an unlinked host's follow-up blocks as host_not_linked even when its original never arrived", async () => {
  const h = await setup();
  const { canceled, replacement } = incidentAPayloads(UNLINKED_MEMBER);
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");
  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({ status: "blocked", reason: "host_not_linked" });
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({ status: "blocked", reason: "host_not_linked" });
  expect(await h.counts()).toEqual({ meetings: 0, opportunities: 0, leads: 0 });
});

it("an inactive closer's follow-up of an untracked booking blocks like its original (host_inactive)", async () => {
  const h = await setup();
  await h.t.run(async (ctx) => {
    const closer = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique();
    await ctx.db.patch("users", closer!._id, { isActive: false });
  });
  const { canceled, replacement } = incidentAPayloads(CLOSER);
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");
  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({ status: "blocked", reason: "host_inactive" });
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({ status: "blocked", reason: "host_inactive" });
});

it("regression guard: a closer's reschedule of an untracked booking still blocks as a missing booking", async () => {
  const h = await setup();
  const { canceled, replacement } = incidentAPayloads(CLOSER);
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");
  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({ status: "blocked", reason: "booking_not_tracked" });
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({ status: "blocked", reason: "previous_booking_missing" });
  expect(await h.counts()).toEqual({ meetings: 0, opportunities: 0, leads: 0 });
});

it("linking an unlinked host and retrying the original settles its blocked cancellation", async () => {
  const h = await setup();
  const { original, canceled, replacement } = incidentAPayloads(UNLINKED_MEMBER);
  await h.deliver("invitee.created", original, "2026-10-08T04:27:44Z");
  await h.deliver("invitee.canceled", canceled, "2026-10-12T16:27:13Z");
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");
  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({ status: "blocked", reason: "host_not_linked" });

  // An admin links the Calendly member to the closer, then retries the original booking.
  await h.t.run(async (ctx) => {
    const closer = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique();
    const member = await ctx.db.query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", h.tenantId).eq("calendlyUserUri", UNLINKED_MEMBER.user)).unique();
    await ctx.db.patch("calendlyOrgMembers", member!._id, { matchedUserId: closer!._id });
  });
  await h.retry((await h.receipt("invitee.created", original))._id);
  const created = await h.receipt("invitee.created", original);
  expect(created).toMatchObject({ status: "applied" });
  expect(await h.receipt("invitee.canceled", canceled)).toMatchObject({ status: "applied", meetingId: created.meetingId });
  expect(await h.meetingFor(original)).toMatchObject({ status: "canceled" });

  await h.retry((await h.receipt("invitee.created", replacement))._id);
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({
    status: "applied", opportunityId: created.opportunityId,
  });
});

it("a non-closer booking's early cancellation settles once the booking attaches to a follow-up", async () => {
  const h = await setup();
  // A tracked closer booking whose opportunity is waiting on a follow-up.
  const first = inviteePayload({
    ...A_OLD, ...LEAD_A, host: CLOSER, start: "2026-10-09T19:30:00Z", end: "2026-10-09T20:00:00Z",
  });
  await h.deliver("invitee.created", first, "2026-10-08T04:27:44Z");
  const { opportunityId } = await h.receipt("invitee.created", first);
  await h.t.run((ctx) => forceOpportunityState(ctx, opportunityId!, {
    status: "follow_up_scheduled", ...writtenBesideStatus("follow_up_scheduled", "calendly"),
    updatedAt: Date.parse("2026-10-09T21:00:00Z"),
  }));

  // The follow-up is booked on an admin's calendar and canceled; the cancel is processed first.
  const followUp = inviteePayload({
    ...A_NEW, ...LEAD_A, host: CRM_ADMIN, start: "2026-10-16T17:00:00Z", end: "2026-10-16T17:30:00Z",
  });
  const followUpCanceled = inviteePayload({
    ...A_NEW, ...LEAD_A, host: CRM_ADMIN, start: "2026-10-16T17:00:00Z", end: "2026-10-16T17:30:00Z",
    canceled: { at: "2026-10-12T16:27:13Z" },
  });
  await h.deliver("invitee.canceled", followUpCanceled, "2026-10-12T16:27:13Z");
  expect(await h.receipt("invitee.canceled", followUpCanceled)).toMatchObject({ status: "ignored", reason: "non_closer_host" });
  await h.deliver("invitee.created", followUp, "2026-10-12T16:00:00Z");

  const created = await h.receipt("invitee.created", followUp);
  expect(created).toMatchObject({ status: "applied", opportunityId });
  expect(await h.receipt("invitee.canceled", followUpCanceled)).toMatchObject({ status: "applied", meetingId: created.meetingId });
  expect(await h.meetingFor(followUp)).toMatchObject({ status: "canceled" });
});

// Desired behavior (not implemented): if the replacement is processed before its original
// (for example, the original was queued, failed, or retried later), applying the original
// should wake the `previous_booking_missing` replacement, as processor.ts already does for
// `booking_not_tracked` cancellations.
it.fails("desired: a replacement processed before its original is applied once the original lands", async () => {
  const h = await setup();
  const { original, replacement } = incidentAPayloads(CLOSER);
  await h.deliver("invitee.created", replacement, "2026-10-12T16:27:16Z");
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({ status: "blocked", reason: "previous_booking_missing" });
  await h.deliver("invitee.created", original, "2026-10-08T04:27:44Z");
  expect(await h.receipt("invitee.created", original)).toMatchObject({ status: "applied" });
  // Today: stays blocked previous_booking_missing until someone retries it.
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({ status: "applied" });
});

// ---------------------------------------------------------------------------
// Incident B: cancellation of a linked closer's booking lost by the legacy pipeline
// ---------------------------------------------------------------------------

const LEAD_B = { email: "lead.bravo@example.com", name: "Lead Bravo" };
const B1 = { eventId: "33333333-aaaa-4aaa-8aaa-000000000003", inviteeId: "33333333-bbbb-4bbb-8bbb-000000000003" };
const B2 = { eventId: "44444444-aaaa-4aaa-8aaa-000000000004", inviteeId: "44444444-bbbb-4bbb-8bbb-000000000004" };
const B3 = { eventId: "55555555-aaaa-4aaa-8aaa-000000000005", inviteeId: "55555555-bbbb-4bbb-8bbb-000000000005" };

function incidentBPayloads() {
  const slot = { start: "2026-10-06T13:00:00Z", end: "2026-10-06T13:45:00Z" };
  const b3Slot = { start: "2026-10-09T13:15:00Z", end: "2026-10-09T14:00:00Z" };
  return {
    // Tracked by the legacy pipeline: booked, then canceled by the invitee.
    tracked: inviteePayload({ ...B1, ...LEAD_B, host: CLOSER, ...slot }),
    trackedCanceled: inviteePayload({ ...B1, ...LEAD_B, host: CLOSER, ...slot, canceled: { at: "2026-10-05T22:48:54Z" } }),
    // Rebooked two minutes later, same slot, no reschedule link. Never applied by legacy.
    rebooked: inviteePayload({ ...B2, ...LEAD_B, host: CLOSER, ...slot }),
    // Booked again on 2026-10-07. Never applied by legacy.
    lost: inviteePayload({ ...B3, ...LEAD_B, host: CLOSER, ...b3Slot }),
    lostCanceled: inviteePayload({ ...B3, ...LEAD_B, host: CLOSER, ...b3Slot, canceled: { at: "2026-10-09T08:48:32Z" } }),
  };
}

it("incident B: reproduces the blocked cancellation of a legacy closer booking that never got a meeting", async () => {
  const h = await setup();
  const p = incidentBPayloads();
  // Legacy era, tracked history for the lead (an opportunity that ends canceled).
  await h.deliver("invitee.created", p.tracked, "2026-10-05T11:04:42Z");
  await h.deliver("invitee.canceled", p.trackedCanceled, "2026-10-05T22:48:55Z");
  const trackedOpportunityId = (await h.receipt("invitee.created", p.tracked)).opportunityId!;
  expect(await h.t.run((ctx) => ctx.db.get("opportunities", trackedOpportunityId))).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "canceled" });

  // Legacy era: two later bookings stored but never turned into meetings (unprocessed).
  const rebookedRaw = await h.seedLegacyRaw("invitee.created", p.rebooked, "2026-10-05T22:50:14Z", false);
  const lostRaw = await h.seedLegacyRaw("invitee.created", p.lost, "2026-10-07T11:42:36Z", false);
  await h.runReceiptAdoption([rebookedRaw, lostRaw]);
  for (const payload of [p.rebooked, p.lost])
    expect(await h.receipt("invitee.created", payload)).toMatchObject({
      generation: 0, status: "blocked", reason: "legacy_delivery_requires_review",
    });

  // 2026-10-09T08:48:34Z: the invitee cancels the lost booking.
  await h.deliver("invitee.canceled", p.lostCanceled, "2026-10-09T08:48:33Z");
  expect(await h.receipt("invitee.canceled", p.lostCanceled)).toMatchObject({
    generation: 1, status: "blocked", reason: "booking_not_tracked",
  });
  expect(await h.meetingFor(p.lost)).toBeNull();
  expect(await h.meetingFor(p.rebooked)).toBeNull();
  expect(await h.counts()).toEqual({ meetings: 1, opportunities: 1, leads: 1 });
});

it("incident B recovery: retrying the legacy creates applies them and settles the blocked cancellation", async () => {
  const h = await setup();
  const p = incidentBPayloads();
  await h.deliver("invitee.created", p.tracked, "2026-10-05T11:04:42Z");
  await h.deliver("invitee.canceled", p.trackedCanceled, "2026-10-05T22:48:55Z");
  const trackedOpportunityId = (await h.receipt("invitee.created", p.tracked)).opportunityId!;
  const rebookedRaw = await h.seedLegacyRaw("invitee.created", p.rebooked, "2026-10-05T22:50:14Z", false);
  const lostRaw = await h.seedLegacyRaw("invitee.created", p.lost, "2026-10-07T11:42:36Z", false);
  await h.runReceiptAdoption([rebookedRaw, lostRaw]);
  await h.deliver("invitee.canceled", p.lostCanceled, "2026-10-09T08:48:33Z");

  // Admin reviews and retries in provider order (as of 2026-10-13).
  vi.setSystemTime(Date.parse("2026-10-13T12:00:00Z"));
  await h.retry((await h.receipt("invitee.created", p.rebooked))._id);
  // The rebooking used to rejoin the canceled deal (the 14-day reschedule
  // join). A cancellation ends the deal now, so the rebooking is a new deal.
  const rebooked = await h.receipt("invitee.created", p.rebooked);
  expect(rebooked).toMatchObject({ status: "applied" });
  expect(rebooked.opportunityId).not.toBe(trackedOpportunityId);
  expect(await h.t.run((ctx) => ctx.db.get("opportunities", trackedOpportunityId))).toMatchObject({ stage: "closed", outcome: "lost", lostReason: "canceled" });
  await h.retry((await h.receipt("invitee.created", p.lost))._id);
  const lost = await h.receipt("invitee.created", p.lost);
  expect(lost).toMatchObject({ status: "applied" });

  // The stored cancellation fact is reconciled with the new meeting, and the blocked
  // cancel receipt is woken by processor.ts and settles as applied.
  expect(await h.meetingFor(p.lost)).toMatchObject({ status: "canceled", canceledAt: Date.parse("2026-10-09T08:48:33Z") });
  expect(await h.receipt("invitee.canceled", p.lostCanceled)).toMatchObject({ status: "applied", meetingId: lost.meetingId });
  expect(await h.meetingFor(p.rebooked)).toMatchObject({ status: "scheduled" });
});

// ---------------------------------------------------------------------------
// Incident C (2026-10-14): a person books a new slot, then cancels the old one
// ---------------------------------------------------------------------------
// The new booking was held (an identity conflict, since resolved) and retried
// after the old booking's cancel had closed its deal. A booking processed after
// a later change to the person's deals gets the outcome it would have had in
// arrival order, when the later change can't have affected it.

const LEAD_C = { email: "lead.charlie@example.com", name: "Lead Charlie" };
const C_OLD = { eventId: "55555555-aaaa-4aaa-8aaa-000000000005", inviteeId: "55555555-bbbb-4bbb-8bbb-000000000005" };
const C_NEW = { eventId: "66666666-aaaa-4aaa-8aaa-000000000006", inviteeId: "66666666-bbbb-4bbb-8bbb-000000000006" };
const C_LATER = { eventId: "77777777-aaaa-4aaa-8aaa-000000000007", inviteeId: "77777777-bbbb-4bbb-8bbb-000000000007" };

function incidentCPayloads() {
  const old = inviteePayload({
    ...C_OLD, ...LEAD_C, host: CLOSER, start: "2026-10-14T18:30:00Z", end: "2026-10-14T19:00:00Z",
  });
  const oldCanceled = inviteePayload({
    ...C_OLD, ...LEAD_C, host: CLOSER, start: "2026-10-14T18:30:00Z", end: "2026-10-14T19:00:00Z",
    canceled: { at: "2026-10-14T09:13:44Z" },
  });
  const rebooked = inviteePayload({
    ...C_NEW, ...LEAD_C, host: CLOSER, start: "2026-10-14T20:15:00Z", end: "2026-10-14T20:45:00Z",
  });
  return { old, oldCanceled, rebooked };
}

/** Each deal's status and the scheduled events of its meetings, order-free. */
async function dealShapes(h: Awaited<ReturnType<typeof setup>>) {
  return await h.t.run(async (ctx) => {
    const opportunities = await ctx.db.query("opportunities").take(10);
    const shapes = await Promise.all(opportunities.map(async (o) => ({
      status: await namedStatus(ctx, o._id),
      meetings: (await ctx.db.query("meetings").withIndex("by_opportunityId", (q) => q.eq("opportunityId", o._id)).take(10))
        .map((m) => `${m.calendlyEventUri}:${m.status}`).sort(),
    })));
    return shapes.sort((a, b) => a.meetings.join().localeCompare(b.meetings.join()));
  });
}

it.each(["in arrival order", "after the cancel"] as const)(
  "incident C: a new booking processed %s gets its own deal, and the old one stays canceled",
  async (order) => {
    const h = await setup();
    const { old, oldCanceled, rebooked } = incidentCPayloads();
    await h.deliver("invitee.created", old, "2026-10-14T01:00:23Z");
    if (order === "in arrival order") {
      await h.deliver("invitee.created", rebooked, "2026-10-14T09:13:23Z");
      await h.deliver("invitee.canceled", oldCanceled, "2026-10-14T09:13:44Z");
    } else {
      await h.deliver("invitee.canceled", oldCanceled, "2026-10-14T09:13:44Z");
      await h.deliver("invitee.created", rebooked, "2026-10-14T09:13:23Z");
    }
    expect(await h.receipt("invitee.created", rebooked)).toMatchObject({ status: "applied" });
    expect(await dealShapes(h)).toEqual([
      { status: "canceled", meetings: [`${old.scheduled_event.uri}:canceled`] },
      { status: "scheduled", meetings: [`${rebooked.scheduled_event.uri}:scheduled`] },
    ]);
    expect(await h.counts()).toEqual({ meetings: 2, opportunities: 2, leads: 1 });
  },
);

it("incident C: a late booking doesn't take a deal that became a follow-up after it", async () => {
  const h = await setup();
  const { old, rebooked } = incidentCPayloads();
  await h.deliver("invitee.created", old, "2026-10-14T01:00:23Z");
  const { opportunityId } = await h.receipt("invitee.created", old);
  // The closer schedules a follow-up on the old deal after the rebooking happened.
  const at = Date.parse("2026-10-14T10:00:00Z");
  vi.setSystemTime(Math.max(Date.now(), at));
  await h.t.run((ctx) => transitionOpportunity(ctx, opportunityId!, {
    to: { stage: "follow_up" }, source: "closer", occurredAt: at, fields: { updatedAt: at },
  }));
  await h.deliver("invitee.created", rebooked, "2026-10-14T09:13:23Z");
  const receipt = await h.receipt("invitee.created", rebooked);
  expect(receipt).toMatchObject({ status: "applied" });
  expect(receipt.opportunityId).not.toBe(opportunityId);
  expect(await dealShapes(h)).toEqual([
    { status: "follow_up_scheduled", meetings: [`${old.scheduled_event.uri}:scheduled`] },
    { status: "scheduled", meetings: [`${rebooked.scheduled_event.uri}:scheduled`] },
  ]);
});

it("incident C guard: a booking stays held when a deal it could have taken changed after it", async () => {
  const h = await setup();
  const { old, rebooked } = incidentCPayloads();
  const later = inviteePayload({
    ...C_LATER, ...LEAD_C, host: CLOSER, start: "2026-10-15T18:30:00Z", end: "2026-10-15T19:00:00Z",
  });
  // The old deal waits on a follow-up before the rebooking happens, so the
  // rebooking would have joined it. A later booking took the deal first.
  // (This guard used a canceled deal, which the 14-day reschedule join took.
  // No booking without a link joins a canceled deal now, so a follow-up deal
  // is the one it could have taken.)
  await h.deliver("invitee.created", old, "2026-10-14T01:00:23Z");
  const { opportunityId } = await h.receipt("invitee.created", old);
  const at = Date.parse("2026-10-14T05:00:00Z");
  vi.setSystemTime(Math.max(Date.now(), at));
  await h.t.run((ctx) => transitionOpportunity(ctx, opportunityId!, {
    to: { stage: "follow_up" }, source: "closer", occurredAt: at, fields: { updatedAt: at },
  }));
  await h.deliver("invitee.created", later, "2026-10-14T12:00:00Z");
  expect(await h.receipt("invitee.created", later)).toMatchObject({ status: "applied", opportunityId });
  await h.deliver("invitee.created", rebooked, "2026-10-14T09:13:23Z");
  expect(await h.receipt("invitee.created", rebooked)).toMatchObject({
    status: "blocked", reason: "historical_booking_requires_review",
  });
});

it("incident C guard: a provider reschedule stays held when its own deal changed after it", async () => {
  const h = await setup();
  const { old } = incidentCPayloads();
  const replacement = inviteePayload({
    ...C_NEW, ...LEAD_C, host: CLOSER, start: "2026-10-14T20:15:00Z", end: "2026-10-14T20:45:00Z",
    oldInvitee: old.uri,
  });
  await h.deliver("invitee.created", old, "2026-10-14T01:00:23Z");
  const { opportunityId } = await h.receipt("invitee.created", old);
  // A closer acts on the deal after the reschedule happened, before it's processed.
  await h.t.run((ctx) => forceOpportunityState(ctx, opportunityId!, {
    status: "scheduled", updatedAt: Date.parse("2026-10-14T10:00:00Z"),
  }));
  await h.deliver("invitee.created", replacement, "2026-10-14T09:13:23Z");
  expect(await h.receipt("invitee.created", replacement)).toMatchObject({
    status: "blocked", reason: "historical_booking_requires_review",
  });
});
