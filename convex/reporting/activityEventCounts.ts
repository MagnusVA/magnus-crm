import { DirectAggregate } from "@convex-dev/aggregate";
import { v } from "convex/values";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import schema from "../schema";
import { EVENT_LABELS } from "./lib/eventLabels";
import { assertValidDateRange, makeTupleDateBounds } from "./lib/helpers";
import {
  businessDateToUtcStart,
  timestampToBusinessDateKey,
} from "./lib/hondurasBusinessTime";

export const activityEventCounts = new DirectAggregate<{
  Namespace: Id<"tenants">;
  Key: [dimension: string, value: string, occurredAt: number];
  Id: string;
}>(components.activityEventCounts);

export const ACTIVITY_SOURCES =
  schema.tables.domainEvents.validator.fields.source.members.map(
    (member) => member.value,
  );
export const ACTIVITY_ENTITY_TYPES =
  schema.tables.domainEvents.validator.fields.entityType.members.map(
    (member) => member.value,
  );
// Event types are strings in the schema. Include the display catalog and the
// operational events without display labels. Extra historical values are
// recorded by the backfill and live writes so those buckets stay visible.
export const ACTIVITY_EVENT_TYPES = [
  ...new Set([
    ...Object.keys(EVENT_LABELS),
    "lead.disposition_changed",
    "lead.lifecycle_stage_changed",
    "opportunity.deleted",
    "opportunity.stale_flagged",
    "slack.installation.tokens_revoked",
    "slack.installation.uninstalled",
    "slack.notify.failed",
    "slack.stale.failed",
  ]),
];
export const ACTIVITY_REMINDER_OUTCOMES =
  schema.tables.followUps.validator.fields.completionOutcome.members.map(
    (member) => `reminder_${member.value}`,
  );

export function activityEventDimensions(
  event: Doc<"domainEvents">,
): Array<[string, string]> {
  const dimensions: Array<[string, string]> = [
    ["all", ""],
    ["source", event.source ?? ""],
    ["entityType", event.entityType],
    ["eventType", event.eventType],
    ["actor", event.actorUserId ?? ""],
  ];
  if (event.eventType === "followUp.completed") {
    try {
      const metadata = JSON.parse(event.metadata ?? "null") as {
        outcome?: unknown;
      } | null;
      if (typeof metadata?.outcome === "string")
        dimensions.push(["reminderOutcome", `reminder_${metadata.outcome}`]);
    } catch {
      /* Invalid JSON has no outcome in the old summary either. */
    }
  }
  return dimensions;
}

const MAX_EXTRA_ACTIVITY_VALUES = 128;
function isExtraValue([dimension, value]: [string, string]) {
  return (
    (dimension === "eventType" && !ACTIVITY_EVENT_TYPES.includes(value)) ||
    (dimension === "reminderOutcome" &&
      !ACTIVITY_REMINDER_OUTCOMES.includes(value))
  );
}

export async function insertActivityEventCounts(
  ctx: MutationCtx,
  event: Doc<"domainEvents">,
) {
  const dimensions = activityEventDimensions(event);
  for (const [dimension, value] of dimensions) {
    await activityEventCounts.insertIfDoesNotExist(ctx, {
      namespace: event.tenantId,
      key: [dimension, value, event.occurredAt],
      id: `${event._id}:${dimension}`,
    });
  }
  const extras = dimensions.filter(isExtraValue);
  if (extras.length > 0) {
    const tenant = await ctx.db.get("tenants", event.tenantId);
    if (!tenant || tenant.activityEventCountsExtraValues?.overflow) return;
    const values = [...(tenant.activityEventCountsExtraValues?.values ?? [])];
    let overflow = false;
    let changed = false;
    for (const [dimension, value] of extras) {
      if (
        values.some(
          (entry) => entry.dimension === dimension && entry.value === value,
        )
      )
        continue;
      changed = true;
      if (values.length === MAX_EXTRA_ACTIVITY_VALUES) {
        overflow = true;
        break;
      }
      values.push({ dimension, value });
    }
    if (changed)
      await ctx.db.patch("tenants", tenant._id, {
        activityEventCountsExtraValues: { values, overflow },
        ...(overflow
          ? {
              activityEventCountsVerifiedAt: undefined,
              activityEventCountsVerification: undefined,
            }
          : {}),
      });
  }
}

