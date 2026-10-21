/**
 * The Instagram handle on a Calendly form decides who a booking belongs to,
 * and every booking whose identifiers name more than one person opens a
 * booking review. Built around the 2026-10-19 to 2026-10-21 holds; names,
 * emails, phones and handles are sanitized.
 */
import { afterEach, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";
import { buildBookingReviewNotification } from "../lib/slackBlockKit";
import { insertOpportunityAggregate } from "../reporting/writeHooks";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const EVENT_TYPE = "https://api.calendly.com/event_types/test";
const PHONE_QUESTION = "Phone ";
const INSTAGRAM_QUESTION =
  "What's your Instagram username? (Example @therealbrianmark)";

type Harness = Awaited<ReturnType<typeof bookingHarness>>;

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  const harness = await bookingHarness();
  await harness.t.run(async (ctx) => {
    await ctx.db.insert("eventTypeConfigs", {
      tenantId: harness.tenantId,
      calendlyEventTypeUri: EVENT_TYPE,
      displayName: "Strategy Call",
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
  return {
    ...bookingPayload(key, args.email),
    name: args.name,
    timezone: "America/Los_Angeles",
    text_reminder_number: null,
    tracking: { utm_source: "phonesetters", utm_medium: "setter_one" },
    questions_and_answers: [
      ...(args.phone ? [{ question: PHONE_QUESTION, answer: args.phone, position: 0 }] : []),
      ...(args.instagram
        ? [{ question: INSTAGRAM_QUESTION, answer: args.instagram, position: 4 }]
        : []),
    ],
  };
}

async function deliver({ t, tenantId }: Harness, payload: ReturnType<typeof booking>) {
  await t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: "2026-10-21T01:50:00Z", payload }),
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function receipt({ admin }: Harness) {
  const page = await admin.query(api.pipeline.delivery.list, {
    paginationOpts: { cursor: null, numItems: 5 },
  });
  return page.page[0];
}

async function reviews({ t }: Harness) {
  return await t.run((ctx) => ctx.db.query("bookingReviews").take(10));
}

async function alertJobs({ t }: Harness) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").take(100))
      .filter((job) => job.name === "slack/bookingReviewNotify:post")
      .map((job) => job.args[0] as { reviewId: Id<"bookingReviews"> }),
  );
}

type Identifier = ["email" | "phone" | "instagram", string, ("calendly_booking" | "slack_qualified" | "dm_portal" | "lead_gen")?];

async function seedPerson(
  { t, tenantId }: Harness,
  person: { fullName?: string; email?: string; phone?: string },
  identifiers: Identifier[],
  options: { slackDeal?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const at = Date.parse("2026-10-20T00:00:00Z");
    const handle = identifiers.find(([type]) => type === "instagram")?.[1];
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(at),
      tenantId,
      ...person,
      status: "active",
      firstSeenAt: at,
      updatedAt: at,
      ...(handle ? { socialHandles: [{ type: "instagram", handle }] } : {}),
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
    let opportunityId: Id<"opportunities"> | undefined;
    if (options.slackDeal) {
      opportunityId = await ctx.db.insert("opportunities", {
        tenantId,
        leadId,
        status: "qualified_pending",
        source: "slack_qualified",
        qualifiedBy: { slackUserId: "U_SETTER", slackTeamId: "T1", submittedAt: at },
        createdAt: at,
        updatedAt: at,
      });
      await insertOpportunityAggregate(ctx, opportunityId);
    }
    return { leadId, opportunityId };
  });
}

// Incident C (2026-10-21): a setter booked a Slack-qualified lead with the
// email of the lead they had booked an hour earlier. Name, phone, handle and
// time zone are the Slack lead's; only the email is the other person's.
async function seedIncidentC(harness: Harness) {
  const earlier = await seedPerson(
    harness,
    { fullName: "Earlier Booker", email: "earlier.booker@gmail.example", phone: "+1 551-555-0115" },
    [
      ["instagram", "earlier.handle", "lead_gen"],
      ["email", "earlier.booker@gmail.example"],
      ["phone", "+15515550115"],
    ],
  );
  const slack = await seedPerson(
    harness,
    { fullName: "Doorsdollars" },
    [["instagram", "doors.dollars", "slack_qualified"]],
    { slackDeal: true },
  );
  return { earlier, slack };
}

const incidentCBooking = booking("incident-c", {
  email: "earlier.booker@gmail.example",
  name: "Tyson Example",
  phone: "+1 775-555-0182",
  instagram: "Doors.Dollars",
});

