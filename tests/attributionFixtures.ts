import migrationsTest from "@convex-dev/migrations/test";
import { vi } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import {
  qualificationCreditsSetter,
  recordBookingAttribution,
  recordCloserReassignment,
  recordDealCreation,
  recordSetterAttribution,
} from "../convex/lib/attribution/dealAttributions";
import { computePersonTouches } from "../convex/lib/touches";
import { migrations } from "../convex/migrations";
import { rebuildQualificationRow } from "../convex/operations/projections";
import { bookingHarness, qualifiedLifecycle } from "./bookingHarness";

// Phase 3 attribution data as production holds it after the phase
// (docs/plans/phase-3-attribution.md §4): touch events, qualification
// events, each person's first and latest touch, each deal's snapshot, and the
// attribution rows each booking, deal and qualification writes. Meetings keep
// their resolution; nothing holds a copied team or DM closer.

export const AT = {
  CAPTURED: Date.parse("2026-08-01T10:00:00Z"),
  SLACK_TOUCH: Date.parse("2026-08-03T09:59:00Z"),
  QUALIFIED: Date.parse("2026-08-03T10:00:00Z"),
  JOINED: Date.parse("2026-08-03T12:00:00Z"),
  BOOKED: Date.parse("2026-08-04T10:00:00Z"),
  CALL: Date.parse("2026-08-06T15:00:00Z"),
  REBOOKED: Date.parse("2026-08-07T10:00:00Z"),
  RECALL: Date.parse("2026-08-09T15:00:00Z"),
  CALENDLY_BOOKED: Date.parse("2026-08-10T10:00:00Z"),
  CALENDLY_CALL: Date.parse("2026-08-12T15:00:00Z"),
  REASSIGNED: Date.parse("2026-08-11T10:00:00Z"),
  TEAM_ONLY_BOOKED: Date.parse("2026-08-14T10:00:00Z"),
  TEAM_ONLY_CALL: Date.parse("2026-08-16T15:00:00Z"),
  EARLY_SLACK: Date.parse("2026-05-05T10:00:00Z"),
  SIDE_DEAL: Date.parse("2026-08-18T10:00:00Z"),
  LATER: Date.parse("2026-08-20T10:00:00Z"),
};

export type AttributionHarness = Awaited<ReturnType<typeof attributionHarness>>;

