/**
 * Placeholder contact values and the split lock (docs/plans/polluted-lead-split.md
 * §5.0). Placeholder emails, fake phones, and junk handles once merged many
 * people into one lead; they must never decide identity. A lead the split
 * migration has locked blocks every booking that matches it until the split
 * clears the lock.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload } from "../../tests/bookingHarness";
import { insertLeadAggregate, insertOpportunityAggregate } from "../reporting/writeHooks";

afterEach(() => vi.useRealTimers());

const EVENT_TYPE = "https://api.calendly.com/event_types/test";
const PHONE_QUESTION = "Phone ";
const INSTAGRAM_QUESTION = "What's your Instagram username?";
const LOCKED_AT = Date.parse("2026-10-13T12:00:00Z");

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  const harness = await bookingHarness();
  await harness.t.run(async (ctx) => {
    await ctx.db.insert("eventTypeConfigs", {
      tenantId: harness.tenantId,
      calendlyEventTypeUri: EVENT_TYPE,
      displayName: "Strategy Meeting",
      createdAt: Date.parse("2026-04-01T00:00:00Z"),
      customFieldMappings: {
        phoneField: "Phone",
        socialHandleField: INSTAGRAM_QUESTION,
        socialHandleType: "instagram",
      },
    });
  });
  return harness;
}

function booking(
  key: string,
  args: { email: string; name: string; phone?: string; instagram?: string },
) {
  const payload = {
    ...bookingPayload(key, args.email),
    name: args.name,
    text_reminder_number: null,
    questions_and_answers: [
      { question: PHONE_QUESTION, answer: args.phone ?? "", position: 0 },
      { question: INSTAGRAM_QUESTION, answer: args.instagram ?? "", position: 1 },
    ],
  };
  payload.scheduled_event.start_time = "2026-10-20T14:00:00Z";
  payload.scheduled_event.end_time = "2026-10-20T14:45:00Z";
  return payload;
}

async function deliver({ t, tenantId }: Harness, payload: { uri: string }) {
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-10-13T18:00:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** The newest delivery receipt. */
async function latestReceipt({ admin }: Harness) {
  const { page } = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 1 },
  });
  return page[0];
}

