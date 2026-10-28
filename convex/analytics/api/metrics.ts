import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import {
  businessDateForInstant,
  businessPeriodDate,
  type BusinessDaySetting,
} from "../../../lib/businessDay";
import type { ResolvedAnalyticsRange } from "../../../lib/analyticsRange";
import type { SqlQuery, SqlRow } from "../clickhouse";
import {
  num,
  optionalEnumFilter,
  rangeParams,
  str,
  type AnalyticsFilters,
  type AnyReportDefinition,
  type ReportDefinition,
} from "../definition";

// The external API's metric catalog (docs/plans/clickhouse-reporting.md §9,
// docs/api/openapi.yaml). Every metric has one definition with two
// implementations: SQL for any range (cached like a report page) and Convex
// index reads for today (`/api/v1/today`). Both produce the same base facts,
// and one function derives the rates from them.

export const API_METRICS = [
  "leads_captured",
  "unique_prospects",
  "resparks",
  "qualifications",
  "new_qualified_people",
  "calls_booked",
  "calls_scheduled",
  "calls_held",
  "no_shows",
  "cancellations",
  "show_rate",
  "deals_won",
  "close_rate",
  "cash_collected",
  "deposits",
  "average_deal_size",
] as const;
export type ApiMetric = (typeof API_METRICS)[number];

export const API_GROUPS = ["none", "closer", "team", "program", "lead_generator"] as const;
export type ApiGroup = (typeof API_GROUPS)[number];

export const API_GRANULARITIES = ["day", "week", "month", "total"] as const;
export type ApiGranularity = (typeof API_GRANULARITIES)[number];

type Source =
  | "captures"
  | "resparks"
  | "qualifications"
  | "meetings_booked"
  | "meetings_scheduled"
  | "deals_won"
  | "payments";

type BaseMetric =
  | "leads_captured"
  | "unique_prospects"
  | "resparks"
  | "qualifications"
  | "new_qualified_people"
  | "calls_booked"
  | "calls_scheduled"
  | "calls_held"
  | "no_shows"
  | "cancellations"
  | "deals_won"
  | "cash_collected"
  | "deposits"
  | "final_cash"
  | "final_count";

const SOURCE_METRICS: Record<Source, readonly BaseMetric[]> = {
  captures: ["leads_captured", "unique_prospects"],
  resparks: ["resparks"],
  qualifications: ["qualifications", "new_qualified_people"],
  meetings_booked: ["calls_booked"],
  meetings_scheduled: ["calls_scheduled", "calls_held", "no_shows", "cancellations"],
  deals_won: ["deals_won"],
  payments: ["cash_collected", "deposits", "final_cash", "final_count"],
};

const CAPTURE_GROUPS = ["none", "team", "lead_generator"] as const;
const SALES_GROUPS = ["none", "closer", "program"] as const;

/** The groupings each metric supports and the sources it reads. */
export const METRIC_CATALOG: Record<ApiMetric, { groups: readonly ApiGroup[]; sources: readonly Source[] }> = {
  leads_captured: { groups: CAPTURE_GROUPS, sources: ["captures"] },
  unique_prospects: { groups: CAPTURE_GROUPS, sources: ["captures"] },
  resparks: { groups: ["none", "lead_generator"], sources: ["resparks"] },
  qualifications: { groups: ["none"], sources: ["qualifications"] },
  new_qualified_people: { groups: ["none"], sources: ["qualifications"] },
  calls_booked: { groups: SALES_GROUPS, sources: ["meetings_booked"] },
  calls_scheduled: { groups: SALES_GROUPS, sources: ["meetings_scheduled"] },
  calls_held: { groups: SALES_GROUPS, sources: ["meetings_scheduled"] },
  no_shows: { groups: SALES_GROUPS, sources: ["meetings_scheduled"] },
  cancellations: { groups: SALES_GROUPS, sources: ["meetings_scheduled"] },
  show_rate: { groups: SALES_GROUPS, sources: ["meetings_scheduled"] },
  deals_won: { groups: SALES_GROUPS, sources: ["deals_won"] },
  close_rate: { groups: SALES_GROUPS, sources: ["deals_won", "meetings_scheduled"] },
  cash_collected: { groups: SALES_GROUPS, sources: ["payments"] },
  deposits: { groups: SALES_GROUPS, sources: ["payments"] },
  average_deal_size: { groups: SALES_GROUPS, sources: ["payments"] },
};

