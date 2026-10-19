/**
 * Placeholder contact values (docs/plans/polluted-lead-split.md §5.0).
 * Placeholder emails, fake phones, and junk handles once merged many people
 * into one lead; they must never decide identity.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

const EVENT_TYPE = "https://api.calendly.com/event_types/test";
const PHONE_QUESTION = "Phone ";
const INSTAGRAM_QUESTION = "What's your Instagram username?";

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
  lead: { fullName: string; email?: string },
  identifiers: SeedIdentifier[],
) {
  return await t.run(async (ctx) => {
    const at = Date.parse("2026-09-01T00:00:00Z");
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(at),
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
