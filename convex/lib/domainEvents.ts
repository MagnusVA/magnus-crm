import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type DomainEventEntityType =
  | "opportunity"
  | "meeting"
  | "lead"
  | "customer"
  | "followUp"
  | "user"
  | "payment";

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
};

export async function emitDomainEvent(
  ctx: MutationCtx,
  params: EmitDomainEventParams,
): Promise<Id<"domainEvents">> {
  const occurredAt = params.occurredAt ?? Date.now();

  return await ctx.db.insert("domainEvents", {
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
  });
}
