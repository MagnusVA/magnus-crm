import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { PAYMENT_TYPES } from "../lib/paymentTypes";
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
const PAYMENT_TYPE_SET = new Set<string>(PAYMENT_TYPES);

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

function parseEventMetadata(metadata: string | undefined | null) {
  if (!metadata) {
    return null;
  }

  try {
    return JSON.parse(metadata) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parsePaymentMetadata(metadata: Record<string, unknown> | null) {
  if (!metadata) {
    return null;
  }

  const paymentType = metadata.paymentType;
  const programId = metadata.programId;
  const programName = metadata.programName;
  const commissionable = metadata.commissionable;
  const attributedCloserId = metadata.attributedCloserId;

  if (
    typeof paymentType !== "string" ||
    !PAYMENT_TYPE_SET.has(paymentType) ||
    (programId !== undefined && typeof programId !== "string") ||
    (programName !== undefined && typeof programName !== "string") ||
    (commissionable !== undefined && typeof commissionable !== "boolean") ||
    (attributedCloserId !== undefined &&
      attributedCloserId !== null &&
      typeof attributedCloserId !== "string")
  ) {
    return null;
  }

  return {
    programId: typeof programId === "string" ? programId : null,
    programName: typeof programName === "string" ? programName : null,
    paymentType,
    commissionable: commissionable === true,
    attributedCloserId:
      typeof attributedCloserId === "string" ? attributedCloserId : null,
    originCategory:
      commissionable === true ? "commissionable" : "non_commissionable",
  };
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
    programId: v.optional(v.id("tenantPrograms")),
    paymentType: v.optional(
      v.union(
        v.literal("monthly"),
        v.literal("split"),
        v.literal("pif"),
        v.literal("deposit"),
      ),
    ),
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
    const events: Array<{
      event: Doc<"domainEvents">;
      parsedMetadata: Record<string, unknown> | null;
      paymentMetadata: ReturnType<typeof parsePaymentMetadata>;
    }> = [];

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

      const parsedMetadata = parseEventMetadata(event.metadata);
      const paymentMetadata =
        event.entityType === "payment"
          ? parsePaymentMetadata(parsedMetadata)
          : null;
      if (args.programId || args.paymentType) {
        if (!paymentMetadata) {
          continue;
        }
        if (
          (args.programId && paymentMetadata.programId !== args.programId) ||
          (args.paymentType && paymentMetadata.paymentType !== args.paymentType)
        ) {
          continue;
        }
      }

      events.push({ event, parsedMetadata, paymentMetadata });
      if (events.length >= limit) {
        break;
      }
    }

    const actorIds = [
      ...new Set(
        events
          .map(({ event }) => event.actorUserId)
          .filter((actorUserId): actorUserId is Id<"users"> => actorUserId !== undefined),
      ),
    ];
    const actorDocs = await Promise.all(
      actorIds.map(async (actorId) => [actorId, await ctx.db.get(actorId)] as const),
    );
    const actorById = new Map(actorDocs);

    return events.map(({ event, parsedMetadata, paymentMetadata }) => ({
      ...event,
      actorName: event.actorUserId
        ? getUserDisplayName(actorById.get(event.actorUserId) ?? null)
        : null,
      metadata: parsedMetadata,
      paymentMetadata,
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
    const byEventType: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
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
      byEventType[event.eventType] = (byEventType[event.eventType] ?? 0) + 1;

      const parsedMetadata = parseEventMetadata(event.metadata);
      if (event.eventType === "followUp.completed") {
        const outcome = parsedMetadata?.outcome;
        if (typeof outcome === "string") {
          const bucket = `reminder_${outcome}`;
          byOutcome[bucket] = (byOutcome[bucket] ?? 0) + 1;
        }
      } else if (event.eventType === "meeting.overran_review_resolved") {
        const resolutionAction = parsedMetadata?.resolutionAction;
        if (typeof resolutionAction === "string") {
          const bucket = `review_resolved_${resolutionAction}`;
          byOutcome[bucket] = (byOutcome[bucket] ?? 0) + 1;
        }
      }

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
        .map(([actorUserId, count]) => {
          const actor = actorById.get(actorUserId) ?? null;
          return {
            actorUserId,
            actorName: getUserDisplayName(actor),
            actorRole: actor?.role ?? "unknown",
            count,
          };
        })
        .sort((left, right) => right.count - left.count),
      byEventType,
      byOutcome,
    };
  },
});
