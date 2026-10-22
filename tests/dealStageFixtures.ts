import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import {
  stageForStatus,
  type DealOutcome,
  type DealSource,
  type DealStage,
} from "../convex/opportunities/stages";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import {
  isActiveOpportunityStatus,
  updateTenantStats,
} from "../convex/lib/tenantStatsHelper";
import { opportunityByStage, opportunityByStatus } from "../convex/reporting/aggregates";
import { insertOpportunityAggregate } from "../convex/reporting/writeHooks";
import { qualifiedLifecycle } from "./bookingHarness";

// Phase 5 deal stages (docs/plans/phase-5-deal-status.md §3.1, §4.2): deals
// inserted the way production holds them, before and after the backfill.

/** The status of a deal with the stage and outcome the dual write gives it. */
export function stageFields(status: OpportunityStatus, source: DealSource) {
  return { status, source, ...stageForStatus(status, source) };
}

export type DealFields = Partial<Omit<Doc<"opportunities">, "_id" | "_creationTime" | "tenantId" | "leadId">>;

/**
 * A person and a deal at `status`. `written: false` is a deal from before the
 * widen: no stage or outcome, and counted only in the status aggregate, as
 * the old insert left it.
 */
export async function insertDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    status: OpportunityStatus;
    source?: DealSource;
    written?: boolean;
    fields?: DealFields;
  },
): Promise<Id<"opportunities">> {
  const { tenantId, status } = args;
  const source = args.source ?? "calendly";
  const leadId = await ctx.db.insert("leads", {
    ...qualifiedLifecycle(0),
    tenantId,
    email: "deal-person@example.com",
    status: "active",
    firstSeenAt: 0,
    updatedAt: 0,
  });
  const base = { tenantId, leadId, createdAt: 1_000, updatedAt: 1_000, ...args.fields };
  await updateTenantStats(ctx, tenantId, {
    totalOpportunities: 1,
    activeOpportunities: isActiveOpportunityStatus(status) ? 1 : 0,
    wonDeals: status === "payment_received" ? 1 : 0,
    lostDeals: status === "lost" ? 1 : 0,
  });
  if (args.written === false) {
    const opportunityId = await ctx.db.insert("opportunities", { ...base, status, source });
    await opportunityByStatus.insert(ctx, (await ctx.db.get("opportunities", opportunityId))!);
    return opportunityId;
  }
  const opportunityId = await ctx.db.insert("opportunities", { ...base, ...stageFields(status, source) });
  await insertOpportunityAggregate(ctx, opportunityId);
  return opportunityId;
}

/** A meeting on the deal, made its latest. */
export async function insertLatestMeeting(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  fields: Partial<Doc<"meetings">> & Pick<Doc<"meetings">, "status">,
): Promise<Id<"meetings">> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const closer = (await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
    .unique())!;
  const meetingId = await ctx.db.insert("meetings", {
    tenantId: deal.tenantId,
    opportunityId,
    assignedCloserId: closer._id,
    calendlyEventUri: `https://api.calendly.com/scheduled_events/${opportunityId}`,
    calendlyInviteeUri: `https://api.calendly.com/scheduled_events/${opportunityId}/invitees/person`,
    scheduledAt: 2_000,
    durationMinutes: 30,
    createdAt: 2_000,
    ...fields,
  });
  await ctx.db.patch("opportunities", opportunityId, { latestMeetingId: meetingId });
  return meetingId;
}

/** Deals counted in `opportunityByStage` at a stage and outcome, optionally one closer's. */
export async function countAtStage(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  stage: DealStage,
  outcome: DealOutcome,
  closerId?: Id<"users">,
): Promise<number> {
  return await opportunityByStage.count(ctx, {
    namespace: tenantId,
    bounds: { prefix: closerId === undefined ? [stage, outcome] : [stage, outcome, closerId] },
  });
}

/** The closer the booking harness creates. */
export async function harnessCloserId(ctx: QueryCtx): Promise<Id<"users">> {
  const closer = await ctx.db
    .query("users")
    .withIndex("by_workosUserId", (q) => q.eq("workosUserId", "user_closer"))
    .unique();
  return closer!._id;
}
