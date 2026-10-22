import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import {
  recordBookingAttribution,
  recordDealCreation,
  recordSetterAttribution,
} from "../convex/lib/attribution/dealAttributions";
import { computePersonTouches } from "../convex/lib/touches";
import type { UtmParams } from "../convex/lib/utmParams";
import { qualifiedLifecycle } from "./bookingHarness";
import { stageFields } from "./dealStageFixtures";

// Deals, bookings and their attribution rows as production holds them after
// Phase 3 (docs/plans/phase-3-attribution.md §4): every booking has its rows,
// and keeps its own resolution.

export const T0 = Date.parse("2026-09-01T12:00:00Z");
const HOUR = 60 * 60 * 1000;

type Resolution = NonNullable<Doc<"meetings">["attributionResolution"]>;

export async function userByWorkosId(ctx: MutationCtx, workosUserId: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
    .unique();
  if (!user) throw new Error(`No user ${workosUserId}`);
  return user;
}

export async function insertTeamMember(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  displayName: string,
) {
  return await ctx.db.insert("teamMembers", {
    tenantId,
    displayName,
    createdAt: T0,
    updatedAt: T0,
  });
}

export async function insertTeam(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  displayName: string,
  utmSource: string,
) {
  return await ctx.db.insert("attributionTeams", {
    tenantId,
    slug: utmSource,
    displayName,
    utmSource,
    normalizedUtmSource: utmSource,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
  });
}

/** An unlinked DM closer with its own team member. */
export async function insertDmCloser(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    teamId: Id<"attributionTeams">;
    displayName: string;
    utmMedium: string;
    teamMemberName?: string;
  },
) {
  const teamMemberId = await insertTeamMember(
    ctx,
    args.tenantId,
    args.teamMemberName ?? args.displayName,
  );
  const dmCloserId = await ctx.db.insert("dmClosers", {
    tenantId: args.tenantId,
    teamId: args.teamId,
    slug: args.utmMedium,
    displayName: args.displayName,
    utmMedium: args.utmMedium,
    normalizedUtmMedium: args.utmMedium,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    teamMemberId,
  });
  return { dmCloserId, teamMemberId };
}

export async function insertPerson(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  fullName = "Ana Lead",
) {
  return await ctx.db.insert("leads", {
    tenantId,
    fullName,
    email: `${fullName.toLowerCase().replaceAll(" ", ".")}@example.com`,
    firstSeenAt: T0,
    updatedAt: T0,
    status: "active",
    ...qualifiedLifecycle(T0),
  });
}

export async function insertDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    closerId: Id<"users">;
    source: NonNullable<Doc<"opportunities">["source"]>;
    createdAt?: number;
  },
) {
  const createdAt = args.createdAt ?? T0;
  return await ctx.db.insert("opportunities", {
    tenantId: args.tenantId,
    leadId: args.leadId,
    assignedCloserId: args.closerId,
    ...stageFields(args.source === "slack_qualified" ? "qualified_pending" : "scheduled", args.source),
    createdAt,
    updatedAt: createdAt,
    ...(args.source === "slack_qualified"
      ? {
          qualifiedBy: { slackUserId: "U1", slackTeamId: "T1", submittedAt: createdAt },
          qualifiedAt: createdAt,
        }
      : {}),
  });
}

/**
 * A booking: the meeting, its `meeting.created` event, and its rows through
 * the pipeline's own writer. `resolution` undefined is a meeting that was
 * never resolved, which gets only its closer row (D11). The first external
 * booking fills the deal's first booking fields, as the pipeline does.
 */
