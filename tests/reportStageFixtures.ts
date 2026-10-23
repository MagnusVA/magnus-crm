import { isHeldStatus } from "../convex/lib/meetingAttendance";
import { vi } from "vitest";
import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import { meetingDayKey } from "../convex/operations/meetingStats";
import type { DealSource } from "../convex/opportunities/stages";
import { bookingHarness, qualifiedLifecycle } from "./bookingHarness";
import { insertPayment, insertProgram } from "./enrollmentFixtures";
import {
  harnessCloserId,
  insertDeal,
  missedMeetingLossReason,
  stageFields,
  type DealFields,
} from "./dealStageFixtures";

// PR 6 of Phase 5 (docs/plans/phase-5-deal-status.md §6.5, §6.6): the reports
// and operations screens read the deal's stage and outcome.

/**
 * The operations meeting stats buckets of the UTC days in [scheduledFrom,
 * scheduledTo), summed by meeting status the way the removed
 * phoneSales.getPhoneSalesStats summed them. The buckets carry no deal field
 * from PR 9 (docs/plans/phase-5-deal-status.md §4.8).
 */
export async function meetingStatsTotals(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    scheduledFrom: number;
    scheduledTo: number;
    soldProgramId?: Id<"tenantPrograms">;
  },
) {
  const rows = await ctx.db
    .query("operationsMeetingStatsV2")
    .withIndex("by_tenantId_and_dayKey", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .gte("dayKey", meetingDayKey(args.scheduledFrom))
        .lt("dayKey", meetingDayKey(args.scheduledTo)),
    )
    .take(8192);
  const totals = { scheduled: 0, completed: 0, canceled: 0, noShows: 0 };
  for (const row of rows) {
    if (args.soldProgramId && row.soldProgramId !== args.soldProgramId) continue;
    totals.scheduled += row.count;
    if (isHeldStatus(row.meetingStatus)) totals.completed += row.count;
    if (row.meetingStatus === "canceled") totals.canceled += row.count;
    if (row.meetingStatus === "no_show") totals.noShows += row.count;
  }
  return totals;
}

/**
 * Puts a deal at `status` with the stage, outcome and missed meeting loss the
 * dual write gives it, and nothing else: no aggregates, no copies. The
 * meetings keep the status they copied, so a screen that reads the copy shows
 * the old one.
 */
export async function moveDealTo(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  status: OpportunityStatus,
  fields: Partial<Doc<"opportunities">> = {},
): Promise<void> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const reason = missedMeetingLossReason(status);
  await ctx.db.patch("opportunities", opportunityId, {
    ...stageFields(status, deal.source ?? "calendly"),
    ...(reason ? { lostReason: reason, lostAt: deal.updatedAt } : {}),
    ...fields,
  });
}

// ── No-shows and cancellations (§6.5) ───────────────────────────────────

export const MISSED_DAY = 86_400_000;
export const MISSED_NOW = Date.UTC(2026, 9, 20, 12);
/** The page's default: the last 30 days. */
export const MISSED_RANGE = { startDate: MISSED_NOW - 30 * MISSED_DAY, endDate: MISSED_NOW };

const daysBefore = (days: number) => MISSED_NOW - days * MISSED_DAY;

type PersonSpec = {
  fullName?: string;
  email?: string;
  phone?: string;
  instagram?: string;
  /** Identifier rows beyond the lead's own fields. */
  identifiers?: Array<{ type: "email" | "phone" | "instagram"; rawValue: string }>;
};

async function insertPerson(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  spec: PersonSpec,
): Promise<Id<"leads">> {
  const leadId = await ctx.db.insert("leads", {
    ...qualifiedLifecycle(daysBefore(60)),
    tenantId,
    fullName: spec.fullName,
    email: spec.email,
    phone: spec.phone,
    socialHandles: spec.instagram ? [{ type: "instagram", handle: spec.instagram }] : undefined,
    status: "active",
    firstSeenAt: daysBefore(60),
    updatedAt: daysBefore(60),
  });
  for (const identifier of spec.identifiers ?? []) {
    await ctx.db.insert("leadIdentifiers", {
      tenantId,
      leadId,
      type: identifier.type,
      value: identifier.rawValue.replace(/^@/, "").toLowerCase(),
      rawValue: identifier.rawValue,
      source: "calendly_booking",
      confidence: "verified",
      createdAt: daysBefore(60),
    });
  }
  return leadId;
}

