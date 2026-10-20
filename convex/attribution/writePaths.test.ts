/**
 * The write paths of deal attribution and first and latest touch
 * (docs/plans/phase-3-attribution.md §4 and §5).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { moveMeetingToOpportunity } from "../leads/repointLeadReferences";
import { recordSetterAttribution } from "../lib/attribution/dealAttributions";
import { ATTRIBUTION_RESOLUTION_VERSION } from "../lib/attribution/resolveAttribution";
import { emitDomainEvent } from "../lib/domainEvents";
import { insertOpportunityAggregate } from "../reporting/writeHooks";
import { bookingHarness, bookingPayload, qualifiedLifecycle } from "../../tests/bookingHarness";

afterEach(() => vi.useRealTimers());

type Harness = Awaited<ReturnType<typeof bookingHarness>>;
type Role = Doc<"dealAttributions">["role"];

const NOW = Date.parse("2026-10-10T12:00:00Z");
const MINUTE = 60_000;
const CLOSER_URI = "https://api.calendly.com/users/closer";
const CLOSER2_URI = "https://api.calendly.com/users/closer2";

async function setup(at = NOW) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(at));
  return await bookingHarness();
}

// --- Fixtures ---

async function user(harness: Harness, workosUserId: string) {
  return await harness.t.run(async (ctx) => {
    const row = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
    if (!row) throw new Error(`Missing user ${workosUserId}`);
    return row;
  });
}

async function secondCloser(harness: Harness) {
  await harness.t.run(async (ctx) =>
    await ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_closer2",
      email: "closer2@example.com",
      role: "closer",
      isActive: true,
      calendlyUserUri: CLOSER2_URI,
    }),
  );
  return await user(harness, "user_closer2");
}

async function dmTeam(harness: Harness, utmSource = "team-a") {
  return await harness.t.run(async (ctx) =>
    await ctx.db.insert("attributionTeams", {
      tenantId: harness.tenantId, slug: utmSource, displayName: utmSource, utmSource,
      normalizedUtmSource: utmSource, isActive: true, createdAt: 0, updatedAt: 0,
    }),
  );
}

async function dmCloser(harness: Harness, teamId: Id<"attributionTeams">, utmMedium: string) {
  const dmCloserId = await harness.admin.mutation(api.attribution.dmClosers.createDmCloser, {
    teamId,
    displayName: `DM ${utmMedium}`,
    utmMedium,
  });
  const row = await harness.t.run((ctx) => ctx.db.get("dmClosers", dmCloserId));
  if (!row?.teamMemberId) throw new Error("DM closer has no team member");
  return row;
}

type Booking = {
  createdAt: number;
  tracking?: Record<string, string>;
  hostUri?: string;
  oldInvitee?: string;
  startTime?: string;
  email?: string;
};

/** Delivers one invitee.created webhook and returns the meeting it made. */
async function book(harness: Harness, key: string, booking: Booking) {
  const base = bookingPayload(key, booking.email);
  const start = booking.startTime ?? base.scheduled_event.start_time;
  const payload = {
    ...base,
    ...(booking.tracking ? { tracking: booking.tracking } : {}),
    ...(booking.oldInvitee ? { old_invitee: booking.oldInvitee } : {}),
    scheduled_event: {
      ...base.scheduled_event,
      start_time: start,
      end_time: new Date(Date.parse(start) + 30 * MINUTE).toISOString(),
      event_memberships: [{
        user: booking.hostUri ?? CLOSER_URI,
        user_email: "host@example.com",
        user_name: "Host",
      }],
    },
  };
  vi.setSystemTime(new Date(booking.createdAt + MINUTE));
  await harness.t.mutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: harness.tenantId,
    calendlyEventUri: payload.uri,
    eventType: "invitee.created",
    payload: JSON.stringify({ created_at: new Date(booking.createdAt).toISOString(), payload }),
  });
  await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
  const meeting = await harness.t.run((ctx) =>
    ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_calendlyEventUri", (q) =>
        q.eq("tenantId", harness.tenantId).eq("calendlyEventUri", payload.scheduled_event.uri),
      )
      .unique(),
  );
  if (!meeting) throw new Error(`Booking ${key} made no meeting`);
  return meeting;
}

async function slackInstallation(harness: Harness): Promise<Id<"slackInstallations">> {
  return await harness.t.run(async (ctx) => {
    const existing = await ctx.db.query("slackInstallations").first();
    if (existing) return existing._id;
    return await ctx.db.insert("slackInstallations", {
      tenantId: harness.tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false,
      appId: "A1", botUserId: "B1", botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1",
      notifyChannelName: "qualified", installedByWorkosUserId: "user_slack", installedAt: 0,
      tokenExpiresAt: 0, refreshToken: "r", status: "active",
    });
  });
}

async function qualify(
  harness: Harness,
  args: { submittedAt: number; slackUserId?: string; handle?: string },
) {
  const installationId = await slackInstallation(harness);
  return await harness.t.mutation(internal.slack.createQualifiedLead.create, {
    tenantId: harness.tenantId,
    installationId,
    fullName: "Ana Lead",
    handle: args.handle ?? "ana.lead",
    country: "Honduras",
    leadType: "pt",
    qualifiedBy: { slackUserId: args.slackUserId ?? "U1", slackTeamId: "T1", submittedAt: args.submittedAt },
  });
}

