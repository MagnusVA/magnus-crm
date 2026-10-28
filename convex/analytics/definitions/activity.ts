import { activityCountKeys } from "../../reporting/activityEventCounts";
import {
  ACTIVITY_SUMMARY_USER_LIMIT,
  buildAggregateActivitySummary,
  type getActivitySummary,
} from "../../reporting/activityFeed";
import type { SqlRow } from "../clickhouse";
import { defineReport, noFilters, num, rangeParams, type ReportInput } from "../definition";

// Activity Feed (app/workspace/reports/activity). The summary cards read the
// activityEventCounts aggregate; ClickHouse counts the same entries from the
// events, one per dimension of activityEventDimensions, so the aggregate
// path's builder answers. The feed itself is paginated and stays on Convex.

function summarySql(input: ReportInput<Record<string, never>>) {
  return {
    counts: {
      sql: `
SELECT entry.1 AS dimension, entry.2 AS value, count() AS count
FROM (
  SELECT arrayJoin(arrayConcat(
    [
      ('all', ''),
      ('source', ifNull(source, '')),
      ('entityType', ifNull(entity_type, '')),
      ('eventType', ifNull(event_type, '')),
      ('actor', ifNull(actor_user_id, ''))
    ],
    if(
      event_type = 'followUp.completed' AND JSONType(ifNull(metadata, 'null'), 'outcome') = 'String',
      [('reminderOutcome', concat('reminder_', JSONExtractString(metadata, 'outcome')))],
      []
    )
  )) AS entry
  FROM analytics.events
  WHERE tenant_id = {tenant_id:String}
    AND occurred_at_ms >= {from_ms:Int64}
    AND occurred_at_ms < {to_ms:Int64}
)
GROUP BY dimension, value`,
      params: rangeParams(input.range),
    },
  };
}

function countKey(dimension: string, value: string) {
  return JSON.stringify([dimension, value]);
}

function countsByKey(rows: SqlRow[] | undefined) {
  return new Map(
    (rows ?? []).map((row) => [countKey(String(row.dimension), String(row.value)), num(row.count)]),
  );
}

export const activityReports = [
  defineReport<typeof getActivitySummary>({
    id: "activity.summary",
    page: "activity",
    roles: ["tenant_master", "tenant_admin"],
    day: "browser",
    parseFilters: noFilters,
    sql: summarySql,
    finalize: async (ctx, input) => {
      const tenant = await ctx.db.get("tenants", input.tenantId);
      const users = await ctx.db
        .query("users")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", input.tenantId))
        .take(ACTIVITY_SUMMARY_USER_LIMIT);
      // The aggregate read's keys, so values the aggregate has no key for
      // count only in the total, as they do there.
      const counts = countsByKey(input.rows.counts);
      const rows = activityCountKeys(
        users.map((user) => user._id),
        tenant?.activityEventCountsExtraValues?.values,
      ).map(([dimension, value]) => ({
        dimension,
        value,
        count: counts.get(countKey(dimension, value)) ?? 0,
      }));
      return await buildAggregateActivitySummary(ctx, users, rows);
    },
    live: {
      name: "reporting/activityFeed:getActivitySummary",
      args: (input) => ({ startDate: input.range.fromMs, endDate: input.range.toMs }),
    },
  }),
];