export type ApiMetricsFilters = {
  /** Sorted, comma-separated. */
  metrics: string;
  granularity: ApiGranularity;
  group_by: ApiGroup;
};

export type ApiMetricRow = {
  metric: ApiMetric;
  /** `YYYY-MM-DD` for a day, the Monday for a week, `YYYY-MM`, or `total`. */
  period: string;
  /** A team member, team or program id; null when ungrouped or unattributed. */
  group_id: string | null;
  /** Money metrics only: an ISO 4217 code. */
  currency?: string;
  /** Null for a rate with nothing to divide by. */
  value: number | null;
};

export type ApiMetricsAnswer = { rows: ApiMetricRow[]; partial: boolean };

/** Throws `Error` with a message safe to return to the caller. */
export function parseApiMetricsFilters(raw: AnalyticsFilters): ApiMetricsFilters {
  const metrics = String(raw.metrics ?? "")
    .split(",")
    .map((metric) => metric.trim())
    .filter(Boolean);
  if (metrics.length === 0) throw new Error("Choose at least one metric.");
  for (const metric of metrics) {
    if (!(API_METRICS as readonly string[]).includes(metric)) throw new Error(`Unknown metric ${metric}.`);
  }
  const granularity = optionalEnumFilter(raw.granularity, API_GRANULARITIES) ?? "day";
  const groupBy = optionalEnumFilter(raw.group_by, API_GROUPS) ?? "none";
  for (const metric of metrics as ApiMetric[]) {
    if (!METRIC_CATALOG[metric].groups.includes(groupBy)) {
      throw new Error(`${metric} can't be grouped by ${groupBy}.`);
    }
  }
  return { metrics: [...new Set(metrics)].sort().join(","), granularity, group_by: groupBy };
}

function metricList(filters: ApiMetricsFilters) {
  return filters.metrics.split(",") as ApiMetric[];
}

function sourcesFor(metrics: readonly ApiMetric[]) {
  return [...new Set(metrics.flatMap((metric) => METRIC_CATALOG[metric].sources))].sort();
}

// --- ClickHouse ------------------------------------------------------------

function periodSql(msColumn: string) {
  const day = `toDate(toTimeZone(fromUnixTimestamp64Milli(assumeNotNull(${msColumn})), {tz:String}) - toIntervalHour({day_start_hour:UInt8}))`;
  return `multiIf({granularity:String} = 'day', toString(${day}), {granularity:String} = 'week', toString(toMonday(${day})), {granularity:String} = 'month', formatDateTime(${day}, '%Y-%m'), 'total')`;
}

function inRange(msColumn: string) {
  return `${msColumn} >= {from_ms:Int64} AND ${msColumn} < {to_ms:Int64}`;
}

const SALES_GROUP = (closerColumn: string, programColumn: string) =>
  `multiIf({group_by:String} = 'closer', ifNull(${closerColumn}, ''), {group_by:String} = 'program', ifNull(${programColumn}, ''), '')`;

