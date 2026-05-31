import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  lifecycleMatchesFilter,
  resolveDirectEntityIdentifier,
  toLeadCustomerSearchRowDto,
} from "./identifierResolution";
import { leadCustomerLifecycleFilterValidator } from "./validators";

export const listEntities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    lifecycle: v.optional(leadCustomerLifecycleFilterValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

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
                  .eq("isSearchVisible", true)
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
      page: result.page.map((row) => toLeadCustomerSearchRowDto({ row })),
    };
  },
});

export const searchEntities = query({
  args: {
    searchTerm: v.string(),
    lifecycle: v.optional(leadCustomerLifecycleFilterValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lifecycle = args.lifecycle ?? "all";
    const term = args.searchTerm.trim();
    if (term.length === 0) {
      return [];
    }

    const direct = await resolveDirectEntityIdentifier(ctx, tenantId, term);
    if (direct) {
      return lifecycleMatchesFilter(direct.row.lifecycle, lifecycle)
        ? [toLeadCustomerSearchRowDto(direct)]
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
                .eq("isSearchVisible", true)
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

    return rows.map((row) => toLeadCustomerSearchRowDto({ row }));
  },
});