export async function deleteActivityEventCounts(
  ctx: MutationCtx,
  event: Doc<"domainEvents">,
) {
  for (const [dimension, value] of activityEventDimensions(event)) {
    await activityEventCounts.deleteIfExists(ctx, {
      namespace: event.tenantId,
      key: [dimension, value, event.occurredAt],
      id: `${event._id}:${dimension}`,
    });
  }
}

/** Asserts exact per-entry IDs, so parity cannot hide one missing and one extra entry. */
export async function assertActivityEventCountEntries(
  ctx: QueryCtx,
  event: Doc<"domainEvents">,
) {
  const entries = activityEventDimensions(event).map(([dimension, value]) => ({
    key: [dimension, value, event.occurredAt] as [string, string, number],
    id: `${event._id}:${dimension}`,
  }));
  const counts = await activityEventCounts.countBatch(
    ctx,
    entries.map(({ key, id }) => ({
      namespace: event.tenantId,
      bounds: {
        lower: { key, id, inclusive: true },
        upper: { key, id, inclusive: true },
      },
    })),
  );
  if (counts.some((count) => count !== 1))
    throw new Error(`Missing activity aggregate entry: ${event._id}`);
}

export function activityCountKeys(
  actorIds: string[],
  extras: Array<{ dimension: string; value: string }> = [],
): Array<[string, string]> {
  return [
    ["all", ""],
    ...ACTIVITY_SOURCES.map((value): [string, string] => ["source", value]),
    ...ACTIVITY_ENTITY_TYPES.map((value): [string, string] => [
      "entityType",
      value,
    ]),
    ...ACTIVITY_EVENT_TYPES.map((value): [string, string] => [
      "eventType",
      value,
    ]),
    ...ACTIVITY_REMINDER_OUTCOMES.map((value): [string, string] => [
      "reminderOutcome",
      value,
    ]),
    ...extras
      .filter((entry) => isExtraValue([entry.dimension, entry.value]))
      .map(({ dimension, value }): [string, string] => [dimension, value]),
    ["actor", ""],
    ...actorIds.map((value): [string, string] => ["actor", value]),
  ];
}

export async function readActivityEventCounts(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  startDate: number,
  endDate: number,
  keys: Array<[string, string]>,
) {
  const counts = await activityEventCounts.countBatch(
    ctx,
    keys.map(([dimension, value]) => ({
      namespace: tenantId,
      bounds: makeTupleDateBounds(
        [dimension, value] as const,
        startDate,
        endDate,
      ),
    })),
  );
  return keys.map(([dimension, value], index) => ({
    dimension,
    value,
    count: counts[index],
  }));
}

const rangeArgs = {
  tenantId: v.id("tenants"),
  startDate: v.number(),
  endDate: v.number(),
};
const differenceValidator = v.object({
  dimension: v.string(),
  value: v.string(),
  scanned: v.number(),
  aggregate: v.number(),
});
const verificationValidator = v.object({
  tenantId: v.id("tenants"),
  startDate: v.number(),
  endDate: v.number(),
  passed: v.boolean(),
  scanned: v.number(),
  differences: v.array(differenceValidator),
});
type VerificationRange = {
  tenantId: Id<"tenants">;
  startDate: number;
  endDate: number;
};