async function slackUser(harness: Harness, slackUserId: string) {
  return await harness.t.run(async (ctx) => {
    const row = await ctx.db
      .query("slackUsers")
      .withIndex("by_tenantId_and_slackUserId", (q) =>
        q.eq("tenantId", harness.tenantId).eq("slackUserId", slackUserId),
      )
      .first();
    if (!row?.teamMemberId) throw new Error(`Slack user ${slackUserId} has no team member`);
    return row;
  });
}

async function capture(harness: Harness, handle = "ana.lead") {
  return await harness.admin.mutation(api.leadGen.capture.submit, {
    source: "instagram",
    rawHandleOrProfileUrl: `@${handle}`,
    originKind: "follower",
  });
}

/** Gives the only person the booking email, so a booking finds them. */
async function addEmailToOnlyLead(harness: Harness) {
  await harness.t.run(async (ctx) => {
    const lead = (await ctx.db.query("leads").first())!;
    await ctx.db.patch("leads", lead._id, { email: "lead@example.com" });
    await ctx.db.insert("leadIdentifiers", {
      tenantId: harness.tenantId, leadId: lead._id, type: "email", value: "lead@example.com",
      rawValue: "lead@example.com", source: "manual_entry", confidence: "verified", createdAt: 0,
    });
  });
}

async function program(harness: Harness): Promise<Id<"tenantPrograms">> {
  const admin = await user(harness, "user_admin");
  return await harness.t.run(async (ctx) =>
    await ctx.db.insert("tenantPrograms", {
      tenantId: harness.tenantId, name: "Program", normalizedName: "program",
      createdAt: 0, createdByUserId: admin._id, updatedAt: 0,
    }),
  );
}

// --- Reads ---

async function dealRows(harness: Harness, opportunityId: Id<"opportunities">) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_opportunityId_and_role", (q) =>
        q.eq("tenantId", harness.tenantId).eq("opportunityId", opportunityId),
      )
      .take(500),
  );
}

function ofRole(rows: Doc<"dealAttributions">[], role: Role) {
  return rows.filter((row) => row.role === role);
}

function roles(rows: Doc<"dealAttributions">[]) {
  return rows.map((row) => row.role).sort();
}

async function get<T extends "leads" | "opportunities" | "meetings" | "teamMembers" | "dmClosers">(
  harness: Harness,
  table: T,
  id: Id<T>,
) {
  return await harness.t.run((ctx) => ctx.db.get(table, id));
}

async function events(harness: Harness, eventType: string) {
  return await harness.t.run((ctx) =>
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
        q.eq("tenantId", harness.tenantId).eq("eventType", eventType),
      )
      .take(50),
  );
}

async function meetingCreatedEvent(harness: Harness, meetingId: Id<"meetings">) {
  const event = (await events(harness, "meeting.created")).find((row) => row.entityId === meetingId);
  if (!event) throw new Error(`No meeting.created for ${meetingId}`);
  return event;
}

function touch(event: Doc<"domainEvents">, channel: string) {
  return { eventId: event._id, eventType: event.eventType, channel, occurredAt: event.occurredAt };
}

async function qualificationRows(harness: Harness) {
  return await harness.t.run((ctx) => ctx.db.query("operationsQualificationRows").take(50));
}

function bookingRowBase(meeting: Doc<"meetings">) {
  return {
    tenantId: meeting.tenantId,
    opportunityId: meeting.opportunityId,
    meetingId: meeting._id,
    meetingScheduledAt: meeting.scheduledAt,
    attributedAt: meeting.createdAt,
  };
}

// ---------------------------------------------------------------------------

