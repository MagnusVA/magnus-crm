/**
 * Booking identity rules, built around two production `identity_conflict`
 * blocks (2026-10-10 and 2026-10-13). All names, emails, phones, and handles
 * are sanitized; only the shape of the data is kept.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { insertOpportunityAggregate } from "../reporting/writeHooks";

afterEach(() => vi.useRealTimers());

const EVENT_TYPE = "https://api.calendly.com/event_types/test";
const PHONE_QUESTION = "Phone "; // Calendly sends the trailing space.
const INSTAGRAM_QUESTION =
  "What's your Instagram username? (Example @therealbrianmark)";

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T00:00:00Z"));
  const harness = await bookingHarness();
  // Production config for both event types: phone and Instagram come from
  // form answers, not from `text_reminder_number`.
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
  args: { email: string; name: string; phone: string; instagram: string; start: string },
) {
  const payload = {
    ...bookingPayload(key, args.email),
    name: args.name,
    text_reminder_number: null,
    questions_and_answers: [
      { question: PHONE_QUESTION, answer: args.phone, position: 0 },
      { question: INSTAGRAM_QUESTION, answer: args.instagram, position: 4 },
    ],
  };
  const end = new Date(Date.parse(args.start) + 45 * 60_000).toISOString();
  payload.scheduled_event.start_time = args.start;
  payload.scheduled_event.end_time = end;
  return payload;
}

async function deliver(
  { t, tenantId }: Harness,
  payload: ReturnType<typeof booking>,
  createdAt: string,
) {
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: createdAt, payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function receipts({ admin }: Harness) {
  return (
    await admin.query(api.pipeline.delivery.list, {
      paginationOpts: { cursor: null, numItems: 20 },
    })
  ).page;
}

async function retryDelivery({ admin }: Harness, deliveryId: Id<"webhookDeliveries">) {
  const manifest = await admin.query(api.pipeline.recovery.preview, {
    deliveryIds: [deliveryId],
  });
  await admin.mutation(api.pipeline.recovery.retry, { manifest });
}

// ---------------------------------------------------------------------------
// Incident A (2026-10-13): one person, a new email, the same Instagram handle.
//
// Prod history: the Slack bot qualified the lead with only an Instagram handle.
// Her first booking used a business email and the Calendly placeholder phone
// (+1 234-567-8910). It attached to the Slack lead through the handle and set
// the lead's canonical email. Her second booking used a personal email, a real
// phone, and the same handle. The handle resolves to the lead and the new
// email belongs to no lead, so the booking applies to her lead: the canonical
// email stays and the new email is added as another email identifier.
// ---------------------------------------------------------------------------

async function seedIncidentA(harness: Harness) {
  const { t, tenantId } = harness;
  const slackAt = Date.parse("2026-09-28T02:14:00Z");
  const leadId = await t.run(async (ctx) => {
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(slackAt),
      tenantId,
      fullName: "Jane Coach",
      status: "active",
      firstSeenAt: slackAt,
      updatedAt: slackAt,
      socialHandles: [{ type: "instagram", handle: "jane.coach.speaks" }],
    });
    await ctx.db.insert("leadIdentifiers", {
      tenantId,
      leadId,
      type: "instagram",
      value: "jane.coach.speaks",
      rawValue: "@jane.coach.speaks",
      source: "slack_qualified",
      confidence: "verified",
      createdAt: slackAt,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "qualified_pending",
      source: "slack_qualified",
      createdAt: slackAt,
      updatedAt: slackAt,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    return leadId;
  });

  await deliver(
    harness,
    booking("incident-a-first", {
      email: "owner@acme-coaching.example",
      name: "Jane Coach",
      phone: "+1 234-567-8910", // Calendly's example number, ignored as identity
      instagram: "@jane.coach.speaks",
      start: "2026-09-29T19:00:00Z",
    }),
    "2026-09-28T04:59:00Z",
  );
  return leadId;
}

const incidentASecondBooking = booking("incident-a-second", {
  email: "jane.personal@hotmail.example",
  name: "Jane Coach",
  phone: "+1 416-555-0142",
  instagram: "@jane.coach.speaks",
  start: "2026-10-13T14:00:00Z",
});

it("incident A: a returning lead's new email matched through her Instagram handle books onto her lead", async () => {
  const harness = await setup();
  const leadId = await seedIncidentA(harness);

  const [first] = await receipts(harness);
  expect(first).toMatchObject({ status: "applied", leadId });
  const leadAfterFirst = await harness.t.run((ctx) => ctx.db.get("leads", leadId));
  expect(leadAfterFirst?.email).toBe("owner@acme-coaching.example");

  await deliver(harness, incidentASecondBooking, "2026-10-13T00:25:29Z");

  const [second] = await receipts(harness);
  expect(second).toMatchObject({ status: "applied", leadId });
  const state = await harness.t.run(async (ctx) => ({
    lead: await ctx.db.get("leads", leadId),
    leads: await ctx.db.query("leads").take(10),
    meetings: await ctx.db.query("meetings").order("asc").take(10),
    identifiers: await ctx.db.query("leadIdentifiers").take(20),
  }));
  // The canonical email stays; the new email becomes an additional identifier.
  expect(state.lead?.email).toBe("owner@acme-coaching.example");
  expect(state.leads).toHaveLength(1);
  expect(state.meetings).toHaveLength(2);
  const secondMeeting = state.meetings[1];
  expect(state.identifiers.find((i) => i.value === "jane.personal@hotmail.example")).toMatchObject({
    leadId,
    type: "email",
    source: "calendly_booking",
    sourceMeetingId: secondMeeting._id,
  });
  expect(state.identifiers.filter((i) => i.type === "email").map((i) => i.value).sort()).toEqual([
    "jane.personal@hotmail.example",
    "owner@acme-coaching.example",
  ]);
  expect(state.lead?.searchText).toContain("jane.personal@hotmail.example");
});

it(
  "after an admin merge, either of the person's emails can book again",
  async () => {
    // The only tool for "same person, two emails" is merging two leads. The
    // merged-away email resolves through the merge chain (and its identifier)
    // to the target, so it is a known email of that lead even though it is
    // not the canonical one.
    const harness = await setup();
    const { t, tenantId } = harness;
    const at = Date.parse("2026-09-01T00:00:00Z");
    const targetId = await t.run(async (ctx) => {
      const targetId = await ctx.db.insert("leads", { ...qualifiedLifecycle(at),
        tenantId,
        fullName: "Jane Coach",
        email: "owner@acme-coaching.example",
        status: "active",
        firstSeenAt: at,
        updatedAt: at,
      });
      await ctx.db.insert("leads", { ...qualifiedLifecycle(at),
        tenantId,
        fullName: "Jane Coach",
        email: "jane.personal@hotmail.example",
        status: "merged",
        mergedIntoLeadId: targetId,
        firstSeenAt: at,
        updatedAt: at,
      });
      for (const value of ["owner@acme-coaching.example", "jane.personal@hotmail.example"])
        await ctx.db.insert("leadIdentifiers", {
          tenantId,
          leadId: targetId,
          type: "email",
          value,
          rawValue: value,
          source: value.startsWith("owner") ? "calendly_booking" : "merge",
          confidence: "verified",
          createdAt: at,
        });
      return targetId;
    });

    await deliver(harness, incidentASecondBooking, "2026-10-13T00:25:29Z");

    const [receipt] = await receipts(harness);
    expect(receipt).toMatchObject({ status: "applied", leadId: targetId });
  },
);

type SeedIdentifier = ["email" | "phone" | "instagram", string, ("calendly_booking" | "manual_entry" | "slack_qualified")?];

async function seedLead(
  { t, tenantId }: Harness,
  lead: { fullName: string; email?: string; phone?: string },
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
    for (const [type, value, source = "calendly_booking"] of identifiers)
      await ctx.db.insert("leadIdentifiers", {
        tenantId,
        leadId,
        type,
        value,
        rawValue: value,
        source,
        confidence: "verified",
        createdAt: at,
      });
    return leadId;
  });
}

it("a known non-canonical email books onto its lead without changing the canonical email", async () => {
  const harness = await setup();
  const leadId = await seedLead(
    harness,
    { fullName: "Jane Coach", email: "owner@acme-coaching.example" },
    [
      ["email", "owner@acme-coaching.example"],
      ["email", "jane.personal@hotmail.example", "manual_entry"],
    ],
  );

  await deliver(
    harness,
    booking("known-alias", {
      email: "jane.personal@hotmail.example",
      name: "Jane Coach",
      phone: "",
      instagram: "",
      start: "2026-10-13T14:00:00Z",
    }),
    "2026-10-13T00:25:29Z",
  );

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "applied", leadId });
  const lead = await harness.t.run((ctx) => ctx.db.get("leads", leadId));
  expect(lead?.email).toBe("owner@acme-coaching.example");
});

// The booking used to rejoin the canceled opportunity (the 14-day reschedule
// join). A cancellation ends the deal now, so it makes a new one; the new
// email is still searchable on the person and on the deal it booked.
it("a handle match with a new email that books after a canceled opportunity makes the new email searchable", async () => {
  const harness = await setup();
  const leadId = await seedLead(
    harness,
    { fullName: "Jane Coach", email: "owner@acme-coaching.example" },
    [
      ["email", "owner@acme-coaching.example"],
      ["instagram", "jane.coach.speaks", "slack_qualified"],
    ],
  );
  const opportunityId = await harness.t.run(async (ctx) => {
    const at = Date.parse("2026-10-10T00:00:00Z");
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId: harness.tenantId,
      leadId,
      status: "canceled",
      source: "calendly",
      createdAt: at,
      updatedAt: at,
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    return opportunityId;
  });

  await deliver(harness, incidentASecondBooking, "2026-10-13T00:25:29Z");

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "applied", leadId });
  expect(receipt.opportunityId).not.toBe(opportunityId);
  const state = await harness.t.run(async (ctx) => ({
    lead: await ctx.db.get("leads", leadId),
    opportunitySearch: await ctx.db.query("opportunitySearch").take(5),
  }));
  expect(state.lead?.email).toBe("owner@acme-coaching.example");
  expect(state.lead?.searchText).toContain("jane.personal@hotmail.example");
  expect(state.opportunitySearch.find((row) => row.opportunityId === receipt.opportunityId)?.searchText).toContain(
    "jane.personal@hotmail.example",
  );
});

it("a phone-only match with a new email stays blocked until an admin changes the canonical email", async () => {
  // Shared and fake phones once merged dozens of people into one lead, so a
  // phone match alone never vouches for a new email.
  const harness = await setup();
  const leadId = await seedLead(
    harness,
    { fullName: "Jane Coach", email: "owner@acme-coaching.example", phone: "+1 416-555-0142" },
    [
      ["email", "owner@acme-coaching.example"],
      ["phone", "+14165550142"],
    ],
  );

  await deliver(
    harness,
    booking("phone-only", {
      email: "someone.else@hotmail.example",
      name: "Someone Else",
      phone: "+1 416-555-0142",
      instagram: "",
      start: "2026-10-13T14:00:00Z",
    }),
    "2026-10-13T00:25:29Z",
  );

  const [blocked] = await receipts(harness);
  expect(blocked).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  const identifiers = await harness.t.run((ctx) => ctx.db.query("leadIdentifiers").take(20));
  expect(identifiers.map((i) => i.value)).not.toContain("someone.else@hotmail.example");

  await harness.admin.mutation(api.leads.mutations.updateLead, {
    leadId,
    email: "someone.else@hotmail.example",
  });
  await retryDelivery(harness, blocked._id);
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  const [retried] = await receipts(harness);
  expect(retried).toMatchObject({ _id: blocked._id, status: "applied", leadId });
});

it("an email owned by one lead and a handle owned by another books onto the handle's lead, for review", async () => {
  // The handle decides (docs/adr/0001-lead-lifecycle-model.md); the email
  // stays with its lead, and convex/pipeline/bookingReviews.test.ts covers
  // the review.
  const harness = await setup();
  const leadA = await seedLead(harness, { fullName: "Lead A", email: "lead.a@example.com" }, [
    ["email", "lead.a@example.com"],
    ["instagram", "lead.a.handle"],
  ]);
  const leadB = await seedLead(harness, { fullName: "Lead B", email: "lead.b@example.com" }, [
    ["email", "lead.b@example.com"],
  ]);

  await deliver(
    harness,
    booking("cross-lead", {
      email: "lead.b@example.com",
      name: "Lead B",
      phone: "",
      instagram: "@lead.a.handle",
      start: "2026-10-13T14:00:00Z",
    }),
    "2026-10-13T00:25:29Z",
  );

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "applied", leadId: leadA });
  const state = await harness.t.run(async (ctx) => ({
    leadA: await ctx.db.get("leads", leadA),
    emailOwners: (await ctx.db.query("leadIdentifiers").take(20))
      .filter((i) => i.value === "lead.b@example.com")
      .map((i) => i.leadId),
    reviews: await ctx.db.query("bookingReviews").take(5),
  }));
  expect(state.leadA?.email).toBe("lead.a@example.com");
  expect(state.emailOwners).toEqual([leadB]);
  expect(state.reviews).toMatchObject([
    { kind: "attached", leadId: leadA, conflicts: [{ leadId: leadB, via: "email" }] },
  ]);
});

// A lead holding a placeholder phone identifier collected other people's
// emails and handles, so neither vouches for a booking until it is split.
const POLLUTED_LEAD_IDENTIFIERS: SeedIdentifier[] = [
  ["email", "first.booker@gmail.example"],
  ["phone", "+12345678910"],
  ["email", "returning.booker@hotmail.example"],
  ["instagram", "returning.booker"],
];

it("a known non-canonical email on a placeholder-polluted lead stays blocked", async () => {
  const harness = await setup();
  await seedLead(
    harness,
    { fullName: "Most Recent Booker", email: "first.booker@gmail.example" },
    POLLUTED_LEAD_IDENTIFIERS,
  );

  await deliver(
    harness,
    booking("polluted-known-email", {
      email: "returning.booker@hotmail.example",
      name: "Returning Booker",
      phone: "",
      instagram: "",
      start: "2026-10-13T14:00:00Z",
    }),
    "2026-10-13T00:25:29Z",
  );

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "blocked", reason: "identity_conflict" });
});

it("a handle match with a new email on a placeholder-polluted lead stays blocked", async () => {
  const harness = await setup();
  await seedLead(
    harness,
    { fullName: "Most Recent Booker", email: "first.booker@gmail.example" },
    POLLUTED_LEAD_IDENTIFIERS,
  );

  await deliver(
    harness,
    booking("polluted-handle-new-email", {
      email: "brand.new@hotmail.example",
      name: "Returning Booker",
      phone: "",
      instagram: "@returning.booker",
      start: "2026-10-13T14:00:00Z",
    }),
    "2026-10-13T00:25:29Z",
  );

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "blocked", reason: "identity_conflict" });
});

// ---------------------------------------------------------------------------
// Incident B (2026-10-10): a lead polluted by the placeholder phone.
//
// Before 2026-10-08 the placeholder +1 234-567-8910 was a live identity key.
// Every booker who left Calendly's example number in the Phone field was
// attached to the first lead that used it, and each booking added that
// booker's email and Instagram handle as identifiers. In prod that one lead
// holds about 55 people's emails and handles. This booker was attached to it
// on 2026-06-27. On 2026-10-10 he booked again with the same email and handle
// and a different fake phone (+1 234-567-8945, not on the placeholder list then).
// His email resolves through an identifier to the polluted lead, whose
// canonical email belongs to the first booker. The lead's placeholder phone
// identifier marks it as polluted, so the known email does not vouch for him.
// ---------------------------------------------------------------------------

it("incident B: blocks a returning booker whose email alias sits on a placeholder-polluted lead", async () => {
  const harness = await setup();
  const { t, tenantId } = harness;
  const polluted = await t.run(async (ctx) => {
    const at = Date.parse("2026-04-19T22:33:00Z");
    const leadId = await ctx.db.insert("leads", { ...qualifiedLifecycle(at),
      tenantId,
      fullName: "Most Recent Booker", // overwritten by each booking's name
      email: "first.booker@gmail.example", // never overwritten
      phone: "+1 234-567-8910",
      status: "converted",
      firstSeenAt: at,
      updatedAt: at,
    });
    const identifiers: Array<["email" | "phone" | "instagram", string]> = [
      ["email", "first.booker@gmail.example"],
      ["phone", "+12345678910"],
      ["instagram", "first.booker"],
      ["email", "other.person@gmail.example"],
      ["instagram", "other.person"],
      ["email", "returning.booker@hotmail.example"],
      ["instagram", "returning.booker"],
      ["email", "another.person@yahoo.example"],
      ["instagram", "another.person"],
    ];
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
    // The returning booker's June opportunity lives on the polluted lead.
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: "canceled",
      source: "calendly",
      createdAt: Date.parse("2026-06-27T00:12:00Z"),
      updatedAt: Date.parse("2026-06-27T00:12:00Z"),
    });
    await insertOpportunityAggregate(ctx, opportunityId);
    return leadId;
  });

  await deliver(
    harness,
    booking("incident-b", {
      email: "returning.booker@hotmail.example",
      name: "Returning Booker",
      phone: "+1 234-567-8945",
      instagram: "returning.booker",
      start: "2026-10-10T23:00:00Z",
    }),
    "2026-10-10T05:38:43Z",
  );

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  const state = await t.run(async (ctx) => ({
    lead: await ctx.db.get("leads", polluted),
    leads: await ctx.db.query("leads").take(10),
    meetings: await ctx.db.query("meetings").take(10),
  }));
  expect(state.lead?.email).toBe("first.booker@gmail.example");
  expect(state.lead?.fullName).toBe("Most Recent Booker");
  expect(state.leads).toHaveLength(1);
  expect(state.meetings).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// CRM follow-up links (utm_source=ptdom) follow the same email rule as
// cold bookings: a known email of the target lead is accepted, an email the
// identity lookup doesn't tie to the target lead still needs review.
// ---------------------------------------------------------------------------

async function seedFollowUpOpportunity({ t, tenantId }: Harness, leadId: Id<"leads">) {
  return await t.run(async (ctx) => {
    const closer = await ctx.db.query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer")).unique();
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
}

function followUpLinkBooking(key: string, email: string, opportunityId: Id<"opportunities">) {
  return {
    ...booking(key, { email, name: "Jane Coach", phone: "", instagram: "", start: "2026-10-13T14:00:00Z" }),
    tracking: { utm_source: "ptdom", utm_medium: "follow_up", utm_campaign: opportunityId },
  };
}

it("a known non-canonical email booked through a follow-up link applies to the target opportunity", async () => {
  const harness = await setup();
  const leadId = await seedLead(
    harness,
    { fullName: "Jane Coach", email: "owner@acme-coaching.example" },
    [
      ["email", "owner@acme-coaching.example"],
      ["email", "jane.personal@hotmail.example", "manual_entry"],
    ],
  );
  const opportunityId = await seedFollowUpOpportunity(harness, leadId);

  await deliver(harness, followUpLinkBooking("follow-up-alias", "jane.personal@hotmail.example", opportunityId), "2026-10-13T00:25:29Z");

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "applied", leadId, opportunityId });
  const state = await harness.t.run(async (ctx) => ({
    lead: await ctx.db.get("leads", leadId),
    opportunity: await ctx.db.get("opportunities", opportunityId),
  }));
  expect(state.lead?.email).toBe("owner@acme-coaching.example");
  expect(state.opportunity?.status).toBe("scheduled");
});

it("an unknown email booked through a follow-up link stays blocked", async () => {
  const harness = await setup();
  const leadId = await seedLead(
    harness,
    { fullName: "Jane Coach", email: "owner@acme-coaching.example" },
    [["email", "owner@acme-coaching.example"]],
  );
  const opportunityId = await seedFollowUpOpportunity(harness, leadId);

  await deliver(harness, followUpLinkBooking("follow-up-unknown", "someone.else@hotmail.example", opportunityId), "2026-10-13T00:25:29Z");

  const [receipt] = await receipts(harness);
  expect(receipt).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  expect(await harness.t.run((ctx) => ctx.db.get("opportunities", opportunityId))).toMatchObject({
    status: "follow_up_scheduled",
  });
});
