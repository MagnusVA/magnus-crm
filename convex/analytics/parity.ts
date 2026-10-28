import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type QueryCtx } from "../_generated/server";
import { getTenantBusinessDay } from "../lib/tenantBusinessDay";
import { browserDay, resolveAnalyticsRange } from "../../lib/analyticsRange";
import type { AnalyticsFilters } from "./definition";
import { canonicalJson } from "./keys";
import { getReportDefinition, listReportDefinitions } from "./registry";
import { resolvedRangeValidator } from "./results";
import { fetchReportRows } from "./run";
import { analyticsPageValidator, analyticsRangeValidator } from "./schema";

// Read-only helpers for `pnpm analytics:parity` (scripts/analytics-parity.mjs),
// which compares each report's Convex reader with its ClickHouse path on
// production before the page is switched (§12.1). Nothing here writes.

/** Tenants, so the script can default to the only one. */
export const tenants = internalQuery({
  args: {},
  returns: v.array(v.object({ tenantId: v.id("tenants"), companyName: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("tenants").take(50);
    return rows.map((tenant) => ({ tenantId: tenant._id, companyName: tenant.companyName }));
  },
});

/** The user the script runs the Convex readers as: the tenant's owner. */
async function readerUser(ctx: QueryCtx, tenantId: Id<"tenants">) {
  const tenant = await ctx.db.get("tenants", tenantId);
  if (!tenant) throw new Error(`Missing tenant ${tenantId}`);
  let owner = tenant.tenantOwnerId ? await ctx.db.get("users", tenant.tenantOwnerId) : null;
  if (!owner || !owner.isActive) {
    const active = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) => q.eq("tenantId", tenantId).eq("isActive", true))
      .take(200);
    owner = active.find((user) => user.role === "tenant_master") ?? null;
  }
  if (!owner) throw new Error("The tenant has no active owner to run the readers as.");
  return { tenant, owner };
}

/** The identity the script runs the Convex readers as: the tenant's owner. */
export const identity = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.object({
    subject: v.string(),
    issuer: v.string(),
    tokenIdentifier: v.string(),
    org_id: v.string(),
  }),
  handler: async (ctx, { tenantId }) => {
    const { tenant, owner } = await readerUser(ctx, tenantId);
    const separator = owner.workosUserId.lastIndexOf("|");
    return {
      subject: separator === -1 ? owner.workosUserId : owner.workosUserId.slice(separator + 1),
      issuer: separator === -1 ? "" : owner.workosUserId.slice(0, separator),
      tokenIdentifier: owner.workosUserId,
      org_id: tenant.workosOrgId,
    };
  },
});

/**
 * For each report on a page: the reader to call, its args, and the new path's
 * inputs. Filters are parsed as `reports.request` parses them, defaults
 * included, so both paths get the same ones. A report whose filters don't
 * parse returns the error instead.
 */
export const plan = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    // A report page, or "api" for the external API's metrics.
    page: v.union(analyticsPageValidator, v.literal("api")),
    range: analyticsRangeValidator,
    timeZone: v.string(),
    filtersJson: v.optional(v.string()),
  },
  returns: v.array(
    v.union(
      v.object({
        reportId: v.string(),
        liveName: v.string(),
        liveArgsJson: v.string(),
        filtersJson: v.string(),
        range: resolvedRangeValidator,
      }),
      v.object({ reportId: v.string(), error: v.string() }),
    ),
  ),
  handler: async (ctx, args) => {
    const raw = JSON.parse(args.filtersJson ?? "{}") as AnalyticsFilters;
    const { owner } = await readerUser(ctx, args.tenantId);
    const viewer = {
      userId: owner._id,
      tenantId: args.tenantId,
      role: owner.role,
      workosUserId: owner.workosUserId,
    };
    const now = Date.now();
    const items = [];
    for (const definition of listReportDefinitions()) {
      if (definition.page !== (args.page === "api" ? null : args.page)) continue;
      let filters: AnalyticsFilters;
      try {
        filters = await definition.parseFilters(ctx, raw, viewer);
      } catch (error) {
        items.push({ reportId: definition.id, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const day =
        definition.day === "browser"
          ? browserDay(args.timeZone)
          : await getTenantBusinessDay(ctx, args.tenantId);
      const range = resolveAnalyticsRange(args.range, day, now);
      const input = { tenantId: args.tenantId, filters, range };
      items.push({
        reportId: definition.id,
        liveName: definition.live.name,
        liveArgsJson: JSON.stringify(definition.live.args(input)),
        filtersJson: canonicalJson(filters),
        range,
      });
    }
    return items;
  },
});

/** The new path's answer for one report, computed and returned, never saved. */
export const runNew = internalAction({
  args: {
    tenantId: v.id("tenants"),
    reportId: v.string(),
    filtersJson: v.string(),
    range: resolvedRangeValidator,
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const definition = getReportDefinition(args.reportId);
    const rowsJson = await fetchReportRows(definition, {
      tenantId: args.tenantId,
      filters: JSON.parse(args.filtersJson) as AnalyticsFilters,
      range: args.range,
    });
    return await ctx.runQuery(internal.analytics.results.previewFinalize, {
      reportId: args.reportId,
      tenantId: args.tenantId,
      filtersJson: args.filtersJson,
      range: args.range,
      rowsJson,
    });
  },
});
