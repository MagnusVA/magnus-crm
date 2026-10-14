/**
 * Calendly group events, from a production `ambiguous_booking_identity` block
 * (2026-10-11).
 *
 * Shape preserved from prod, PII replaced:
 * - The event type is a Calendly `group` event ("Comeback Call", invitee limit 15)
 *   hosted by one closer. Every invitee joins the same scheduled event URI.
 * - Invitee A registered on day 0 and got the meeting. Invitee B, a different
 *   person, registered 10 days later. A is still active (counter 2 active / 2 total),
 *   so this is neither a cancel-and-rebook nor a reschedule.
 * - B's invitee.created blocked because the meeting belonged to A's invitee URI.
 *
 * Group events are not closers' sales calls, so every delivery of one is now
 * ignored as `group_event` and writes nothing. A registrant that already owns a
 * meeting from before this rule keeps it consistent.
 */
import { afterEach, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const EVENT_URI =
  "https://api.calendly.com/scheduled_events/group-comeback-call";
const EVENT_TYPE_URI = "https://api.calendly.com/event_types/comeback-call-group";
const INVITEE_A = `${EVENT_URI}/invitees/invitee-a`;
const INVITEE_B = `${EVENT_URI}/invitees/invitee-b`;
const EVENT_CREATED_AT = "2026-10-01T17:45:04.410998Z";
const B_CREATED_AT = "2026-10-11T02:14:51.256025Z";

type EventType = "invitee.created" | "invitee.canceled" | "invitee_no_show.created";

function groupInvitee(opts: {
  uri: string;
  email: string;
  name: string;
  createdAt: string;
  counter: { total: number; active: number } | null;
  canceledAt?: string;
}) {
  return {
    uri: opts.uri,
    email: opts.email,
    name: opts.name,
    status: opts.canceledAt ? "canceled" : "active",
    rescheduled: false,
    old_invitee: null,
    new_invitee: null,
    created_at: opts.createdAt,
    updated_at: opts.canceledAt ?? opts.createdAt,
    event: EVENT_URI,
    cancellation: opts.canceledAt
      ? { canceled_by: opts.name, canceler_type: "invitee", created_at: opts.canceledAt, reason: "Busy" }
      : undefined,
    questions_and_answers: [
      {
        position: 0,
        question: "What's your phone number? (Please include your country code)",
        answer: "+1 555-010-0000",
      },
    ],
    tracking: {},
    scheduled_event: {
      uri: EVENT_URI,
      name: "Comeback Call ",
      status: "active",
      event_type: EVENT_TYPE_URI,
      start_time: "2026-10-29T21:00:00.000000Z",
      end_time: "2026-10-29T21:45:00.000000Z",
      created_at: EVENT_CREATED_AT,
      event_guests: [],
      // Payloads from before the pipeline read the counter are modelled without it.
      ...(opts.counter ? { invitees_counter: { ...opts.counter, limit: 15 } } : {}),
      location: { type: "custom", location: "https://zoom.example/j/1" },
      event_memberships: [
        {
          user: "https://api.calendly.com/users/closer",
          user_email: "closer@example.com",
          user_name: "Closer",
        },
      ],
    },
  };
}

const inviteeA = (counter: { total: number; active: number } | null, canceledAt?: string) =>
  groupInvitee({
    uri: INVITEE_A,
    email: "alex.first@example.com",
    name: "Alex First",
    createdAt: "2026-10-01T17:45:04.436979Z",
    counter,
    canceledAt,
  });
const inviteeB = (counter: { total: number; active: number } | null, canceledAt?: string) =>
  groupInvitee({
    uri: INVITEE_B,
    email: "blair.second@example.com",
    name: "Blair Second",
    createdAt: B_CREATED_AT,
    counter,
    canceledAt,
  });

async function setup() {
  vi.useFakeTimers();
  const harness = await bookingHarness();
  const { t, tenantId } = harness;

  async function deliver(eventType: EventType, payload: { uri: string }, createdAt: string) {
    vi.setSystemTime(Math.max(Date.now(), Date.parse(createdAt) + 600));
    await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
      tenantId,
      calendlyEventUri: payload.uri,
      eventType,
      payload: JSON.stringify({ event: eventType, created_at: createdAt, payload }),
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  async function receipt(eventType: EventType, inviteeUri: string) {
    const rows = await t.run((ctx) => ctx.db.query("webhookDeliveries")
      .withIndex("by_tenantId_and_receivedAt", (q) => q.eq("tenantId", tenantId)).take(50));
    const row = rows.find((r) => r.eventType === eventType && r.inviteeUri === inviteeUri);
    if (!row) throw new Error(`No receipt for ${eventType} ${inviteeUri}`);
    return row;
  }

  async function state() {
    return await t.run(async (ctx) => ({
      meetings: await ctx.db.query("meetings").take(50),
      opportunities: await ctx.db.query("opportunities").take(50),
      leads: await ctx.db.query("leads").take(50),
      leadIdentifiers: await ctx.db.query("leadIdentifiers").take(50),
      raws: await ctx.db.query("rawWebhookEvents").take(50),
    }));
  }

  return { ...harness, deliver, receipt, state };
}

async function expectIgnoredAsGroupEvent(
  h: Awaited<ReturnType<typeof setup>>,
  eventType: EventType,
  inviteeUri: string,
) {
  const row = await h.receipt(eventType, inviteeUri);
  expect(row).toMatchObject({ status: "ignored", reason: "group_event" });
  expect(row.meetingId).toBeUndefined();
  expect(row.leadId).toBeUndefined();
  const { raws } = await h.state();
  const raw = raws.find((r) => r.eventType === eventType && r.calendlyEventUri === inviteeUri);
  expect(raw).toMatchObject({ processed: true, processingReason: "group_event" });
}

it("ignores the first registrant of a group event hosted by an active closer and writes nothing", async () => {
  const h = await setup();
  await h.deliver("invitee.created", inviteeA({ total: 1, active: 1 }), "2026-10-01T17:45:05Z");

  await expectIgnoredAsGroupEvent(h, "invitee.created", INVITEE_A);
  const state = await h.state();
  expect(state.meetings).toHaveLength(0);
  expect(state.opportunities).toHaveLength(0);
  expect(state.leads).toHaveLength(0);
  expect(state.leadIdentifiers).toHaveLength(0);
});

it("ignores a second registrant on a group event instead of blocking it", async () => {
  const h = await setup();
  await h.deliver("invitee.created", inviteeA({ total: 1, active: 1 }), "2026-10-01T17:45:05Z");
  await h.deliver("invitee.created", inviteeB({ total: 2, active: 2 }), "2026-10-11T02:14:51Z");

  await expectIgnoredAsGroupEvent(h, "invitee.created", INVITEE_A);
  await expectIgnoredAsGroupEvent(h, "invitee.created", INVITEE_B);
  const state = await h.state();
  expect(state.meetings).toHaveLength(0);
  expect(state.leads).toHaveLength(0);
});

it.each(["invitee.canceled", "invitee_no_show.created"] as const)(
  "ignores a %s on a group event",
  async (eventType) => {
    const h = await setup();
    await h.deliver("invitee.created", inviteeA({ total: 1, active: 1 }), "2026-10-01T17:45:05Z");
    await h.deliver(
      eventType,
      eventType === "invitee.canceled"
        ? inviteeA({ total: 1, active: 0 }, "2026-10-05T10:00:00Z")
        : inviteeA({ total: 1, active: 1 }),
      "2026-10-05T10:00:00Z",
    );
    await expectIgnoredAsGroupEvent(h, eventType, INVITEE_A);
  },
);

it("recognizes a group event from its synced event type when the payload has no invitee counter", async () => {
  const h = await setup();
  await h.t.run((ctx) => ctx.db.insert("eventTypeConfigs", {
    tenantId: h.tenantId,
    calendlyEventTypeUri: EVENT_TYPE_URI,
    displayName: "Comeback Call",
    calendlyKind: "group",
    createdAt: Date.parse("2026-09-01T00:00:00Z"),
  }));
  await h.deliver("invitee.created", inviteeA(null), "2026-10-01T17:45:05Z");
  await expectIgnoredAsGroupEvent(h, "invitee.created", INVITEE_A);
  expect((await h.state()).leads).toHaveLength(0);
});

it("keeps a group meeting tracked before this rule consistent and ignores other registrants", async () => {
  const h = await setup();
  // A was processed before the pipeline read invitees_counter, so it owns a meeting.
  await h.deliver("invitee.created", inviteeA(null), "2026-10-01T17:45:05Z");
  const tracked = await h.receipt("invitee.created", INVITEE_A);
  expect(tracked).toMatchObject({ status: "applied" });

  await h.deliver("invitee.created", inviteeB({ total: 2, active: 2 }), "2026-10-11T02:14:51Z");
  await h.deliver("invitee.canceled", inviteeB({ total: 2, active: 1 }, "2026-10-12T09:00:00Z"), "2026-10-12T09:00:00Z");
  await expectIgnoredAsGroupEvent(h, "invitee.created", INVITEE_B);
  await expectIgnoredAsGroupEvent(h, "invitee.canceled", INVITEE_B);
  let state = await h.state();
  expect(state.meetings).toHaveLength(1);
  expect(state.meetings[0]).toMatchObject({ calendlyInviteeUri: INVITEE_A, status: "scheduled" });
  expect(state.leads.map((l) => l.email)).toEqual(["alex.first@example.com"]);

  // A's own cancellation still applies to its meeting.
  await h.deliver("invitee.canceled", inviteeA({ total: 2, active: 0 }, "2026-10-13T09:00:00Z"), "2026-10-13T09:00:00Z");
  expect(await h.receipt("invitee.canceled", INVITEE_A)).toMatchObject({
    status: "applied", meetingId: tracked.meetingId,
  });
  state = await h.state();
  expect(state.meetings[0]).toMatchObject({ status: "canceled" });
});

it("still tracks a one-on-one closer booking whose invitee limit is 1", async () => {
  const h = await setup();
  const payload = {
    ...bookingPayload("one-on-one"),
    scheduled_event: {
      ...bookingPayload("one-on-one").scheduled_event,
      invitees_counter: { total: 1, active: 1, limit: 1 },
    },
  };
  await h.deliver("invitee.created", payload, "2026-10-01T10:00:00Z");
  const row = await h.receipt("invitee.created", payload.uri);
  expect(row).toMatchObject({ status: "applied" });
  const state = await h.state();
  expect(state.meetings).toHaveLength(1);
  expect(state.opportunities).toHaveLength(1);
  expect(state.leads).toHaveLength(1);
});
