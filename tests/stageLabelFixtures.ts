import type { Doc, Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import type { OpportunityStatus } from "../convex/lib/statusTransitions";
import { missedMeetingLossReason, type DealSource } from "../convex/opportunities/stages";
import { insertOpportunityAggregate } from "../convex/reporting/writeHooks";
import { qualifiedLifecycle } from "./bookingHarness";
import { harnessCloserId, stageFields, type DealFields } from "./dealStageFixtures";

// Phase 5 deal labels (docs/plans/phase-5-deal-status.md §6.1): a person's
// deals as the dual write leaves them, their events in both forms, and the
// rows the readers show beside them.

/** A person for the deals below. */
export async function insertPerson(ctx: MutationCtx, tenantId: Id<"tenants">): Promise<Id<"leads">> {
  return await ctx.db.insert("leads", {
    ...qualifiedLifecycle(0),
    tenantId,
    fullName: "Label Person",
    email: "label-person@example.com",
    status: "active",
    firstSeenAt: 0,
    updatedAt: 0,
  });
}

/**
 * A deal at `status` on the person, worked by the harness closer, with the
 * stage, outcome and missed meeting loss the dual write gives it.
 */
export async function insertPersonDeal(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    leadId: Id<"leads">;
    status: OpportunityStatus;
    source?: DealSource;
    createdAt?: number;
    fields?: DealFields;
  },
): Promise<Id<"opportunities">> {
  const reason = missedMeetingLossReason(args.status);
  const createdAt = args.createdAt ?? 1_000;
  const opportunityId = await ctx.db.insert("opportunities", {
    tenantId: args.tenantId,
    leadId: args.leadId,
    assignedCloserId: await harnessCloserId(ctx),
    createdAt,
    updatedAt: createdAt,
    ...stageFields(args.status, args.source ?? "calendly"),
    ...(reason ? { lostReason: reason, lostAt: createdAt + 500 } : {}),
    ...args.fields,
  });
  await insertOpportunityAggregate(ctx, opportunityId);
  return opportunityId;
}

/** A deal event on its person's timeline, old form or new. */
export async function insertDealEvent(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  event: Pick<Doc<"domainEvents">, "eventType" | "occurredAt"> &
    Partial<Pick<Doc<"domainEvents">, "fromStatus" | "toStatus" | "reason">> & {
      metadata?: Record<string, unknown>;
    },
): Promise<Id<"domainEvents">> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  return await ctx.db.insert("domainEvents", {
    tenantId: deal.tenantId,
    entityType: "opportunity",
    entityId: opportunityId,
    leadId: deal.leadId,
    source: "closer",
    ...event,
    metadata: event.metadata ? JSON.stringify(event.metadata) : undefined,
  });
}

/** A pending manual reminder on the deal, the harness closer's. */
export async function insertReminder(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Id<"followUps">> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  return await ctx.db.insert("followUps", {
    tenantId: deal.tenantId,
    opportunityId,
    leadId: deal.leadId,
    closerId: await harnessCloserId(ctx),
    type: "manual_reminder",
    reminderScheduledAt: 5_000,
    reason: "closer_initiated",
    status: "pending",
    createdAt: 1_000,
  });
}

/** A side deal payment on the deal, as a closer records it. */
export async function insertSideDealPayment(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
): Promise<Id<"paymentRecords">> {
  const deal = (await ctx.db.get("opportunities", opportunityId))!;
  const closerId = await harnessCloserId(ctx);
  const programId = await ctx.db.insert("tenantPrograms", {
    tenantId: deal.tenantId,
    name: "Program",
    normalizedName: "program",
    createdAt: 0,
    createdByUserId: closerId,
    updatedAt: 0,
  });
  await ctx.db.patch("opportunities", opportunityId, { soldProgramId: programId, soldProgramName: "Program" });
  return await ctx.db.insert("paymentRecords", {
    tenantId: deal.tenantId,
    opportunityId,
    attributedCloserId: closerId,
    recordedByUserId: closerId,
    commissionable: true,
    amountMinor: 10_000,
    currency: "USD",
    programId,
    programName: "Program",
    paymentType: "pif",
    status: "recorded",
    recordedAt: 3_000,
    origin: "closer_side_deal",
  });
}