describe("Calendly bookings", () => {
  it("a new deal booked through a DM closer's link credits the team, the DM closer and the closer", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    const dana = await dmCloser(harness, teamId, "dana");

    const bookedAt = Date.parse("2026-10-09T15:00:00Z");
    const meeting = await book(harness, "first", {
      createdAt: bookedAt,
      tracking: { utm_source: "team-a", utm_medium: "dana" },
    });
    const closer = await user(harness, "user_closer");

    expect(meeting.createdAt).toBe(bookedAt);
    const rows = await dealRows(harness, meeting.opportunityId);
    expect(roles(rows)).toEqual(["closer", "dm_closer", "dm_team"]);
    expect(ofRole(rows, "dm_team")[0]).toMatchObject({
      ...bookingRowBase(meeting),
      teamId,
      source: { kind: "booking_utm" },
    });
    expect(ofRole(rows, "dm_team")[0].teamMemberId).toBeUndefined();
    expect(ofRole(rows, "dm_closer")[0]).toMatchObject({
      ...bookingRowBase(meeting),
      teamMemberId: dana.teamMemberId,
      source: { kind: "booking_utm", dmCloserId: dana._id },
    });
    expect(ofRole(rows, "closer")[0]).toMatchObject({
      ...bookingRowBase(meeting),
      teamMemberId: closer.teamMemberId,
      source: { kind: "booking_closer", userId: closer._id },
    });
    expect(closer.teamMemberId).toBeDefined();

    // The credit is the rows alone. The meeting keeps its UTMs and
    // resolution; the deal its first booking caches and UTMs.
    expect(meeting).toMatchObject({
      utmParams: { utm_source: "team-a", utm_medium: "dana" },
      utmTruncated: false,
      attributionResolution: "mapped",
      attributionResolutionVersion: ATTRIBUTION_RESOLUTION_VERSION,
      attributionResolvedAt: expect.any(Number),
    });
    const deal = await get(harness, "opportunities", meeting.opportunityId);
    expect(deal).toMatchObject({
      firstMeetingId: meeting._id,
      firstMeetingAt: meeting.scheduledAt,
      firstBookedAt: meeting.scheduledAt,
      utmParams: { utm_source: "team-a", utm_medium: "dana" },
    });

    // The deal's snapshot includes the booking that created it; the
    // Calendly deal's own opportunity.created is not a touch.
    const booked = touch(await meetingCreatedEvent(harness, meeting._id), "calendly");
    expect(deal?.firstTouch).toEqual(booked);
    expect(deal?.latestTouch).toEqual(booked);
    const lead = await get(harness, "leads", deal!.leadId);
    expect(lead?.firstTouch).toEqual(booked);
    expect(lead?.latestTouch).toEqual(booked);
  });

  it("team-only UTMs credit the team and the closer", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);

    const meeting = await book(harness, "team-only", {
      createdAt: NOW - 60 * MINUTE,
      tracking: { utm_source: "team-a", utm_medium: "nobody" },
    });

    const rows = await dealRows(harness, meeting.opportunityId);
    expect(roles(rows)).toEqual(["closer", "dm_team"]);
    expect(ofRole(rows, "dm_team")[0]).toMatchObject({ ...bookingRowBase(meeting), teamId });
  });

  it.each([
    ["internal", { utm_source: "ptdom" }],
    ["unmapped", { utm_source: "nobody", utm_medium: "nobody" }],
    ["UTM-less", undefined],
  ] as const)("a %s booking credits only its closer", async (_kind, tracking) => {
    const harness = await setup();
    await dmTeam(harness);

    const meeting = await book(harness, "plain", {
      createdAt: NOW - 60 * MINUTE,
      tracking: tracking ? { ...tracking } : undefined,
    });

    const rows = await dealRows(harness, meeting.opportunityId);
    expect(roles(rows)).toEqual(["closer"]);
    expect(rows[0]).toMatchObject({
      ...bookingRowBase(meeting),
      source: { kind: "booking_closer", userId: meeting.assignedCloserId },
    });
  });

  it("a rebook through another DM closer adds its own rows and keeps the first booking's", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    const dana = await dmCloser(harness, teamId, "dana");
    const eli = await dmCloser(harness, teamId, "eli");

    const first = await book(harness, "first", {
      createdAt: NOW - 3 * 60 * MINUTE,
      tracking: { utm_source: "team-a", utm_medium: "dana" },
    });
    const second = await book(harness, "second", {
      createdAt: NOW - 60 * MINUTE,
      tracking: { utm_source: "team-a", utm_medium: "eli" },
      oldInvitee: first.calendlyInviteeUri,
      startTime: "2026-10-12T12:00:00Z",
    });

    expect(second.opportunityId).toBe(first.opportunityId);
    const rows = await dealRows(harness, first.opportunityId);
    const dmClosers = ofRole(rows, "dm_closer").sort((a, b) => a.attributedAt - b.attributedAt);
    expect(dmClosers).toHaveLength(2);
    expect(dmClosers[0]).toMatchObject({
      ...bookingRowBase(first),
      teamMemberId: dana.teamMemberId,
      source: { kind: "booking_utm", dmCloserId: dana._id },
    });
    expect(dmClosers[1]).toMatchObject({
      ...bookingRowBase(second),
      teamMemberId: eli.teamMemberId,
      source: { kind: "booking_utm", dmCloserId: eli._id },
    });
    expect(ofRole(rows, "dm_team").map((row) => row.meetingId).sort()).toEqual(
      [first._id, second._id].sort(),
    );
    expect(ofRole(rows, "closer")).toHaveLength(2);

    // The rebook's meeting has its own resolution.
    const rebooked = await get(harness, "meetings", second._id);
    expect(rebooked?.attributionResolution).toBe("mapped");

    // The deal keeps its snapshot from creation; the person's latest touch moves.
    const firstBooked = touch(await meetingCreatedEvent(harness, first._id), "calendly");
    const deal = await get(harness, "opportunities", first.opportunityId);
    expect(deal?.firstTouch).toEqual(firstBooked);
    expect(deal?.latestTouch).toEqual(firstBooked);
    const lead = await get(harness, "leads", deal!.leadId);
    expect(lead?.firstTouch).toEqual(firstBooked);
    expect(lead?.latestTouch).toEqual(touch(await meetingCreatedEvent(harness, second._id), "calendly"));
  });

  it("a rebook with another Calendly host keeps the first booking's closer row", async () => {
    const harness = await setup();
    const closer2 = await secondCloser(harness);

    const first = await book(harness, "first", { createdAt: NOW - 3 * 60 * MINUTE });
    const second = await book(harness, "second", {
      createdAt: NOW - 60 * MINUTE,
      hostUri: CLOSER2_URI,
      oldInvitee: first.calendlyInviteeUri,
      startTime: "2026-10-12T12:00:00Z",
    });

    // The pipeline moves every meeting of the deal to the new host.
    expect((await get(harness, "meetings", first._id))?.assignedCloserId).toBe(closer2._id);
    const closer = await user(harness, "user_closer");
    const rows = ofRole(await dealRows(harness, first.opportunityId), "closer");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.meetingId === first._id)).toMatchObject({
      teamMemberId: closer.teamMemberId,
      source: { kind: "booking_closer", userId: closer._id },
    });
    expect(rows.find((row) => row.meetingId === second._id)).toMatchObject({
      teamMemberId: (await user(harness, "user_closer2")).teamMemberId,
      source: { kind: "booking_closer", userId: closer2._id },
    });
  });

  it("a booking through the CRM's own link onto a follow-up deal writes only its closer row", async () => {
    const harness = await setup();
    const closer = await user(harness, "user_closer");
    const opportunityId = await harness.t.run(async (ctx) => {
      const leadId = await ctx.db.insert("leads", {
        ...qualifiedLifecycle(NOW - 5 * 24 * 60 * MINUTE),
        tenantId: harness.tenantId,
        email: "lead@example.com",
        status: "active",
        firstSeenAt: NOW - 5 * 24 * 60 * MINUTE,
        updatedAt: NOW - 5 * 24 * 60 * MINUTE,
      });
      const id = await ctx.db.insert("opportunities", {
        tenantId: harness.tenantId,
        leadId,
        assignedCloserId: closer._id,
        status: "follow_up_scheduled",
        source: "calendly",
        createdAt: NOW - 5 * 24 * 60 * MINUTE,
        updatedAt: NOW - 4 * 24 * 60 * MINUTE,
      });
      await insertOpportunityAggregate(ctx, id);
      return id;
    });

    const meeting = await book(harness, "relink", {
      createdAt: NOW - 60 * MINUTE,
      tracking: { utm_source: "ptdom", utm_campaign: opportunityId },
    });

    expect(meeting.opportunityId).toBe(opportunityId);
    const rows = await dealRows(harness, opportunityId);
    expect(roles(rows)).toEqual(["closer"]);
    expect(rows[0]).toMatchObject({
      ...bookingRowBase(meeting),
      source: { kind: "booking_closer", userId: closer._id },
    });
    expect(meeting.attributionResolution).toBe("internal");
    const deal = await get(harness, "opportunities", opportunityId);
    // A booking that joins a deal doesn't snapshot it.
    expect(deal?.firstTouch).toBeUndefined();
  });
});

