import { isHeldStatus, withAttendanceCounts } from "../lib/meetingAttendance";
import { readMeetingStatsCounts } from "../operations/meetingStats";
import { requireReportingReady } from "../operations/reportingReadiness";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import {
  DEAL_POSITIONS,
  dealPosition,
  dealStageOf,
  stageOfPosition,
  type DealPosition,
  type DealStage,
} from "../opportunities/stages";
import { requireTenantUser } from "../requireTenantUser";
import { opportunityByStage } from "./aggregates";
import {
  assertValidDateRange,
  getUserDisplayName,
  reportingUserIdentity,
} from "./lib/helpers";
import { isPersonLoss } from "./lib/outcomeDerivation";

// Each number below reads the deal's stage and outcome
// (docs/plans/phase-5-deal-status.md §6.6).

// The open stages: the deals the aging table and the stale list count, with
// the side deal at Call held (§4.6, §7).
export const OPEN_PIPELINE_STAGES = [
  "qualified",
  "booked",
  "call_held",
  "follow_up",
] as const satisfies ReadonlyArray<DealStage>;

export type OpenPipelineStage = (typeof OPEN_PIPELINE_STAGES)[number];

const MAX_STALE_OPPORTUNITIES = 20;
const MAX_VELOCITY_ROWS = 500;
const REPORT_ROW_CAP = 2000;
const MAX_UNRESOLVED_REMINDER_SCAN_ROWS = REPORT_ROW_CAP + 1;
const MAX_NO_SHOW_SCAN_ROWS = REPORT_ROW_CAP + 1;
// The loss read takes the losses by when they happened, the system's with
// them (production: roughly 1,500 stale, no-show and canceled losses a month
// against a few dozen a person records), so it scans past those to this bound.
const MAX_LOSS_STAGE_SCAN_ROWS = 4000;
const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000;
const VELOCITY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const DAY_MS = 86400000;

type NoShowSource = "closer" | "calendly_webhook" | "none";
type LossAttributionRole = "admin" | "closer" | "unknown";
type ReminderCreatedSource = "closer" | "admin" | "system";

function toRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function emptyNoShowSourceSplit(): Record<NoShowSource, number> {
  return {
    closer: 0,
    calendly_webhook: 0,
    none: 0,
  };
}

function emptyReminderCreatedSourceSplit(): Record<ReminderCreatedSource, number> {
  return {
    closer: 0,
    admin: 0,
    system: 0,
  };
}

function toNoShowSource(
  source: Doc<"meetings">["noShowSource"],
): NoShowSource {
  switch (source) {
    case "closer":
      return "closer";
    case "calendly_webhook":
      return "calendly_webhook";
    case undefined:
      return "none";
    default:
      return "none";
  }
}

function toReminderCreatedSource(
  source: Doc<"followUps">["createdSource"],
): ReminderCreatedSource {
  switch (source) {
    case "closer":
      return "closer";
    case "admin":
      return "admin";
    case "system":
    case undefined:
      return "system";
    default:
      return "system";
  }
}

function toLossAttributionRole(
  role: Doc<"users">["role"] | null | undefined,
): LossAttributionRole {
  switch (role) {
    case "tenant_master":
    case "tenant_admin":
      return "admin";
    case "closer":
      return "closer";
    case undefined:
    case null:
      return "unknown";
    default:
      return "unknown";
  }
}

// ── Distribution ────────────────────────────────────────────────────────

/** Deals in each of the six positions, from opportunityByStage (§6.6). */
export async function readPipelineDistributionByStage(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): Promise<Array<{ position: DealPosition; count: number }>> {
  const counts = await opportunityByStage.countBatch(
    ctx,
    DEAL_POSITIONS.map((position) => {
      const { stage, outcome } = stageOfPosition(position);
      return { namespace: tenantId, bounds: { prefix: [stage, outcome] } };
    }),
  );
  return DEAL_POSITIONS.map((position, index) => ({
    position,
    count: counts[index] ?? 0,
  }));
}

