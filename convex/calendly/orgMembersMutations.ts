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
    const linkedUserId = matchedUser?._id ?? existing?.matchedUserId;

    if (existing) {
      await ctx.db.patch("calendlyOrgMembers", existing._id, {
        email: args.email,
        name: args.name,
        calendlyRole: args.calendlyRole,
        matchedUserId: linkedUserId,
        lastSyncedAt: Date.now(),
      });

      if (linkedUserId) {
        await ctx.db.patch("users", linkedUserId, {
          calendlyUserUri: args.calendlyUserUri,
          calendlyMemberName: args.name,
        });
      }
      return;
    }

    await ctx.db.insert("calendlyOrgMembers", {
      tenantId: args.tenantId,
      calendlyUserUri: args.calendlyUserUri,
      email: args.email,
      name: args.name,
      calendlyRole: args.calendlyRole,
      matchedUserId: linkedUserId,
      lastSyncedAt: Date.now(),
    });

    if (linkedUserId) {
      await ctx.db.patch("users", linkedUserId, {
        calendlyUserUri: args.calendlyUserUri,
        calendlyMemberName: args.name,
      });
    }
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
        await ctx.db.delete("calendlyOrgMembers", member._id);
        deleted++;
      }

      hasMore = staleMembers.length === 128;
    }

    return { deleted };
  },
});