it("incident C: the handle's person gets the booking when the email belongs to someone else", async () => {
  const harness = await setup();
  const { earlier, slack } = await seedIncidentC(harness);

  await deliver(harness, incidentCBooking);

  expect(await receipt(harness)).toMatchObject({ status: "applied", leadId: slack.leadId });
  const state = await harness.t.run(async (ctx) => ({
    slackLead: await ctx.db.get("leads", slack.leadId),
    earlierLead: await ctx.db.get("leads", earlier.leadId),
    deal: await ctx.db.get("opportunities", slack.opportunityId!),
    identifiers: await ctx.db.query("leadIdentifiers").take(20),
  }));
  // The booking joins the setter's deal.
  expect(state.deal?.status).toBe("scheduled");
  // The other person's email stays theirs: not copied, not an identifier.
  expect(state.slackLead?.email).toBeUndefined();
  expect(state.slackLead?.fullName).toBe("Doorsdollars");
  expect(
    state.identifiers.filter((i) => i.value === "earlier.booker@gmail.example").map((i) => i.leadId),
  ).toEqual([earlier.leadId]);
  // The booking's own phone is nobody else's, so the handle's person gets it.
  expect(state.identifiers.find((i) => i.value === "+17755550182")?.leadId).toBe(slack.leadId);
  expect(state.earlierLead?.email).toBe("earlier.booker@gmail.example");

  const [review] = await reviews(harness);
  expect(review).toMatchObject({
    kind: "attached",
    status: "open",
    leadId: slack.leadId,
    conflicts: [{ leadId: earlier.leadId, via: "email" }],
    booking: {
      name: "Tyson Example",
      email: "earlier.booker@gmail.example",
      phone: "+17755550182",
      socialHandle: { platform: "instagram", handle: "doors.dollars" },
    },
  });
  expect(await alertJobs(harness)).toEqual([{ reviewId: review._id }]);
});

it("the Slack alert names the booking, both people, what differs, and links to the review", async () => {
  const harness = await setup();
  await seedIncidentC(harness);
  await harness.t.run(async (ctx) => {
    const installationId = await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [],
      installedByWorkosUserId: "user_admin", installedAt: 0, tokenExpiresAt: 0,
      refreshToken: "r", status: "uninstalled",
    });
    await ctx.db.insert("slackUsers", {
      tenantId: harness.tenantId, installationId, slackUserId: "U_SETTER", slackTeamId: "T1",
      realName: "Sam Setter", isBot: false, isDeleted: false, firstSeenAt: 0, lastSeenAt: 0,
      lastSyncedAt: 0,
    });
  });
  await deliver(harness, incidentCBooking);
  const [review] = await reviews(harness);

  const alert = await harness.t.query(internal.pipeline.bookingReviews.getForAlert, {
    reviewId: review._id,
  });
  const message = buildBookingReviewNotification(alert!.detail, "https://crm.example/");
  const blocks = JSON.stringify(message.blocks);
  for (const value of [
    "Booking matched two people",
    "Tyson Example",
    "earlier.booker@gmail.example",
    "+17755550182",
    "@doors.dollars",
    "America/Los_Angeles",
    "phonesetters / setter_one",
    "*Doorsdollars*",
    "qualified by Sam Setter",
    "*Earlier Booker*",
    "Also matched by email",
    "Same as the booking: email",
    "Different: name, phone, Instagram",
    `https://crm.example/workspace/operations/booking-reviews/${review._id}`,
  ])
    expect(blocks).toContain(value);
  expect(message.text).toContain("its email belongs to *Earlier Booker*");
});

