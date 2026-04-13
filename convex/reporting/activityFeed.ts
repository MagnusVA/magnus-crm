import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getUserDisplayName,
} from "./lib/helpers";

const MAX_ACTIVITY_FEED_LIMIT = 100;
const MAX_ACTIVITY_SUMMARY_EVENTS = 10000;

const DOMAIN_EVENT_ENTITY_TYPES = [
  "customer",
  "followUp",
  "lead",
  "meeting",
  "opportunity",
  "payment",
  "user",
] as const satisfies ReadonlyArray<Doc<"domainEvents">["entityType"]>;
const DOMAIN_EVENT_SOURCES = [
  "admin",
  "closer",
  "pipeline",
  "system",
] as const satisfies ReadonlyArray<Doc<"domainEvents">["source"]>;

function matchesFeedFilters(
  event: Doc<"domainEvents">,
  args: {
    actorUserId?: Id<"users">;
    entityType?: Doc<"domainEvents">["entityType"];
    eventType?: string;
  },
) {
  if (args.actorUserId && event.actorUserId !== args.actorUserId) {
    return false;
  }
  if (args.entityType && event.entityType !== args.entityType) {
    return false;
  }
  if (args.eventType && event.eventType !== args.eventType) {
    return false;
  }
  return true;
}

function parseEventMetadata(metadata: string | undefined) {
  if (!metadata) {
    return null;
  }

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const getActivityFeed = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    entityType: v.optional(
      v.union(
        v.literal("customer"),
        v.literal("followUp"),
        v.literal("lead"),
        v.literal("meeting"),
        v.literal("opportunity"),
        v.literal("payment"),
        v.literal("user"),
      ),
    ),
    eventType: v.optional(v.string()),
    actorUserId: v.optional(v.id("users")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(args.startDate, args.endDate);
    if (args.limit !== undefined && !Number.isFinite(args.limit)) {
      throw new Error("limit must be a finite number");
    }

    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? 50), 1),
      MAX_ACTIVITY_FEED_LIMIT,
    );
    const events: Array<Doc<"domainEvents">> = [];

    const querySource = args.actorUserId
      ? ctx.db
          .query("domainEvents")
          .withIndex("by_tenantId_and_actorUserId_and_occurredAt", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("actorUserId", args.actorUserId!)
              .gte("occurredAt", args.startDate)
              .lt("occurredAt", args.endDate),
          )
          .order("desc")
      : args.eventType
        ? ctx.db
            .query("domainEvents")
            .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
              q
                .eq("tenantId", tenantId)
                .eq("eventType", args.eventType!)
                .gte("occurredAt", args.startDate)
                .lt("occurredAt", args.endDate),
            )
            .order("desc")
        : ctx.db
            .query("domainEvents")
            .withIndex("by_tenantId_and_occurredAt", (q) =>
              q
                .eq("tenantId", tenantId)
                .gte("occurredAt", args.startDate)
                .lt("occurredAt", args.endDate),
            )
            .order("desc");

    for await (const event of querySource) {
      if (!matchesFeedFilters(event, args)) {
        continue;
      }

      events.push(event);
      if (events.length >= limit) {
        break;
      }
    }

    const actorIds = [
      ...new Set(
        events
          .map((event) => event.actorUserId)
          .filter((actorUserId): actorUserId is Id<"users"> => actorUserId !== undefined),
      ),
    ];
    const actorDocs = await Promise.all(
      actorIds.map(async (actorId) => [actorId, await ctx.db.get(actorId)] as const),
    );
    const actorById = new Map(actorDocs);

    return events.map((event) => ({
      ...event,
      actorName: event.actorUserId
        ? getUserDisplayName(actorById.get(event.actorUserId) ?? null)
        : null,
      metadata: parseEventMetadata(event.metadata),
    }));
  },
});

export const getActivitySummary = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, { startDate, endDate }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(startDate, endDate);

    const bySource = Object.fromEntries(
      DOMAIN_EVENT_SOURCES.map((source) => [source, 0]),
    ) as Record<Doc<"domainEvents">["source"], number>;
    const byEntity = Object.fromEntries(
      DOMAIN_EVENT_ENTITY_TYPES.map((entityType) => [entityType, 0]),
    ) as Record<Doc<"domainEvents">["entityType"], number>;
    const actorCounts = new Map<Id<"users">, number>();
    let totalEvents = 0;
    let isTruncated = false;

    for await (const event of ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) =>
        q.eq("tenantId", tenantId).gte("occurredAt", startDate).lt("occurredAt", endDate),
      )
      .order("desc")) {
      if (totalEvents >= MAX_ACTIVITY_SUMMARY_EVENTS) {
        isTruncated = true;
        break;
      }

      totalEvents += 1;
      bySource[event.source] = (bySource[event.source] ?? 0) + 1;
      byEntity[event.entityType] = (byEntity[event.entityType] ?? 0) + 1;

      if (event.actorUserId) {
        actorCounts.set(
          event.actorUserId,
          (actorCounts.get(event.actorUserId) ?? 0) + 1,
        );
      }
    }

    const actorIds = [...actorCounts.keys()];
    const actorDocs = await Promise.all(
      actorIds.map(async (actorId) => [actorId, await ctx.db.get(actorId)] as const),
    );
    const actorById = new Map(actorDocs);

    return {
      totalEvents,
      isTruncated,
      bySource,
      byEntity,
      byActor: Object.fromEntries(actorCounts.entries()),
      actorBreakdown: [...actorCounts.entries()]
        .map(([actorUserId, count]) => ({
          actorUserId,
          actorName: getUserDisplayName(actorById.get(actorUserId) ?? null),
          count,
        }))
        .sort((left, right) => right.count - left.count),
    };
  },
});