export async function insertBooking(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    createdAt: number;
    utmParams?: UtmParams;
    resolution?: Resolution;
    teamId?: Id<"attributionTeams">;
    dmCloserId?: Id<"dmClosers">;
  },
) {
  const opportunity = await ctx.db.get("opportunities", args.opportunityId);
  if (!opportunity) throw new Error("No deal");
  const resolved = args.resolution !== undefined;
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    assignedCloserId: args.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${args.createdAt}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${args.createdAt}/invitees/1`,
    scheduledAt: args.createdAt + 24 * HOUR,
    durationMinutes: 30,
    status: "scheduled",
    callClassification: opportunity.firstMeetingId ? "follow_up" : "new",
    createdAt: args.createdAt,
    utmParams: args.utmParams,
    attributionResolution: args.resolution,
  });
  const meeting = (await ctx.db.get("meetings", meetingId))!;
  await recordBookingAttribution(ctx, {
    meeting,
    credit: resolved ? { teamId: args.teamId, dmCloserId: args.dmCloserId } : {},
  });
  const eventId = await ctx.db.insert("domainEvents", {
    tenantId: args.tenantId,
    entityType: "meeting",
    entityId: meetingId,
    eventType: "meeting.created",
    occurredAt: args.createdAt,
    source: "pipeline",
    leadId: opportunity.leadId,
  });

  const internal = args.utmParams?.utm_source === "ptdom";
  if (!internal && !opportunity.firstMeetingId) {
    await ctx.db.patch("opportunities", opportunity._id, {
      firstMeetingId: meetingId,
      firstMeetingAt: meeting.scheduledAt,
      firstBookedAt: meeting.scheduledAt,
      ...(args.utmParams ? { utmParams: args.utmParams } : {}),
    });
  }
  return { meeting, eventId };
}

const DAY = 24 * HOUR;

/**
 * A deal that holds every role: a capture by a lead gen worker, a Slack
 * qualification that created the deal, then a booking through Alpha Team and
 * Dana DM and a rebook through Alpha Team and Dirk DM. The deal's touches
 * are snapshotted and its lead gen row written by `recordDealCreation`, and
 * the person's touches computed from the events, as the backfills do.
 */
export async function seedCreditedDeal(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const closer = await userByWorkosId(ctx, "user_closer");
  const teamId = await insertTeam(ctx, tenantId, "Alpha Team", "alpha");
  const dana = await insertDmCloser(ctx, { tenantId, teamId, displayName: "Dana DM", utmMedium: "dana" });
  const dirk = await insertDmCloser(ctx, { tenantId, teamId, displayName: "Dirk DM", utmMedium: "dirk" });
  const leadId = await insertPerson(ctx, tenantId);

  // The lead gen worker, who has a login.
  const workerTeamMemberId = await insertTeamMember(ctx, tenantId, "Wendy Worker");
  const workerUserId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: "user_worker",
    email: "wendy@example.com",
    fullName: "Wendy W.",
    role: "lead_generator",
    isActive: true,
    teamMemberId: workerTeamMemberId,
  });
  const workerId = await ctx.db.insert("leadGenWorkers", {
    tenantId,
    userId: workerUserId,
    workosUserId: "user_worker",
    email: "wendy@example.com",
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    teamMemberId: workerTeamMemberId,
  });
  const capturedAt = T0 - 3 * DAY;
  const prospectId = await ctx.db.insert("leadGenProspects", {
    tenantId,
    firstSource: "instagram",
    latestSource: "instagram",
    dedupeKey: "instagram:ana.lead",
    normalizedHandle: "ana.lead",
    rawHandle: "@ana.lead",
    profileUrl: "https://instagram.com/ana.lead",
    firstCapturedByWorkerId: workerId,
    firstCapturedAt: capturedAt,
    lastSubmittedByWorkerId: workerId,
    lastSubmittedAt: capturedAt,
    latestOriginKind: "follower",
    contactAttemptCount: 1,
    distinctWorkerCount: 1,
    leadId,
    createdAt: capturedAt,
    updatedAt: capturedAt,
  });
  const captureEventId = await ctx.db.insert("domainEvents", {
    tenantId,
    entityType: "lead",
    entityId: leadId,
    eventType: "lead.captured",
    occurredAt: capturedAt,
    source: "closer",
    metadata: JSON.stringify({ prospectId, workerId }),
    leadId,
    teamMemberId: workerTeamMemberId,
  });

  // The setter, a Slack user with an avatar.
  const setterTeamMemberId = await insertTeamMember(ctx, tenantId, "Sam Setter");
  const installationId = await ctx.db.insert("slackInstallations", {
    tenantId, teamId: "T1", teamName: "Team", isEnterpriseInstall: false, appId: "A1",
    botUserId: "B1", botAccessToken: "xoxb", scopes: [], installedByWorkosUserId: "user_admin",
    installedAt: 0, tokenExpiresAt: 0, refreshToken: "r", status: "active",
  });
  await ctx.db.insert("slackUsers", {
    tenantId,
    installationId,
    slackUserId: "U1",
    slackTeamId: "T1",
    realName: "Sam S.",
    avatarUrl: "https://example.com/sam.png",
    isBot: false,
    isDeleted: false,
    firstSeenAt: T0,
    lastSeenAt: T0,
    lastSyncedAt: T0,
    teamMemberId: setterTeamMemberId,
  });
  const qualifiedAt = T0 - 2 * DAY;
  const opportunityId = await insertDeal(ctx, {
    tenantId, leadId, closerId: closer._id, source: "slack_qualified", createdAt: qualifiedAt,
  });
  const dealEventId = await ctx.db.insert("domainEvents", {
    tenantId,
    entityType: "opportunity",
    entityId: opportunityId,
    eventType: "opportunity.created",
    occurredAt: qualifiedAt,
    source: "pipeline",
    metadata: JSON.stringify({ source: "slack_qualified" }),
    leadId,
    teamMemberId: setterTeamMemberId,
  });
  await recordSetterAttribution(ctx, {
    tenantId, opportunityId, slackUserId: "U1", submittedAt: qualifiedAt,
  });
  await recordDealCreation(ctx, opportunityId);

  const base = { tenantId, opportunityId, closerId: closer._id, resolution: "mapped" as const, teamId };
  const first = await insertBooking(ctx, {
    ...base,
    createdAt: T0,
    utmParams: { utm_source: "alpha", utm_medium: "dana" },
    dmCloserId: dana.dmCloserId,
  });
  const rebook = await insertBooking(ctx, {
    ...base,
    createdAt: T0 + 2 * DAY,
    utmParams: { utm_source: "alpha", utm_medium: "dirk" },
    dmCloserId: dirk.dmCloserId,
  });
  await ctx.db.patch("leads", leadId, await computePersonTouches(ctx, { tenantId, leadId }));

  return {
    leadId,
    opportunityId,
    teamId,
    closer,
    dana,
    dirk,
    workerTeamMemberId,
    setterTeamMemberId,
    captureEventId,
    dealEventId,
    capturedAt,
    qualifiedAt,
    first,
    rebook,
  };
}

export type ScenarioName =
  | "team_and_dm_closer"
  | "team_only"
  | "unresolved_rebook"
  | "internal_rebook"
  | "no_bookings";

/** One deal per scenario, and the meeting its detail page would show. */
export async function seedScenario(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  scenario: ScenarioName,
) {
  const closer = await userByWorkosId(ctx, "user_closer");
  const teamId = await insertTeam(ctx, tenantId, "Alpha Team", "alpha");
  const dm = await insertDmCloser(ctx, {
    tenantId,
    teamId,
    displayName: "Dana DM",
    utmMedium: "dana",
  });
  const leadId = await insertPerson(ctx, tenantId);
  const base = { tenantId, closerId: closer._id };

  if (scenario === "no_bookings") {
    const opportunityId = await insertDeal(ctx, {
      tenantId, leadId, closerId: closer._id, source: "slack_qualified",
    });
    return { opportunityId, meetingId: null, teamId, dm, closer };
  }

  const opportunityId = await insertDeal(ctx, {
    tenantId, leadId, closerId: closer._id, source: "calendly",
  });
  const mappedFirst = () =>
    insertBooking(ctx, {
      ...base,
      opportunityId,
      createdAt: T0,
      utmParams: { utm_source: "alpha", utm_medium: "dana" },
      resolution: "mapped",
      teamId,
      dmCloserId: dm.dmCloserId,
    });

  if (scenario === "team_and_dm_closer") {
    const { meeting } = await mappedFirst();
    return { opportunityId, meetingId: meeting._id, teamId, dm, closer };
  }
  if (scenario === "team_only") {
    const { meeting } = await insertBooking(ctx, {
      ...base,
      opportunityId,
      createdAt: T0,
      utmParams: { utm_source: "alpha" },
      resolution: "mapped",
      teamId,
    });
    return { opportunityId, meetingId: meeting._id, teamId, dm, closer };
  }
  await mappedFirst();
  if (scenario === "unresolved_rebook") {
    const { meeting } = await insertBooking(ctx, {
      ...base,
      opportunityId,
      createdAt: T0 + 48 * HOUR,
    });
    return { opportunityId, meetingId: meeting._id, teamId, dm, closer };
  }
  const { meeting } = await insertBooking(ctx, {
    ...base,
    opportunityId,
    createdAt: T0 + 48 * HOUR,
    utmParams: { utm_source: "ptdom" },
    resolution: "internal",
  });
  return { opportunityId, meetingId: meeting._id, teamId, dm, closer };
}