async function verifyCounts(
  ctx: QueryCtx,
  { tenantId, startDate, endDate }: VerificationRange,
) {
  assertValidDateRange(startDate, endDate);
  const events = await ctx.db
    .query("domainEvents")
    .withIndex("by_tenantId_and_occurredAt", (q) =>
      q
        .eq("tenantId", tenantId)
        .gte("occurredAt", startDate)
        .lt("occurredAt", endDate),
    )
    .take(10000);
  // A day past the old scan's cap can't be compared; fail it, so the mark
  // mutation clears the flag instead of leaving an earlier pass in place.
  if (events.length === 10000) {
    return { tenantId, startDate, endDate, passed: false, scanned: events.length, differences: [] };
  }
  const expected = new Map<
    string,
    { dimension: string; value: string; count: number }
  >();
  const keyOf = (dimension: string, value: string) =>
    JSON.stringify([dimension, value]);
  for (const event of events)
    for (const [dimension, value] of activityEventDimensions(event)) {
      const key = keyOf(dimension, value);
      expected.set(key, {
        dimension,
        value,
        count: (expected.get(key)?.count ?? 0) + 1,
      });
    }
  // Include deleted actors for exact per-ID parity, without returning names or metadata.
  const actors = [
    ...new Set(
      events.flatMap((event) => (event.actorUserId ? [event.actorUserId] : [])),
    ),
  ];
  const tenant = await ctx.db.get("tenants", tenantId);
  const actual = await readActivityEventCounts(
    ctx,
    tenantId,
    startDate,
    endDate,
    activityCountKeys(actors, tenant?.activityEventCountsExtraValues?.values),
  );
  const differences: Array<{
    dimension: string;
    value: string;
    scanned: number;
    aggregate: number;
  }> = [];
  for (const row of actual) {
    const key = keyOf(row.dimension, row.value);
    const scanned = expected.get(key)?.count ?? 0;
    if (scanned !== row.count)
      differences.push({
        dimension: row.dimension,
        value: row.value,
        scanned,
        aggregate: row.count,
      });
    expected.delete(key);
  }
  // Values missing from the catalogs indicate an incomplete backfill; block cutover.
  for (const row of expected.values())
    differences.push({
      dimension: row.dimension,
      value: row.value,
      scanned: row.count,
      aggregate: 0,
    });
  return {
    tenantId,
    startDate,
    endDate,
    passed:
      differences.length === 0 &&
      !tenant?.activityEventCountsExtraValues?.overflow,
    scanned: events.length,
    differences,
  };
}

export const verifyActivityEventCounts = internalQuery({
  args: rangeArgs,
  returns: verificationValidator,
  handler: verifyCounts,
});

const DAY_MS = 86_400_000;
export const markActivityEventCountsVerified = internalMutation({
  args: rangeArgs,
  returns: v.object({
    passed: v.boolean(),
    verifiedDays: v.number(),
    enabled: v.boolean(),
    differences: v.array(differenceValidator),
  }),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get("tenants", args.tenantId);
    if (!tenant) throw new Error(`Tenant not found: ${args.tenantId}`);
    const end = businessDateToUtcStart(timestampToBusinessDateKey(Date.now()));
    if (
      args.endDate !== args.startDate + DAY_MS ||
      args.startDate < end - 30 * DAY_MS ||
      args.endDate > end ||
      (end - args.startDate) % DAY_MS !== 0
    ) {
      throw new Error(
        "Verify one of the last 30 completed Honduras business days",
      );
    }
    // Recompute inside this transaction; never trust caller-supplied parity.
    const result = await verifyCounts(ctx, args);
    const [backfill] = await ctx.runQuery(components.migrations.lib.getStatus, {
      names: ["migrations:backfillActivityEventCounts"],
    });
    const oldest = await ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_occurredAt", (q) =>
        q.eq("tenantId", tenant._id),
      )
      .first();
    let oldestCovered = true;
    if (oldest) {
      const key: [string, string, number] = ["all", "", oldest.occurredAt];
      const entry = { key, id: `${oldest._id}:all`, inclusive: true };
      oldestCovered =
        (await activityEventCounts.count(ctx, {
          namespace: tenant._id,
          bounds: { lower: entry, upper: entry },
        })) === 1;
    }
    // Recent daily parity cannot prove that historical ranges were backfilled.
    if (
      !result.passed ||
      !backfill?.isDone ||
      backfill.error !== undefined ||
      !oldestCovered
    ) {
      await ctx.db.patch("tenants", tenant._id, {
        activityEventCountsVerifiedAt: undefined,
        activityEventCountsVerification: undefined,
      });
      return {
        passed: false,
        verifiedDays: 0,
        enabled: false,
        differences: result.differences,
      };
    }
    const previous = tenant.activityEventCountsVerification;
    const days = [
      ...new Set([
        ...(previous?.endDate === end ? previous.days : []),
        args.startDate,
      ]),
    ].sort((a, b) => a - b);
    const enabled = days.length === 30;
    await ctx.db.patch("tenants", tenant._id, {
      activityEventCountsVerification: { endDate: end, days },
      activityEventCountsVerifiedAt: enabled ? Date.now() : undefined,
    });
    return {
      passed: true,
      verifiedDays: days.length,
      enabled,
      differences: [],
    };
  },
});
