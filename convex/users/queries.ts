import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const workosUserId = identity.tokenIdentifier ?? identity.subject;
    if (!workosUserId) {
      return null;
    }

    return await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
  },
});

export const getById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db.get(userId);
  },
});

export const getByTenantAndEmail = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    email: v.string(),
  },
  handler: async (ctx, { tenantId, email }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email),
      )
      .unique();
  },
});

export const getCurrentUserInternal = internalQuery({
  args: { workosUserId: v.string() },
  handler: async (ctx, { workosUserId }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();
  },
});

/**
 * List all team members for the current tenant.
 * Enriched with Calendly member names for display.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const listTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const users: Doc<"users">[] = [];
    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      users.push(user);
    }

    const memberNameByUri = new Map<string, string | undefined>();
    for await (const member of ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      memberNameByUri.set(member.calendlyUserUri, member.name);
    }

    return users.map((user) => ({
      ...user,
      calendlyMemberName: user.calendlyUserUri
        ? memberNameByUri.get(user.calendlyUserUri)
        : undefined,
    }));
  },
});

/**
 * List Calendly org members that are NOT yet linked to a CRM user.
 * Used by the invite form dropdown when inviting a Closer.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const listUnmatchedCalendlyMembers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const members: Doc<"calendlyOrgMembers">[] = [];
    for await (const member of ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_matchedUserId", (q) =>
        q.eq("tenantId", tenantId).eq("matchedUserId", undefined),
      )) {
      members.push(member);
    }

    return members;
  },
});
