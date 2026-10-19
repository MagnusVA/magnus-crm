import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
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
  /** Skips PostHog, for backfills that write past events in bulk. */
  skipAnalytics?: boolean;
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

  if (!params.skipAnalytics) {
    await captureDomainEvent(ctx, { ...params, leadId, teamMemberId }, domainEventId, occurredAt);
  }

  return domainEventId;
}

// Far above the events of one type that share one millisecond; a scan past
// it throws rather than miss the record's event.
const SAME_TIME_EVENT_SCAN_LIMIT = 2000;

/**
 * The events of `eventType` at `occurredAt` whose metadata names `value` in
 * `field`: the touch a backfill already wrote for one source record. Found by
 * type and time rather than by person, so a person merged since still finds
 * them. Every event at that time is scanned, so unrelated ones don't hide it.
 */
export async function eventsForRecord(
  ctx: QueryCtx | MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventType: string;
    occurredAt: number;
    field: string;
    value: string;
  },
): Promise<Doc<"domainEvents">[]> {
  const matches: Doc<"domainEvents">[] = [];
  let scanned = 0;
  for await (const event of ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
      q.eq("tenantId", args.tenantId).eq("eventType", args.eventType).eq("occurredAt", args.occurredAt),
    )) {
    scanned += 1;
    if (scanned > SAME_TIME_EVENT_SCAN_LIMIT) {
      throw new Error(`More than ${SAME_TIME_EVENT_SCAN_LIMIT} ${args.eventType} events at ${args.occurredAt}`);
    }
    if (metadataField(event.metadata, args.field) === args.value) {
      matches.push(event);
    }
  }
  return matches;
}

function metadataField(metadata: string | undefined, field: string): unknown {
  if (!metadata) {
    return undefined;
  }
  try {
    return (JSON.parse(metadata) as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}
