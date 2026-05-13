import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { DomainEventEntityType, DomainEventSource } from "./domainEvents";

export async function emitDomainEventInAction(
  ctx: ActionCtx,
  args: {
    tenantId: Id<"tenants">;
    entityType: DomainEventEntityType;
    entityId: string;
    eventType: string;
    source: DomainEventSource;
    occurredAt?: number;
    actorUserId?: Id<"users">;
    fromStatus?: string;
    toStatus?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.runMutation(internal.lib.domainEventsInternal.insert, args);
}