describe("Slack qualifications", () => {
  it("a Slack deal credits its setter and snapshots the person's touches", async () => {
    const harness = await setup();

    const result = await qualify(harness, { submittedAt: NOW - 2_000 });
    if (result.kind !== "created") throw new Error(`Expected a new deal, got ${result.kind}`);

    const setter = await slackUser(harness, "U1");
    const [qualification] = await harness.t.run((ctx) => ctx.db.query("slackQualificationEvents").take(2));
    const rows = await dealRows(harness, result.opportunityId);
    expect(roles(rows)).toEqual(["setter"]);
    expect(rows[0]).toMatchObject({
      tenantId: harness.tenantId,
      opportunityId: result.opportunityId,
      teamMemberId: setter.teamMemberId,
      source: { kind: "slack_qualification", slackUserId: "U1", qualificationEventId: qualification._id },
      attributedAt: NOW - 2_000,
    });
    expect(rows[0].meetingId).toBeUndefined();

    const [qualified] = await events(harness, "lead.slack_qualified");
    const created = (await events(harness, "opportunity.created")).find(
      (event) => event.entityId === result.opportunityId,
    )!;
    const deal = await get(harness, "opportunities", result.opportunityId);
    expect(deal?.firstTouch).toEqual(touch(qualified, "slack"));
    expect(deal?.latestTouch).toEqual(touch(created, "slack"));
  });

  it("a capture before the qualification credits the capture's worker", async () => {
    const harness = await setup();
    const captured = await capture(harness);
    vi.setSystemTime(new Date(NOW + 2 * MINUTE));

    const result = await qualify(harness, { submittedAt: NOW + MINUTE });
    if (result.kind !== "created") throw new Error(`Expected a new deal, got ${result.kind}`);

    const admin = await user(harness, "user_admin");
    const worker = await harness.t.run((ctx) =>
      ctx.db
        .query("leadGenWorkers")
        .withIndex("by_tenantId_and_userId", (q) => q.eq("tenantId", harness.tenantId).eq("userId", admin._id))
        .unique(),
    );
    const [captureEvent] = await events(harness, "lead.captured");
    const rows = await dealRows(harness, result.opportunityId);
    expect(roles(rows)).toEqual(["lead_gen", "setter"]);
    expect(ofRole(rows, "lead_gen")[0]).toMatchObject({
      teamMemberId: worker!.teamMemberId,
      source: {
        kind: "capture",
        prospectId: captured.prospectId,
        workerId: worker!._id,
        eventId: captureEvent._id,
      },
      attributedAt: NOW,
    });
    expect(worker!.teamMemberId).toBeDefined();
    const deal = await get(harness, "opportunities", result.opportunityId);
    expect(deal?.firstTouch).toEqual(touch(captureEvent, "lead_gen"));
  });

  it("a capture after the qualification credits no lead gen worker", async () => {
    const harness = await setup();
    const result = await qualify(harness, { submittedAt: NOW - 2_000 });
    if (result.kind !== "created") throw new Error(`Expected a new deal, got ${result.kind}`);
    vi.setSystemTime(new Date(NOW + MINUTE));

    await capture(harness);

    expect(roles(await dealRows(harness, result.opportunityId))).toEqual(["setter"]);
    const [captureEvent] = await events(harness, "lead.captured");
    const deal = await get(harness, "opportunities", result.opportunityId);
    const lead = await get(harness, "leads", deal!.leadId);
    expect(lead?.latestTouch).toEqual(touch(captureEvent, "lead_gen"));
    expect(deal?.firstTouch?.channel).toBe("slack");
  });

  it("another setter who qualifies the waiting deal gets a row; the same setter again doesn't", async () => {
    const harness = await setup();
    const result = await qualify(harness, { submittedAt: NOW - 2_000 });
    if (result.kind !== "created") throw new Error(`Expected a new deal, got ${result.kind}`);

    vi.setSystemTime(new Date(NOW + MINUTE));
    expect((await qualify(harness, { submittedAt: NOW + 30_000, slackUserId: "U2" })).kind).toBe("duplicate_pending");
    vi.setSystemTime(new Date(NOW + 2 * MINUTE));
    expect((await qualify(harness, { submittedAt: NOW + 90_000 })).kind).toBe("duplicate_pending");

    const setters = ofRole(await dealRows(harness, result.opportunityId), "setter").sort(
      (a, b) => a.attributedAt - b.attributedAt,
    );
    expect(setters.map((row) => row.teamMemberId)).toEqual([
      (await slackUser(harness, "U1")).teamMemberId,
      (await slackUser(harness, "U2")).teamMemberId,
    ]);
    expect(setters[1]).toMatchObject({
      source: { kind: "slack_qualification", slackUserId: "U2" },
      attributedAt: NOW + 30_000,
    });
  });

  it("a booking joins the Slack deal with its own rows, and a later qualification adds no setter", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    const dana = await dmCloser(harness, teamId, "dana");
    const result = await qualify(harness, { submittedAt: NOW - 2_000 });
    if (result.kind !== "created") throw new Error(`Expected a new deal, got ${result.kind}`);
    await addEmailToOnlyLead(harness);
    const snapshot = await get(harness, "opportunities", result.opportunityId);

    const meeting = await book(harness, "joins", {
      createdAt: NOW + 60 * MINUTE,
      tracking: { utm_source: "team-a", utm_medium: "dana" },
    });
    expect(meeting.opportunityId).toBe(result.opportunityId);

    vi.setSystemTime(new Date(NOW + 2 * 60 * MINUTE));
    expect((await qualify(harness, { submittedAt: NOW + 2 * 60 * MINUTE, slackUserId: "U2" })).kind).toBe(
      "existing_opportunity_bump",
    );

    const rows = await dealRows(harness, result.opportunityId);
    expect(roles(rows)).toEqual(["closer", "dm_closer", "dm_team", "setter"]);
    expect(ofRole(rows, "dm_closer")[0]).toMatchObject({
      ...bookingRowBase(meeting),
      teamMemberId: dana.teamMemberId,
    });
    expect(ofRole(rows, "setter")[0].source).toMatchObject({ slackUserId: "U1" });
    const deal = await get(harness, "opportunities", result.opportunityId);
    expect(deal?.firstTouch).toEqual(snapshot?.firstTouch);
    expect(deal?.latestTouch).toEqual(snapshot?.latestTouch);

    // The booking rebuilt the qualification rows from the deal.
    const qualifications = await qualificationRows(harness);
    expect(qualifications).toHaveLength(2);
    for (const row of qualifications) {
      expect(row).toMatchObject({ opportunityId: result.opportunityId, firstMeetingId: meeting._id });
    }
  });
});

