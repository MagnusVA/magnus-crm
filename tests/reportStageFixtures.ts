import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/lib/statusTransitions";
import { meetingDayKey } from "../convex/operations/meetingStats";
import { missedMeetingLossReason, type DealSource } from "../convex/opportunities/stages";
import { qualifiedLifecycle } from "./bookingHarness";
import { harnessCloserId, stageFields } from "./dealStageFixtures";

// PR 6 of Phase 5 (docs/plans/phase-5-deal-status.md §6.5, §6.6): the reports
// and operations screens read the deal's stage and outcome.

/**
 * Rewrites only the deal's stored status, leaving its stage and outcome: a
 * screen that reads the stage shows the deal as before, one that reads the
 * status doesn't.
 */
export async function setStoredStatus(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  status: OpportunityStatus,
): Promise<void> {
  await ctx.db.patch("opportunities", opportunityId, { status });
}

/**
 * The operations meeting stats buckets of the UTC days in [scheduledFrom,
 * scheduledTo), summed by meeting status the way the removed
 * phoneSales.getPhoneSalesStats summed them: `won` counts the meetings whose
 * deal was paid when they were bucketed.
 */
export async function meetingStatsTotals(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    scheduledFrom: number;
    scheduledTo: number;
    soldProgramId?: Id<"tenantPrograms">;
    opportunityStatus?: OpportunityStatus;
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
  const totals = { scheduled: 0, completed: 0, canceled: 0, noShows: 0, won: 0 };
  for (const row of rows) {
    if (args.soldProgramId && row.soldProgramId !== args.soldProgramId) continue;
    if (args.opportunityStatus && row.opportunityStatus !== args.opportunityStatus) continue;
    totals.scheduled += row.count;
    if (row.meetingStatus === "completed") totals.completed += row.count;
    if (row.meetingStatus === "canceled") totals.canceled += row.count;
    if (row.meetingStatus === "no_show") totals.noShows += row.count;
    if (row.opportunityStatus === "payment_received") totals.won += row.count;
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
    meeting: { status: "completed", scheduledAt: daysBefore(3), closerId },
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
