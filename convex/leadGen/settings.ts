import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const DEFAULT_RAW_EXPORT_MAX_ROWS = 5000;

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const settings = await ctx.db
      .query("leadGenSettings")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    return (
      settings ?? {
        rawExportMaxRows: DEFAULT_RAW_EXPORT_MAX_ROWS,
        duplicateDisplayMode: "show_all" as const,
      }
    );
  },
});

export const updateSettings = mutation({
  args: {
    correctionWindowMinutes: v.optional(v.number()),
    rawExportMaxRows: v.number(),
    duplicateDisplayMode: v.union(
      v.literal("show_all"),
      v.literal("group_by_prospect"),
    ),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    if (
      args.correctionWindowMinutes !== undefined &&
      (args.correctionWindowMinutes < 0 || args.correctionWindowMinutes > 10080)
    ) {
      throw new Error("Correction window must be between 0 and 10080 minutes");
    }

    if (args.rawExportMaxRows < 1 || args.rawExportMaxRows > 50000) {
      throw new Error("Raw export limit must be between 1 and 50000 rows");
    }

    const existing = await ctx.db
      .query("leadGenSettings")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { ...args, updatedAt: now });
      return existing._id;
    }

    return await ctx.db.insert("leadGenSettings", {
      tenantId,
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});
