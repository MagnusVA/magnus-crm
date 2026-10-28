import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { log } from "../lib/observability/log";
import { analyticsPageValidator } from "./schema";

/**
 * Moves a report page to ClickHouse for every range but Today, after its
 * parity run passes (docs/plans/clickhouse-reporting.md §12.1):
 * `npx convex run --prod analytics/switch:enable '{"tenantId":"…","page":"revenue"}'`.
 * Open pages switch without a reload.
 */
export const enable = internalMutation({
  args: { tenantId: v.id("tenants"), page: analyticsPageValidator },
  returns: v.array(analyticsPageValidator),
  handler: async (ctx, { tenantId, page }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw new Error(`Missing tenant ${tenantId}`);
    const pages = tenant.analyticsReports ?? [];
    if (pages.includes(page)) return pages;
    const next = [...pages, page];
    await ctx.db.patch("tenants", tenantId, { analyticsReports: next });
    log.info("analytics.page_switched", { tenantId, page, enabled: true });
    return next;
  },
});

/** Puts a page back on its Convex readers at once. The rollback (§12.1). */
export const disable = internalMutation({
  args: { tenantId: v.id("tenants"), page: analyticsPageValidator },
  returns: v.array(analyticsPageValidator),
  handler: async (ctx, { tenantId, page }) => {
    const tenant = await ctx.db.get("tenants", tenantId);
    if (!tenant) throw new Error(`Missing tenant ${tenantId}`);
    const next = (tenant.analyticsReports ?? []).filter((item) => item !== page);
    await ctx.db.patch("tenants", tenantId, {
      analyticsReports: next.length > 0 ? next : undefined,
    });
    log.info("analytics.page_switched", { tenantId, page, enabled: false });
    return next;
  },
});