// ── Aging and the stale list ────────────────────────────────────────────

export type PipelineAgingGroup = {
  count: number;
  totalAgeDays: number;
  oldestAgeDays: number;
};

export type StaleCandidate = {
  opportunity: Doc<"opportunities">;
  ageDays: number;
  nextMeetingAt: number | null;
};

export type PipelineAgingScan<Key extends string> = {
  groups: Record<Key, PipelineAgingGroup>;
  staleCount: number;
  /** Every stale deal, in the order read. */
  staleCandidates: StaleCandidate[];
  /** Stopped at `maxDocs`: the numbers cover only the deals read. */
  capped: boolean;
};

export type PipelineAgingScanOptions = {
  /** Only the deals created in [from, to); with no `to`, from `from` on. */
  createdAt?: { from: number; to?: number };
  /** Stop past this many deals and set `capped`. */
  maxDocs?: number;
};

function isStale(opportunity: Doc<"opportunities">, now: number): boolean {
  return (
    opportunity.nextMeetingAt === undefined ||
    opportunity.nextMeetingAt < now - STALE_THRESHOLD_MS
  );
}

async function scanPipelineAging<Key extends string>(
  ranges: Array<{ key: Key; deals: () => AsyncIterable<Doc<"opportunities">> }>,
  now: number,
  options: PipelineAgingScanOptions,
): Promise<PipelineAgingScan<Key>> {
  const groups = {} as Record<Key, PipelineAgingGroup>;
  const staleCandidates: StaleCandidate[] = [];
  let staleCount = 0;
  let scanned = 0;
  let capped = false;

  for (const { key, deals } of ranges) {
    const group = { count: 0, totalAgeDays: 0, oldestAgeDays: 0 };
    groups[key] = group;
    if (capped) {
      continue;
    }
    // `nextMeetingAt` is not indexed, so exact stale counts require scanning
    // the active pipeline rows instead of relying on the capped sample list.
    for await (const opportunity of deals()) {
      if (options.maxDocs !== undefined && scanned >= options.maxDocs) {
        capped = true;
        break;
      }
      scanned += 1;
      group.count += 1;
      const ageDays = (now - opportunity.createdAt) / DAY_MS;
      group.totalAgeDays += ageDays;
      group.oldestAgeDays = Math.max(group.oldestAgeDays, ageDays);

      if (isStale(opportunity, now)) {
        staleCount += 1;
        staleCandidates.push({
          opportunity,
          ageDays,
          nextMeetingAt: opportunity.nextMeetingAt ?? null,
        });
      }
    }
  }

  return { groups, staleCount, staleCandidates, capped };
}

/**
 * The open deals' ages by stage (§6.6), read through
 * by_tenantId_and_stage_and_outcome_and_createdAt, with the side deal at
 * Call held. A deal is stale with no next meeting, or one long past.
 */
export async function scanPipelineAgingByStage(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
  options: PipelineAgingScanOptions = {},
): Promise<PipelineAgingScan<OpenPipelineStage>> {
  const window = options.createdAt;
  return await scanPipelineAging(
    OPEN_PIPELINE_STAGES.map((stage) => ({
      key: stage,
      deals: () =>
        ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) => {
            const range = q
              .eq("tenantId", tenantId)
              .eq("stage", stage)
              .eq("outcome", "open");
            if (!window) return range;
            return window.to === undefined
              ? range.gte("createdAt", window.from)
              : range.gte("createdAt", window.from).lt("createdAt", window.to);
          }),
    })),
    now,
    options,
  );
}

// ── Velocity ────────────────────────────────────────────────────────────

export type PipelineVelocity = {
  velocityDays: number | null;
  /** The won deals measured. */
  opportunityIds: Array<Id<"opportunities">>;
  truncated: boolean;
};