// Incident A (2026-10-19): the Slack lead and a Calendly lead are one person.
// The handle wins; an admin merges the two from the review.
it("incident A: merging from the review folds the email's person into the handle's person", async () => {
  const harness = await setup();
  const calendly = await seedPerson(
    harness,
    { fullName: "Coach Example", email: "coach.example@gmail.example" },
    [["email", "coach.example@gmail.example"]],
  );
  const slack = await seedPerson(
    harness,
    { fullName: "COACH E" },
    [["instagram", "elpmaxehcaoc", "slack_qualified"]],
    { slackDeal: true },
  );

  await deliver(
    harness,
    booking("incident-a", {
      email: "coach.example@gmail.example",
      name: "Coach Example",
      phone: "+1 876-555-0139",
      instagram: "elpmaxehcaoc",
    }),
  );
  expect(await receipt(harness)).toMatchObject({ status: "applied", leadId: slack.leadId });
  const [review] = await reviews(harness);

  const detail = await harness.admin.query(api.pipeline.bookingReviews.get, { reviewId: review._id });
  expect(detail?.people.map((p) => [p.leadId, p.role])).toEqual([
    [slack.leadId, "booked"],
    [calendly.leadId, "matched"],
  ]);
  expect(detail?.booking.inviteeName).toBe("Coach Example");
  expect(detail?.booking.bookedVia).toBe("phonesetters / setter_one");
  expect(detail?.people[1].checks).toEqual([
    { label: "name", same: true },
    { label: "email", same: true },
  ]);

  await harness.admin.mutation(api.pipeline.bookingReviews.mergePeople, {
    reviewId: review._id,
    keepLeadId: slack.leadId,
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  const after = await harness.t.run(async (ctx) => ({
    merged: await ctx.db.get("leads", calendly.leadId),
    review: await ctx.db.get("bookingReviews", review._id),
    email: await ctx.db
      .query("leadIdentifiers")
      .withIndex("by_tenantId_and_type_and_value", (q) =>
        q.eq("tenantId", harness.tenantId).eq("type", "email").eq("value", "coach.example@gmail.example"),
      )
      .take(5),
  }));
  expect(after.merged).toMatchObject({ status: "merged", mergedIntoLeadId: slack.leadId });
  expect(after.review).toMatchObject({ status: "resolved", resolution: "merged" });
  expect(after.email.map((i) => i.leadId)).toEqual([slack.leadId]);
});

// Incident B (2026-10-19): a DM portal link copy created a handle-only person
// minutes before the booking, whose email belongs to a person from an earlier
// booking. The handle-only person gets the call, and the email stays put.
it("incident B: a handle-only person from the DM portal gets the booking", async () => {
  const harness = await setup();
  const emailPerson = await seedPerson(
    harness,
    { fullName: "Tara Example", email: "tara.example@yahoo.example" },
    [["email", "tara.example@yahoo.example"]],
  );
  const portalPerson = await seedPerson(harness, {}, [["instagram", "diane_example", "dm_portal"]]);

  await deliver(
    harness,
    booking("incident-b", {
      email: "tara.example@yahoo.example",
      name: "Tara Example",
      phone: "+1 613-555-0176",
      instagram: "@diane_example",
    }),
  );

  expect(await receipt(harness)).toMatchObject({ status: "applied", leadId: portalPerson.leadId });
  const lead = await harness.t.run((ctx) => ctx.db.get("leads", portalPerson.leadId));
  expect(lead).toMatchObject({ fullName: "Tara Example", phone: "+1 613-555-0176" });
  expect(lead?.email).toBeUndefined();
  const [review] = await reviews(harness);
  expect(review).toMatchObject({
    kind: "attached",
    leadId: portalPerson.leadId,
    conflicts: [{ leadId: emailPerson.leadId, via: "email" }],
  });
});

it("a later booking of a pair an admin kept separate opens no new review", async () => {
  const harness = await setup();
  await seedIncidentC(harness);
  await deliver(harness, incidentCBooking);
  const [first] = await reviews(harness);
  await harness.admin.mutation(api.pipeline.bookingReviews.keepSeparate, { reviewId: first._id });

  await deliver(harness, booking("incident-c-rebook", {
    email: "earlier.booker@gmail.example",
    name: "Tyson Example",
    phone: "+1 775-555-0182",
    instagram: "doors.dollars",
  }));

  expect(await receipt(harness)).toMatchObject({ status: "applied" });
  expect((await reviews(harness)).map((r) => r._id)).toEqual([first._id]);
  expect(await alertJobs(harness)).toHaveLength(1);
});

it("keeping the people separate closes the review and changes no one", async () => {
  const harness = await setup();
  const { earlier, slack } = await seedIncidentC(harness);
  await deliver(harness, incidentCBooking);
  const [review] = await reviews(harness);

  await harness.admin.mutation(api.pipeline.bookingReviews.keepSeparate, { reviewId: review._id });

  const after = await harness.t.run(async (ctx) => ({
    review: await ctx.db.get("bookingReviews", review._id),
    earlier: await ctx.db.get("leads", earlier.leadId),
    slack: await ctx.db.get("leads", slack.leadId),
  }));
  expect(after.review).toMatchObject({ status: "resolved", resolution: "kept_separate" });
  expect(after.earlier?.status).toBe("active");
  expect(after.slack?.status).toBe("active");
  expect(await harness.admin.query(api.pipeline.bookingReviews.list, {})).toEqual([]);
});

it("only admins can see or act on booking reviews", async () => {
  const harness = await setup();
  await seedIncidentC(harness);
  await deliver(harness, incidentCBooking);
  const [review] = await reviews(harness);

  await expect(harness.closer.query(api.pipeline.bookingReviews.list, {})).rejects.toThrow();
  await expect(
    harness.closer.mutation(api.pipeline.bookingReviews.keepSeparate, { reviewId: review._id }),
  ).rejects.toThrow();
});

it("a booking whose email and phone name two people and has no handle is held, with a review", async () => {
  const harness = await setup();
  const first = await seedPerson(harness, { fullName: "Lead A", email: "lead.a@example.com" }, [
    ["email", "lead.a@example.com"],
  ]);
  const second = await seedPerson(harness, { fullName: "Lead B", phone: "+1 416-555-0142" }, [
    ["phone", "+14165550142"],
  ]);

  await deliver(
    harness,
    booking("held", { email: "lead.a@example.com", name: "Lead A", phone: "+1 416-555-0142" }),
  );

  const held = await receipt(harness);
  expect(held).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  const [review] = await reviews(harness);
  expect(review).toMatchObject({
    kind: "held",
    status: "open",
    deliveryId: held._id,
    reason: "identity_conflict",
    conflicts: [
      { leadId: first.leadId, via: "email" },
      { leadId: second.leadId, via: "phone" },
    ],
  });
  expect(review.leadId).toBeUndefined();
  expect(await alertJobs(harness)).toEqual([{ reviewId: review._id }]);

  // Merging the two people retries the booking, which then applies.
  await harness.admin.mutation(api.pipeline.bookingReviews.mergePeople, {
    reviewId: review._id,
    keepLeadId: first.leadId,
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await receipt(harness)).toMatchObject({ _id: held._id, status: "applied", leadId: first.leadId });
  const after = await reviews(harness);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ status: "resolved", resolution: "merged" });
  // One alert for one review, however often the booking is processed.
  expect(await alertJobs(harness)).toHaveLength(1);
});

it("a held booking retried without a fix stays held under the same review and alerts once", async () => {
  const harness = await setup();
  await seedPerson(harness, { fullName: "Lead A", email: "lead.a@example.com" }, [
    ["email", "lead.a@example.com"],
  ]);
  await seedPerson(harness, { fullName: "Lead B", phone: "+1 416-555-0142" }, [
    ["phone", "+14165550142"],
  ]);
  await deliver(
    harness,
    booking("held-again", { email: "lead.a@example.com", name: "Lead A", phone: "+1 416-555-0142" }),
  );
  const [review] = await reviews(harness);

  await harness.admin.mutation(api.pipeline.bookingReviews.retryBooking, { reviewId: review._id });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await receipt(harness)).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  const after = await reviews(harness);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ _id: review._id, status: "open", kind: "held" });
  expect(await alertJobs(harness)).toHaveLength(1);
});

