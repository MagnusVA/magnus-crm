import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalQuery, query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  getCanonicalIdentityWorkosUserId,
  getWorkosUserIdCandidates,
} from "../lib/workosUserId";

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    console.log("[Users] getCurrentUser called");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.log("[Users] getCurrentUser: no identity");
      return null;
    }

    console.log("[Users] getCurrentUser identity", {
      subject: identity.subject,
      tokenIdentifier: identity.tokenIdentifier ?? null,
    });

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      console.warn("[Users] getCurrentUser: no workosUserId from identity");
      return null;
    }

    console.log("[Users] getCurrentUser lookup", {
      workosUserId,
      usedTokenIdentifier: identity.tokenIdentifier === workosUserId,
    });

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

    if (!user && identity.subject && identity.subject !== workosUserId) {
      const subjectMatch = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", identity.subject))
        .unique();

      console.warn("[Users] getCurrentUser no match for chosen lookup key", {
        chosenLookupKey: workosUserId,
        subject: identity.subject,
        tokenIdentifier: identity.tokenIdentifier ?? null,
        subjectMatchFound: Boolean(subjectMatch),
        subjectMatchUserId: subjectMatch?._id ?? null,
      });
    }

    console.log("[Users] getCurrentUser result", { found: !!user, userId: user?._id });
    if (user?.isActive === false) {
      return null;
    }
    return user;
  },
});

export const getById = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    console.log("[Users] getById called", { userId });
    const user = await ctx.db.get(userId);
    console.log("[Users] getById result", { found: !!user });
    return user;
  },
});

export const getByTenantAndEmail = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    email: v.string(),
  },
  handler: async (ctx, { tenantId, email }) => {
    console.log("[Users] getByTenantAndEmail called", { tenantId });
    const user = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email),
      )
      .unique();
    console.log("[Users] getByTenantAndEmail result", { found: !!user });
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
      "in_progress",
      "follow_up_scheduled",
      "reschedule_link_sent",
    ] as const;

    let count = 0;
    for (const status of activeStatuses) {
      const opportunities = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
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
    console.log("[Users] getCurrentUserInternal called", { workosUserId });
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
    console.log("[Users] getCurrentUserInternal result", { found: !!user, userId: user?._id });
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
    console.log("[Users] listTeamMembers called");
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const users: Doc<"users">[] = [];
    for await (const user of ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))) {
      if (user.isActive === false) {
        continue;
      }
      users.push(user);
      if (users.length >= 200) {
        break;
      }
    }

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

    console.log("[Users] listTeamMembers result", { count: users.length });
    return users.map((user) => ({
      ...user,
      calendlyMemberName:
        user.calendlyMemberName ??
        (user.calendlyUserUri
          ? calendlyMemberNameByUri.get(user.calendlyUserUri)
          : undefined),
      isPendingInvite: user.invitationStatus === "pending",
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
    console.log("[Users] listUnmatchedCalendlyMembers called");
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const members = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_matchedUserId", (q) =>
        q.eq("tenantId", tenantId).eq("matchedUserId", undefined),
      )
      .take(200);

    console.log("[Users] listUnmatchedCalendlyMembers result", { count: members.length });
    return members;
  },
});