type MissedDealSpec = {
  status: OpportunityStatus;
  source?: DealSource;
  createdAt: number;
  lostAt?: number;
  /** By default the loss, or the creation: a loss is activity. */
  latestActivityAt?: number;
  /** The deal's latest meeting, hosted by `closerId`. */
  meeting?: { status: Doc<"meetings">["status"]; scheduledAt: number; closerId: Id<"users"> };
  /** The booking's DM team and DM closer rows. */
  credit?: { teamId?: Id<"attributionTeams">; dmCloserId?: Id<"dmClosers"> };
  setterTeamMemberId?: Id<"teamMembers">;
  fields?: Partial<Doc<"opportunities">>;
};

/**
 * A deal as the dual write leaves it, with its latest meeting and its credit
 * rows, written directly: no aggregates or projections, which the list
 * doesn't read.
 */
async function insertMissedDeal(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
  spec: MissedDealSpec,
): Promise<Id<"opportunities">> {
  const source = spec.source ?? "calendly";
  const reason = missedMeetingLossReason(spec.status);
  const opportunityId = await ctx.db.insert("opportunities", {
    tenantId,
    leadId,
    ...stageFields(spec.status, source),
    ...(reason ? { lostReason: reason } : {}),
    ...(spec.lostAt !== undefined ? { lostAt: spec.lostAt } : {}),
    assignedCloserId: spec.meeting?.closerId,
    createdAt: spec.createdAt,
    updatedAt: spec.lostAt ?? spec.createdAt,
    latestActivityAt: spec.latestActivityAt ?? spec.lostAt ?? spec.createdAt,
    ...spec.fields,
  });
  if (spec.meeting) {
    const meetingId = await ctx.db.insert("meetings", {
      tenantId,
      opportunityId,
      assignedCloserId: spec.meeting.closerId,
      calendlyEventUri: `https://api.calendly.com/scheduled_events/${opportunityId}`,
      calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${opportunityId}/invitees/person`,
      scheduledAt: spec.meeting.scheduledAt,
      durationMinutes: 30,
      status: spec.meeting.status,
      createdAt: spec.createdAt,
    });
    const base = {
      tenantId,
      opportunityId,
      meetingId,
      meetingScheduledAt: spec.meeting.scheduledAt,
      attributedAt: spec.createdAt,
      createdAt: spec.createdAt,
    };
    if (spec.credit?.teamId) {
      await ctx.db.insert("dealAttributions", {
        ...base,
        role: "dm_team",
        teamId: spec.credit.teamId,
        source: { kind: "booking_utm" },
      });
    }
    if (spec.credit?.dmCloserId) {
      const dmCloser = (await ctx.db.get("dmClosers", spec.credit.dmCloserId))!;
      await ctx.db.insert("dealAttributions", {
        ...base,
        role: "dm_closer",
        teamMemberId: dmCloser.teamMemberId,
        source: { kind: "booking_utm", dmCloserId: dmCloser._id },
      });
    }
    await ctx.db.patch("opportunities", opportunityId, {
      latestMeetingId: meetingId,
      latestMeetingAt: spec.meeting.scheduledAt,
      firstMeetingId: meetingId,
    });
  }
  if (spec.setterTeamMemberId) {
    await ctx.db.insert("dealAttributions", {
      tenantId,
      opportunityId,
      role: "setter",
      teamMemberId: spec.setterTeamMemberId,
      source: { kind: "slack_qualification", slackUserId: "U1" },
      attributedAt: spec.createdAt,
      createdAt: spec.createdAt,
    });
  }
  return opportunityId;
}

export type MissedMeetingsSeed = Awaited<ReturnType<typeof seedMissedMeetings>>;

/**
 * The booking harness's tenant with three deals a missed meeting closed in
 * the last 30 days (Nora's no-show, Cal's cancellation, and Rita's no-show,
 * after which she booked again), beside what the list leaves out: a loss a
 * person recorded with the reason "no_show", a Slack expiry, a no-show before
 * the range, an open deal, and another tenant's no-show. Cal's closer has
 * since been deleted.
 */
export async function seedMissedMeetings(ctx: MutationCtx, tenantId: Id<"tenants">) {
  const closerId = await harnessCloserId(ctx);
  const teamId = await ctx.db.insert("attributionTeams", {
    tenantId,
    slug: "north",
    displayName: "Team North",
    utmSource: "north",
    normalizedUtmSource: "north",
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
  });
  const danaMemberId = await ctx.db.insert("teamMembers", {
    tenantId,
    displayName: "Dana DM",
    createdAt: 0,
    updatedAt: 0,
  });
  const dmCloserId = await ctx.db.insert("dmClosers", {
    tenantId,
    teamId,
    slug: "dana",
    displayName: "Dana DM",
    utmMedium: "dana",
    normalizedUtmMedium: "dana",
    isActive: true,
    createdAt: 0,
    updatedAt: 0,
    teamMemberId: danaMemberId,
  });
  const setterTeamMemberId = await ctx.db.insert("teamMembers", {
    tenantId,
    displayName: "Sam Setter",
    createdAt: 0,
    updatedAt: 0,
  });
  const goneCloserId = await ctx.db.insert("users", {
    tenantId,
    workosUserId: "user_gone",
    email: "gone@example.com",
    role: "closer",
    isActive: false,
  });

  const nora = await insertPerson(ctx, tenantId, {
    fullName: "Nora Noshow",
    email: "nora@example.com",
    phone: "+15550001",
    instagram: "nora.noshow",
  });
  const noraDeal = await insertMissedDeal(ctx, tenantId, nora, {
    status: "no_show",
    createdAt: daysBefore(3),
    lostAt: daysBefore(2),
    meeting: { status: "no_show", scheduledAt: daysBefore(2) - 3_600_000, closerId },
    credit: { teamId, dmCloserId },
    setterTeamMemberId,
  });

  // Cal's handle and phone are only on identifier rows, and a note since the
  // cancellation makes the deal's latest activity newer than Nora's.
  const cal = await insertPerson(ctx, tenantId, {
    fullName: "Cal Canceled",
    email: "cal@example.com",
    identifiers: [
      { type: "instagram", rawValue: "@cal.canceled" },
      { type: "phone", rawValue: "+15550002" },
    ],
  });
  const calDeal = await insertMissedDeal(ctx, tenantId, cal, {
    status: "canceled",
    source: "slack_qualified",
    createdAt: daysBefore(6),
    lostAt: daysBefore(5),
    latestActivityAt: daysBefore(1),
    meeting: { status: "canceled", scheduledAt: daysBefore(4), closerId: goneCloserId },
  });
  await ctx.db.delete("users", goneCloserId);

  const rita = await insertPerson(ctx, tenantId, { fullName: "Rita Rebooked" });
  const ritaDeal = await insertMissedDeal(ctx, tenantId, rita, {
    status: "no_show",
    createdAt: daysBefore(12),
    lostAt: daysBefore(10),
    meeting: { status: "no_show", scheduledAt: daysBefore(10), closerId },
  });
  const ritaNewDeal = await insertMissedDeal(ctx, tenantId, rita, {
    status: "scheduled",
    createdAt: daysBefore(1),
    meeting: { status: "scheduled", scheduledAt: MISSED_NOW + MISSED_DAY, closerId },
  });

  // Left out: a person's loss with the system's word, the Slack expiry (it
  // keeps its earlier activity time), a no-show before the range with
  // activity since, and another tenant's no-show.
  const left = await insertPerson(ctx, tenantId, { fullName: "Left Out" });
  await insertMissedDeal(ctx, tenantId, left, {
    status: "lost",
    createdAt: daysBefore(4),
    lostAt: daysBefore(3),
    meeting: { status: "held", scheduledAt: daysBefore(3), closerId },
    fields: { lostReason: "no_show", lostByUserId: closerId },
  });
  await insertMissedDeal(ctx, tenantId, left, {
    status: "lost",
    source: "slack_qualified",
    createdAt: daysBefore(40),
    lostAt: daysBefore(4),
    latestActivityAt: daysBefore(39),
    fields: { lostReason: "stale" },
  });
  await insertMissedDeal(ctx, tenantId, left, {
    status: "no_show",
    createdAt: daysBefore(45),
    lostAt: daysBefore(40),
    latestActivityAt: daysBefore(1),
    meeting: { status: "no_show", scheduledAt: daysBefore(40), closerId },
  });
  const otherTenantId = await ctx.db.insert("tenants", {
    companyName: "Other",
    contactEmail: "other@example.com",
    workosOrgId: "org_other",
    status: "active",
    inviteExpiresAt: 0,
    createdBy: "test",
  });
  const stranger = await insertPerson(ctx, otherTenantId, { fullName: "Other Tenant" });
  await insertMissedDeal(ctx, otherTenantId, stranger, {
    status: "no_show",
    createdAt: daysBefore(3),
    lostAt: daysBefore(2),
  });

  return {
    closerId,
    leads: { nora, cal, rita },
    deals: { noraDeal, calDeal, ritaDeal, ritaNewDeal },
    meetingAt: {
      nora: daysBefore(2) - 3_600_000,
      cal: daysBefore(4),
      rita: daysBefore(10),
    },
    lostAt: { nora: daysBefore(2), cal: daysBefore(5), rita: daysBefore(10) },
  };
}

/** `count` more no-shows in the range, one person each, with no meeting. */
export async function insertManyNoShows(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const leadId = await insertPerson(ctx, tenantId, { fullName: `Many ${index}` });
    await insertMissedDeal(ctx, tenantId, leadId, {
      status: "no_show",
      createdAt: daysBefore(20),
      lostAt: daysBefore(15) + index,
    });
  }
}

// ── The mixed pipeline (§6.2, §6.6) ─────────────────────────────────────
// A small tenant with a deal at every old status, written as its stage, two
// closers, meetings with every outcome the team report derives, and losses
// by a person and by the system.

export const NOW = Date.UTC(2026, 9, 20, 12);
export const DAY = 86_400_000;

export function daysAgo(days: number): number {
  return NOW - days * DAY;
}

/** The losses Pipeline Health counts: the last 30 days. */
export const LOSS_RANGE = { startDate: daysAgo(30), endDate: NOW };

/** The meetings the team report and the closer strip count. */
export const MEETING_RANGE = { startDate: daysAgo(60), endDate: NOW + 7 * DAY };

export type MixedPipelineHarness = Awaited<ReturnType<typeof mixedPipelineHarness>>;

/** The booking harness at NOW, with a second closer. */
export async function mixedPipelineHarness() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const harness = await bookingHarness();
  const users = await harness.t.run(async (ctx) => {
    const byWorkosId = async (workosUserId: string) =>
      (await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
        .unique())!._id;
    const closerBId = await ctx.db.insert("users", {
      tenantId: harness.tenantId,
      workosUserId: "user_closer_b",
      email: "closer-b@example.com",
      role: "closer",
      isActive: true,
    });
    return {
      adminId: await byWorkosId("user_admin"),
      closerAId: await byWorkosId("user_closer"),
      closerBId,
    };
  });
  return { ...harness, ...users };
}

type DealSpec = {
  status: OpportunityStatus;
  source: DealSource;
  closer?: "A" | "B";
  fields: DealFields;
};

type MeetingSpec = {
  deal: DealName;
  closer: "A" | "B";
  status: Doc<"meetings">["status"];
  scheduledAt: number;
  // An earlier meeting's name.
  rescheduledFrom?: string;
};

// Every status, with the cases each report treats apart: the side deal
// (Call held), a stale-expired Slack deal, a missed meeting's loss, a loss
// before the range, and losses by a closer, by an admin and by nobody known.
const DEALS = {
  qualified: { status: "qualified_pending", source: "slack_qualified", fields: { createdAt: daysAgo(5) } },
  bookedStale: {
    status: "scheduled",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(40), nextMeetingAt: daysAgo(20) },
  },
  bookedUpcoming: {
    status: "scheduled",
    source: "calendly",
    closer: "B",
    fields: { createdAt: daysAgo(3), nextMeetingAt: NOW + DAY },
  },
  sideDeal: { status: "scheduled", source: "side_deal", closer: "A", fields: { createdAt: daysAgo(10) } },
  followUp: {
    status: "follow_up_scheduled",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(30), nextMeetingAt: daysAgo(2) },
  },
  linkSent: { status: "reschedule_link_sent", source: "calendly", closer: "B", fields: { createdAt: daysAgo(25) } },
  won: {
    status: "payment_received",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(20), paymentReceivedAt: daysAgo(15) },
  },
  wonOld: {
    status: "payment_received",
    source: "side_deal",
    closer: "B",
    fields: { createdAt: daysAgo(100), paymentReceivedAt: daysAgo(95) },
  },
  lostByCloser: {
    status: "lost",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(12), lostReason: "Budget", lostAt: daysAgo(2), latestActivityAt: daysAgo(2) },
  },
  lostByAdmin: {
    status: "lost",
    source: "calendly",
    closer: "B",
    fields: { createdAt: daysAgo(9), lostAt: daysAgo(1), latestActivityAt: daysAgo(1) },
  },
  lostUnknown: {
    status: "lost",
    source: "slack_qualified",
    closer: "B",
    fields: { createdAt: daysAgo(14), lostReason: "Went quiet", lostAt: daysAgo(3), latestActivityAt: daysAgo(3) },
  },
  stale: {
    status: "lost",
    source: "slack_qualified",
    fields: { createdAt: daysAgo(36), lostReason: "stale", lostAt: daysAgo(4), latestActivityAt: daysAgo(35) },
  },
  canceled: {
    status: "canceled",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(8), lostReason: "canceled", lostAt: daysAgo(2), latestActivityAt: daysAgo(2) },
  },
  noShow: {
    status: "no_show",
    source: "calendly",
    closer: "B",
    fields: { createdAt: daysAgo(11), lostReason: "no_show", lostAt: daysAgo(6), latestActivityAt: daysAgo(6) },
  },
  lostEarlier: {
    status: "lost",
    source: "calendly",
    closer: "A",
    fields: { createdAt: daysAgo(45), lostReason: "Timing", lostAt: daysAgo(40), latestActivityAt: daysAgo(1) },
  },
} satisfies Record<string, DealSpec>;

export type DealName = keyof typeof DEALS;

// In time order per deal; the last one on a deal is its latest.
const MEETINGS = {
  lostEarlier: { deal: "lostEarlier", closer: "A", status: "held", scheduledAt: daysAgo(41) },
  followUp: { deal: "followUp", closer: "A", status: "held", scheduledAt: daysAgo(29) },
  linkSentHeld: { deal: "linkSent", closer: "B", status: "held", scheduledAt: daysAgo(26) },
  linkSent: { deal: "linkSent", closer: "B", status: "no_show", scheduledAt: daysAgo(24) },
  bookedStale: { deal: "bookedStale", closer: "A", status: "scheduled", scheduledAt: daysAgo(20) },
  won: { deal: "won", closer: "A", status: "held", scheduledAt: daysAgo(18) },
  lostByCloserEarly: { deal: "lostByCloser", closer: "A", status: "held", scheduledAt: daysAgo(10) },
  lostUnknown: { deal: "lostUnknown", closer: "B", status: "held", scheduledAt: daysAgo(7) },
  noShow: { deal: "noShow", closer: "B", status: "no_show", scheduledAt: daysAgo(6) },
  lostByCloser: { deal: "lostByCloser", closer: "A", status: "held", scheduledAt: daysAgo(5) },
  bookedUpcomingOld: { deal: "bookedUpcoming", closer: "B", status: "canceled", scheduledAt: daysAgo(4) },
  lostByAdmin: { deal: "lostByAdmin", closer: "B", status: "held", scheduledAt: daysAgo(3) },
  canceled: { deal: "canceled", closer: "A", status: "canceled", scheduledAt: daysAgo(2) },
  bookedUpcoming: {
    deal: "bookedUpcoming",
    closer: "B",
    status: "scheduled",
    scheduledAt: NOW + DAY,
    rescheduledFrom: "bookedUpcomingOld",
  },
} satisfies Record<string, MeetingSpec>;

export type MeetingName = keyof typeof MEETINGS;

export type MixedPipeline = {
  deals: Record<DealName, Id<"opportunities">>;
  meetings: Record<MeetingName, Id<"meetings">>;
};

/** Seeds the mixed tenant: 15 deals, 14 meetings, a reschedule link, a payment. */
export async function seedMixedPipeline(harness: MixedPipelineHarness): Promise<MixedPipeline> {
  const { tenantId, adminId, closerAId, closerBId } = harness;
  const closerIds = { A: closerAId, B: closerBId };
  return await harness.t.run(async (ctx) => {
    const deals = {} as Record<DealName, Id<"opportunities">>;
    for (const [name, spec] of Object.entries(DEALS) as [DealName, DealSpec][]) {
      const createdAt = spec.fields.createdAt ?? NOW;
      deals[name] = await insertDeal(ctx, {
        tenantId,
        status: spec.status,
        source: spec.source,
        fields: {
          assignedCloserId: spec.closer ? closerIds[spec.closer] : undefined,
          updatedAt: createdAt,
          latestActivityAt: createdAt,
          ...spec.fields,
        },
      });
    }
    // Losses a person recorded.
    await ctx.db.patch("opportunities", deals.lostByCloser, { lostByUserId: closerAId });
    await ctx.db.patch("opportunities", deals.lostByAdmin, { lostByUserId: adminId });
    await ctx.db.patch("opportunities", deals.lostEarlier, { lostByUserId: closerAId });

    const meetings = {} as Record<MeetingName, Id<"meetings">>;
    for (const [name, spec] of Object.entries(MEETINGS) as [MeetingName, MeetingSpec][]) {
      meetings[name] = await insertMeeting(ctx, {
        tenantId,
        opportunityId: deals[spec.deal],
        closerId: closerIds[spec.closer],
        status: spec.status,
        scheduledAt: spec.scheduledAt,
        rescheduledFromMeetingId: spec.rescheduledFrom
          ? meetings[spec.rescheduledFrom as MeetingName]
          : undefined,
      });
    }

    await insertRescheduleLink(ctx, { tenantId, opportunityId: deals.linkSent, closerId: closerBId });
    const programId = await insertProgram(ctx, tenantId, "Program");
    await insertPayment(ctx, { tenantId, opportunityId: deals.won, programId, recordedAt: daysAgo(15) });
    return { deals, meetings };
  });
}

/** The harness with the mixed tenant seeded. */
export async function seededMixedPipeline(): Promise<{ harness: MixedPipelineHarness; seed: MixedPipeline }> {
  const harness = await mixedPipelineHarness();
  const seed = await seedMixedPipeline(harness);
  return { harness, seed };
}

// What the mixed tenant counts.

export const noOutcomes = {
  sold: 0,
  lost: 0,
  no_show: 0,
  canceled: 0,
  rescheduled: 0,
  dq: 0,
  follow_up: 0,
  scheduled: 0,
};

export const noPositions = { qualified: 0, booked: 0, call_held: 0, follow_up: 0, won: 0, lost: 0 };

/** The team report's outcome mix for the meetings in MEETING_RANGE. */
export const closerAOutcomes = { ...noOutcomes, sold: 1, lost: 2, canceled: 1, follow_up: 1, scheduled: 2 };
export const closerBOutcomes = { ...noOutcomes, lost: 2, no_show: 2, canceled: 1, scheduled: 2 };

/** A meeting on the deal, made its latest. */
export async function insertMeeting(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    opportunityId: Id<"opportunities">;
    closerId: Id<"users">;
    status: Doc<"meetings">["status"];
    scheduledAt: number;
    rescheduledFromMeetingId?: Id<"meetings">;
  },
): Promise<Id<"meetings">> {
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    assignedCloserId: args.closerId,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${args.opportunityId}-${args.scheduledAt}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${args.opportunityId}-${args.scheduledAt}/invitees/person`,
    scheduledAt: args.scheduledAt,
    durationMinutes: 30,
    createdAt: args.scheduledAt - DAY,
    status: args.status,
    heldMarkedAt: args.status === "held" ? args.scheduledAt + 30 * 60_000 : undefined,
    rescheduledFromMeetingId: args.rescheduledFromMeetingId,
  });
  await ctx.db.patch("opportunities", args.opportunityId, {
    latestMeetingId: meetingId,
    latestMeetingAt: args.scheduledAt,
  });
  return meetingId;
}

/** The pending reschedule link a deal at reschedule_link_sent has (§4.5). */
export async function insertRescheduleLink(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; opportunityId: Id<"opportunities">; closerId: Id<"users"> },
): Promise<Id<"followUps">> {
  const deal = (await ctx.db.get("opportunities", args.opportunityId))!;
  return await ctx.db.insert("followUps", {
    tenantId: args.tenantId,
    opportunityId: args.opportunityId,
    leadId: deal.leadId,
    closerId: args.closerId,
    type: "scheduling_link",
    schedulingLinkUrl: "https://calendly.com/closer-b/follow-up",
    reason: "no_show_follow_up",
    status: "pending",
    createdAt: daysAgo(23),
    createdSource: "closer",
  });
}
