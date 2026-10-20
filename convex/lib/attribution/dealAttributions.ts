import type { Infer } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { readLiveQueryRows } from "../liveQueryBounds";
import { log } from "../observability/log";
import {
  ensureUserTeamMember,
  linkDmCloserTeamMember,
  linkLeadGenWorkerTeamMember,
  linkSlackUserTeamMember,
} from "../teamMembers";
import { snapshotDealTouches } from "../touches";
import type {
  dealAttributionRoleValidator,
  dealAttributionSourceValidator,
} from "./validators";

// Deal attribution rows (docs/plans/phase-3-attribution.md §3.1 and §4).
// Rows are only added: a rebook or a reassignment writes new ones.

export type DealAttributionRole = Infer<typeof dealAttributionRoleValidator>;
export type DealAttributionSource = Infer<typeof dealAttributionSourceValidator>;
export type DealAttribution = Doc<"dealAttributions">;

type ReadCtx = QueryCtx | MutationCtx;

/** What a booking's UTMs credited: a team, and maybe a DM closer of it. */
export type BookingCredit = {
  teamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
  dmCloserTeamMemberId?: Id<"teamMembers">;
};

// Far above the rows one deal or meeting holds.
const ROWS_PER_DEAL_LIMIT = 200;
const ROWS_PER_MEETING_LIMIT = 50;

// ---------------------------------------------------------------------------
// Team members behind each role record. Every record has one in production
// (Phase 1); a record missing one gets it the way its write path would.
// ---------------------------------------------------------------------------

async function userTeamMember(ctx: MutationCtx, userId: Id<"users">) {
  return await ensureUserTeamMember(ctx, userId);
}

async function dmCloserTeamMember(ctx: MutationCtx, dmCloser: Doc<"dmClosers">) {
  if (dmCloser.teamMemberId) return dmCloser.teamMemberId;
  await linkDmCloserTeamMember(ctx, dmCloser._id);
  return (await ctx.db.get("dmClosers", dmCloser._id))?.teamMemberId;
}

async function slackUserTeamMember(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  slackUserId: string,
) {
  const slackUser = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId_and_slackUserId", (q) =>
      q.eq("tenantId", tenantId).eq("slackUserId", slackUserId),
    )
    .first();
  if (!slackUser) return undefined;
  if (slackUser.teamMemberId) return slackUser.teamMemberId;
  await linkSlackUserTeamMember(ctx, slackUser._id);
  return (await ctx.db.get("slackUsers", slackUser._id))?.teamMemberId;
}