const SOURCE_SQL: Record<Source, string> = {
  captures: `
SELECT
  ${periodSql("c.submitted_at_ms")} AS period,
  multiIf({group_by:String} = 'team', ifNull(c.team_id, ''), {group_by:String} = 'lead_generator', ifNull(w.team_member_id, ''), '') AS group_id,
  count() AS leads_captured,
  uniqExact(c.prospect_id) AS unique_prospects
FROM analytics.captures AS c
LEFT JOIN analytics.workers AS w ON w.id = c.worker_id AND w.tenant_id = {tenant_id:String}
WHERE c.tenant_id = {tenant_id:String} AND ${inRange("c.submitted_at_ms")}
  -- Voided captures: voided_at_ms once Fivetran has synced the column
  -- (NULL until then), and the void events, which cover the meantime.
  AND c.voided_at_ms IS NULL
  AND c.id NOT IN (
    SELECT JSONExtractString(e.metadata, 'submissionId')
    FROM analytics.events AS e
    WHERE e.tenant_id = {tenant_id:String} AND e.event_type = 'lead.capture_voided'
  )
GROUP BY period, group_id`,
  resparks: `
SELECT
  ${periodSql("r.worked_at_ms")} AS period,
  if({group_by:String} = 'lead_generator', ifNull(w.team_member_id, ''), '') AS group_id,
  count() AS resparks
FROM analytics.respark_items AS r
LEFT JOIN analytics.workers AS w ON w.id = r.worker_id AND w.tenant_id = {tenant_id:String}
WHERE r.tenant_id = {tenant_id:String} AND r.result = 'resparked' AND ${inRange("r.worked_at_ms")}
GROUP BY period, group_id`,
  qualifications: `
SELECT
  ${periodSql("q.submitted_at_ms")} AS period,
  '' AS group_id,
  count() AS qualifications,
  countIf(q.result_kind = 'created_opportunity') AS new_qualified_people
FROM analytics.qualifications AS q
WHERE q.tenant_id = {tenant_id:String} AND ${inRange("q.submitted_at_ms")}
GROUP BY period, group_id`,
  meetings_booked: `
SELECT
  ${periodSql("m.created_at_ms")} AS period,
  ${SALES_GROUP("u.team_member_id", "m.booking_program_id")} AS group_id,
  count() AS calls_booked
FROM analytics.meetings AS m
LEFT JOIN analytics.users AS u ON u.id = m.assigned_closer_id AND u.tenant_id = {tenant_id:String}
WHERE m.tenant_id = {tenant_id:String} AND ${inRange("m.created_at_ms")}
GROUP BY period, group_id`,
  meetings_scheduled: `
SELECT
  ${periodSql("m.scheduled_at_ms")} AS period,
  ${SALES_GROUP("u.team_member_id", "m.booking_program_id")} AS group_id,
  countIf(m.status != 'canceled') AS calls_scheduled,
  countIf(m.status = 'held') AS calls_held,
  countIf(m.status = 'no_show') AS no_shows,
  countIf(m.status = 'canceled') AS cancellations
FROM analytics.meetings AS m
LEFT JOIN analytics.users AS u ON u.id = m.assigned_closer_id AND u.tenant_id = {tenant_id:String}
WHERE m.tenant_id = {tenant_id:String} AND ${inRange("m.scheduled_at_ms")}
GROUP BY period, group_id`,
  deals_won: `
SELECT
  ${periodSql("d.payment_received_at_ms")} AS period,
  ${SALES_GROUP("u.team_member_id", "d.sold_program_id")} AS group_id,
  count() AS deals_won
FROM analytics.deals AS d
LEFT JOIN analytics.users AS u ON u.id = d.assigned_closer_id AND u.tenant_id = {tenant_id:String}
WHERE d.tenant_id = {tenant_id:String} AND d.outcome = 'won' AND ${inRange("d.payment_received_at_ms")}
GROUP BY period, group_id`,
  payments: `
SELECT
  ${periodSql("p.recorded_at_ms")} AS period,
  ${SALES_GROUP("u.team_member_id", "p.program_id")} AS group_id,
  ifNull(p.currency, '') AS currency,
  sum(p.amount_minor) AS cash_collected,
  sumIf(p.amount_minor, p.payment_type = 'deposit') AS deposits,
  sumIf(p.amount_minor, p.payment_type != 'deposit') AS final_cash,
  countIf(p.payment_type != 'deposit') AS final_count
FROM analytics.payments AS p
LEFT JOIN analytics.users AS u ON u.id = p.attributed_closer_id AND u.tenant_id = {tenant_id:String}
WHERE p.tenant_id = {tenant_id:String} AND ifNull(p.status, '') != 'disputed' AND ${inRange("p.recorded_at_ms")}
GROUP BY period, group_id, currency`,
};

export function metricsSql(filters: ApiMetricsFilters, range: ResolvedAnalyticsRange): Record<string, SqlQuery> {
  const params = { ...rangeParams(range), granularity: filters.granularity, group_by: filters.group_by };
  return Object.fromEntries(
    sourcesFor(metricList(filters)).map((source) => [source, { sql: SOURCE_SQL[source], params }]),
  );
}

type BaseFact = { metric: BaseMetric; period: string; groupId: string | null; currency: string | null; value: number };

function factsFromSqlRows(rows: Record<string, SqlRow[]>): BaseFact[] {
  const facts: BaseFact[] = [];
  for (const [source, sourceRows] of Object.entries(rows) as Array<[Source, SqlRow[]]>) {
    for (const row of sourceRows) {
      for (const metric of SOURCE_METRICS[source]) {
        facts.push({
          metric,
          period: String(row.period),
          groupId: str(row.group_id),
          currency: str(row.currency),
          value: num(row[metric]),
        });
      }
    }
  }
  return facts;
}

// --- Convex (today) --------------------------------------------------------

/** Rows read per source for one window. A day has well under this today. */
const LIVE_SOURCE_LIMIT = 8_000;

