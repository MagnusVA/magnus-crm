import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  dmCloserMemberIdentity,
  slackMemberIdentity,
  type MemberAvatarIdentity,
  teamMemberIdentity,
  userMemberIdentity,
} from "../memberIdentity";
import type { TouchChannel, TouchSnapshot } from "../touches";
import {
  attributionsForDeal,
  bookingCreditForMeeting,
  bookingCreditOf,
  attributionsForMeeting,
  dealBookingCredit,
  type BookingCredit,
  type DealAttribution,
  type DealAttributionRole,
  type DealAttributionSource,
} from "./dealAttributions";

export type AttributionStatus = "mapped" | "unmapped" | "internal" | "none";

export type EntityAttributionSummary = {
  slackQualification: {
    slackUserId: string;
    slackUserLabel: string;
    slackUser: MemberAvatarIdentity;
    submittedAt: number;
    resultKind: Doc<"slackQualificationEvents">["resultKind"];
  } | null;
  bookedProgram: { id: Id<"tenantPrograms">; name: string } | null;
  soldProgram: { id: Id<"tenantPrograms">; name: string } | null;
  dmAttribution: {
    status: AttributionStatus;
    teamName: string | null;
    dmCloserName: string | null;
    dmCloser: MemberAvatarIdentity | null;
    rawSource: string | null;
    rawMedium: string | null;
  };
  phoneCloser: { id: Id<"users">; name: string; identity: MemberAvatarIdentity } | null;
  timeline: {
    qualifiedAt: number | null;
    firstBookedAt: number | null;
    firstMeetingAt: number | null;
    paymentReceivedAt: number | null;
  };
};

/** One attribution row on a deal, as the detail pages list it. */
export type AttributionCredit = {
  id: Id<"dealAttributions">;
  role: DealAttributionRole;
  /** The team member's name, or for dm_team the team's. */
  name: string | null;
  /** The team member; null for dm_team. */
  identity: MemberAvatarIdentity | null;
  sourceKind: DealAttributionSource["kind"];
  meetingId: Id<"meetings"> | null;
  attributedAt: number;
};

/** A first or latest touch, with the team member who made it when known. */
export type AttributionTouch = {
  eventId: Id<"domainEvents">;
  eventType: string;
  channel: TouchChannel;
  occurredAt: number;
  teamMemberName: string | null;
  teamMember: MemberAvatarIdentity | null;
};

/** Every row on a deal, and the touches it copied when it was created. */
export type DealAttributionDetail = {
  credits: AttributionCredit[];
  firstTouch: AttributionTouch | null;
  latestTouch: AttributionTouch | null;
};

export type EntityAttributionPayload = EntityAttributionSummary & DealAttributionDetail;

type ResolvedTeamMember = { name: string; identity: MemberAvatarIdentity } | null;

/** Resolves team members once per request; detail pages repeat them. */
export type TeamMemberDirectory = (
  teamMemberId: Id<"teamMembers"> | undefined,
) => Promise<ResolvedTeamMember>;

export function teamMemberDirectory(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): TeamMemberDirectory {
  const cache = new Map<Id<"teamMembers">, Promise<ResolvedTeamMember>>();
  return (teamMemberId) => {
    if (!teamMemberId) return Promise.resolve(null);
    let resolved = cache.get(teamMemberId);
    if (!resolved) {
      resolved = teamMemberIdentity(ctx, tenantId, teamMemberId);
      cache.set(teamMemberId, resolved);
    }
    return resolved;
  };
}

function slackUserLabel(user: Doc<"slackUsers"> | null | undefined) {
  return (
    user?.displayName?.trim() ||
    user?.realName?.trim() ||
    user?.username?.trim() ||
    user?.slackUserId
  );
}

function userDisplayName(user: Doc<"users"> | null | undefined) {
  return user?.fullName?.trim() || user?.email || null;
}

function tenantOwned<T extends { tenantId: Id<"tenants"> }>(
  doc: T | null,
  tenantId: Id<"tenants">,
): T | null {
  return doc && doc.tenantId === tenantId ? doc : null;
}