export async function attributionHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  const harness = await bookingHarness();
  migrationsTest.register(harness.t);
  const ids = await harness.t.run(async (ctx) => {
    const seeded = await seed(ctx, harness.tenantId);
    await writeAttribution(ctx, seeded);
    return seeded;
  });

  async function status(name: string) {
    await harness.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [result] = await harness.t.run((ctx) =>
      migrations.getStatus(ctx, { migrations: [`migrations:${name}`] as never }),
    );
    return result;
  }
  async function run(name: string) {
    await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}` });
    return await status(name);
  }
  async function rerun(name: string) {
    await harness.t.mutation(internal.migrations.run, { fn: `migrations:${name}`, reset: true });
    return await status(name);
  }
  return { ...harness, ids, run, rerun };
}

export async function attributionRows(harness: AttributionHarness) {
  return await harness.t.run((ctx) => ctx.db.query("dealAttributions").take(500));
}

async function teamMember(ctx: MutationCtx, tenantId: Id<"tenants">, displayName: string) {
  return await ctx.db.insert("teamMembers", { tenantId, displayName, createdAt: 0, updatedAt: 0 });
}

async function user(ctx: MutationCtx, workosUserId: string): Promise<Doc<"users">> {
  return (await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique())!;
}

type Seeded = Awaited<ReturnType<typeof seed>>;

/**
 * What the live write paths leave behind (§5): each person's touches
 * (`recordPersonTouch`), each deal's snapshot and its lead gen and side deal
 * rows (`recordDealCreation`), a setter row for each qualification that
 * credits one, the Slack deal older than the qualification events through its
 * `qualifiedBy`, and the rows of every booking (§4.1). The booking never
 * resolved went to the admin, and its reassignment moved it on (§4.6).
 */
async function writeAttribution(ctx: MutationCtx, seeded: Seeded) {
  const { tenantId, leads, opportunities, meetings, teamA, teamB, dana, adminId, closerId } = seeded;
  for (const leadId of [leads.p1, leads.p2, leads.p3, leads.p4, leads.p5]) {
    await ctx.db.patch("leads", leadId, await computePersonTouches(ctx, { tenantId, leadId }));
  }
  for (const opportunityId of Object.values(opportunities)) {
    await recordDealCreation(ctx, opportunityId);
  }

  for (const qualificationEventId of Object.values(seeded.qualifications)) {
    const event = (await ctx.db.get("slackQualificationEvents", qualificationEventId))!;
    if (!event.opportunityId || !qualificationCreditsSetter(event.resultKind)) continue;
    await recordSetterAttribution(ctx, {
      tenantId, opportunityId: event.opportunityId, slackUserId: event.slackUserId,
      submittedAt: event.submittedAt, qualificationEventId,
    });
  }
  await recordSetterAttribution(ctx, {
    tenantId, opportunityId: opportunities.o3, slackUserId: "U2", submittedAt: AT.EARLY_SLACK,
  });

  const book = async (meetingId: Id<"meetings">, credit: Parameters<typeof recordBookingAttribution>[1]["credit"]) =>
    await recordBookingAttribution(ctx, { meeting: (await ctx.db.get("meetings", meetingId))!, credit });
  await book(meetings.m1, { teamId: teamA, dmCloserId: dana });
  await book(meetings.m2, { teamId: teamB });
  await book(meetings.m4, { teamId: teamA });

  await book(meetings.m3, {});
  await ctx.db.patch("meetings", meetings.m3, { assignedCloserId: closerId, reassignedFromCloserId: adminId });
  await ctx.db.insert("meetingReassignments", {
    tenantId, meetingId: meetings.m3, opportunityId: opportunities.o2, fromCloserId: adminId, toCloserId: closerId,
    reason: "unavailable", reassignedByUserId: adminId, reassignedAt: AT.REASSIGNED,
  });
  await recordCloserReassignment(ctx, {
    tenantId, opportunityId: opportunities.o2, meeting: (await ctx.db.get("meetings", meetings.m3))!,
    toUserId: closerId, fromUserId: adminId, at: AT.REASSIGNED,
  });
}

async function seed(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const admin = await user(ctx, "user_admin");
  const closer = await user(ctx, "user_closer");
  const tm = {
    admin: await teamMember(ctx, tenantId, "Admin"),
    closer: await teamMember(ctx, tenantId, "Closer"),
    dana: await teamMember(ctx, tenantId, "Dana"),
    u1: await teamMember(ctx, tenantId, "Setter One"),
    u2: await teamMember(ctx, tenantId, "Setter Two"),
    u3: await teamMember(ctx, tenantId, "Setter Three"),
  };
  await ctx.db.patch("users", admin._id, { teamMemberId: tm.admin });
  await ctx.db.patch("users", closer._id, { teamMemberId: tm.closer });

  const installationId = await ctx.db.insert("slackInstallations", {
    tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1", botUserId: "B1",
    botAccessToken: "xoxb", scopes: [], notifyChannelId: "C1", notifyChannelName: "qualified",
    installedByWorkosUserId: "user_admin", installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
  });
  for (const [slackUserId, teamMemberId] of [["U1", tm.u1], ["U2", tm.u2], ["U3", tm.u3]] as const) {
    await ctx.db.insert("slackUsers", {
      tenantId, installationId, slackUserId, slackTeamId: "T1", realName: slackUserId, isBot: false,
      isDeleted: false, firstSeenAt: 0, lastSeenAt: 0, lastSyncedAt: 0, teamMemberId,
    });
  }

  const team = (slug: string) =>
    ctx.db.insert("attributionTeams", {
      tenantId, slug, displayName: slug, utmSource: slug, normalizedUtmSource: slug, isActive: true,
      createdAt: 0, updatedAt: 0,
    });
  const teamA = await team("alpha");
  const teamB = await team("bravo");
  const dana = await ctx.db.insert("dmClosers", {
    tenantId, teamId: teamA, slug: "dana", displayName: "Dana", utmMedium: "dana", normalizedUtmMedium: "dana",
    isActive: true, createdAt: 0, updatedAt: 0, teamMemberId: tm.dana,
  });
  const workerId = await ctx.db.insert("leadGenWorkers", {
    tenantId, userId: admin._id, workosUserId: "user_admin", email: "admin@example.com", isActive: true,
    createdAt: 0, updatedAt: 0, teamMemberId: tm.admin,
  });

  const lead = (fields: Partial<Doc<"leads">> = {}) =>
    ctx.db.insert("leads", {
      ...qualifiedLifecycle(0), tenantId, status: "active", firstSeenAt: 0, updatedAt: 0, ...fields,
    });
  const event = (fields: {
    entityType: "lead" | "opportunity" | "meeting";
    entityId: string;
    eventType: string;
    occurredAt: number;
    leadId: Id<"leads">;
    metadata?: Record<string, unknown>;
  }) =>
    ctx.db.insert("domainEvents", {
      tenantId, source: "pipeline", ...fields,
      metadata: fields.metadata ? JSON.stringify(fields.metadata) : undefined,
    });
  const meeting = (fields: Partial<Doc<"meetings">> & Pick<Doc<"meetings">, "opportunityId" | "scheduledAt" | "createdAt">) =>
    ctx.db.insert("meetings", {
      tenantId, assignedCloserId: closer._id, calendlyEventUri: `e-${fields.createdAt}`,
      calendlyInviteeUri: `i-${fields.createdAt}`, durationMinutes: 30, status: "scheduled", ...fields,
    });

  // P1: captured by lead gen, qualified in Slack, booked through Dana, then
  // rebooked through team B with no DM closer. A lead merged into P1 holds
  // P1's latest touch.
  const p1 = await lead({ updatedAt: 123 });
  const prospectId = await ctx.db.insert("leadGenProspects", {
    tenantId, leadId: p1, firstSource: "instagram", latestSource: "instagram", dedupeKey: "instagram:p1",
    normalizedHandle: "p1", rawHandle: "p1", profileUrl: "https://instagram.com/p1",
    firstCapturedByWorkerId: workerId, firstCapturedAt: AT.CAPTURED, lastSubmittedByWorkerId: workerId,
    lastSubmittedAt: AT.CAPTURED, latestOriginKind: "follower", contactAttemptCount: 1, distinctWorkerCount: 1,
    createdAt: AT.CAPTURED, updatedAt: AT.CAPTURED,
  });
  const o1 = await ctx.db.insert("opportunities", {
    tenantId, leadId: p1, status: "scheduled", source: "slack_qualified", assignedCloserId: closer._id,
    qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: AT.QUALIFIED }, qualifiedAt: AT.QUALIFIED,
    createdAt: AT.QUALIFIED, updatedAt: AT.QUALIFIED,
  });
  const m1 = await meeting({
    opportunityId: o1, scheduledAt: AT.CALL, createdAt: AT.BOOKED, status: "completed", callClassification: "new",
    attributionResolution: "mapped",
  });
  const m2 = await meeting({
    opportunityId: o1, scheduledAt: AT.RECALL, createdAt: AT.REBOOKED, callClassification: "follow_up",
    attributionResolution: "mapped",
  });
  await ctx.db.patch("opportunities", o1, { firstMeetingId: m1, firstMeetingAt: AT.CALL, firstBookedAt: AT.BOOKED });
  const captured = await event({
    entityType: "lead", entityId: p1, eventType: "lead.captured", occurredAt: AT.CAPTURED, leadId: p1,
    metadata: { prospectId, workerId, source: "instagram" },
  });
  const slackTouch = await event({
    entityType: "lead", entityId: p1, eventType: "lead.slack_qualified", occurredAt: AT.SLACK_TOUCH, leadId: p1,
  });
  const o1Created = await event({
    entityType: "opportunity", entityId: o1, eventType: "opportunity.created", occurredAt: AT.QUALIFIED,
    leadId: p1, metadata: { source: "slack_qualified" },
  });
  await event({ entityType: "meeting", entityId: m1, eventType: "meeting.created", occurredAt: AT.BOOKED, leadId: p1 });
  await event({ entityType: "meeting", entityId: m2, eventType: "meeting.created", occurredAt: AT.REBOOKED, leadId: p1 });
  // Not a touch, and later than every touch.
  await event({
    entityType: "opportunity", entityId: o1, eventType: "opportunity.status_changed", occurredAt: AT.LATER + 1, leadId: p1,
  });
  const merged = await lead({ status: "merged", mergedIntoLeadId: p1 });
  await ctx.db.insert("leadMergeHistory", {
    tenantId, sourceLeadId: merged, targetLeadId: p1, mergedByUserId: admin._id, mergedAt: AT.LATER,
    identifiersMoved: 0, opportunitiesMoved: 0, meetingsMoved: 0,
  });
  const portalNote = await event({
    entityType: "lead", entityId: merged, eventType: "lead.portal_note_added", occurredAt: AT.LATER, leadId: merged,
  });

  const qualification = (fields: {
    slackUserId: string;
    resultKind: Doc<"slackQualificationEvents">["resultKind"];
    submittedAt: number;
    opportunityId?: Id<"opportunities">;
    leadId?: Id<"leads">;
  }) =>
    ctx.db.insert("slackQualificationEvents", {
      tenantId, installationId, ...fields,
      qualifiedBy: { slackUserId: fields.slackUserId, slackTeamId: "T1", submittedAt: fields.submittedAt },
      slackTeamId: "T1", fullNameSnapshot: "Person", platform: "instagram", handleSnapshot: "p",
      createdAt: fields.submittedAt,
    });
  const qualifications = {
    created: await qualification({ slackUserId: "U1", resultKind: "created_opportunity", submittedAt: AT.QUALIFIED, opportunityId: o1, leadId: p1 }),
    joined: await qualification({ slackUserId: "U2", resultKind: "duplicate_pending", submittedAt: AT.JOINED, opportunityId: o1, leadId: p1 }),
    joinedAgain: await qualification({ slackUserId: "U1", resultKind: "duplicate_pending", submittedAt: AT.JOINED + 1, opportunityId: o1, leadId: p1 }),
    alreadyBooked: await qualification({ slackUserId: "U3", resultKind: "already_booked", submittedAt: AT.LATER, opportunityId: o1, leadId: p1 }),
    unlinked: await qualification({ slackUserId: "U3", resultKind: "unlinked", submittedAt: AT.LATER }),
  };
  for (const id of Object.values(qualifications)) {
    await rebuildQualificationRow(ctx, id);
  }

  // P2: a Calendly booking never resolved, booked with the admin; the
  // reassignment in writeAttribution moves it to the closer.
  const p2 = await lead();
  const o2 = await ctx.db.insert("opportunities", {
    tenantId, leadId: p2, status: "scheduled", source: "calendly", assignedCloserId: closer._id,
    createdAt: AT.CALENDLY_BOOKED, updatedAt: AT.CALENDLY_BOOKED,
  });
  const m3 = await meeting({
    opportunityId: o2, scheduledAt: AT.CALENDLY_CALL, createdAt: AT.CALENDLY_BOOKED, callClassification: "new",
    status: "no_show", assignedCloserId: admin._id,
  });
  await ctx.db.patch("opportunities", o2, { firstMeetingId: m3, firstMeetingAt: AT.CALENDLY_CALL });
  const m3Created = await event({
    entityType: "meeting", entityId: m3, eventType: "meeting.created", occurredAt: AT.CALENDLY_BOOKED, leadId: p2,
  });

  // P3: a Slack deal older than the qualification events.
  const p3 = await lead();
  const o3 = await ctx.db.insert("opportunities", {
    tenantId, leadId: p3, status: "lost", source: "slack_qualified",
    qualifiedBy: { slackUserId: "U2", slackTeamId: "T1", submittedAt: AT.EARLY_SLACK },
    createdAt: AT.EARLY_SLACK, updatedAt: AT.EARLY_SLACK,
  });
  const o3Created = await event({
    entityType: "opportunity", entityId: o3, eventType: "opportunity.created", occurredAt: AT.EARLY_SLACK,
    leadId: p3, metadata: { source: "slack_qualified" },
  });

  // P4: a side deal.
  const p4 = await lead();
  const o4 = await ctx.db.insert("opportunities", {
    tenantId, leadId: p4, status: "payment_received", source: "side_deal", assignedCloserId: closer._id,
    createdAt: AT.SIDE_DEAL, updatedAt: AT.SIDE_DEAL,
  });
  await event({
    entityType: "opportunity", entityId: o4, eventType: "opportunity.created", occurredAt: AT.SIDE_DEAL,
    leadId: p4, metadata: { source: "side_deal" },
  });

  // P5: a first booking whose UTMs named team A and no DM closer.
  const p5 = await lead();
  const o5 = await ctx.db.insert("opportunities", {
    tenantId, leadId: p5, status: "scheduled", source: "calendly", assignedCloserId: closer._id,
    createdAt: AT.TEAM_ONLY_BOOKED, updatedAt: AT.TEAM_ONLY_BOOKED,
  });
  const m4 = await meeting({
    opportunityId: o5, scheduledAt: AT.TEAM_ONLY_CALL, createdAt: AT.TEAM_ONLY_BOOKED, callClassification: "new",
    attributionResolution: "mapped",
  });
  await ctx.db.patch("opportunities", o5, { firstMeetingId: m4, firstMeetingAt: AT.TEAM_ONLY_CALL });
  await event({ entityType: "meeting", entityId: m4, eventType: "meeting.created", occurredAt: AT.TEAM_ONLY_BOOKED, leadId: p5 });

  return {
    tenantId, adminId: admin._id, closerId: closer._id, tm, teamA, teamB, dana, workerId, prospectId,
    leads: { p1, p2, p3, p4, p5, merged },
    opportunities: { o1, o2, o3, o4, o5 },
    meetings: { m1, m2, m3, m4 },
    events: { captured, slackTouch, o1Created, portalNote, m3Created, o3Created },
    qualifications,
  };
}
