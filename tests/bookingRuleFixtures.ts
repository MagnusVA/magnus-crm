import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import {
  OPPORTUNITY_STATUSES,
  validateTransition,
  type OpportunityStatus,
} from "../convex/lib/statusTransitions";
import { legacyStatus, type DealStateFields } from "../convex/opportunities/dealState";
import {
  missedMeetingLossReason,
  stageForStatus,
  type DealOutcome,
  type DealSource,
  type DealStage,
} from "../convex/opportunities/stages";
import { dealPositionAt, wasUnattachableAt } from "../convex/pipeline/bookingHistory";
import { SLACK_STALE_LOST_REASON } from "../convex/pipeline/slackJoinLookup";
import { bookingHarness, qualifiedLifecycle } from "./bookingHarness";
import { harnessCloserId } from "./dealStageFixtures";

// The booking rules read the deal's stage, outcome, loss and tasks from PR 7
// (docs/plans/phase-5-deal-status.md §4.6, §6.7) and must give the answers
// today's status checks give. These are the deals the dual write leaves,
// today's checks written in statuses, and the deal histories the late
// booking guard reads.

export const DEAL_SOURCES: (DealSource | undefined)[] = [
  "calendly",
  "slack_qualified",
  "side_deal",
  undefined,
];

/** The deal's fields a booking rule reads, with the loss time the Slack join reads. */
export type RuleDeal = DealStateFields & Pick<Doc<"opportunities">, "lostAt">;

export type DealTasks = { hasPendingRescheduleLink: boolean };

export type BookingRuleWorld = {
  label: string;
  /** The status the deal holds, which today's checks read. */
  status: OpportunityStatus;
  deal: RuleDeal;
  tasks: DealTasks;
};

const PERSON = "user_person" as Id<"users">;

// The losses a deal can carry: none, a person's (free text, no text, or text
// that matches a system code), the Slack expiry's, and a missed meeting's.
// Each status gets them all; the filter below keeps the ones it can hold.
const LOSSES: Array<{ label: string; fields: Partial<RuleDeal> }> = [
  { label: "no loss", fields: {} },
  { label: "a person's reason", fields: { lostReason: "budget", lostByUserId: PERSON } },
  { label: "a person's 'no_show'", fields: { lostReason: "no_show", lostByUserId: PERSON } },
  { label: "a person's 'stale'", fields: { lostReason: SLACK_STALE_LOST_REASON, lostByUserId: PERSON } },
  { label: "a person, no reason", fields: { lostByUserId: PERSON } },
  { label: "the Slack expiry", fields: { lostReason: SLACK_STALE_LOST_REASON } },
  { label: "a no-show", fields: { lostReason: "no_show" } },
  { label: "a cancellation", fields: { lostReason: "canceled" } },
];

/**
 * Every deal the dual write can leave, with every task state it can have: each
 * of the eight statuses × four sources × the losses above × with and without
 * a stored stage × with and without a pending reschedule link, kept only
 * where `legacyStatus` rebuilds the status from the rest, the invariant
 * `assertDealStages` checks on every deal in production.
 */
export function bookingRuleWorlds(): BookingRuleWorld[] {
  const worlds: BookingRuleWorld[] = [];
  for (const status of OPPORTUNITY_STATUSES)
    for (const source of DEAL_SOURCES)
      for (const loss of LOSSES)
        for (const written of [true, false])
          for (const hasPendingRescheduleLink of [false, true]) {
            const deal: RuleDeal = {
              status,
              source,
              ...(written ? stageForStatus(status, source) : {}),
              ...loss.fields,
              ...(loss.fields.lostReason || loss.fields.lostByUserId ? { lostAt: 1_500 } : {}),
            };
            const tasks = { hasPendingRescheduleLink };
            if (legacyStatus(deal, tasks) !== status) continue;
            worlds.push({
              label: [
                status,
                source ?? "no source",
                loss.label,
                written ? "stage stored" : "no stored stage",
                hasPendingRescheduleLink ? "a pending reschedule link" : "no reschedule link",
              ].join(", "),
              status,
              deal,
              tasks,
            });
          }
  return worlds;
}

/**
 * Today's checks, in statuses, as `inviteeCreated.ts`, `bookingFacts.ts` and
 * `slackJoinLookup.ts` wrote them before PR 7. Frozen: they are the reference
 * the new predicates must agree with.
 */