it("a hold that names one person, not two, opens no review", async () => {
  // A phone match alone never vouches for a new email: the booking is held,
  // but only one person is involved, so there is nothing to merge.
  const harness = await setup();
  await seedPerson(harness, { fullName: "Lead A", email: "lead.a@example.com", phone: "+1 416-555-0142" }, [
    ["email", "lead.a@example.com"],
    ["phone", "+14165550142"],
  ]);
  await deliver(
    harness,
    booking("one-person-hold", { email: "someone.else@example.com", name: "Someone Else", phone: "+1 416-555-0142" }),
  );
  expect(await receipt(harness)).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  expect(await reviews(harness)).toEqual([]);
  expect(await alertJobs(harness)).toEqual([]);
});

it("a malformed review link reads as not found", async () => {
  const harness = await setup();
  expect(await harness.admin.query(api.pipeline.bookingReviews.get, { reviewId: "not-an-id" })).toBeNull();
});

it("retrying a held booking an admin kept separate leaves the decision and alerts no one", async () => {
  const harness = await setup();
  await seedPerson(harness, { fullName: "Lead A", email: "lead.a@example.com" }, [
    ["email", "lead.a@example.com"],
  ]);
  await seedPerson(harness, { fullName: "Lead B", phone: "+1 416-555-0142" }, [
    ["phone", "+14165550142"],
  ]);
  await deliver(
    harness,
    booking("kept-held", { email: "lead.a@example.com", name: "Lead A", phone: "+1 416-555-0142" }),
  );
  const [review] = await reviews(harness);
  await harness.admin.mutation(api.pipeline.bookingReviews.keepSeparate, { reviewId: review._id });

  const manifest = await harness.admin.query(api.pipeline.recovery.preview, {
    deliveryIds: [review.deliveryId],
  });
  await harness.admin.mutation(api.pipeline.recovery.retry, { manifest });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  expect(await receipt(harness)).toMatchObject({ status: "blocked", reason: "identity_conflict" });
  expect(await reviews(harness)).toMatchObject([
    { _id: review._id, status: "resolved", resolution: "kept_separate" },
  ]);
  expect(await alertJobs(harness)).toHaveLength(1);
});