function measureVelocity(rows: Array<Doc<"opportunities">>): PipelineVelocity {
  const wonRows = rows.slice(0, MAX_VELOCITY_ROWS);

  let velocityTotalDays = 0;
  let velocityCount = 0;
  for (const opportunity of wonRows) {
    if (opportunity.paymentReceivedAt === undefined) {
      continue;
    }
    velocityTotalDays +=
      (opportunity.paymentReceivedAt - opportunity.createdAt) / DAY_MS;
    velocityCount += 1;
  }

  return {
    velocityDays: velocityCount > 0 ? velocityTotalDays / velocityCount : null,
    opportunityIds: wonRows.map((opportunity) => opportunity._id),
    truncated: rows.length > MAX_VELOCITY_ROWS,
  };
}

/** Days from creation to payment over deals Closed won and created in the last 90 days (§6.6). */
export async function readPipelineVelocityByStage(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  now: number,
): Promise<PipelineVelocity> {
  const rows = await ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_stage_and_outcome_and_createdAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("stage", "closed")
        .eq("outcome", "won")
        .gte("createdAt", now - VELOCITY_WINDOW_MS),
    )
    .take(MAX_VELOCITY_ROWS + 1);
  return measureVelocity(rows);
}

// ── Loss attribution ────────────────────────────────────────────────────

export type PipelineLosses = {
  /** The deals a person lost in the range, up to the report's cap. */
  losses: Array<Doc<"opportunities">>;
  truncated: boolean;
  /** Deals read to find them. */
  scanned: number;
};

/**
 * Deals Closed lost in the range by `lostAt`, leaving out every loss the
 * system wrote (the Slack expiry, a no-show, a cancellation). It reads from
 * the start of the range by activity
 * (by_tenantId_and_stage_and_outcome_and_latestActivityAt): a loss is
 * activity, so a deal lost in the range has activity at or after its start,
 * and the Slack expiry keeps a deal's earlier activity, so the expiries, about
 * 4,000 in a recent month of production, aren't read at all.
 */
export async function readLossesByStage(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
): Promise<PipelineLosses> {
  const losses: Array<Doc<"opportunities">> = [];
  let scanned = 0;
  let truncated = false;
  for await (const opportunity of ctx.db
    .query("opportunities")
    .withIndex("by_tenantId_and_stage_and_outcome_and_latestActivityAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .eq("stage", "closed")
        .eq("outcome", "lost")
        .gte("latestActivityAt", startDate),
    )) {
    if (scanned >= MAX_LOSS_STAGE_SCAN_ROWS) {
      truncated = true;
      break;
    }
    scanned += 1;
    if (
      opportunity.lostAt === undefined ||
      opportunity.lostAt < startDate ||
      opportunity.lostAt >= endDate ||
      !isPersonLoss(opportunity)
    ) {
      continue;
    }
    if (losses.length >= REPORT_ROW_CAP) {
      truncated = true;
      break;
    }
    losses.push(opportunity);
  }
  return { losses, truncated, scanned };
}

export function countLossesByActor(losses: Array<Doc<"opportunities">>) {
  const lossCountsByActor = new Map<Id<"users">, number>();
  let unknownLossCount = 0;

  for (const opportunity of losses) {
    if (!opportunity.lostByUserId) {
      unknownLossCount += 1;
      continue;
    }

    lossCountsByActor.set(
      opportunity.lostByUserId,
      (lossCountsByActor.get(opportunity.lostByUserId) ?? 0) + 1,
    );
  }

  return { lossCountsByActor, unknownLossCount };
}

// ── Screens ─────────────────────────────────────────────────────────────

export const getPipelineDistribution = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return {
      distribution: await readPipelineDistributionByStage(ctx, tenantId),
    };
  },
});

