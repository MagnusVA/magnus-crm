import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../convex/_generated/server";
import {
  SYSTEM_LOSS_REASONS,
  stageForStatus,
  type DealOutcome,
  type DealSource,
  type DealStage,
} from "../convex/opportunities/stages";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import { updateTenantStats } from "../convex/lib/tenantStatsHelper";
import { opportunityByStage } from "../convex/reporting/aggregates";
import { insertOpportunityAggregate } from "../convex/reporting/writeHooks";
import { qualifiedLifecycle } from "./bookingHarness";

// Phase 5 deal stages (docs/plans/phase-5-deal-status.md §3.1, §4.2). The
// fixtures name a deal by an old status, a short name for where it is, and
// write only what the status maps to: the stage and the outcome. No deal
// stores a status.

/** The stage and outcome an old status names, with the deal's source. */
export function stageFields(status: OpportunityStatus, source: DealSource) {
  return { source, ...stageForStatus(status, source) };
}

/** The loss reason a missed meeting's old status names: its system code. */
export function missedMeetingLossReason(
  status: OpportunityStatus,
): typeof SYSTEM_LOSS_REASONS.canceled | typeof SYSTEM_LOSS_REASONS.no_show | undefined {
  switch (status) {
    case "canceled":
      return SYSTEM_LOSS_REASONS.canceled;
    case "no_show":
      return SYSTEM_LOSS_REASONS.no_show;
    default:
      return undefined;
  }
}

export type DealFields = Partial<Omit<Doc<"opportunities">, "_id" | "_creationTime" | "tenantId" | "leadId">>;

/** A person and a deal at the stage `status` names, counted in opportunityByStage. */
export async function insertDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    status: OpportunityStatus;
    source?: DealSource;
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
  await updateTenantStats(ctx, tenantId, { totalOpportunities: 1 });
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