describe("side deals", () => {
  it("a side deal credits the closer it names, and deleting it deletes its rows", async () => {
    const harness = await setup();

    const created = await harness.closer.mutation(api.opportunities.createManual.createManual, {
      clientRequestId: "side-deal",
      newLeadInput: { fullName: "Side Deal", email: "side@example.com" },
    });
    const closer = await user(harness, "user_closer");

    const rows = await dealRows(harness, created.opportunityId);
    expect(roles(rows)).toEqual(["closer"]);
    expect(rows[0]).toMatchObject({
      teamMemberId: closer.teamMemberId,
      source: { kind: "side_deal", userId: closer._id },
      attributedAt: NOW,
    });
    expect(rows[0].meetingId).toBeUndefined();
    const createdEvent = (await events(harness, "opportunity.created"))[0];
    const deal = await get(harness, "opportunities", created.opportunityId);
    expect(deal?.firstTouch).toEqual(touch(createdEvent, "side_deal"));
    expect(deal?.latestTouch).toEqual(touch(createdEvent, "side_deal"));

    await harness.closer.mutation(api.sideDeals.deleteEmptyOpportunity.deleteEmptyOpportunity, {
      opportunityId: created.opportunityId,
    });
    expect(await dealRows(harness, created.opportunityId)).toEqual([]);
  });
});