export const getPipelineAging = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const now = Date.now();
    const aging = await scanPipelineAgingByStage(ctx, tenantId, now);
    const agingByStage = {} as Record<
      OpenPipelineStage,
      { averageAgeDays: number | null; count: number; oldestAgeDays: number | null }
    >;
    for (const stage of OPEN_PIPELINE_STAGES) {
      const { count, totalAgeDays, oldestAgeDays } = aging.groups[stage];
      agingByStage[stage] = {
        count,
        averageAgeDays: count > 0 ? totalAgeDays / count : null,
        oldestAgeDays: count > 0 ? oldestAgeDays : null,
      };
    }

    const velocity = await readPipelineVelocityByStage(ctx, tenantId, now);

    const staleOpportunities = aging.staleCandidates
      .sort((left, right) => right.ageDays - left.ageDays)
      .slice(0, MAX_STALE_OPPORTUNITIES);

    const leadIds = [
      ...new Set(staleOpportunities.map((entry) => entry.opportunity.leadId)),
    ];
    const closerIds = [
      ...new Set(
        staleOpportunities
          .map((entry) => entry.opportunity.assignedCloserId)
          .filter((closerId): closerId is Id<"users"> => closerId !== undefined),
      ),
    ];
    const [leadDocs, closerDocs] = await Promise.all([
      Promise.all(leadIds.map(async (leadId) => [leadId, await ctx.db.get("leads", leadId)] as const)),
      Promise.all(
        closerIds.map(async (closerId) => [closerId, await ctx.db.get("users", closerId)] as const),
      ),
    ]);
    const leadById = new Map(leadDocs);
    const closerById = new Map(closerDocs);

    return {
      agingByStage,
      velocityDays: velocity.velocityDays,
      staleCount: aging.staleCount,
      staleOpps: await Promise.all(staleOpportunities.map(
        async ({ opportunity, ageDays, nextMeetingAt }) => {
          const assignedCloser = opportunity.assignedCloserId
            ? closerById.get(opportunity.assignedCloserId)
            : null;
          const { stage, outcome } = dealStageOf(opportunity);
          return {
            opportunityId: opportunity._id,
            position: dealPosition(stage, outcome),
            ageDays: Math.round(ageDays * 10) / 10,
            nextMeetingAt,
            assignedCloserId: opportunity.assignedCloserId ?? null,
            assignedCloserName: assignedCloser
              ? getUserDisplayName(assignedCloser)
              : null,
            assignedCloser: assignedCloser
              ? await reportingUserIdentity(ctx, assignedCloser, "Removed closer")
              : null,
            leadId: opportunity.leadId,
            leadName:
              leadById.get(opportunity.leadId)?.fullName ??
              leadById.get(opportunity.leadId)?.email ??
              null,
          };
        },
      )),
      isAgingTruncated: aging.capped,
      isVelocityTruncated: velocity.truncated,
    };
  },
});

