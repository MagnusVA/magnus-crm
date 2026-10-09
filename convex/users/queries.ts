import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  getCanonicalIdentityWorkosUserId,
  getWorkosUserIdCandidates,
} from "../lib/workosUserId";
import { userMemberIdentity } from "../lib/memberIdentity";

// eslint-disable-next-line @convex-dev/require-access-control -- returns null when signed out; reads only the caller's user
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      return null;
    }

    let user = null;
    for (const candidateWorkosUserId of getWorkosUserIdCandidates(workosUserId)) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidateWorkosUserId))
        .unique();
      if (user) {
        break;
      }
    }

    if (user?.isActive === false) {
      return null;
    }
    if (!user) {
      return null;
    }

    return {
      ...user,
      avatar: await userMemberIdentity(ctx, user),
    };
  },
});

export const getById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get("users", userId);
    return user;
  },
});

export const getByTenantAndEmail = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    email: v.string(),
  },
  handler: async (ctx, { tenantId, email }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email),
      )
      .unique();
    return user;
  },
});

export const getActiveAssignedOpportunityCount = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    userId: v.id("users"),
  },
  handler: async (ctx, { tenantId, userId }) => {
    const activeStatuses = [
      "scheduled",
      "follow_up_scheduled",
      "reschedule_link_sent",
    ] as const;

    let count = 0;
    for (const status of activeStatuses) {
      const opportunities = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status_and_createdAt", (q) =>
          q
            .eq("tenantId", tenantId)
            .eq("assignedCloserId", userId)
            .eq("status", status),
        )
        .take(1);
      count += opportunities.length;
      if (count > 0) {
        break;
      }
    }

    return count;
  },
});

export const getCurrentUserInternal = internalQuery({
  args: { workosUserId: v.string() },
  handler: async (ctx, { workosUserId }) => {
    let user = null;
    for (const candidateWorkosUserId of getWorkosUserIdCandidates(workosUserId)) {
      user = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidateWorkosUserId))
        .unique();
      if (user) {
        break;
      }
    }
    if (user?.isActive === false) {
      return null;
    }
    return user;
  },
});

/**
 * List all team members for the current tenant.
 * Calendly member names are denormalized onto the user document for query efficiency.
 *
 * Only callable by tenant_master or tenant_admin.
 */
export const listTeamMembers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    // Return all users (including deactivated) — frontend handles filtering
    // via showInactive toggle. Deactivated users are still needed for
    // historical display and admin visibility.
    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200);

    const missingCalendlyUris = [
      ...new Set(
        users
          .filter(
            (user): user is Doc<"users"> & { calendlyUserUri: string } =>
              !user.calendlyMemberName && Boolean(user.calendlyUserUri),
          )
          .map((user) => user.calendlyUserUri),
      ),
    ];
    const linkedMembers = await Promise.all(
      missingCalendlyUris.map(async (calendlyUserUri) => ({
        calendlyUserUri,
        linkedMember: await ctx.db
          .query("calendlyOrgMembers")
          .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
            q.eq("tenantId", tenantId).eq("calendlyUserUri", calendlyUserUri),
          )
          .unique(),
      })),
    );
    const calendlyMemberNameByUri = new Map(
      linkedMembers.map(({ calendlyUserUri, linkedMember }) => [
        calendlyUserUri,
        linkedMember?.name,
      ]),
    );

    return await Promise.all(
      users.map(async (user) => ({
        ...user,
        avatar: await userMemberIdentity(ctx, user),
        calendlyMemberName:
          user.calendlyMemberName ??
          (user.calendlyUserUri
            ? calendlyMemberNameByUri.get(user.calendlyUserUri)
            : undefined),
        isPendingInvite: user.invitationStatus === "pending",
      })),
    );
  },
});

export const listActiveClosers = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const users = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", tenantId).eq("isActive", true),
      )
      .take(200);

    return await Promise.all(
      users
        .filter((user) => user.role === "closer")
        .map(async (user) => ({
          _id: user._id,
          fullName: user.fullName,
          email: user.email,
          avatar: await userMemberIdentity(ctx, user),
        })),
    );
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

    const members = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_matchedUserId", (q) =>
        q.eq("tenantId", tenantId).eq("matchedUserId", undefined),
      )
      .take(200);

    return members;
  },
});
