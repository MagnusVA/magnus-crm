import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { DomainEventEntityType } from "./domainEvents";

// The person an event is about and the team member who acted, so the event
// log can serve as the person timeline (docs/plans/phase-1-foundations.md
// §6.2). `emitDomainEvent` derives both for every new event, and the link
// backfill uses the same rules for older ones.

export type DomainEventLinkInput = {
  tenantId: Id<"tenants">;
  entityType: DomainEventEntityType;
  entityId: string;
  actorUserId?: Id<"users">;
  metadata?: Record<string, unknown>;
};

export type DomainEventLinks = {
  leadId?: Id<"leads">;
  teamMemberId?: Id<"teamMembers">;
};

type Ctx = QueryCtx | MutationCtx;

async function opportunityLeadId(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  opportunityId: Id<"opportunities"> | undefined,
): Promise<Id<"leads"> | undefined> {
  if (!opportunityId) {
    return undefined;
  }
  const opportunity = await ctx.db.get("opportunities", opportunityId);
  return opportunity?.tenantId === tenantId ? opportunity.leadId : undefined;
}

async function customerLeadId(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  customerId: Id<"customers"> | undefined,
): Promise<Id<"leads"> | undefined> {
  if (!customerId) {
    return undefined;
  }
  const customer = await ctx.db.get("customers", customerId);
  return customer?.tenantId === tenantId ? customer.leadId : undefined;
}

/** The lead an event's entity belongs to now. */
export async function entityLeadId(
  ctx: Ctx,
  input: Pick<DomainEventLinkInput, "tenantId" | "entityType" | "entityId">,
): Promise<Id<"leads"> | undefined> {
  const { tenantId, entityType, entityId } = input;
  switch (entityType) {
    case "lead": {
      const leadId = ctx.db.normalizeId("leads", entityId);
      const lead = leadId && (await ctx.db.get("leads", leadId));
      return lead && lead.tenantId === tenantId ? lead._id : undefined;
    }
    case "opportunity":
      return await opportunityLeadId(ctx, tenantId, ctx.db.normalizeId("opportunities", entityId) ?? undefined);
    case "meeting": {
      const meetingId = ctx.db.normalizeId("meetings", entityId);
      const meeting = meetingId && (await ctx.db.get("meetings", meetingId));
      return meeting && meeting.tenantId === tenantId
        ? await opportunityLeadId(ctx, tenantId, meeting.opportunityId)
        : undefined;
    }
    case "payment": {
      const paymentId = ctx.db.normalizeId("paymentRecords", entityId);
      const payment = paymentId && (await ctx.db.get("paymentRecords", paymentId));
      if (!payment || payment.tenantId !== tenantId) {
        return undefined;
      }
      return (
        (await opportunityLeadId(ctx, tenantId, payment.opportunityId)) ??
        (await customerLeadId(ctx, tenantId, payment.customerId))
      );
    }
    case "customer":
      return await customerLeadId(ctx, tenantId, ctx.db.normalizeId("customers", entityId) ?? undefined);
    case "followUp": {
      const followUpId = ctx.db.normalizeId("followUps", entityId);
      const followUp = followUpId && (await ctx.db.get("followUps", followUpId));
      return followUp && followUp.tenantId === tenantId ? followUp.leadId : undefined;
    }
    case "user":
    case "slackInstallation":
      return undefined;
  }
}

/** A `leadId` the event's metadata names, for an entity that is gone. */
async function metadataLeadId(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  metadata: Record<string, unknown> | undefined,
): Promise<Id<"leads"> | undefined> {
  const value = metadata?.leadId;
  if (typeof value !== "string") {
    return undefined;
  }
  const leadId = ctx.db.normalizeId("leads", value);
  const lead = leadId && (await ctx.db.get("leads", leadId));
  return lead && lead.tenantId === tenantId ? lead._id : undefined;
}

export async function userTeamMemberId(
  ctx: Ctx,
  tenantId: Id<"tenants">,
  userId: Id<"users"> | undefined,
): Promise<Id<"teamMembers"> | undefined> {
  if (!userId) {
    return undefined;
  }
  const user = await ctx.db.get("users", userId);
  return user?.tenantId === tenantId ? user.teamMemberId : undefined;
}

export async function deriveDomainEventLinks(
  ctx: Ctx,
  input: DomainEventLinkInput,
): Promise<DomainEventLinks> {
  const leadId =
    (await entityLeadId(ctx, input)) ??
    (input.entityType === "user" || input.entityType === "slackInstallation"
      ? undefined
      : await metadataLeadId(ctx, input.tenantId, input.metadata));
  const teamMemberId = await userTeamMemberId(ctx, input.tenantId, input.actorUserId);
  return { leadId, teamMemberId };
}