async function leadGenWorkerTeamMember(ctx: MutationCtx, workerId: Id<"leadGenWorkers">) {
  const worker = await ctx.db.get("leadGenWorkers", workerId);
  if (!worker) return undefined;
  if (worker.teamMemberId) return worker.teamMemberId;
  await linkLeadGenWorkerTeamMember(ctx, workerId);
  return (await ctx.db.get("leadGenWorkers", workerId))?.teamMemberId;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function attributionsForMeeting(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  meetingId: Id<"meetings">,
): Promise<DealAttribution[]> {
  return await ctx.db
    .query("dealAttributions")
    .withIndex("by_tenantId_and_meetingId", (q) =>
      q.eq("tenantId", tenantId).eq("meetingId", meetingId),
    )
    .take(ROWS_PER_MEETING_LIMIT);
}

export async function attributionsForDeal(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities">,
  role?: DealAttributionRole,
): Promise<DealAttribution[]> {
  return await ctx.db
    .query("dealAttributions")
    .withIndex("by_tenantId_and_opportunityId_and_role", (q) => {
      const range = q.eq("tenantId", tenantId).eq("opportunityId", opportunityId);
      return role ? range.eq("role", role) : range;
    })
    .take(ROWS_PER_DEAL_LIMIT);
}

/** The team and DM closer one booking's rows credit. */
export function bookingCreditOf(rows: readonly DealAttribution[]): BookingCredit {
  const credit: BookingCredit = {};
  for (const row of rows) {
    if (row.source.kind !== "booking_utm") continue;
    if (row.role === "dm_team" && row.teamId) credit.teamId = row.teamId;
    if (row.role === "dm_closer") {
      credit.dmCloserId = row.source.dmCloserId;
      credit.dmCloserTeamMemberId = row.teamMemberId;
    }
  }
  return credit;
}

export async function bookingCreditForMeeting(
  ctx: ReadCtx,
  tenantId: Id<"tenants">,
  meetingId: Id<"meetings">,
): Promise<BookingCredit> {
  return bookingCreditOf(await attributionsForMeeting(ctx, tenantId, meetingId));
}

/**
 * The deal-level DM credit: its first external booking's, as the copied
 * columns held it. A deal no booking has reached has none.
 */
export async function dealBookingCredit(
  ctx: ReadCtx,
  opportunity: Pick<Doc<"opportunities">, "tenantId" | "firstMeetingId">,
): Promise<BookingCredit> {
  return opportunity.firstMeetingId
    ? await bookingCreditForMeeting(ctx, opportunity.tenantId, opportunity.firstMeetingId)
    : {};
}

/** Groups rows by the meeting they came from. */
export function bookingCreditsByMeeting(
  rows: readonly DealAttribution[],
): Map<Id<"meetings">, BookingCredit> {
  const byMeeting = new Map<Id<"meetings">, DealAttribution[]>();
  for (const row of rows) {
    if (!row.meetingId) continue;
    const list = byMeeting.get(row.meetingId) ?? [];
    list.push(row);
    byMeeting.set(row.meetingId, list);
  }
  return new Map([...byMeeting].map(([meetingId, list]) => [meetingId, bookingCreditOf(list)]));
}

/**
 * The DM team and DM closer rows of every booking made in [start, end), keyed
 * by meeting. Bookings have `attributedAt` equal to the meeting's
 * `createdAt`, so this matches a meetings read over the same window.
 */
export async function bookingCreditsInWindow(
  ctx: ReadCtx,
  args: {
    tenantId: Id<"tenants">;
    start: number;
    end: number;
    maxRowsPerRole: number;
  },
): Promise<{ credits: Map<Id<"meetings">, BookingCredit>; capped: boolean }> {
  const reads = await Promise.all(
    (["dm_team", "dm_closer"] as const).map((role) =>
      readLiveQueryRows(
        ctx.db
          .query("dealAttributions")
          .withIndex("by_tenantId_and_role_and_attributedAt", (q) =>
            q
              .eq("tenantId", args.tenantId)
              .eq("role", role)
              .gte("attributedAt", args.start)
              .lt("attributedAt", args.end),
          ),
        args.maxRowsPerRole,
      ),
    ),
  );
  return {
    credits: bookingCreditsByMeeting(reads.flatMap((read) => read.rows)),
    capped: reads.some((read) => read.capped),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function insertRow(
  ctx: MutationCtx,
  row: Omit<DealAttribution, "_id" | "_creationTime" | "createdAt">,
) {
  return await ctx.db.insert("dealAttributions", { ...row, createdAt: Date.now() });
}

/**
 * The rows one booking writes (§4.1): a dm_team row when its UTMs named a
 * team, a dm_closer row when they named a DM closer, and always a closer row
 * for the closer the meeting was assigned to. Runs once per meeting; a
 * meeting that already has its booking rows is left alone. `closerUserId`
 * overrides the booking closer for the backfill of a meeting reassigned
 * before the rows existed: its booking went to the closer it came from.
 */
export async function recordBookingAttribution(
  ctx: MutationCtx,
  args: {
    meeting: Doc<"meetings">;
    credit: { teamId?: Id<"attributionTeams">; dmCloserId?: Id<"dmClosers"> };
    closerUserId?: Id<"users">;
  },
): Promise<void> {
  const { meeting, credit } = args;
  const bookingCloserId = args.closerUserId ?? meeting.assignedCloserId;
  const existing = await attributionsForMeeting(ctx, meeting.tenantId, meeting._id);
  if (existing.some((row) => row.source.kind === "booking_utm" || row.source.kind === "booking_closer")) {
    return;
  }
  const base = {
    tenantId: meeting.tenantId,
    opportunityId: meeting.opportunityId,
    meetingId: meeting._id,
    meetingScheduledAt: meeting.scheduledAt,
    attributedAt: meeting.createdAt,
  };

  if (credit.teamId) {
    const team = await ctx.db.get("attributionTeams", credit.teamId);
    if (team && team.tenantId === meeting.tenantId) {
      await insertRow(ctx, {
        ...base,
        role: "dm_team",
        teamId: team._id,
        source: { kind: "booking_utm" },
      });
    }
  }

  if (credit.dmCloserId) {
    const dmCloser = await ctx.db.get("dmClosers", credit.dmCloserId);
    if (dmCloser && dmCloser.tenantId === meeting.tenantId) {
      await insertRow(ctx, {
        ...base,
        role: "dm_closer",
        teamMemberId: await dmCloserTeamMember(ctx, dmCloser),
        source: { kind: "booking_utm", dmCloserId: dmCloser._id },
      });
    }
  }

  await insertRow(ctx, {
    ...base,
    role: "closer",
    teamMemberId: await userTeamMember(ctx, bookingCloserId),
    source: { kind: "booking_closer", userId: bookingCloserId },
  });
}

/** Whether a Slack qualification of this kind credits its setter (§4.4). */
export function qualificationCreditsSetter(
  resultKind: Doc<"slackQualificationEvents">["resultKind"],
): boolean {
  return resultKind === "created_opportunity" || resultKind === "duplicate_pending";
}

/**
 * A setter row for a qualification that created the deal or joined it while
 * it waited for a booking, unless that setter already has one on the deal.
 */
export async function recordSetterAttribution(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    slackUserId: string;
    submittedAt: number;
    qualificationEventId?: Id<"slackQualificationEvents">;
  },
): Promise<void> {
  // Credit names a team member. A qualification always upserts its Slack
  // user first, which links one, so a miss means the Slack user is gone.
  const teamMemberId = await slackUserTeamMember(ctx, args.tenantId, args.slackUserId);
  if (!teamMemberId) {
    log.error("attribution.setter_without_team_member", {
      tenantId: args.tenantId,
      opportunityId: args.opportunityId,
      slackUserId: args.slackUserId,
    });
    return;
  }
  const setters = await attributionsForDeal(ctx, args.tenantId, args.opportunityId, "setter");
  if (setters.some((row) => row.teamMemberId === teamMemberId)) {
    return;
  }
  await insertRow(ctx, {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    role: "setter",
    teamMemberId,
    source: {
      kind: "slack_qualification",
      slackUserId: args.slackUserId,
      qualificationEventId: args.qualificationEventId,
    },
    attributedAt: args.submittedAt,
  });
}

function parsedMetadata(metadata: string | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The lead gen row a deal should hold (§4.3): when its first touch is a
 * capture, the capture's worker. Null otherwise, or when the capture's
 * prospect or worker is gone.
 */
export async function expectedLeadGenRow(
  ctx: MutationCtx,
  opportunity: Doc<"opportunities">,
): Promise<Omit<DealAttribution, "_id" | "_creationTime" | "createdAt"> | null> {
  const touch = opportunity.firstTouch;
  if (touch?.channel !== "lead_gen") return null;
  const event = await ctx.db.get("domainEvents", touch.eventId);
  if (!event || event.tenantId !== opportunity.tenantId) return null;
  const metadata = parsedMetadata(event.metadata);
  const prospectId = ctx.db.normalizeId("leadGenProspects", String(metadata.prospectId ?? ""));
  const workerId = ctx.db.normalizeId("leadGenWorkers", String(metadata.workerId ?? ""));
  if (!prospectId || !workerId) return null;
  // Credit names the worker's team member; a worker always has one (Phase 1).
  const teamMemberId = await leadGenWorkerTeamMember(ctx, workerId);
  if (!teamMemberId) return null;
  return {
    tenantId: opportunity.tenantId,
    opportunityId: opportunity._id,
    role: "lead_gen",
    teamMemberId,
    source: { kind: "capture", prospectId, workerId, eventId: event._id },
    attributedAt: event.occurredAt,
  };
}

/**
 * The work a new deal does once (§4.2): snapshot the person's touches, then
 * credit the lead gen worker when the first touch is a capture, and a side
 * deal's closer. Setters come from `recordSetterAttribution`, which the
 * qualification calls. Callers run it after the event that created the deal.
 */
export async function recordDealCreation(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<void> {
  const opportunity = await snapshotDealTouches(ctx, opportunityId);
  if (!opportunity) return;

  const leadGen = await expectedLeadGenRow(ctx, opportunity);
  if (leadGen) {
    const existing = await attributionsForDeal(ctx, opportunity.tenantId, opportunity._id, "lead_gen");
    if (existing.length === 0) await insertRow(ctx, leadGen);
  }

  if (opportunity.source === "side_deal" && opportunity.assignedCloserId) {
    const closers = await attributionsForDeal(ctx, opportunity.tenantId, opportunity._id, "closer");
    if (!closers.some((row) => row.source.kind === "side_deal")) {
      await insertRow(ctx, {
        tenantId: opportunity.tenantId,
        opportunityId: opportunity._id,
        role: "closer",
        teamMemberId: await userTeamMember(ctx, opportunity.assignedCloserId),
        source: { kind: "side_deal", userId: opportunity.assignedCloserId },
        attributedAt: opportunity.createdAt,
      });
    }
  }
}

/**
 * A closer row for a reassignment (§4.6). Never removes the earlier rows. A
 * "reassignment" to the same closer adds nothing.
 */
export async function recordCloserReassignment(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    meeting?: Doc<"meetings">;
    toUserId: Id<"users">;
    fromUserId?: Id<"users">;
    at: number;
  },
): Promise<void> {
  if (args.fromUserId === args.toUserId) return;
  await insertRow(ctx, {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    role: "closer",
    teamMemberId: await userTeamMember(ctx, args.toUserId),
    source: { kind: "reassignment", userId: args.toUserId, fromUserId: args.fromUserId },
    meetingId: args.meeting?._id,
    meetingScheduledAt: args.meeting?.scheduledAt,
    attributedAt: args.at,
  });
}

/** Deletes a deal's rows with it. Returns false while rows are left. */
export async function deleteDealAttributions(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities">,
): Promise<boolean> {
  const rows = await attributionsForDeal(ctx, tenantId, opportunityId);
  for (const row of rows) await ctx.db.delete("dealAttributions", row._id);
  return rows.length < ROWS_PER_DEAL_LIMIT;
}

/** Deletes a meeting's rows with it. */
export async function deleteMeetingAttributions(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  meetingId: Id<"meetings">,
): Promise<void> {
  for (const row of await attributionsForMeeting(ctx, tenantId, meetingId)) {
    await ctx.db.delete("dealAttributions", row._id);
  }
}

/** A meeting moved to another deal takes its rows along. */
export async function moveMeetingAttributions(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    meetingId: Id<"meetings">;
    toOpportunityId: Id<"opportunities">;
  },
): Promise<void> {
  for (const row of await attributionsForMeeting(ctx, args.tenantId, args.meetingId)) {
    if (row.opportunityId !== args.toOpportunityId) {
      await ctx.db.patch("dealAttributions", row._id, { opportunityId: args.toOpportunityId });
    }
  }
}

const ROLES: readonly DealAttributionRole[] = ["lead_gen", "setter", "dm_team", "dm_closer", "closer"];

/**
 * Repoints up to `limit` rows from one team member to another, for
 * `mergeTeamMembers`. Returns how many it moved; a full page means more.
 */
export async function repointDealAttributionTeamMember(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    fromTeamMemberId: Id<"teamMembers">;
    intoTeamMemberId: Id<"teamMembers">;
    limit: number;
  },
): Promise<number> {
  let moved = 0;
  for (const role of ROLES) {
    if (moved >= args.limit) break;
    const rows = await ctx.db
      .query("dealAttributions")
      .withIndex("by_tenantId_and_role_and_teamMemberId_and_meetingScheduledAt", (q) =>
        q.eq("tenantId", args.tenantId).eq("role", role).eq("teamMemberId", args.fromTeamMemberId),
      )
      .take(args.limit - moved);
    for (const row of rows) {
      await ctx.db.patch("dealAttributions", row._id, { teamMemberId: args.intoTeamMemberId });
    }
    moved += rows.length;
  }
  return moved;
}
