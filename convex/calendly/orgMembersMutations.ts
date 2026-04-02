import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const upsertMember = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyUserUri: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    calendlyRole: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", args.tenantId).eq("calendlyUserUri", args.calendlyUserUri),
      )
      .unique();

    const matchedUser = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", args.tenantId).eq("email", args.email),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        name: args.name,
        calendlyRole: args.calendlyRole,
        matchedUserId: matchedUser?._id ?? existing.matchedUserId,
        lastSyncedAt: Date.now(),
      });
      return;
    }

    await ctx.db.insert("calendlyOrgMembers", {
      tenantId: args.tenantId,
      calendlyUserUri: args.calendlyUserUri,
      email: args.email,
      name: args.name,
      calendlyRole: args.calendlyRole,
      matchedUserId: matchedUser?._id,
      lastSyncedAt: Date.now(),
    });
  },
});

export const deleteStaleMembers = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartTimestamp: v.number(),
  },
  handler: async (ctx, { tenantId, syncStartTimestamp }) => {
    let deleted = 0;
    let hasMore = true;

    while (hasMore) {
      const staleMembers = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_lastSyncedAt", (q) =>
          q.eq("tenantId", tenantId).lt("lastSyncedAt", syncStartTimestamp),
        )
        .take(128);

      for (const member of staleMembers) {
        await ctx.db.delete(member._id);
        deleted++;
      }

      hasMore = staleMembers.length === 128;
    }

    return { deleted };
  },
});
