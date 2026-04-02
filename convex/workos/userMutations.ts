import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Create a fully-provisioned CRM user record and link a Calendly org member.
 *
 * Called by the inviteUser action AFTER WorkOS user + membership + invitation
 * are already created. This ensures the CRM record exists before the user
 * ever signs up.
 *
 * Idempotent: if a user with this workosUserId already exists, returns
 * the existing user's ID without creating a duplicate.
 */
export const createUserWithCalendlyLink = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyUserUri: v.optional(v.string()),
    calendlyMemberId: v.optional(v.id("calendlyOrgMembers")),
  },
  handler: async (ctx, args) => {
    const {
      tenantId, workosUserId, email, fullName, role,
      calendlyUserUri, calendlyMemberId,
    } = args;

    // Idempotency: if user already exists, return existing ID
    const existing = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        tenantId,
        email,
        fullName: fullName ?? existing.fullName,
        role,
        calendlyUserUri: calendlyUserUri ?? existing.calendlyUserUri,
      });

      if (calendlyMemberId) {
        await ctx.db.patch(calendlyMemberId, {
          matchedUserId: existing._id,
        });
      }

      return existing._id;
    }

    // Insert CRM user record
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId,
      email,
      fullName,
      role,
      calendlyUserUri,
    });

    // Link the Calendly org member to this user (if selected during invite)
    if (calendlyMemberId) {
      await ctx.db.patch(calendlyMemberId, {
        matchedUserId: userId,
      });
    }

    return userId;
  },
});

/**
 * Update a CRM user's role.
 * Called by updateUserRole action after updating WorkOS membership.
 */
export const updateRole = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
  },
  handler: async (ctx, { userId, role }) => {
    await ctx.db.patch(userId, { role });
  },
});

/**
 * Remove a CRM user and unlink their Calendly org member.
 * Called by removeUser action after removing WorkOS membership.
 */
export const removeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return;

    // Unlink Calendly org member (if linked)
    if (user.calendlyUserUri) {
      const member = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", user.tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
        )
        .unique();
      if (member) {
        await ctx.db.patch(member._id, { matchedUserId: undefined });
      }
    }

    // Delete the CRM user record
    await ctx.db.delete(userId);
  },
});
