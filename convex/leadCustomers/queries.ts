import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import { query } from "../_generated/server";
import { isAdminRole } from "../lib/roleMapping";
import { requireTenantUser } from "../requireTenantUser";
import {
  lifecycleMatchesFilter,
  resolveDirectEntityIdentifier,
  toLeadCustomerSearchRowDto,
} from "./identifierResolution";
import { loadListDeals, type ListViewer } from "./listDeal";
import type { LeadCustomerListRowDto, LeadCustomerSearchRowDto } from "./types";
import { leadCustomerLifecycleFilterValidator } from "./validators";

/** Each row with the person's deal beside it (listDeal.ts). */
async function withListDeals(
  ctx: QueryCtx,
  viewer: ListViewer,
  rows: LeadCustomerSearchRowDto[],
): Promise<LeadCustomerListRowDto[]> {
  const deals = await loadListDeals(ctx, viewer, rows.map((row) => row.leadId));
  return rows.map((row) => ({ ...row, deal: deals.get(row.leadId) ?? null }));
}

export const listEntities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    lifecycle: v.optional(leadCustomerLifecycleFilterValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const viewer: ListViewer = { tenantId, userId, isAdmin: isAdminRole(role) };

    const lifecycle = args.lifecycle ?? "all";
    const result =
      lifecycle !== "all"
        ? await ctx.db
            .query("leadCustomerSearchRows")
            .withIndex(
              "by_tenantId_visible_lifecycle_latestActivityAt",
              (q) =>
                q
                  .eq("tenantId", tenantId)
                  // Prospect rows are hidden from the default views.
                  .eq("isSearchVisible", lifecycle !== "prospect")
                  .eq("lifecycle", lifecycle),
            )
            .order("desc")
            .paginate(args.paginationOpts)
        : await ctx.db
            .query("leadCustomerSearchRows")
            .withIndex(
              "by_tenantId_and_isSearchVisible_and_latestActivityAt",
              (q) => q.eq("tenantId", tenantId).eq("isSearchVisible", true),
            )
            .order("desc")
            .paginate(args.paginationOpts);

    return {
      ...result,
      page: await withListDeals(
        ctx,
        viewer,
        result.page.map((row) => toLeadCustomerSearchRowDto({ row })),
      ),
    };
  },
});

export const searchEntities = query({
  args: {
    searchTerm: v.string(),
    lifecycle: v.optional(leadCustomerLifecycleFilterValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);
    const viewer: ListViewer = { tenantId, userId, isAdmin: isAdminRole(role) };

    const lifecycle = args.lifecycle ?? "all";
    const term = args.searchTerm.trim();
    if (term.length === 0) {
      return [];
    }

    const direct = await resolveDirectEntityIdentifier(ctx, tenantId, term);
    if (direct) {
      return lifecycleMatchesFilter(direct.row.lifecycle, lifecycle)
        ? await withListDeals(ctx, viewer, [toLeadCustomerSearchRowDto(direct)])
        : [];
    }
    if (term.length < 2) {
      return [];
    }

    const rows =
      lifecycle !== "all"
        ? await ctx.db
            .query("leadCustomerSearchRows")
            .withSearchIndex("search_lead_customer_entities", (q) =>
              q
                .search("searchText", term)
                .eq("tenantId", tenantId)
                .eq("isSearchVisible", lifecycle !== "prospect")
                .eq("lifecycle", lifecycle),
            )
            .take(50)
        : await ctx.db
            .query("leadCustomerSearchRows")
            .withSearchIndex("search_lead_customer_entities", (q) =>
              q
                .search("searchText", term)
                .eq("tenantId", tenantId)
                .eq("isSearchVisible", true),
            )
            .take(50);

    return await withListDeals(
      ctx,
      viewer,
      rows.map((row) => toLeadCustomerSearchRowDto({ row })),
    );
  },
});