describe("reassignment", () => {
  async function unavailableDay(harness: Harness, closerId: Id<"users">) {
    const admin = await user(harness, "user_admin");
    return await harness.t.run((ctx) =>
      ctx.db.insert("closerUnavailability", {
        tenantId: harness.tenantId,
        closerId,
        date: Date.parse("2026-10-01T00:00:00Z"),
        isFullDay: true,
        reason: "sick",
        createdByUserId: admin._id,
        createdAt: NOW,
      }),
    );
  }

  function expectReassignment(
    rows: Doc<"dealAttributions">[],
    meeting: Doc<"meetings"> | null,
    to: Doc<"users">,
    from: Doc<"users">,
    at: number,
  ) {
    const reassigned = ofRole(rows, "closer").filter((row) => row.source.kind === "reassignment");
    expect(reassigned).toHaveLength(1);
    expect(reassigned[0]).toMatchObject({
      teamMemberId: to.teamMemberId,
      source: { kind: "reassignment", userId: to._id, fromUserId: from._id },
      attributedAt: at,
    });
    expect(reassigned[0].meetingId).toBe(meeting?._id);
    expect(reassigned[0].meetingScheduledAt).toBe(meeting?.scheduledAt);
    expect(to.teamMemberId).toBeDefined();
  }

  it("auto-distribution adds a reassignment row and keeps the booking's", async () => {
    const harness = await setup();
    const closer = await user(harness, "user_closer");
    const closer2 = await secondCloser(harness);
    const meeting = await book(harness, "busy", { createdAt: Date.parse("2026-09-30T10:00:00Z") });
    const unavailabilityId = await unavailableDay(harness, closer._id);
    vi.setSystemTime(new Date(NOW));

    const result = await harness.admin.mutation(api.unavailability.redistribution.autoDistributeMeetings, {
      unavailabilityId,
      meetingIds: [meeting._id],
      candidateCloserIds: [closer2._id],
    });
    expect(result.assigned).toHaveLength(1);

    const rows = await dealRows(harness, meeting.opportunityId);
    expect(ofRole(rows, "closer").filter((row) => row.source.kind === "booking_closer")).toHaveLength(1);
    expectReassignment(rows, meeting, await user(harness, "user_closer2"), closer, NOW);
  });

  it("a manual reassignment adds a reassignment row", async () => {
    const harness = await setup();
    const closer = await user(harness, "user_closer");
    const closer2 = await secondCloser(harness);
    const meeting = await book(harness, "busy", { createdAt: Date.parse("2026-09-30T10:00:00Z") });
    const unavailabilityId = await unavailableDay(harness, closer._id);
    vi.setSystemTime(new Date(NOW));

    await harness.admin.mutation(api.unavailability.redistribution.manuallyResolveMeeting, {
      meetingId: meeting._id,
      unavailabilityId,
      action: "assign",
      targetCloserId: closer2._id,
    });

    const rows = await dealRows(harness, meeting.opportunityId);
    expect(roles(rows)).toEqual(["closer", "closer"]);
    expectReassignment(rows, meeting, await user(harness, "user_closer2"), closer, NOW);
  });

  it("an admin's reminder payment for another closer adds a deal-level reassignment row", async () => {
    const harness = await setup();
    const closer = await user(harness, "user_closer");
    const closer2 = await secondCloser(harness);
    const meeting = await book(harness, "reminded", { createdAt: Date.parse("2026-09-30T10:00:00Z") });
    const programId = await program(harness);
    const followUpId = await harness.t.run(async (ctx) => {
      const deal = (await ctx.db.get("opportunities", meeting.opportunityId))!;
      return await ctx.db.insert("followUps", {
        tenantId: harness.tenantId,
        opportunityId: deal._id,
        leadId: deal.leadId,
        closerId: closer2._id,
        type: "manual_reminder",
        reason: "admin_initiated",
        status: "pending",
        createdAt: NOW - MINUTE,
      });
    });
    vi.setSystemTime(new Date(NOW));

    await harness.admin.mutation(api.closer.reminderOutcomes.logReminderPayment, {
      followUpId,
      amount: 100,
      currency: "USD",
      programId,
      paymentType: "pif",
    });

    expect((await get(harness, "opportunities", meeting.opportunityId))?.assignedCloserId).toBe(closer2._id);
    expectReassignment(
      await dealRows(harness, meeting.opportunityId),
      null,
      await user(harness, "user_closer2"),
      closer,
      NOW,
    );
  });
});