function livePeriod(ms: number, granularity: ApiGranularity, day: BusinessDaySetting) {
  if (granularity === "total") return "total";
  const date = businessDateForInstant(ms, day);
  if (granularity === "day") return date;
  return granularity === "week" ? businessPeriodDate(date, "week") : date.slice(0, 7);
}

/**
 * The base facts for a window from Convex, by index range. Reads each source
 * at most `LIVE_SOURCE_LIMIT` rows and reports `partial` past that.
 */
async function liveFacts(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  filters: ApiMetricsFilters,
  window: { fromMs: number; toMs: number; day: BusinessDaySetting },
): Promise<{ facts: BaseFact[]; partial: boolean }> {
  const facts = new Map<string, BaseFact & { prospects?: Set<string> }>();
  let partial = false;
  const period = (ms: number) => livePeriod(ms, filters.granularity, window.day);
  const add = (metric: BaseMetric, ms: number, groupId: string | null, value = 1, currency: string | null = null) => {
    const fact = { metric, period: period(ms), groupId: groupId || null, currency };
    const key = JSON.stringify(fact);
    const existing = facts.get(key);
    if (existing) existing.value += value;
    else facts.set(key, { ...fact, value });
  };
  const bounded = <Row,>(rows: Row[]) => {
    if (rows.length >= LIVE_SOURCE_LIMIT) partial = true;
    return rows;
  };

  const teamMemberOf = new Map<string, string | null>();
  const closerMember = async (userId: Id<"users"> | undefined) => {
    if (!userId) return null;
    if (!teamMemberOf.has(userId)) {
      const user = await ctx.db.get("users", userId);
      teamMemberOf.set(userId, user?.tenantId === tenantId ? (user.teamMemberId ?? null) : null);
    }
    return teamMemberOf.get(userId) ?? null;
  };
  const workerMember = async (workerId: Id<"leadGenWorkers"> | undefined) => {
    if (!workerId) return null;
    if (!teamMemberOf.has(workerId)) {
      const worker = await ctx.db.get("leadGenWorkers", workerId);
      teamMemberOf.set(workerId, worker?.tenantId === tenantId ? (worker.teamMemberId ?? null) : null);
    }
    return teamMemberOf.get(workerId) ?? null;
  };
  const salesGroup = async (closerId: Id<"users"> | undefined, programId: string | undefined) =>
    filters.group_by === "closer" ? await closerMember(closerId) : filters.group_by === "program" ? (programId ?? null) : null;

  const sources = sourcesFor(metricList(filters));
  if (sources.includes("captures")) {
    const captures = bounded(
      await ctx.db
        .query("leadGenSubmissions")
        .withIndex("by_tenantId_and_submittedAt", (q) =>
          q.eq("tenantId", tenantId).gte("submittedAt", window.fromMs).lt("submittedAt", window.toMs),
        )
        .take(LIVE_SOURCE_LIMIT),
    );
    for (const capture of captures) {
      if (capture.voidedAt !== undefined) continue;
      const groupId =
        filters.group_by === "team"
          ? (capture.teamId ?? null)
          : filters.group_by === "lead_generator"
            ? await workerMember(capture.workerId)
            : null;
      add("leads_captured", capture.submittedAt, groupId);
      const key = JSON.stringify({ metric: "unique_prospects", period: period(capture.submittedAt), groupId: groupId || null, currency: null });
      const fact = facts.get(key) ?? { metric: "unique_prospects" as const, period: period(capture.submittedAt), groupId: groupId || null, currency: null, value: 0, prospects: new Set<string>() };
      fact.prospects!.add(capture.prospectId);
      fact.value = fact.prospects!.size;
      facts.set(key, fact);
    }
  }
  if (sources.includes("resparks")) {
    const items = bounded(
      await ctx.db
        .query("resparkBatchItems")
        .withIndex("by_tenantId_and_workedAt", (q) =>
          q.eq("tenantId", tenantId).gte("workedAt", window.fromMs).lt("workedAt", window.toMs),
        )
        .take(LIVE_SOURCE_LIMIT),
    );
    for (const item of items) {
      if (item.result !== "resparked" || item.workedAt === undefined) continue;
      add("resparks", item.workedAt, filters.group_by === "lead_generator" ? await workerMember(item.workerId) : null);
    }
  }
  if (sources.includes("qualifications")) {
    const events = bounded(
      await ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_submittedAt", (q) =>
          q.eq("tenantId", tenantId).gte("submittedAt", window.fromMs).lt("submittedAt", window.toMs),
        )
        .take(LIVE_SOURCE_LIMIT),
    );
    for (const event of events) {
      add("qualifications", event.submittedAt, null);
      add("new_qualified_people", event.submittedAt, null, event.resultKind === "created_opportunity" ? 1 : 0);
    }
  }
  if (sources.includes("meetings_booked")) {
    const meetings = bounded(
      await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_createdAt", (q) =>
          q.eq("tenantId", tenantId).gte("createdAt", window.fromMs).lt("createdAt", window.toMs),
        )
        .take(LIVE_SOURCE_LIMIT),
    );
    for (const meeting of meetings) {
      add("calls_booked", meeting.createdAt, await salesGroup(meeting.assignedCloserId, meeting.bookingProgramId));
    }
  }
  if (sources.includes("meetings_scheduled")) {
    const meetings = bounded(
      await ctx.db
        .query("meetings")
        .withIndex("by_tenantId_and_scheduledAt", (q) =>
          q.eq("tenantId", tenantId).gte("scheduledAt", window.fromMs).lt("scheduledAt", window.toMs),
        )
        .take(LIVE_SOURCE_LIMIT),
    );
    for (const meeting of meetings) {
      const groupId = await salesGroup(meeting.assignedCloserId, meeting.bookingProgramId);
      add("calls_scheduled", meeting.scheduledAt, groupId, meeting.status === "canceled" ? 0 : 1);
      add("calls_held", meeting.scheduledAt, groupId, meeting.status === "held" ? 1 : 0);
      add("no_shows", meeting.scheduledAt, groupId, meeting.status === "no_show" ? 1 : 0);
      add("cancellations", meeting.scheduledAt, groupId, meeting.status === "canceled" ? 1 : 0);
    }
  }
  if (sources.includes("payments") || sources.includes("deals_won")) {
    const payments = bounded(
      await ctx.db
        .query("paymentRecords")
        .withIndex("by_tenantId_and_recordedAt", (q) =>
          q.eq("tenantId", tenantId).gte("recordedAt", window.fromMs).lt("recordedAt", window.toMs),
        )
        .take(LIVE_SOURCE_LIMIT),
    );
    if (sources.includes("payments")) {
      for (const payment of payments) {
        if (payment.status === "disputed") continue;
        const groupId = await salesGroup(payment.attributedCloserId, payment.programId);
        const deposit = payment.paymentType === "deposit";
        add("cash_collected", payment.recordedAt, groupId, payment.amountMinor, payment.currency);
        add("deposits", payment.recordedAt, groupId, deposit ? payment.amountMinor : 0, payment.currency);
        add("final_cash", payment.recordedAt, groupId, deposit ? 0 : payment.amountMinor, payment.currency);
        add("final_count", payment.recordedAt, groupId, deposit ? 0 : 1, payment.currency);
      }
    }
    if (sources.includes("deals_won")) {
      // A deal is won when its first payment lands, so the window's payments
      // name every deal won in it; there is no index on paymentReceivedAt.
      const dealIds = [...new Set(payments.map((payment) => payment.opportunityId).filter((id) => id !== undefined))];
      for (const dealId of dealIds) {
        const deal: Doc<"opportunities"> | null = await ctx.db.get("opportunities", dealId);
        if (
          !deal ||
          deal.tenantId !== tenantId ||
          deal.outcome !== "won" ||
          deal.paymentReceivedAt === undefined ||
          deal.paymentReceivedAt < window.fromMs ||
          deal.paymentReceivedAt >= window.toMs
        ) {
          continue;
        }
        add("deals_won", deal.paymentReceivedAt, await salesGroup(deal.assignedCloserId, deal.soldProgramId));
      }
    }
  }
  return { facts: [...facts.values()].map(({ prospects: _prospects, ...fact }) => fact), partial };
}