export const getPipelineBacklogAndLoss = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const pendingFollowUpRows = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_UNRESOLVED_REMINDER_SCAN_ROWS);

    const noShowRows = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "no_show")
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )
      .take(MAX_NO_SHOW_SCAN_ROWS);

    // Closed lost by lostAt, leaving out the system's losses. The read
    // passes over those too, so it can stop at its bound: truncated.
    const losses = await readLossesByStage(ctx, tenantId, startDate, endDate);

    const unresolvedManualReminders = pendingFollowUpRows
      .slice(0, REPORT_ROW_CAP)
      .filter((followUp) => followUp.type === "manual_reminder");
    const unresolvedReminderSplit = emptyReminderCreatedSourceSplit();
    for (const followUp of unresolvedManualReminders) {
      unresolvedReminderSplit[toReminderCreatedSource(followUp.createdSource)] += 1;
    }

    const noShowMeetings = noShowRows.slice(0, REPORT_ROW_CAP);
    const noShowSourceSplit = emptyNoShowSourceSplit();
    for (const meeting of noShowMeetings) {
      noShowSourceSplit[toNoShowSource(meeting.noShowSource)] += 1;
    }

    const { lossCountsByActor, unknownLossCount } = countLossesByActor(losses.losses);

    const actorIds = [...lossCountsByActor.keys()];
    const actorDocs = await Promise.all(
      actorIds.map(async (actorId) => [actorId, await ctx.db.get("users", actorId)] as const),
    );
    const actorById = new Map(actorDocs);

    const byActor = (await Promise.all(actorIds
      .map(async (actorId) => {
        const actor = actorById.get(actorId);
        return {
          userId: actorId,
          actorName: actor ? getUserDisplayName(actor) : "Removed user",
          actor: await reportingUserIdentity(ctx, actor, "Removed user"),
          actorRole: toLossAttributionRole(actor?.role),
          count: lossCountsByActor.get(actorId) ?? 0,
        };
      })))
      .sort(
        (left, right) =>
          right.count - left.count ||
          left.actorName.localeCompare(right.actorName),
      );

    const lossAttribution = {
      admin: 0,
      closer: 0,
      unknown: unknownLossCount,
      byActor,
    };

    for (const actor of byActor) {
      lossAttribution[actor.actorRole] += actor.count;
    }

    return {
      unresolvedRemindersCount: unresolvedManualReminders.length,
      unresolvedReminderSplit,
      isUnresolvedRemindersTruncated: pendingFollowUpRows.length > REPORT_ROW_CAP,
      noShowSourceSplit,
      isNoShowSourceTruncated: noShowRows.length > REPORT_ROW_CAP,
      lossAttribution,
      isLossAttributionTruncated: losses.truncated,
    };
  },
});

export const getSchedulingShowRateByOperationsDimensions = query({
  args: {
    startDayKey: v.string(),
    endDayKeyExclusive: v.string(),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  returns: v.object({
    scheduled: v.number(),
    shown: v.number(),
    canceled: v.number(),
    noShows: v.number(),
    resultsRecorded: v.number(),
    pastCalls: v.number(),
    showRate: v.union(v.number(), v.null()),
    noShowRate: v.union(v.number(), v.null()),
    attendanceCountsPartial: v.boolean(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    await requireReportingReady(ctx, tenantId);

    if (args.startDayKey >= args.endDayKeyExclusive) {
      throw new Error("startDayKey must be before endDayKeyExclusive");
    }

    // A team or DM closer filter reads the credited meetings' rows
    // (dealAttributions); otherwise the buckets.
    const { counts, truncated } = await readMeetingStatsCounts(ctx, {
      tenantId,
      startDayKey: args.startDayKey,
      endDayKeyExclusive: args.endDayKeyExclusive,
      attributionTeamId: args.attributionTeamId,
      dmCloserId: args.dmCloserId,
    });

    const filtered = counts.filter(
      (row) =>
        !args.bookingProgramId ||
        row.bookingProgramId === args.bookingProgramId,
    );

    let scheduled = 0;
    let shown = 0;
    let canceled = 0;
    let noShows = 0;
    let notRecorded = 0;
    const attendance = await withAttendanceCounts(ctx, tenantId, filtered);
    for (const row of attendance.counts) {
      scheduled += row.count;
      notRecorded += row.notRecorded;
      if (isHeldStatus(row.meetingStatus)) {
        shown += row.count;
      }
      if (row.meetingStatus === "canceled") {
        canceled += row.count;
      }
      if (row.meetingStatus === "no_show") {
        noShows += row.count;
      }
    }
    const denominator = shown + noShows;

    return {
      scheduled,
      shown,
      canceled,
      noShows,
      resultsRecorded: denominator,
      pastCalls: denominator + notRecorded,
      showRate: toRate(shown, denominator),
      noShowRate: toRate(noShows, denominator),
      attendanceCountsPartial: attendance.attendanceCountsPartial,
      truncated,
    };
  },
});
