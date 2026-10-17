import type { Doc, Id } from "../_generated/dataModel";
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

// --- Older events (plan §9.3). ---

// Far above the events one transaction writes (a backfill batch writes 20).
// A bigger bucket throws rather than miss the meeting that caused an event.
export const SAME_TRANSACTION_EVENT_LIMIT = 1000;

function parseMetadata(metadata: string | undefined): Record<string, unknown> | undefined {
  if (!metadata) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The lead of a deal event that a meeting caused, when the split has since
 * moved that meeting to another person's deal. The pipeline writes the
 * meeting event and the deal event in one transaction, at the same
 * `occurredAt`. A deal the split took apart kept its old events, but some
 * were caused by other people's meetings.
 */
async function splitMeetingLeadId(
  ctx: Ctx,
  event: Doc<"domainEvents">,
): Promise<Id<"leads"> | undefined> {
  if (event.entityType !== "opportunity" || event.eventType === "opportunity.created") {
    return undefined;
  }
  const sameTransaction = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_occurredAt", (q) =>
      q.eq("tenantId", event.tenantId).eq("occurredAt", event.occurredAt),
    )
    .take(SAME_TRANSACTION_EVENT_LIMIT + 1);
  if (sameTransaction.length > SAME_TRANSACTION_EVENT_LIMIT) {
    throw new Error(`More than ${SAME_TRANSACTION_EVENT_LIMIT} events at ${event.occurredAt}; event ${event._id} needs a review`);
  }
  const otherLeads = new Set<Id<"leads">>();
  for (const other of sameTransaction) {
    if (other.entityType !== "meeting") {
      continue;
    }
    const meetingId = ctx.db.normalizeId("meetings", other.entityId);
    const meeting = meetingId && (await ctx.db.get("meetings", meetingId));
    if (!meeting) {
      continue;
    }
    if (meeting.opportunityId === event.entityId) {
      // A meeting still on this deal caused it.
      return undefined;
    }
    const leadId = await opportunityLeadId(ctx, event.tenantId, meeting.opportunityId);
    if (leadId) {
      otherLeads.add(leadId);
    }
  }
  return otherLeads.size === 1 ? [...otherLeads][0] : undefined;
}

/** The setter behind a Slack deal's creation, who isn't a CRM user. */
async function slackSetterTeamMemberId(
  ctx: Ctx,
  event: Doc<"domainEvents">,
): Promise<Id<"teamMembers"> | undefined> {
  if (
    event.entityType !== "opportunity" ||
    event.eventType !== "opportunity.created" ||
    event.source !== "pipeline"
  ) {
    return undefined;
  }
  const opportunityId = ctx.db.normalizeId("opportunities", event.entityId);
  const opportunity = opportunityId && (await ctx.db.get("opportunities", opportunityId));
  const slackUserId = opportunity?.source === "slack_qualified" ? opportunity.qualifiedBy?.slackUserId : undefined;
  if (!slackUserId) {
    return undefined;
  }
  const slackUser = await ctx.db
    .query("slackUsers")
    .withIndex("by_tenantId_and_slackUserId", (q) =>
      q.eq("tenantId", event.tenantId).eq("slackUserId", slackUserId),
    )
    .unique();
  return slackUser?.teamMemberId;
}

/** The links an already-stored event should have. */
export async function deriveStoredEventLinks(
  ctx: Ctx,
  event: Doc<"domainEvents">,
): Promise<DomainEventLinks> {
  const derived = await deriveDomainEventLinks(ctx, {
    tenantId: event.tenantId,
    entityType: event.entityType,
    entityId: event.entityId,
    actorUserId: event.actorUserId,
    metadata: parseMetadata(event.metadata),
  });
  return {
    leadId: (await splitMeetingLeadId(ctx, event)) ?? derived.leadId,
    teamMemberId: derived.teamMemberId ?? (await slackSetterTeamMemberId(ctx, event)),
  };
}

/**
 * Whether an event's stored `leadId` is right. A live event names the lead
 * at the time; if that lead has since merged into the derived one, it is
 * still right, and the person timeline follows the merge.
 */
export async function storedLeadIdMatches(
  ctx: Ctx,
  stored: Id<"leads"> | undefined,
  derived: Id<"leads"> | undefined,
): Promise<boolean> {
  if (stored === derived) {
    return true;
  }
  if (!stored || !derived) {
    return false;
  }
  const lead = await ctx.db.get("leads", stored);
  return lead?.status === "merged" && lead.mergedIntoLeadId === derived;
}