// --- Shared ----------------------------------------------------------------

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : null;
}

/** The requested metrics from base facts, rates included, in a stable order. */
export function assembleMetrics(facts: readonly BaseFact[], metrics: readonly ApiMetric[]): ApiMetricRow[] {
  const sums = new Map<string, number>();
  const keyOf = (metric: BaseMetric, period: string, groupId: string | null, currency: string | null) =>
    JSON.stringify([metric, period, groupId, currency]);
  const cells = new Map<string, { period: string; groupId: string | null; currency: string | null }>();
  for (const fact of facts) {
    const key = keyOf(fact.metric, fact.period, fact.groupId, fact.currency);
    sums.set(key, (sums.get(key) ?? 0) + fact.value);
    cells.set(JSON.stringify([fact.period, fact.groupId, fact.currency]), {
      period: fact.period,
      groupId: fact.groupId,
      currency: fact.currency,
    });
  }
  const get = (metric: BaseMetric, cell: { period: string; groupId: string | null; currency: string | null }) =>
    sums.get(keyOf(metric, cell.period, cell.groupId, cell.currency)) ?? 0;
  const has = (metric: BaseMetric, cell: { period: string; groupId: string | null; currency: string | null }) =>
    sums.has(keyOf(metric, cell.period, cell.groupId, cell.currency));

  const rows: ApiMetricRow[] = [];
  const allCells = [...cells.values()];
  const plainCells = allCells.filter((cell) => cell.currency === null);
  const moneyCells = allCells.filter((cell) => cell.currency !== null);
  const salesCells = [
    ...new Map(
      facts
        .filter((fact) => fact.metric === "calls_held" || fact.metric === "no_shows" || fact.metric === "deals_won")
        .map((fact) => [JSON.stringify([fact.period, fact.groupId]), { period: fact.period, groupId: fact.groupId, currency: null }]),
    ).values(),
  ];
  for (const metric of metrics) {
    if (metric === "show_rate") {
      for (const cell of salesCells) {
        if (!has("calls_held", cell) && !has("no_shows", cell)) continue;
        const held = get("calls_held", cell);
        rows.push({ metric, period: cell.period, group_id: cell.groupId, value: ratio(held, held + get("no_shows", cell)) });
      }
    } else if (metric === "close_rate") {
      for (const cell of salesCells) {
        rows.push({ metric, period: cell.period, group_id: cell.groupId, value: ratio(get("deals_won", cell), get("calls_held", cell)) });
      }
    } else if (metric === "average_deal_size") {
      for (const cell of moneyCells) {
        if (!has("final_cash", cell)) continue;
        rows.push({ metric, period: cell.period, group_id: cell.groupId, currency: cell.currency!, value: ratio(get("final_cash", cell), get("final_count", cell)) });
      }
    } else if (metric === "cash_collected" || metric === "deposits") {
      for (const cell of moneyCells) {
        if (!has(metric, cell)) continue;
        rows.push({ metric, period: cell.period, group_id: cell.groupId, currency: cell.currency!, value: get(metric, cell) });
      }
    } else {
      for (const cell of plainCells) {
        if (!has(metric, cell)) continue;
        rows.push({ metric, period: cell.period, group_id: cell.groupId, value: get(metric, cell) });
      }
    }
  }
  const order = (row: ApiMetricRow) => JSON.stringify([API_METRICS.indexOf(row.metric), row.period, row.group_id ?? "", row.currency ?? ""]);
  return rows.sort((left, right) => (order(left) < order(right) ? -1 : order(left) > order(right) ? 1 : 0));
}