async function seedInstallation(harness: Harness, bookingReviewChannelId?: string) {
  return await harness.t.run((ctx) =>
    ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [],
      notifyChannelId: "C_NOTIFY", notifyChannelName: "qualified",
      staleReminderChannelId: "C_STALE", staleReminderChannelName: "stale",
      ...(bookingReviewChannelId && {
        bookingReviewChannelId,
        bookingReviewChannelName: "reviews",
      }),
      installedByWorkosUserId: "user_admin", installedAt: 0,
      tokenExpiresAt: Date.parse("2027-01-01T00:00:00Z"), refreshToken: "r", status: "active",
    }),
  );
}

/** Stubs Slack and records the channel of each post; `failing` channels are gone. */
function stubSlack(failing: string[] = []) {
  vi.stubEnv("APP_URL", "https://crm.example");
  const channels: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { channel } = JSON.parse(init.body) as { channel: string };
    channels.push(channel);
    return new Response(
      JSON.stringify(failing.includes(channel) ? { ok: false, error: "channel_not_found" } : { ok: true }),
    );
  });
  return channels;
}

function saveChannels(harness: Harness, bookingReviewChannel: { channelId: string; channelName: string } | null) {
  return harness.admin.mutation(api.slack.channels.setSlackNotifyChannels, {
    notifyChannelId: "C_NOTIFY",
    notifyChannelName: "qualified",
    staleReminderChannelId: "C_STALE",
    staleReminderChannelName: "stale",
    bookingReviewChannel,
  });
}

it("with no booking review channel, alerts go nowhere, and the open ones post once a channel is set", async () => {
  const harness = await setup();
  await seedIncidentC(harness);
  await seedInstallation(harness);
  const channels = stubSlack();

  await deliver(harness, incidentCBooking);
  await seedPerson(harness, { fullName: "Lead A", email: "lead.a@example.com" }, [
    ["email", "lead.a@example.com"],
  ]);
  await seedPerson(harness, { fullName: "Lead B", phone: "+1 416-555-0142" }, [
    ["phone", "+14165550142"],
  ]);
  await deliver(
    harness,
    booking("decided-before-channel", { email: "lead.a@example.com", name: "Lead A", phone: "+1 416-555-0142" }),
  );
  // Not the notify channel, nor anywhere else.
  expect(channels).toEqual([]);
  const [open, decided] = await reviews(harness);
  await harness.admin.mutation(api.pipeline.bookingReviews.keepSeparate, { reviewId: decided._id });

  await saveChannels(harness, { channelId: "C_REVIEWS", channelName: "reviews" });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

  // Only the review still open is posted, to the new channel.
  expect(channels).toEqual(["C_REVIEWS"]);
  const after = await harness.t.run((ctx) => ctx.db.get("bookingReviews", open._id));
  expect(after?.alertPostedAt).toBeDefined();

  // Moving to another channel doesn't post it again.
  await saveChannels(harness, { channelId: "C_OTHER", channelName: "other" });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(channels).toEqual(["C_REVIEWS"]);
});

it("an alert whose booking review channel is gone turns alerts off and waits for a new channel", async () => {
  const harness = await setup();
  await seedIncidentC(harness);
  const installationId = await seedInstallation(harness, "C_GONE");
  const channels = stubSlack(["C_GONE"]);

  await deliver(harness, incidentCBooking);

  expect(channels).toEqual(["C_GONE"]);
  const state = await harness.t.run(async (ctx) => ({
    installation: await ctx.db.get("slackInstallations", installationId),
    review: (await ctx.db.query("bookingReviews").take(1))[0],
  }));
  expect(state.installation?.bookingReviewChannelId).toBeUndefined();
  expect(state.installation?.bookingReviewChannelError).toMatchObject({
    code: "channel_not_found",
    channelId: "C_GONE",
  });
  expect(state.review.alertPostedAt).toBeUndefined();

  await saveChannels(harness, { channelId: "C_NEW", channelName: "new" });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(channels).toEqual(["C_GONE", "C_NEW"]);
});

it("a booking whose identifiers all name one person opens no review", async () => {
  const harness = await setup();
  const { slack } = await seedIncidentC(harness);
  await deliver(
    harness,
    booking("clean", { email: "new.person@example.com", name: "Tyson Example", instagram: "doors.dollars" }),
  );
  expect(await receipt(harness)).toMatchObject({ status: "applied", leadId: slack.leadId });
  expect(await reviews(harness)).toEqual([]);
  expect(await alertJobs(harness)).toEqual([]);
});
