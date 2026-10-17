import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { deriveDomainEventLinks } from "./domainEventLinks";
import { captureDomainEvent } from "./observability/posthog";

export type DomainEventEntityType =
  | "opportunity"
  | "meeting"
  | "lead"
  | "customer"
  | "followUp"
  | "user"
  | "payment"
  | "slackInstallation";

export type DomainEventSource = "closer" | "admin" | "pipeline" | "system";

export type EmitDomainEventParams = {
  tenantId: Id<"tenants">;
  entityType: DomainEventEntityType;
  entityId: string;
  eventType: string;
  source: DomainEventSource;
  actorUserId?: Id<"users">;
  fromStatus?: string;
  toStatus?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: number;
  /** Overrides the person derived from the entity. */
  leadId?: Id<"leads">;
  /** Overrides the team member derived from `actorUserId`. */
  teamMemberId?: Id<"teamMembers">;
};

export async function emitDomainEvent(
  ctx: MutationCtx,
  params: EmitDomainEventParams,
): Promise<Id<"domainEvents">> {
  const occurredAt = params.occurredAt ?? Date.now();
  const derived = await deriveDomainEventLinks(ctx, params);
  const leadId = params.leadId ?? derived.leadId;
  const teamMemberId = params.teamMemberId ?? derived.teamMemberId;

  const domainEventId = await ctx.db.insert("domainEvents", {
    tenantId: params.tenantId,
    entityType: params.entityType,
    entityId: params.entityId,
    eventType: params.eventType,
    occurredAt,
    source: params.source,
    actorUserId: params.actorUserId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    reason: params.reason,
    metadata: params.metadata ? JSON.stringify(params.metadata) : undefined,
    leadId,
    teamMemberId,
  });

  await captureDomainEvent(ctx, { ...params, leadId, teamMemberId }, domainEventId, occurredAt);

  return domainEventId;
}