export const TODAYS_CHECKS = {
  /** The booking link (utm_source=ptdom) takes the deal. */
  bookingLinkTarget: (status: OpportunityStatus) =>
    (status === "follow_up_scheduled" || status === "reschedule_link_sent") &&
    validateTransition(status, "scheduled"),
  /** The booking link expires the deal's other pending reschedule links. */
  expiresRescheduleLinks: (status: OpportunityStatus) => status === "reschedule_link_sent",
  /** What a Calendly reschedule (`old_invitee`) does with the old booking's deal. */
  calendlyRescheduleTarget: (status: OpportunityStatus): "move" | "ended" | "review" =>
    status === "scheduled"
      ? "move"
      : status === "no_show" || status === "canceled"
        ? "ended"
        : "review",
  /** A booking without a link joins the deal. */
  followUpJoinTarget: (status: OpportunityStatus) => status === "follow_up_scheduled",
  /** The state machine lets a booking move the deal to `scheduled`. */
  allowsMoveToBooked: (status: OpportunityStatus) => validateTransition(status, "scheduled"),
  /** A Calendly fact that leaves the current booking's meeting at `meetingStatus` moves the deal. */
  bookingFactMovesDeal: (
    status: OpportunityStatus,
    meetingStatus: "scheduled" | "no_show" | "canceled",
  ) => ["scheduled", "no_show", "canceled"].includes(status) && status !== meetingStatus,
  /** The stale expiry closed this Slack deal after the booking at `referenceTime`. */
  wasStaleExpiredAfter: (deal: RuleDeal, referenceTime: number) =>
    deal.source === "slack_qualified" &&
    deal.status === "lost" &&
    deal.lostReason === SLACK_STALE_LOST_REASON &&
    (deal.lostAt ?? 0) > referenceTime,
};

/**
 * Today's Slack join lookup on the status index: the person's pending Slack
 * deals and stale-expired ones, eight of each kind at most, inside the
 * window. Returns the candidates, so the caller can tell ambiguity apart.
 */
export async function todaysSlackJoinCandidates(
  ctx: MutationCtx,
  args: { tenantId: Id<"tenants">; leadId: Id<"leads">; referenceTime: number; lookbackMs: number },
): Promise<Id<"opportunities">[]> {
  const cutoff = args.referenceTime - args.lookbackMs;
  const inWindow = (status: "qualified_pending" | "lost") =>
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId_and_source_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("leadId", args.leadId)
          .eq("source", "slack_qualified")
          .eq("status", status)
          .gt("createdAt", cutoff)
          .lte("createdAt", args.referenceTime),
      )
      .order("desc")
      .take(8);
  const pending = await inWindow("qualified_pending");
  const expired = (await inWindow("lost")).filter((deal) =>
    TODAYS_CHECKS.wasStaleExpiredAfter(deal, args.referenceTime),
  );
  return [...pending, ...expired].map((deal) => deal._id);
}

/**
 * What the dual write and PR 1's backfill write beside a deal's status: the
 * stage and outcome, and on a missed meeting its loss, at `lostAt`. The
 * booking rules read these, so a fixture deal needs them.
 */
export function writtenBesideStatus(status: OpportunityStatus, source: DealSource, lostAt = 0) {
  const reason = missedMeetingLossReason(status);
  return { ...stageForStatus(status, source), ...(reason ? { lostReason: reason, lostAt } : {}) };
}

/** A person with one deal, inserted the way the dual write leaves it, for the DB-backed checks. */
export async function insertRuleDeal(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  deal: RuleDeal,
  fields: Partial<Doc<"opportunities">> = {},
): Promise<{ leadId: Id<"leads">; opportunityId: Id<"opportunities"> }> {
  const leadId = await ctx.db.insert("leads", {
    ...qualifiedLifecycle(0),
    tenantId,
    email: "rule-person@example.com",
    status: "active",
    firstSeenAt: 0,
    updatedAt: 0,
  });
  const lostByUserId = deal.lostByUserId ? await harnessCloserId(ctx) : undefined;
  const opportunityId = await ctx.db.insert("opportunities", {
    tenantId,
    leadId,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...deal,
    lostByUserId,
    ...fields,
  });
  return { leadId, opportunityId };
}

