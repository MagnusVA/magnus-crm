import { paginationOptsValidator } from "convex/server";
import { stream } from "convex-helpers/server/stream";
import schema from "../schema";
import {
  activityCountKeys,
  readActivityEventCounts,
} from "./activityEventCounts";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { query, type QueryCtx } from "../_generated/server";
import { PAYMENT_TYPES } from "../lib/paymentTypes";
import { requireTenantUser } from "../requireTenantUser";
import {
  assertValidDateRange,
  getUserDisplayName,
  reportingUserIdentity,
} from "./lib/helpers";

const ACTIVITY_FEED_READ_BUDGET = 500;
export const MAX_ACTIVITY_SCAN_EVENTS = 10000;
// Budget ~10 index reads/range: 300 * 10 + 501 user rows = 3,501,
// leaving 595 of the 4,096 reads for auth and actor identity lookups.
const MAX_AGGREGATE_COUNT_RANGES = 300;

const DOMAIN_EVENT_ENTITY_TYPES = [
  "customer",
  "enrollment",
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
  const attributedCloserId = metadata.attributedCloserId;

  if (
    typeof paymentType !== "string" ||
    !PAYMENT_TYPE_SET.has(paymentType) ||
    (programId !== undefined && typeof programId !== "string") ||
    (programName !== undefined && typeof programName !== "string") ||
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
    attributedCloserId:
      typeof attributedCloserId === "string" ? attributedCloserId : null,
  };
}

export const getActivityFeed = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    entityType: v.optional(
      v.union(
        v.literal("customer"),
        v.literal("enrollment"),
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
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    assertValidDateRange(args.startDate, args.endDate);
    const database = stream(ctx.db, schema);
    const querySource = args.actorUserId
      ? database
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
        ? database
            .query("domainEvents")
            .withIndex("by_tenantId_and_eventType_and_occurredAt", (q) =>
              q
                .eq("tenantId", tenantId)
                .eq("eventType", args.eventType!)
                .gte("occurredAt", args.startDate)
                .lt("occurredAt", args.endDate),
            )
            .order("desc")
        : database
            .query("domainEvents")
            .withIndex("by_tenantId_and_occurredAt", (q) =>
              q
                .eq("tenantId", tenantId)
                .gte("occurredAt", args.startDate)
                .lt("occurredAt", args.endDate),
            )
            .order("desc");

    const page = await querySource
      .filterWith(async (event) => {
        if (!matchesFeedFilters(event, args)) return false;
        if (!args.programId && !args.paymentType) return true;
        const paymentMetadata =
          event.entityType === "payment"
            ? parsePaymentMetadata(parseEventMetadata(event.metadata))
            : null;
        return (
          paymentMetadata !== null &&
          (!args.programId || paymentMetadata.programId === args.programId) &&
          (!args.paymentType ||
            paymentMetadata.paymentType === args.paymentType)
        );
      })
      .paginate({
        ...args.paginationOpts,
        maximumRowsRead: ACTIVITY_FEED_READ_BUDGET,
      });
    const events = page.page.map((event) => ({
      event,
      parsedMetadata: parseEventMetadata(event.metadata),
      paymentMetadata:
        event.entityType === "payment"
          ? parsePaymentMetadata(parseEventMetadata(event.metadata))
          : null,
    }));

    const actorIds = [
      ...new Set(
        events
          .map(({ event }) => event.actorUserId)
          .filter(
            (actorUserId): actorUserId is Id<"users"> =>
              actorUserId !== undefined,
          ),
      ),
    ];
    const actorDocs = await Promise.all(
      actorIds.map(
        async (actorId) =>
          [actorId, await ctx.db.get("users", actorId)] as const,
      ),
    );
    const actorById = new Map(actorDocs);

    const enrichedEvents = await Promise.all(
      events.map(async ({ event, parsedMetadata, paymentMetadata }) => ({
        ...event,
        actorName: event.actorUserId
          ? getUserDisplayName(actorById.get(event.actorUserId) ?? null)
          : null,
        actor: event.actorUserId
          ? await reportingUserIdentity(
              ctx,
              actorById.get(event.actorUserId),
              "Removed user",
            )
          : null,
        metadata: parsedMetadata,
        paymentMetadata,
      })),
    );
    return {
      ...page,
      page: enrichedEvents,
    };
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

    const tenant = await ctx.db.get("tenants", tenantId);
    if (
      tenant?.activityEventCountsVerifiedAt !== undefined &&
      !tenant.activityEventCountsExtraValues?.overflow
    ) {
      return await readAggregateActivitySummary(
        ctx,
        tenant,
        startDate,
        endDate,
      );
    }
    return await readScannedActivitySummary(ctx, tenantId, startDate, endDate);
  },
});