export async function liveMetrics(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  filters: ApiMetricsFilters,
  window: { fromMs: number; toMs: number; day: BusinessDaySetting },
): Promise<ApiMetricsAnswer> {
  const { facts, partial } = await liveFacts(ctx, tenantId, filters, window);
  return { rows: assembleMetrics(facts, metricList(filters)), partial };
}

const definition: ReportDefinition<ApiMetricsFilters, ApiMetricsAnswer> = {
  id: "api.metrics",
  page: null,
  roles: ["tenant_master", "tenant_admin"],
  day: "business",
  parseFilters: async (_ctx, raw) => parseApiMetricsFilters(raw),
  sql: (input) => metricsSql(input.filters, input.range),
  finalize: async (_ctx, input) => ({
    rows: assembleMetrics(factsFromSqlRows(input.rows), metricList(input.filters)),
    partial: false,
  }),
  live: {
    name: "analytics/api/queries:liveMetricsForWindow",
    args: (input) => ({
      tenantId: input.tenantId,
      metrics: input.filters.metrics,
      granularity: input.filters.granularity,
      groupBy: input.filters.group_by,
      fromMs: input.range.fromMs,
      toMs: input.range.toMs,
      timeZone: input.range.timeZone,
      dayStartHour: input.range.dayStartHour,
    }),
  },
};

export const apiReports = [definition as unknown as AnyReportDefinition];