async function retryDelivery({ admin, t }: Harness, deliveryId: Id<"webhookDeliveries">) {
  const manifest = await admin.query(api.pipeline.recovery.preview, {
    deliveryIds: [deliveryId],
  });
  await admin.mutation(api.pipeline.recovery.retry, { manifest });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function state({ t }: Harness) {
  return await t.run(async (ctx) => ({
    leads: await ctx.db.query("leads").take(10),
    identifiers: await ctx.db.query("leadIdentifiers").take(20),
    opportunities: await ctx.db.query("opportunities").take(10),
    meetings: await ctx.db.query("meetings").take(10),
  }));
}

type SeedIdentifier = [Doc<"leadIdentifiers">["type"], string];

async function seedLead(
  { t, tenantId }: Harness,
  lead: { fullName: string; email?: string; splitLockedAt?: number },
  identifiers: SeedIdentifier[],
) {
  return await t.run(async (ctx) => {
    const at = Date.parse("2026-09-01T00:00:00Z");
    const leadId = await ctx.db.insert("leads", {
      tenantId,
      ...lead,
      status: "active",
      firstSeenAt: at,
      updatedAt: at,
    });
    for (const [type, value] of identifiers)
      await ctx.db.insert("leadIdentifiers", {
        tenantId,
        leadId,
        type,
        value,
        rawValue: value,
        source: "calendly_booking",
        confidence: "verified",
        createdAt: at,
      });
    await insertLeadAggregate(ctx, leadId);
    return leadId;
  });
}

// ---------------------------------------------------------------------------
// Placeholder emails
// ---------------------------------------------------------------------------

it("two invitees who book with the same placeholder email get separate leads", async () => {
  const harness = await setup();

  await deliver(
    harness,
    booking("placeholder-email-first", {
      email: "email@gmail.com",
      name: "First Invitee",
      phone: "+1 416-555-0142",
      instagram: "@first.invitee",
    }),
  );
  const first = await latestReceipt(harness);
  await deliver(
    harness,
    // Only the shared placeholder email, no phone or handle.
    booking("placeholder-email-second", { email: "Email@Gmail.com", name: "Second Invitee" }),
  );
  const second = await latestReceipt(harness);

  expect(first).toMatchObject({ status: "applied" });
  expect(second).toMatchObject({ status: "applied" });
  expect(second.leadId).not.toBe(first.leadId);

  const { leads, identifiers, opportunities, meetings } = await state(harness);
  expect(leads).toHaveLength(2);
  expect(opportunities).toHaveLength(2);
  expect(meetings).toHaveLength(2);
  // The placeholder is neither a lead's email nor an identifier.
  expect(leads.map((lead) => lead.email)).toEqual([undefined, undefined]);
  expect(leads.map((lead) => lead.searchText ?? "").join(" ")).not.toContain("email@gmail.com");
  expect(identifiers.filter((identifier) => identifier.type === "email")).toEqual([]);
  expect(identifiers.map((identifier) => identifier.value).sort()).toEqual([
    "+14165550142",
    "first.invitee",
  ]);
});

it("a placeholder email booked with a known handle joins that lead without becoming its email", async () => {
  const harness = await setup();
  // A Slack-qualified lead has a handle and no email yet.
  const leadId = await seedLead(harness, { fullName: "Jane Coach" }, [
    ["instagram", "jane.coach.speaks"],
  ]);

  await deliver(
    harness,
    booking("placeholder-email-known-handle", {
      email: "thisisnotanemail@notanemail.com",
      name: "Jane Coach",
      instagram: "@jane.coach.speaks",
    }),
  );

  expect(await latestReceipt(harness)).toMatchObject({ status: "applied", leadId });
  const { leads, identifiers } = await state(harness);
  expect(leads).toHaveLength(1);
  expect(leads[0].email).toBeUndefined();
  expect(identifiers.map((identifier) => identifier.value)).toEqual(["jane.coach.speaks"]);
});

it("a handle match with a new email on a lead polluted by a placeholder email stays blocked", async () => {
  // Every booker who typed email@gmail.com landed on this lead, so the
  // handles it collected don't vouch for a new email until it is split.
  const harness = await setup();
  await seedLead(harness, { fullName: "Most Recent Booker", email: "email@gmail.com" }, [
    ["email", "email@gmail.com"],
    ["instagram", "returning.booker"],
  ]);

  await deliver(
    harness,
    booking("placeholder-polluted-handle", {
      email: "returning.booker@hotmail.example",
      name: "Returning Booker",
      instagram: "@returning.booker",
    }),
  );

  expect(await latestReceipt(harness)).toMatchObject({ status: "blocked", reason: "identity_conflict" });
});

// ---------------------------------------------------------------------------
// Fake phones
// ---------------------------------------------------------------------------

it.each([
  ["on the known-fake list", "+1 234-234-2342"],
  ["caught by the pattern rule", "(456) 456-4567"],
])(
  "two invitees whose only shared key is a fake phone %s get separate leads",
  async (_, phone) => {
    const harness = await setup();

    await deliver(
      harness,
      booking("fake-phone-first", { email: "first.person@hotmail.example", name: "First Person", phone }),
    );
    const first = await latestReceipt(harness);
    await deliver(
      harness,
      booking("fake-phone-second", { email: "second.person@hotmail.example", name: "Second Person", phone }),
    );
    const second = await latestReceipt(harness);

    expect(first).toMatchObject({ status: "applied" });
    expect(second).toMatchObject({ status: "applied" });
    expect(second.leadId).not.toBe(first.leadId);
    const { leads, identifiers } = await state(harness);
    expect(leads.map((lead) => lead.email).sort()).toEqual([
      "first.person@hotmail.example",
      "second.person@hotmail.example",
    ]);
    expect(identifiers.filter((identifier) => identifier.type === "phone")).toEqual([]);
  },
);

// ---------------------------------------------------------------------------
// Split lock
// ---------------------------------------------------------------------------

it.each<[string, { email?: string }, SeedIdentifier[], Parameters<typeof booking>[1]]>([
  [
    "its canonical email",
    { email: "locked.person@hotmail.example" },
    [],
    { email: "locked.person@hotmail.example", name: "Locked Person" },
  ],
  [
    "an email identifier",
    { email: "locked.person@hotmail.example" },
    [["email", "locked.alias@hotmail.example"]],
    { email: "locked.alias@hotmail.example", name: "Locked Person" },
  ],
  [
    "an Instagram handle",
    { email: "locked.person@hotmail.example" },
    [["instagram", "locked.person"]],
    { email: "new.address@hotmail.example", name: "Locked Person", instagram: "@locked.person" },
  ],
  [
    "a phone, on a lead without an email",
    {},
    [["phone", "+14165550142"]],
    { email: "new.address@hotmail.example", name: "Locked Person", phone: "+1 416-555-0142" },
  ],
])("a booking that matches a split-locked lead through %s is blocked", async (_, lead, identifiers, invitee) => {
  const harness = await setup();
  await seedLead(harness, { fullName: "Locked Person", ...lead, splitLockedAt: LOCKED_AT }, identifiers);

  await deliver(harness, booking("split-locked", invitee));

  expect(await latestReceipt(harness)).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  const after = await state(harness);
  expect(after.leads).toHaveLength(1);
  expect(after.leads[0].email).toBe(lead.email);
  expect(after.identifiers).toHaveLength(identifiers.length);
  expect(after.opportunities).toHaveLength(0);
  expect(after.meetings).toHaveLength(0);
});

it("a booking blocked by the split lock applies to the lead when retried after the lock clears", async () => {
  const harness = await setup();
  const leadId = await seedLead(
    harness,
    { fullName: "Locked Person", email: "locked.person@hotmail.example", splitLockedAt: LOCKED_AT },
    [["email", "locked.person@hotmail.example"]],
  );

  await deliver(harness, booking("split-locked-retry", { email: "locked.person@hotmail.example", name: "Locked Person" }));
  const blocked = await latestReceipt(harness);
  expect(blocked).toMatchObject({ status: "blocked", reason: "identity_conflict" });

  await harness.t.run((ctx) => ctx.db.patch("leads", leadId, { splitLockedAt: undefined }));
  await retryDelivery(harness, blocked._id);

  expect(await latestReceipt(harness)).toMatchObject({ _id: blocked._id, status: "applied", leadId });
  const { opportunities, meetings } = await state(harness);
  expect(opportunities).toHaveLength(1);
  expect(meetings).toHaveLength(1);
});

it("a follow-up link into a split-locked lead is blocked even when no identifier matches", async () => {
  const harness = await setup();
  const { t, tenantId } = harness;
  // Without the lock, a lead with no email would accept this booking's email.
  const leadId = await seedLead(harness, { fullName: "Locked Person", splitLockedAt: LOCKED_AT }, [
    ["instagram", "locked.person"],
  ]);
  const opportunityId = await t.run(async (ctx) => {
    const closer = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
      .unique();
    const at = Date.parse("2026-10-01T00:00:00Z");
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "follow_up_scheduled",
      source: "calendly",
      assignedCloserId: closer!._id,
      createdAt: at,
      updatedAt: at,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    return opportunityId;
  });

  const followUpLinkBooking = {
    ...booking("split-locked-follow-up", { email: "new.address@hotmail.example", name: "Locked Person" }),
    tracking: { utm_source: "ptdom", utm_medium: "follow_up", utm_campaign: opportunityId },
  };
  await deliver(harness, followUpLinkBooking);

  expect(await latestReceipt(harness)).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  const after = await state(harness);
  expect(after.leads[0].email).toBeUndefined();
  expect(after.opportunities[0].status).toBe("follow_up_scheduled");
  expect(after.meetings).toHaveLength(0);
});