export async function readScannedActivitySummary(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
  scanLimit = MAX_ACTIVITY_SCAN_EVENTS,
) {
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
      q
        .eq("tenantId", tenantId)
        .gte("occurredAt", startDate)
        .lt("occurredAt", endDate),
    )
    .order("desc")) {
    if (totalEvents >= scanLimit) {
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
    actorIds.map(
      async (actorId) => [actorId, await ctx.db.get("users", actorId)] as const,
    ),
  );
  const actorById = new Map(actorDocs);

  return {
    totalEvents,
    isTruncated,
    bySource,
    byEntity,
    byActor: Object.fromEntries(actorCounts.entries()),
    actorBreakdown: (
      await Promise.all(
        [...actorCounts.entries()].map(async ([actorUserId, count]) => {
          const actor = actorById.get(actorUserId) ?? null;
          return {
            actorUserId,
            actorName: getUserDisplayName(actor),
            actor: await reportingUserIdentity(ctx, actor, "Removed user"),
            actorRole: actor?.role ?? "unknown",
            count,
          };
        }),
      )
    ).sort((left, right) => right.count - left.count),
    byEventType,
    byOutcome,
  };
}

export const ACTIVITY_SUMMARY_USER_LIMIT = 500;

export async function readAggregateActivitySummary(
  ctx: QueryCtx,
  tenant: Doc<"tenants">,
  startDate: number,
  endDate: number,
  userLimit = ACTIVITY_SUMMARY_USER_LIMIT,
  countRangeLimit = MAX_AGGREGATE_COUNT_RANGES,
) {
  const tenantId = tenant._id;
  const users = await ctx.db
    .query("users")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .take(userLimit + 1);
  // A partial user catalog would mislabel real actors as removed users.
  if (users.length > userLimit)
    return await readScannedActivitySummary(ctx, tenantId, startDate, endDate);
  const keys = activityCountKeys(
    users.map((user) => user._id),
    tenant.activityEventCountsExtraValues?.values,
  );
  if (keys.length > countRangeLimit)
    return await readScannedActivitySummary(ctx, tenantId, startDate, endDate);
  const rows = await readActivityEventCounts(
    ctx,
    tenantId,
    startDate,
    endDate,
    keys,
  );
  return await buildAggregateActivitySummary(ctx, users, rows);
}

/**
 * The summary from the activityEventCounts rows for the range, one per key of
 * `activityCountKeys`. Shared by the aggregate read and the ClickHouse report
 * (convex/analytics/definitions/activity.ts), which counts the same rows from
 * the events.
 */
export async function buildAggregateActivitySummary(
  ctx: QueryCtx,
  users: Array<Doc<"users">>,
  rows: Array<{ dimension: string; value: string; count: number }>,
) {
  const dimension = (name: string) =>
    Object.fromEntries(
      rows
        .filter((row) => row.dimension === name)
        .map((row) => [row.value, row.count]),
    );
  const totalEvents = dimension("all")[""];
  const actorCounts = dimension("actor");
  const bySource: Record<string, number> = {
    ...Object.fromEntries(DOMAIN_EVENT_SOURCES.map((value) => [value, 0])),
    ...dimension("source"),
  };
  const byEntity: Record<string, number> = Object.fromEntries(
    DOMAIN_EVENT_ENTITY_TYPES.map((value) => [value, 0]),
  );
  for (const [value, count] of Object.entries(dimension("entityType")))
    if (count > 0) byEntity[value] = count;
  const nonzero = (name: string) =>
    Object.fromEntries(
      Object.entries(dimension(name)).filter(([, count]) => count > 0),
    );
  const knownActors = users.filter((user) => actorCounts[user._id] > 0);
  const byActor: Record<string, number> = Object.fromEntries(
    knownActors.map((user) => [user._id, actorCounts[user._id]]),
  );
  const actorBreakdown = await Promise.all(
    knownActors.map(async (user) => ({
      actorUserId: String(user._id),
      actorName: getUserDisplayName(user),
      actor: await reportingUserIdentity(ctx, user, "Removed user"),
      actorRole: String(user.role),
      count: actorCounts[user._id],
    })),
  );
  const removedCount =
    totalEvents -
    actorCounts[""] -
    knownActors.reduce((sum, user) => sum + actorCounts[user._id], 0);
  if (removedCount > 0) {
    byActor.removed = removedCount;
    actorBreakdown.push({
      actorUserId: "removed",
      actorName: "Removed user",
      actor: await reportingUserIdentity(ctx, null, "Removed user"),
      actorRole: "unknown",
      count: removedCount,
    });
  }
  return {
    totalEvents,
    isTruncated: false,
    bySource,
    byEntity,
    byActor,
    actorBreakdown: actorBreakdown.sort((a, b) => b.count - a.count),
    byEventType: nonzero("eventType"),
    byOutcome: nonzero("reminderOutcome"),
  };
}