async function resolveProgramSummary(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  programId: Id<"tenantPrograms"> | undefined,
  programName: string | undefined,
) {
  if (!programId) {
    return null;
  }

  if (programName) {
    return { id: programId, name: programName };
  }

  const program = await ctx.db.get("tenantPrograms", programId);
  if (!program || program.tenantId !== tenantId) {
    return null;
  }

  return { id: program._id, name: program.name };
}

// ---------------------------------------------------------------------------
// DM team and DM closer of a meeting or deal
// ---------------------------------------------------------------------------

export type BookingDmAttribution = {
  status: AttributionStatus;
  team: Doc<"attributionTeams"> | null;
  dmCloser: Doc<"dmClosers"> | null;
  dmCloserIdentity: MemberAvatarIdentity | null;
};

/**
 * The DM team and DM closer a page shows (docs/plans/phase-3-attribution.md
 * §6.5), from the booking rows. A meeting that was resolved shows its own
 * booking's. Anything else, a meeting never resolved or no meeting, shows the
 * deal's first booking's, with that booking's resolution as its status.
 */
export async function resolveBookingDmAttribution(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunity: Pick<Doc<"opportunities">, "firstMeetingId"> | null;
    meeting: Doc<"meetings"> | null;
  },
): Promise<BookingDmAttribution> {
  const { tenantId, opportunity, meeting } = args;
  let credit: BookingCredit = {};
  let status: AttributionStatus = "none";

  if (meeting?.attributionResolution !== undefined) {
    credit = await bookingCreditForMeeting(ctx, tenantId, meeting._id);
    status = meeting.attributionResolution;
  } else if (opportunity?.firstMeetingId) {
    const firstMeetingId = opportunity.firstMeetingId;
    const [firstCredit, firstMeeting] = await Promise.all([
      dealBookingCredit(ctx, { tenantId, firstMeetingId }),
      firstMeetingId === meeting?._id
        ? Promise.resolve(meeting)
        : ctx.db.get("meetings", firstMeetingId),
    ]);
    credit = firstCredit;
    status = tenantOwned(firstMeeting, tenantId)?.attributionResolution ?? "none";
  }

  const [team, dmCloser] = await Promise.all([
    credit.teamId ? ctx.db.get("attributionTeams", credit.teamId) : Promise.resolve(null),
    credit.dmCloserId ? ctx.db.get("dmClosers", credit.dmCloserId) : Promise.resolve(null),
  ]);
  const tenantDmCloser = tenantOwned(dmCloser, tenantId);
  const linkedUser = tenantDmCloser?.userId
    ? tenantOwned(await ctx.db.get("users", tenantDmCloser.userId), tenantId)
    : null;

  return {
    status,
    team: tenantOwned(team, tenantId),
    dmCloser: tenantDmCloser,
    dmCloserIdentity: tenantDmCloser
      ? await dmCloserMemberIdentity(ctx, tenantDmCloser, linkedUser)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Credits and touches
// ---------------------------------------------------------------------------

const ROLE_ORDER: Record<DealAttributionRole, number> = {
  lead_gen: 0,
  setter: 1,
  dm_team: 2,
  dm_closer: 3,
  closer: 4,
};

async function creditsOf(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rows: readonly DealAttribution[],
  teamMembers: TeamMemberDirectory,
): Promise<AttributionCredit[]> {
  const teamIds = [
    ...new Set(
      rows.flatMap((row) => (row.role === "dm_team" && row.teamId ? [row.teamId] : [])),
    ),
  ];
  const teamNameById = new Map(
    await Promise.all(
      teamIds.map(async (teamId) => [
        teamId,
        tenantOwned(await ctx.db.get("attributionTeams", teamId), tenantId)?.displayName ?? null,
      ] as const),
    ),
  );

  const credits = await Promise.all(
    rows.map(async (row): Promise<AttributionCredit> => {
      const member =
        row.role === "dm_team" ? null : await teamMembers(row.teamMemberId);
      return {
        id: row._id,
        role: row.role,
        name:
          row.role === "dm_team"
            ? (row.teamId ? teamNameById.get(row.teamId) : null) ?? null
            : member?.name ?? null,
        identity: member?.identity ?? null,
        sourceKind: row.source.kind,
        meetingId: row.meetingId ?? null,
        attributedAt: row.attributedAt,
      };
    }),
  );
  // Array sort is stable, so rows of one role and time keep their insert order.
  return credits.sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.attributedAt - b.attributedAt,
  );
}

/**
 * Who made a touch: its event's team member, or for a Calendly booking the
 * team member on that booking's dm_closer row (§3.2). Undefined when nobody
 * is named, as on a team-only or internal booking.
 */
async function touchTeamMemberId(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  touch: TouchSnapshot,
): Promise<Id<"teamMembers"> | undefined> {
  const event = tenantOwned(await ctx.db.get("domainEvents", touch.eventId), tenantId);
  if (!event) return undefined;
  if (touch.eventType !== "meeting.created") return event.teamMemberId;
  const meetingId = ctx.db.normalizeId("meetings", event.entityId);
  if (!meetingId) return undefined;
  return bookingCreditOf(await attributionsForMeeting(ctx, tenantId, meetingId))
    .dmCloserTeamMemberId;
}

async function touchOf(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  touch: TouchSnapshot | undefined,
  teamMembers: TeamMemberDirectory,
): Promise<AttributionTouch | null> {
  if (!touch) return null;
  const member = await teamMembers(await touchTeamMemberId(ctx, tenantId, touch));
  return {
    eventId: touch.eventId,
    eventType: touch.eventType,
    channel: touch.channel,
    occurredAt: touch.occurredAt,
    teamMemberName: member?.name ?? null,
    teamMember: member?.identity ?? null,
  };
}

/** A person's or a deal's first and latest touch, with who made each. */
export async function resolveTouches(
  ctx: QueryCtx,
  record: Pick<Doc<"leads">, "tenantId" | "firstTouch" | "latestTouch">,
  teamMembers: TeamMemberDirectory = teamMemberDirectory(ctx, record.tenantId),
): Promise<Pick<DealAttributionDetail, "firstTouch" | "latestTouch">> {
  const [firstTouch, latestTouch] = await Promise.all([
    touchOf(ctx, record.tenantId, record.firstTouch, teamMembers),
    touchOf(ctx, record.tenantId, record.latestTouch, teamMembers),
  ]);
  return { firstTouch, latestTouch };
}

/**
 * Every attribution row on a deal, by role then time, and the touches the
 * deal copied from its person when it was created.
 */
export async function buildDealAttributionDetail(
  ctx: QueryCtx,
  opportunity: Doc<"opportunities">,
  teamMembers: TeamMemberDirectory = teamMemberDirectory(ctx, opportunity.tenantId),
): Promise<DealAttributionDetail> {
  const rows = await attributionsForDeal(ctx, opportunity.tenantId, opportunity._id);
  const [credits, touches] = await Promise.all([
    creditsOf(ctx, opportunity.tenantId, rows, teamMembers),
    resolveTouches(ctx, opportunity, teamMembers),
  ]);
  return { credits, ...touches };
}

// ---------------------------------------------------------------------------
// The deal attribution payload
// ---------------------------------------------------------------------------

/**
 * A deal's Slack, program, DM, closer and timeline facts. With a meeting, the
 * meeting's own where it has them.
 */
export async function buildOpportunityAttributionSummary(
  ctx: QueryCtx,
  opportunity: Doc<"opportunities">,
  options?: { meeting?: Doc<"meetings"> | null },
): Promise<EntityAttributionSummary> {
  const meeting = options?.meeting ?? null;
  const useMeetingAttribution = meeting?.attributionResolution !== undefined;
  const rawUtmParams = useMeetingAttribution
    ? meeting.utmParams
    : meeting?.utmParams ?? opportunity.utmParams;
  const phoneCloserId = meeting?.assignedCloserId ?? opportunity.assignedCloserId;
  const bookedProgramId =
    meeting?.bookingProgramId ?? opportunity.firstBookingProgramId;
  const bookedProgramName =
    meeting?.bookingProgramName ?? opportunity.firstBookingProgramName;
  const soldProgramId = meeting?.soldProgramId ?? opportunity.soldProgramId;
  const soldProgramName = meeting?.soldProgramName ?? opportunity.soldProgramName;

  const [
    qualificationEvent,
    dm,
    phoneCloser,
    bookedProgram,
    soldProgram,
  ] = await Promise.all([
    ctx.db
      .query("slackQualificationEvents")
      .withIndex("by_tenantId_and_opportunityId", (q) =>
        q
          .eq("tenantId", opportunity.tenantId)
          .eq("opportunityId", opportunity._id),
      )
      .order("desc")
      .first(),
    resolveBookingDmAttribution(ctx, {
      tenantId: opportunity.tenantId,
      opportunity,
      meeting,
    }),
    phoneCloserId ? ctx.db.get("users", phoneCloserId) : Promise.resolve(null),
    resolveProgramSummary(
      ctx,
      opportunity.tenantId,
      bookedProgramId,
      bookedProgramName,
    ),
    resolveProgramSummary(
      ctx,
      opportunity.tenantId,
      soldProgramId,
      soldProgramName,
    ),
  ]);

  const slackUser = qualificationEvent
    ? await ctx.db
        .query("slackUsers")
        .withIndex("by_tenantId_and_slackUserId", (q) =>
          q
            .eq("tenantId", opportunity.tenantId)
            .eq("slackUserId", qualificationEvent.slackUserId),
        )
        .first()
    : null;

  return {
    slackQualification: qualificationEvent
      ? {
          slackUserId: qualificationEvent.slackUserId,
          slackUserLabel:
            slackUserLabel(slackUser) ?? qualificationEvent.slackUserId,
          slackUser: slackMemberIdentity(
            slackUser,
            `slack:${qualificationEvent.slackUserId}`,
          ),
          submittedAt: qualificationEvent.submittedAt,
          resultKind: qualificationEvent.resultKind,
        }
      : null,
    bookedProgram,
    soldProgram,
    dmAttribution: {
      status: dm.status,
      teamName: dm.team?.displayName ?? null,
      dmCloserName: dm.dmCloser?.displayName ?? null,
      dmCloser: dm.dmCloserIdentity,
      rawSource: rawUtmParams?.utm_source ?? null,
      rawMedium: rawUtmParams?.utm_medium ?? null,
    },
    phoneCloser:
      phoneCloser && phoneCloser.tenantId === opportunity.tenantId
        ? {
            id: phoneCloser._id,
            name: userDisplayName(phoneCloser) ?? "Unknown closer",
            identity: await userMemberIdentity(ctx, phoneCloser),
          }
        : null,
    timeline: {
      qualifiedAt:
        opportunity.qualifiedAt ?? opportunity.qualifiedBy?.submittedAt ?? null,
      firstBookedAt: opportunity.firstBookedAt ?? null,
      firstMeetingAt: opportunity.firstMeetingAt ?? meeting?.scheduledAt ?? null,
      paymentReceivedAt: opportunity.paymentReceivedAt ?? null,
    },
  };
}

/** The summary, plus every attribution row on the deal and its touches. */
export async function buildOpportunityAttributionPayload(
  ctx: QueryCtx,
  opportunity: Doc<"opportunities">,
  options?: {
    meeting?: Doc<"meetings"> | null;
    teamMembers?: TeamMemberDirectory;
  },
): Promise<EntityAttributionPayload> {
  const [summary, detail] = await Promise.all([
    buildOpportunityAttributionSummary(ctx, opportunity, options),
    buildDealAttributionDetail(ctx, opportunity, options?.teamMembers),
  ]);
  return { ...summary, ...detail };
}
