import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { ensureProgramForTenant } from "./shared";

export const ensureInitialProgramForTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    createdByUserId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    defaultCurrency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const creator = await ctx.db.get(args.createdByUserId);
    if (!creator || creator.tenantId !== args.tenantId) {
      throw new Error("Program creator not found");
    }

    const program = await ensureProgramForTenant(ctx, args);
    return program._id;
  },
});
