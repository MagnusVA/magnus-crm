import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/opportunities/stages";
import { rebuildQualificationRow } from "../convex/operations/projections";
import {
  missedMeetingLossReason,
  stageForStatus,
  type DealSource,
} from "../convex/opportunities/stages";
import { harnessCloserId, insertDeal, type DealFields } from "./dealStageFixtures";

// Phase 5 deal state (docs/plans/phase-5-deal-status.md §4.6, §10.2 to
// §10.4): deals as the dual write leaves them, their reschedule links, and
// their qualification rows.

export type DealStateShape = Pick<
  Doc<"opportunities">,
  "status" | "source" | "stage" | "outcome" | "lostReason" | "lostByUserId"
>;

/**
 * A deal's fields at `status` as the dual write leaves them: the mapped stage
 * and outcome, and a missed meeting's loss with no person. `written: false`
 * leaves the stage and outcome unset, as on a deal from before the widen.
 */
export function dealAt(
  status: OpportunityStatus,
  source: DealSource | undefined,
  options: { written?: boolean; fields?: Partial<DealStateShape> } = {},
): DealStateShape {
  const reason = missedMeetingLossReason(status);
  return {
    status,
    source,
    ...(options.written === false ? {} : stageForStatus(status, source)),
    ...(reason ? { lostReason: reason } : {}),
    ...options.fields,
  };
}

/** The loss fields a missed meeting writes, for `insertDeal`'s `fields`. */
export function missedMeetingLoss(status: OpportunityStatus): DealFields {
  const reason = missedMeetingLossReason(status);
  return reason ? { lostReason: reason, lostAt: 1_500 } : {};
}

/** A deal at `status` with the loss fields the dual write gives it. */
export async function insertWrittenDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    status: OpportunityStatus;
    source?: DealSource;
    fields?: DealFields;
  },
): Promise<Id<"opportunities">> {
  return await insertDeal(ctx, {
    tenantId: args.tenantId,
    status: args.status,
    source: args.source,
    fields: { ...missedMeetingLoss(args.status), ...args.fields },
  });
}

/**
 * A task on the deal. By default a pending reschedule link: a scheduling
 * link with the reason `no_show_follow_up`, as the reschedule link actions
 * write it (closer/noShowActions.ts, admin/meetingActions.ts).
 */
export async function insertDealTask(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  fields: Partial<Pick<Doc<"followUps">, "type" | "reason" | "status" | "createdAt">> = {},
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
    ...fields,
  });
}

/** The Slack installation qualification events name; one per tenant. */
async function slackInstallation(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
): Promise<Id<"slackInstallations">> {
  const existing = await ctx.db
    .query("slackInstallations")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("slackInstallations", {
    tenantId,
    teamId: "T1",
    teamName: "Team",
    isEnterpriseInstall: false,
    appId: "A1",
    botUserId: "B1",
    botAccessToken: "xoxb",
    scopes: [],
    installedByWorkosUserId: "user_slack",
    installedAt: 0,
    tokenExpiresAt: 0,
    refreshToken: "r",
    status: "active",
  });
}

/**
 * A Slack qualification at `qualifiedAt`, on a deal or on none, with its
 * qualification row built the way the projection builds it.
 */
export async function insertQualification(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    qualifiedAt: number;
    opportunityId?: Id<"opportunities">;
  },
): Promise<Id<"slackQualificationEvents">> {
  const deal = args.opportunityId ? await ctx.db.get("opportunities", args.opportunityId) : null;
  const qualifiedBy = { slackUserId: "U1", slackTeamId: "T1", submittedAt: args.qualifiedAt };
  const eventId = await ctx.db.insert("slackQualificationEvents", {
    tenantId: args.tenantId,
    installationId: await slackInstallation(ctx, args.tenantId),
    leadId: deal?.leadId,
    opportunityId: deal?._id,
    resultKind: deal ? "created_opportunity" : "unlinked",
    qualifiedBy,
    slackUserId: "U1",
    slackTeamId: "T1",
    fullNameSnapshot: "Qualified Person",
    platform: "instagram",
    handleSnapshot: "qualified.person",
    submittedAt: args.qualifiedAt,
    createdAt: args.qualifiedAt,
  });
  await rebuildQualificationRow(ctx, eventId);
  return eventId;
}

/** The qualification row of an event. */
export async function qualificationRowOf(
  ctx: MutationCtx,
  qualificationEventId: Id<"slackQualificationEvents">,
): Promise<Doc<"operationsQualificationRows">> {
  const row = await ctx.db
    .query("operationsQualificationRows")
    .withIndex("by_qualificationEventId", (q) => q.eq("qualificationEventId", qualificationEventId))
    .unique();
  return row!;
}

/** A second tenant, whose deals a tenant's checks must not read. */
export async function insertOtherTenant(ctx: MutationCtx): Promise<Id<"tenants">> {
  return await ctx.db.insert("tenants", {
    companyName: "Other",
    contactEmail: "other@example.com",
    workosOrgId: "org_other",
    status: "active",
    inviteExpiresAt: 0,
    createdBy: "test",
  });
}
