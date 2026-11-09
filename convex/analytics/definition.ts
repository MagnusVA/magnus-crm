import type { RegisteredQuery } from "convex/server";
import type { Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { CrmRole } from "../lib/roleMapping";
import type { TenantUserResult } from "../requireTenantUser";
import type { ResolvedAnalyticsRange } from "../../lib/analyticsRange";
import type { SqlQuery, SqlRow } from "./clickhouse";
import type { analyticsPageValidator } from "./schema";

export type AnalyticsPage = Infer<typeof analyticsPageValidator>;

/**
 * `browser`: days run midnight to midnight in the viewer's time zone, as the
 * Reports pages' date controls do. `business`: the tenant's business day, as
 * Overview, Operations and lead gen do.
 */
export type AnalyticsDay = "browser" | "business";

export type AnalyticsFilterValue = string | number | boolean | null;
export type AnalyticsFilters = Record<string, AnalyticsFilterValue>;

export type ReportInput<Filters> = {
  tenantId: Id<"tenants">;
  filters: Filters;
  range: ResolvedAnalyticsRange;
};

/** What the replaced Convex reader returns: the shape both sources produce. */
export type ReaderOutput<Reader> =
  Reader extends RegisteredQuery<"public", infer _Args, infer Returns>
    ? Awaited<Returns>
    : never;

/**
 * How a report builds its answer in a Node action instead of the `complete`
 * mutation (docs/agents/reporting.md, "The Node build path"): for reports
 * whose rows are too large to pass into a mutation, or whose build needs more
 * than a mutation's CPU. The rows stay in the action; only the answer is
 * saved. `context` reads the small Convex lookups `build` needs and returns
 * JSON data (arrays and plain objects, never a `Map`): it crosses a function
 * boundary in production, and `finalize` sends it through JSON the same way.
 */
export type NodeBuild<Filters, Output, Context> = {
  /**
   * IDs from the rows that `context` needs, such as closer IDs. Without
   * `keys`, the context loads before the SQL and `sql` receives it.
   */
  keys?(rows: Record<string, SqlRow[]>): string[];
  /** Reads Convex. Only small lookup tables; checks the tenant of every key. */
  context(ctx: QueryCtx, input: ReportInput<Filters>, keys: readonly string[]): Promise<Context>;
  /** Pure: no Convex reads. */
  build(input: ReportInput<Filters> & { rows: Record<string, SqlRow[]>; context: Context }): Output;
};

/**
 * One panel's report. Today stays on the page's Convex reader (`live`); every
 * other range runs `sql` in ClickHouse and `finalize` in Convex, which returns
 * exactly what the reader returns, so no panel knows its source.
 */
export type ReportDefinition<Filters extends AnalyticsFilters, Output, Context = never> = {
  /** `<page>.<panel>`, e.g. `revenue.metrics`. Part of every cache key. */
  id: string;
  /** The page whose switch moves this report; null for the external API's. */
  page: AnalyticsPage | null;
  /** The roles the replaced reader allows. */
  roles: readonly CrmRole[];
  day: AnalyticsDay;
  /**
   * Validates the page's filters and returns them in canonical form. Filters
   * that come from auth (My Activity's worker) are added here, never taken
   * from the client. Throw `Error` with a safe message on bad input.
   */
  parseFilters(
    ctx: QueryCtx,
    raw: AnalyticsFilters,
    viewer: TenantUserResult,
  ): Promise<Filters>;
  /**
   * Named ClickHouse queries. Each reads only `analytics.*` views, filters
   * every view by `tenant_id = {tenant_id:String}`, and takes the range as
   * `{from_ms:Int64}`, `{to_ms:Int64}`, `{tz:String}` and
   * `{day_start_hour:UInt8}` (see `rangeParams`). `tenant_id` is added by the
   * client; templates never set it. A Node-built report without `node.keys`
   * also receives its context, loaded first.
   */
  sql(input: ReportInput<Filters>, context?: Context): Record<string, SqlQuery>;
  /**
   * Turns the rows into the reader's return value. Runs in a mutation; read
   * only. A Node-built report sets it to `nodeFinalize(node)`, which the
   * convex-test parity tests and `previewFinalize` call.
   */
  finalize(
    ctx: QueryCtx,
    input: ReportInput<Filters> & { rows: Record<string, SqlRow[]> },
  ): Promise<Output>;
  /** Set for reports that build in a Node action (`analytics/runNode.ts`). */
  node?: NodeBuild<Filters, Output, Context>;
  /** The Convex reader this replaces, for `pnpm analytics:parity`. */
  live: {
    /** CLI name, e.g. `reporting/revenue:getRevenueMetrics`. */
    name: string;
    args(input: ReportInput<Filters>): Record<string, unknown>;
  };
};

export type AnyReportDefinition = ReportDefinition<AnalyticsFilters, unknown, unknown>;

/** Ties a definition's output to the reader it replaces. */
export function defineReport<Reader, Filters extends AnalyticsFilters = Record<string, never>, Context = never>(
  definition: ReportDefinition<Filters, ReaderOutput<Reader>, Context>,
): AnyReportDefinition {
  return definition as unknown as AnyReportDefinition;
}

/**
 * `finalize` for a Node-built report: the same context and build as the Node
 * action, with the context sent through JSON as it is in production, so a
 * context that isn't plain JSON data fails the parity tests.
 */
export function nodeFinalize<Filters, Output, Context>(node: NodeBuild<Filters, Output, Context>) {
  return async (
    ctx: QueryCtx,
    input: ReportInput<Filters> & { rows: Record<string, SqlRow[]> },
  ): Promise<Output> => {
    const context = await node.context(ctx, input, node.keys?.(input.rows) ?? []);
    return node.build({ ...input, context: JSON.parse(JSON.stringify(context)) as Context });
  };
}

/** The range parameters every template takes. */
export function rangeParams(range: ResolvedAnalyticsRange) {
  return {
    from_ms: range.fromMs,
    to_ms: range.toMs,
    tz: range.timeZone,
    day_start_hour: range.dayStartHour,
  };
}

/** Filters with no options. */
export async function noFilters(): Promise<Record<string, never>> {
  return {};
}

/** Reads an optional ID filter, rejecting IDs from another table. */
export function optionalIdFilter<Table extends "tenantPrograms" | "attributionTeams" | "dmClosers" | "users" | "leadGenWorkers">(
  ctx: QueryCtx,
  table: Table,
  raw: AnalyticsFilterValue | undefined,
): Id<Table> | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("Invalid filter.");
  const id = ctx.db.normalizeId(table, raw);
  if (!id) throw new Error("Invalid filter.");
  return id;
}

/** Reads an optional string filter limited to `allowed`. */
export function optionalEnumFilter<Value extends string>(
  raw: AnalyticsFilterValue | undefined,
  allowed: readonly Value[],
): Value | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new Error("Invalid filter.");
  }
  return raw as Value;
}

/** Numbers from ClickHouse rows; `null` and missing become 0. */
export function num(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Strings from ClickHouse rows; empty and missing become null. */
export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > 0 ? text : null;
}