/** A pending reschedule link on the deal, as the reschedule link actions write it. */
export async function insertRescheduleLink(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Id<"followUps">> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  return await ctx.db.insert("followUps", {
    tenantId: deal.tenantId,
    opportunityId,
    leadId: deal.leadId,
    closerId: await harnessCloserId(ctx),
    type: "scheduling_link",
    schedulingLinkUrl: "https://calendly.com/closer/reschedule",
    reason: "no_show_follow_up",
    status: "pending",
    createdAt: 1_000,
  });
}

// ─── Deal histories (bookingHistory.ts) ─────────────────────────────────

/** Where a new deal event (PR 8) says the deal was: the stage, with the outcome in its metadata. */
export type StageAt = { stage: DealStage; outcome: DealOutcome };

/**
 * A recorded change. An old event holds statuses; an event from PR 8
 * (`opportunity.stage_changed`, or `opportunity.marked_lost` for a loss)
 * holds stages, with the outcomes in its metadata. `undefined` as the old
 * form's `from` is the deal's `opportunity.created`.
 */
export type HistoryChange =
  | [at: number, from: OpportunityStatus | undefined, to: OpportunityStatus]
  | [at: number, from: StageAt, to: StageAt];

/** Shorthand for a new event's side. */
export const at = (stage: DealStage, outcome: DealOutcome = "open"): StageAt => ({ stage, outcome });

/**
 * A deal at `current`, written as the dual write leaves it (the stage, and a
 * missed meeting's loss), with the changes it recorded, read back at
 * `time`: its position then, and whether a booking at `time` couldn't have
 * joined it.
 */
export async function readDealHistory(
  current: OpportunityStatus,
  changes: HistoryChange[],
  options: {
    time: number;
    createdAt: number;
    source?: DealSource;
    /** Events that aren't status changes, recorded after `time`. */
    otherEvents?: number;
    /** A pending reschedule link on the deal, which makes Follow-up `reschedule_link_sent`. */
    rescheduleLink?: boolean;
    /** Outcomes left out of the new events' metadata. */
    dropOutcomes?: boolean;
  },
) {
  const { t, tenantId } = await bookingHarness();
  return await t.run(async (ctx) => {
    const source = options.source ?? "calendly";
    const leadId = await ctx.db.insert("leads", {
      ...qualifiedLifecycle(options.createdAt),
      tenantId,
      email: "lead@example.com",
      status: "active",
      firstSeenAt: options.createdAt,
      updatedAt: options.createdAt,
    });
    const opportunityId = await ctx.db.insert("opportunities", {
      tenantId,
      leadId,
      status: current,
      source,
      ...writtenBesideStatus(current, source, options.time + 21_000),
      createdAt: options.createdAt,
      updatedAt: options.time + 21_000,
    });
    if (options.rescheduleLink) await insertRescheduleLink(ctx, opportunityId);
    for (const [occurredAt, from, to] of changes) {
      const base = {
        tenantId,
        entityType: "opportunity" as const,
        entityId: opportunityId,
        occurredAt,
        source: "pipeline" as const,
      };
      if (typeof to === "string") {
        const fromStatus = from as OpportunityStatus | undefined;
        await ctx.db.insert("domainEvents", {
          ...base,
          eventType: fromStatus ? "opportunity.status_changed" : "opportunity.created",
          fromStatus,
          toStatus: to,
        });
      } else {
        const fromStage = from as StageAt;
        await ctx.db.insert("domainEvents", {
          ...base,
          eventType:
            to.stage === "closed" && to.outcome === "lost"
              ? "opportunity.marked_lost"
              : "opportunity.stage_changed",
          fromStatus: fromStage.stage,
          toStatus: to.stage,
          metadata: options.dropOutcomes
            ? undefined
            : JSON.stringify({ fromOutcome: fromStage.outcome, toOutcome: to.outcome }),
        });
      }
    }
    for (let i = 0; i < (options.otherEvents ?? 0); i++)
      await ctx.db.insert("domainEvents", {
        tenantId,
        entityType: "opportunity",
        entityId: opportunityId,
        eventType: "opportunity.stale_flagged",
        occurredAt: options.time + 1_000 + i,
        source: "system",
      });
    const opportunity = (await ctx.db.get("opportunities", opportunityId))!;
    return {
      position: await dealPositionAt(ctx, opportunity, options.time),
      unattachable: await wasUnattachableAt(ctx, opportunity, options.time),
    };
  });
}