describe("person touches", () => {
  async function person(harness: Harness, status: "active" | "merged" = "active") {
    return await harness.t.run((ctx) =>
      ctx.db.insert("leads", {
        ...qualifiedLifecycle(NOW),
        tenantId: harness.tenantId,
        email: "lead@example.com",
        status,
        firstSeenAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  async function emitLeadEvent(
    harness: Harness,
    leadId: Id<"leads">,
    eventType: string,
    occurredAt: number,
  ) {
    return await harness.t.run((ctx) =>
      emitDomainEvent(ctx, {
        tenantId: harness.tenantId,
        entityType: "lead",
        entityId: leadId,
        eventType,
        source: "pipeline",
        occurredAt,
        skipAnalytics: true,
      }),
    );
  }

  it("keeps the earliest touch first and moves latest to each newer one", async () => {
    const harness = await setup();
    const leadId = await person(harness);

    const captured = await emitLeadEvent(harness, leadId, "lead.captured", NOW);
    const touchOf = (eventId: Id<"domainEvents">, eventType: string, channel: string, occurredAt: number) =>
      ({ eventId, eventType, channel, occurredAt });
    expect(await get(harness, "leads", leadId)).toMatchObject({
      firstTouch: touchOf(captured, "lead.captured", "lead_gen", NOW),
      latestTouch: touchOf(captured, "lead.captured", "lead_gen", NOW),
    });

    const qualified = await emitLeadEvent(harness, leadId, "lead.slack_qualified", NOW + MINUTE);
    expect(await get(harness, "leads", leadId)).toMatchObject({
      firstTouch: touchOf(captured, "lead.captured", "lead_gen", NOW),
      latestTouch: touchOf(qualified, "lead.slack_qualified", "slack", NOW + MINUTE),
    });

    // A webhook processed late carries an earlier time: it becomes the first touch.
    const note = await emitLeadEvent(harness, leadId, "lead.portal_note_added", NOW - MINUTE);
    const lead = await get(harness, "leads", leadId);
    expect(lead).toMatchObject({
      firstTouch: touchOf(note, "lead.portal_note_added", "dm_portal", NOW - MINUTE),
      latestTouch: touchOf(qualified, "lead.slack_qualified", "slack", NOW + MINUTE),
    });
    expect(lead?.updatedAt).toBe(NOW);
  });

  it("a Calendly deal's opportunity.created and an outcome are not touches", async () => {
    const harness = await setup();
    const leadId = await person(harness);
    const opportunityId = await harness.t.run((ctx) =>
      ctx.db.insert("opportunities", {
        tenantId: harness.tenantId, leadId, status: "scheduled", source: "calendly",
        createdAt: NOW, updatedAt: NOW,
      }),
    );

    await harness.t.run(async (ctx) => {
      await emitDomainEvent(ctx, {
        tenantId: harness.tenantId, entityType: "opportunity", entityId: opportunityId,
        eventType: "opportunity.created", source: "pipeline", metadata: { leadId },
        occurredAt: NOW, skipAnalytics: true,
      });
      await emitDomainEvent(ctx, {
        tenantId: harness.tenantId, entityType: "opportunity", entityId: opportunityId,
        eventType: "opportunity.status_changed", source: "closer", fromStatus: "scheduled",
        toStatus: "lost", occurredAt: NOW, skipAnalytics: true,
      });
    });

    const lead = await get(harness, "leads", leadId);
    expect(lead?.firstTouch).toBeUndefined();
    expect(lead?.latestTouch).toBeUndefined();
  });

  it("a merged person isn't patched", async () => {
    const harness = await setup();
    const leadId = await person(harness, "merged");

    await emitLeadEvent(harness, leadId, "lead.captured", NOW);

    const lead = await get(harness, "leads", leadId);
    expect(lead?.firstTouch).toBeUndefined();
    expect(lead?.latestTouch).toBeUndefined();
  });
});

describe("merges and moves", () => {
  it("a person merge keeps the earlier first touch and the later latest touch", async () => {
    const harness = await setup();
    await qualify(harness, { handle: "ana.old", submittedAt: NOW - 5 * 24 * 60 * MINUTE });
    vi.setSystemTime(new Date(NOW + MINUTE));
    await qualify(harness, { handle: "ana.new", submittedAt: NOW });
    const [sourceId, targetId] = await harness.t.run(async (ctx) =>
      (await ctx.db.query("leads").take(3)).map((lead) => lead._id),
    );
    const before = {
      source: (await get(harness, "leads", sourceId))!,
      target: (await get(harness, "leads", targetId))!,
    };
    expect(before.source.firstTouch!.occurredAt).toBeLessThan(before.target.firstTouch!.occurredAt);
    expect(before.source.latestTouch!.occurredAt).toBeLessThan(before.target.latestTouch!.occurredAt);
    vi.setSystemTime(new Date(NOW + 2 * MINUTE));

    await harness.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: sourceId, targetLeadId: targetId });

    const merged = await get(harness, "leads", targetId);
    expect(merged?.firstTouch).toEqual(before.source.firstTouch);
    expect(merged?.latestTouch).toEqual(before.target.latestTouch);
  });

  it("a person merge takes the source's latest touch when it is newer", async () => {
    const harness = await setup();
    await qualify(harness, { handle: "ana.old", submittedAt: NOW - 5 * 24 * 60 * MINUTE });
    vi.setSystemTime(new Date(NOW + MINUTE));
    await qualify(harness, { handle: "ana.new", submittedAt: NOW });
    const [sourceId, targetId] = await harness.t.run(async (ctx) =>
      (await ctx.db.query("leads").take(3)).map((lead) => lead._id),
    );
    vi.setSystemTime(new Date(NOW + 2 * MINUTE));
    await capture(harness, "ana.old");
    const source = (await get(harness, "leads", sourceId))!;
    const target = (await get(harness, "leads", targetId))!;
    expect(source.latestTouch!.occurredAt).toBeGreaterThan(target.latestTouch!.occurredAt);

    await harness.admin.mutation(api.leads.merge.mergeLead, { sourceLeadId: sourceId, targetLeadId: targetId });

    const merged = await get(harness, "leads", targetId);
    expect(merged?.firstTouch).toEqual(source.firstTouch);
    expect(merged?.latestTouch).toEqual(source.latestTouch);
  });

  it("a meeting moved to another deal takes its rows along", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    await dmCloser(harness, teamId, "dana");
    const moved = await book(harness, "moved", {
      createdAt: NOW - 2 * 60 * MINUTE,
      tracking: { utm_source: "team-a", utm_medium: "dana" },
    });
    const other = await book(harness, "other", {
      createdAt: NOW - 60 * MINUTE,
      email: "other@example.com",
    });
    expect(other.opportunityId).not.toBe(moved.opportunityId);

    await harness.t.run((ctx) =>
      moveMeetingToOpportunity(ctx, {
        tenantId: harness.tenantId,
        meetingId: moved._id,
        toOpportunityId: other.opportunityId,
        leadName: "Other",
      }),
    );

    expect(await dealRows(harness, moved.opportunityId)).toEqual([]);
    const rows = await dealRows(harness, other.opportunityId);
    expect(roles(rows)).toEqual(["closer", "closer", "dm_closer", "dm_team"]);
    expect(rows.filter((row) => row.meetingId === moved._id)).toHaveLength(3);
  });

  it("a team member merge repoints the rows that credit them", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    const dana = await dmCloser(harness, teamId, "dana");
    const meeting = await book(harness, "first", {
      createdAt: NOW - 60 * MINUTE,
      tracking: { utm_source: "team-a", utm_medium: "dana" },
    });
    const admin = await user(harness, "user_admin");
    const into = (await user(harness, "user_closer")).teamMemberId!;

    const result = await harness.t.mutation(internal.teamMembers.linking.applyApprovedLinks, {
      tenantId: harness.tenantId,
      approvedByUserId: admin._id,
      links: [{ fromTeamMemberId: dana.teamMemberId!, intoTeamMemberId: into }],
    });

    expect(result.unfinished).toEqual([]);
    const [row] = ofRole(await dealRows(harness, meeting.opportunityId), "dm_closer");
    expect(row.teamMemberId).toBe(into);
    expect(row.source).toEqual({ kind: "booking_utm", dmCloserId: dana._id });
    expect(await get(harness, "teamMembers", dana.teamMemberId!)).toBeNull();
  });

  it("a team member merge keeps the team member until every row is repointed", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    const dana = await dmCloser(harness, teamId, "dana");
    const meeting = await book(harness, "first", { createdAt: NOW - 60 * MINUTE });
    const admin = await user(harness, "user_admin");
    const into = (await user(harness, "user_closer")).teamMemberId!;
    await harness.t.run(async (ctx) => {
      for (let i = 0; i < 201; i++) {
        await ctx.db.insert("dealAttributions", {
          tenantId: harness.tenantId,
          opportunityId: meeting.opportunityId,
          role: "dm_closer",
          teamMemberId: dana.teamMemberId,
          source: { kind: "booking_utm", dmCloserId: dana._id },
          attributedAt: NOW + i,
          createdAt: NOW,
        });
      }
    });
    const link = { fromTeamMemberId: dana.teamMemberId!, intoTeamMemberId: into };
    const apply = () =>
      harness.t.mutation(internal.teamMembers.linking.applyApprovedLinks, {
        tenantId: harness.tenantId,
        approvedByUserId: admin._id,
        links: [link],
      });

    expect((await apply()).unfinished).toEqual([link]);
    expect(await get(harness, "teamMembers", dana.teamMemberId!)).not.toBeNull();
    expect((await apply()).unfinished).toEqual([]);

    const rows = ofRole(await dealRows(harness, meeting.opportunityId), "dm_closer");
    expect(rows).toHaveLength(201);
    expect(rows.every((row) => row.teamMemberId === into)).toBe(true);
    expect(await get(harness, "teamMembers", dana.teamMemberId!)).toBeNull();
  });
});

describe("role record relinks", () => {
  it("linking a DM closer to a login moves its earlier rows to that login's team member", async () => {
    const harness = await setup();
    const teamId = await dmTeam(harness);
    const dana = await dmCloser(harness, teamId, "dana");
    const meeting = await book(harness, "relink", {
      createdAt: Date.parse("2026-10-09T15:00:00Z"),
      tracking: { utm_source: "team-a", utm_medium: "dana" },
    });
    const closer = await user(harness, "user_closer");
    expect(ofRole(await dealRows(harness, meeting.opportunityId), "dm_closer")[0].teamMemberId).toBe(dana.teamMemberId);

    await harness.admin.mutation(api.attribution.dmClosers.updateDmCloser, {
      dmCloserId: dana._id,
      teamId,
      displayName: dana.displayName,
      utmMedium: dana.utmMedium,
      userId: closer._id,
    });
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);

    const relinked = await harness.t.run((ctx) => ctx.db.get("dmClosers", dana._id));
    expect(relinked?.teamMemberId).toBe(closer.teamMemberId);
    const rows = await dealRows(harness, meeting.opportunityId);
    expect(ofRole(rows, "dm_closer")[0]).toMatchObject({
      teamMemberId: closer.teamMemberId,
      source: { kind: "booking_utm", dmCloserId: dana._id },
    });
    // The closer row already credited the login's team member.
    expect(ofRole(rows, "closer")[0].teamMemberId).toBe(closer.teamMemberId);
  });
});

describe("credit names a team member", () => {
  it("a setter with no Slack user record gets no row", async () => {
    const harness = await setup();
    await qualify(harness, { handle: "ana", submittedAt: NOW });
    const deal = await harness.t.run(async (ctx) => (await ctx.db.query("opportunities").first())!);
    await harness.t.run(async (ctx) => {
      await recordSetterAttribution(ctx, {
        tenantId: harness.tenantId,
        opportunityId: deal._id,
        slackUserId: "U_GONE",
        submittedAt: NOW,
      });
    });
    const setters = ofRole(await dealRows(harness, deal._id), "setter");
    expect(setters).toHaveLength(1);
    expect(setters.every((row) => row.teamMemberId !== undefined)).toBe(true);
  });
});
