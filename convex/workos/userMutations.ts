import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation, mutation } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import {
  canonicalizeWorkosUserId,
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
} from "../lib/workosUserId";
import { getIdentityOrgId } from "../lib/identity";
import { emitDomainEvent } from "../lib/domainEvents";
import { updateTenantStats } from "../lib/tenantStatsHelper";

/**
 * Create a fully-provisioned CRM user record and link a Calendly org member.
 *
 * Called by the inviteUser action AFTER WorkOS user + membership + invitation
 * are already created. This ensures the CRM record exists before the user
 * ever signs up.
 *
 * Idempotent: if a user with this workosUserId already exists, returns
 * the existing user's ID without creating a duplicate.
 *
 * @deprecated Use createInvitedUser for new invitation flow. Kept for
 * backwards compatibility with any in-flight invitations.
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
    console.log("[WorkOS:Users] createUserWithCalendlyLink called", { tenantId: args.tenantId, role: args.role, hasCalendlyMember: !!args.calendlyMemberId });
    const {
      tenantId, workosUserId, email, fullName, role,
      calendlyUserUri, calendlyMemberId,
    } = args;
    const calendlyMember = calendlyMemberId
      ? await ctx.db.get(calendlyMemberId)
      : null;
    const resolvedCalendlyUserUri =
      calendlyUserUri ?? calendlyMember?.calendlyUserUri;
    const resolvedCalendlyMemberName = calendlyMember?.name;
    const canonicalWorkosUserId = canonicalizeWorkosUserId(workosUserId);
    const legacyRawWorkosUserId = getRawWorkosUserId(workosUserId);

    // Idempotency: if user already exists, return existing ID
    let existing = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", canonicalWorkosUserId))
      .unique();
    if (!existing && legacyRawWorkosUserId !== canonicalWorkosUserId) {
      existing = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", legacyRawWorkosUserId))
        .unique();
    }
    console.log("[WorkOS:Users] createUserWithCalendlyLink existing check", { exists: !!existing, existingId: existing?._id });
    if (existing) {
      const wasInactive = existing.isActive === false;
      const roleChanged = existing.role !== role;
      console.log("[WorkOS:Users] createUserWithCalendlyLink updating existing user", { userId: existing._id });
      await ctx.db.patch(existing._id, {
        tenantId,
        workosUserId: canonicalWorkosUserId,
        email,
        fullName: fullName ?? existing.fullName,
        role,
        calendlyUserUri: resolvedCalendlyUserUri ?? existing.calendlyUserUri,
        calendlyMemberName:
          resolvedCalendlyMemberName ?? existing.calendlyMemberName,
        deletedAt: undefined,
        isActive: true,
      });

      if (wasInactive) {
        await updateTenantStats(ctx, tenantId, {
          totalTeamMembers: 1,
          totalClosers: role === "closer" ? 1 : 0,
        });
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "user",
          entityId: existing._id,
          eventType: "user.reactivated",
          source: "system",
          toStatus: "active",
        });
      } else if (roleChanged) {
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "user",
          entityId: existing._id,
          eventType: "user.role_changed",
          source: "system",
          fromStatus: existing.role,
          toStatus: role,
        });
      }

      if (calendlyMemberId) {
        console.log("[WorkOS:Users] createUserWithCalendlyLink linking calendly member to existing user", { calendlyMemberId, userId: existing._id });
        await ctx.db.patch(calendlyMemberId, {
          matchedUserId: existing._id,
        });
      }

      return existing._id;
    }

    // Insert CRM user record
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId: canonicalWorkosUserId,
      email,
      fullName,
      role,
      calendlyUserUri: resolvedCalendlyUserUri,
      calendlyMemberName: resolvedCalendlyMemberName,
      isActive: true,
    });
    await updateTenantStats(ctx, tenantId, {
      totalTeamMembers: 1,
      totalClosers: role === "closer" ? 1 : 0,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "user",
      entityId: userId,
      eventType: "user.created",
      source: "system",
      toStatus: role,
    });

    console.log("[WorkOS:Users] createUserWithCalendlyLink user inserted", { userId });

    // Link the Calendly org member to this user (if selected during invite)
    if (calendlyMemberId) {
      console.log("[WorkOS:Users] createUserWithCalendlyLink linking calendly member", { calendlyMemberId, userId });
      await ctx.db.patch(calendlyMemberId, {
        matchedUserId: userId,
      });
    }

    return userId;
  },
});

/**
 * Create a CRM user record for an invited team member.
 *
 * Called by the inviteUser action. The workosUserId is a placeholder
 * ("pending:<email>") because the real WorkOS user doesn't exist yet —
 * it will be created when the invitee signs up via the WorkOS invitation.
 *
 * The Calendly org member link is established immediately so the member
 * is "reserved" and can't be claimed by another invite.
 *
 * Idempotent: if a user with this email already exists in this tenant,
 * returns the existing user's ID.
 */
export const createInvitedUser = internalMutation({
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
    invitationStatus: v.union(v.literal("pending"), v.literal("accepted")),
    workosInvitationId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[WorkOS:Users] createInvitedUser called", {
      tenantId: args.tenantId,
      role: args.role,
      email: args.email,
      hasCalendlyMember: !!args.calendlyMemberId,
    });
    const {
      tenantId, workosUserId, email, fullName, role,
      calendlyUserUri, calendlyMemberId,
      invitationStatus, workosInvitationId,
    } = args;
    const calendlyMember = calendlyMemberId
      ? await ctx.db.get(calendlyMemberId)
      : null;
    const resolvedCalendlyUserUri =
      calendlyUserUri ?? calendlyMember?.calendlyUserUri;
    const resolvedCalendlyMemberName = calendlyMember?.name;

    // Idempotency: check by email + tenant (not workosUserId, since it's a placeholder)
    const existing = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenantId).eq("email", email),
      )
      .unique();

    if (existing) {
      const wasInactive = existing.isActive === false;
      const roleChanged = existing.role !== role;
      console.log("[WorkOS:Users] createInvitedUser updating existing user", { userId: existing._id });
      await ctx.db.patch(existing._id, {
        workosUserId,
        fullName: fullName ?? existing.fullName,
        role,
        calendlyUserUri: resolvedCalendlyUserUri ?? existing.calendlyUserUri,
        calendlyMemberName:
          resolvedCalendlyMemberName ?? existing.calendlyMemberName,
        invitationStatus,
        workosInvitationId,
        deletedAt: undefined,
        isActive: true,
      });

      if (wasInactive) {
        await updateTenantStats(ctx, tenantId, {
          totalTeamMembers: 1,
          totalClosers: role === "closer" ? 1 : 0,
        });
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "user",
          entityId: existing._id,
          eventType: "user.reactivated",
          source: "system",
          toStatus: "active",
        });
      } else if (roleChanged) {
        await emitDomainEvent(ctx, {
          tenantId,
          entityType: "user",
          entityId: existing._id,
          eventType: "user.role_changed",
          source: "system",
          fromStatus: existing.role,
          toStatus: role,
        });
      }

      if (calendlyMemberId) {
        await ctx.db.patch(calendlyMemberId, { matchedUserId: existing._id });
      }

      return existing._id;
    }

    // Insert new CRM user record with placeholder workosUserId
    const userId = await ctx.db.insert("users", {
      tenantId,
      workosUserId,
      email,
      fullName,
      role,
      calendlyUserUri: resolvedCalendlyUserUri,
      calendlyMemberName: resolvedCalendlyMemberName,
      invitationStatus,
      workosInvitationId,
      isActive: true,
    });
    await updateTenantStats(ctx, tenantId, {
      totalTeamMembers: 1,
      totalClosers: role === "closer" ? 1 : 0,
    });
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "user",
      entityId: userId,
      eventType: "user.created",
      source: "admin",
      toStatus: invitationStatus,
    });

    console.log("[WorkOS:Users] createInvitedUser user inserted", { userId, invitationStatus });

    // Link the Calendly org member to this user (if selected during invite)
    if (calendlyMemberId) {
      console.log("[WorkOS:Users] createInvitedUser linking calendly member", { calendlyMemberId, userId });
      await ctx.db.patch(calendlyMemberId, { matchedUserId: userId });
    }

    return userId;
  },
});

export const claimInvitedAccountByEmail = internalMutation({
  args: {
    workosUserId: v.string(),
    orgId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
  },
  handler: async (ctx, { workosUserId, orgId, email, fullName }) => {
    const normalizedEmail = email.trim().toLowerCase();

    console.log("[WorkOS:Users] claimInvitedAccountByEmail called", {
      workosUserId,
      orgId,
      email: normalizedEmail,
    });

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", orgId))
      .unique();

    if (!tenant) {
      console.warn("[WorkOS:Users] claimInvitedAccountByEmail: no tenant for orgId", {
        orgId,
      });
      return null;
    }

    const pendingUser = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", tenant._id).eq("email", normalizedEmail),
      )
      .unique();

    if (!pendingUser) {
      console.log("[WorkOS:Users] claimInvitedAccountByEmail: no pending user found", {
        email: normalizedEmail,
        tenantId: tenant._id,
      });
      return null;
    }

    if (pendingUser.invitationStatus !== "pending") {
      console.log("[WorkOS:Users] claimInvitedAccountByEmail: user not in pending state", {
        userId: pendingUser._id,
        invitationStatus: pendingUser.invitationStatus,
      });
      if (pendingUser.workosUserId === workosUserId) {
        return pendingUser;
      }
      return null;
    }

    console.log("[WorkOS:Users] claimInvitedAccountByEmail: claiming pending user", {
      userId: pendingUser._id,
      oldWorkosUserId: pendingUser.workosUserId,
      newWorkosUserId: workosUserId,
      role: pendingUser.role,
      hasCalendlyLink: !!pendingUser.calendlyUserUri,
    });

    await ctx.db.patch(pendingUser._id, {
      workosUserId,
      invitationStatus: "accepted",
      fullName: pendingUser.fullName ?? fullName,
      isActive: true,
      deletedAt: undefined,
    });

    const claimed = await ctx.db.get(pendingUser._id);
    console.log("[WorkOS:Users] claimInvitedAccountByEmail: claim complete", {
      userId: pendingUser._id,
      role: pendingUser.role,
    });

    return claimed;
  },
});

/**
 * Claim a pending invited-user CRM record after completing sign-up.
 *
 * Called from the workspace layout when getCurrentUser returns null for
 * an authenticated user. This happens when an invited user completes
 * sign-up and their JWT contains a real workosUserId, but the CRM
 * record still has a placeholder "pending:<email>".
 *
 * Flow:
 * 1. Extract real workosUserId and orgId from the authenticated identity
 * 2. Find the tenant by orgId
 * 3. Look up the pending CRM user by email + tenantId
 * 4. Patch the real workosUserId and mark as "accepted"
 * 5. Return the user record so the workspace can render immediately
 *
 * Returns null if no pending record is found (genuine "not provisioned" state).
 */
export const claimInvitedAccount = mutation({
  args: {},
  handler: async (ctx): Promise<Doc<"users"> | null> => {
    console.log("[WorkOS:Users] claimInvitedAccount called");
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      console.warn("[WorkOS:Users] claimInvitedAccount: not authenticated");
      return null;
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      console.warn("[WorkOS:Users] claimInvitedAccount: no workosUserId");
      return null;
    }

    const orgId = getIdentityOrgId(identity);
    if (!orgId) {
      console.warn("[WorkOS:Users] claimInvitedAccount: no orgId");
      return null;
    }

    const email = identity.email;
    if (!email || typeof email !== "string") {
      console.warn("[WorkOS:Users] claimInvitedAccount: no email in identity");
      return null;
    }

    return await ctx.runMutation(
      internal.workos.userMutations.claimInvitedAccountByEmail,
      {
        workosUserId,
        orgId,
        email,
        fullName: typeof identity.name === "string" ? identity.name : undefined,
      },
    );
  },
});

export const normalizeStoredWorkosUserIds = internalMutation({
  args: {},
  handler: async (ctx) => {
    const updatedUsers: Array<{
      userId: string;
      from: string;
      to: string;
    }> = [];

    for await (const user of ctx.db.query("users")) {
      const canonicalWorkosUserId = canonicalizeWorkosUserId(user.workosUserId);
      if (canonicalWorkosUserId === user.workosUserId) {
        continue;
      }

      await ctx.db.patch(user._id, {
        workosUserId: canonicalWorkosUserId,
      });
      updatedUsers.push({
        userId: user._id,
        from: user.workosUserId,
        to: canonicalWorkosUserId,
      });
    }

    console.log("[WorkOS:Users] normalizeStoredWorkosUserIds completed", {
      updatedCount: updatedUsers.length,
      updatedUsers,
    });

    return {
      updatedCount: updatedUsers.length,
      updatedUsers,
    };
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
    console.log("[WorkOS:Users] updateRole called", { userId, role });
    const existing = await ctx.db.get(userId);
    if (!existing) {
      throw new Error("User not found");
    }
    await ctx.db.patch(userId, { role });
    if (existing.role !== role) {
      await updateTenantStats(ctx, existing.tenantId, {
        totalClosers:
          (role === "closer" ? 1 : 0) - (existing.role === "closer" ? 1 : 0),
      });
      await emitDomainEvent(ctx, {
        tenantId: existing.tenantId,
        entityType: "user",
        entityId: userId,
        eventType: "user.role_changed",
        source: "admin",
        fromStatus: existing.role,
        toStatus: role,
      });
    }
    console.log("[WorkOS:Users] updateRole completed", { userId, role });
  },
});

/**
 * Update a CRM user's role AND their stored WorkOS invitation ID.
 * Called by updateUserRole when re-sending a pending invitation with a new role.
 */
export const updateRoleAndInvitation = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    workosInvitationId: v.string(),
  },
  handler: async (ctx, { userId, role, workosInvitationId }) => {
    console.log("[WorkOS:Users] updateRoleAndInvitation called", { userId, role, workosInvitationId });
    const existing = await ctx.db.get(userId);
    if (!existing) {
      throw new Error("User not found");
    }
    await ctx.db.patch(userId, { role, workosInvitationId });
    if (existing.role !== role) {
      await updateTenantStats(ctx, existing.tenantId, {
        totalClosers:
          (role === "closer" ? 1 : 0) - (existing.role === "closer" ? 1 : 0),
      });
      await emitDomainEvent(ctx, {
        tenantId: existing.tenantId,
        entityType: "user",
        entityId: userId,
        eventType: "user.role_changed",
        source: "admin",
        fromStatus: existing.role,
        toStatus: role,
      });
    }
    console.log("[WorkOS:Users] updateRoleAndInvitation completed", { userId, role });
  },
});

/**
 * Remove a CRM user and unlink their Calendly org member.
 * Called by removeUser action after removing WorkOS membership.
 */
export const removeUser = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    console.log("[WorkOS:Users] removeUser called", { userId });
    const user = await ctx.db.get(userId);
    if (!user) {
      console.warn("[WorkOS:Users] removeUser user not found", { userId });
      return;
    }
    if (user.isActive === false) {
      console.log("[WorkOS:Users] removeUser: already deactivated", { userId });
      return;
    }

    const activeStatuses = [
      "scheduled",
      "in_progress",
      "meeting_overran",
      "follow_up_scheduled",
      "reschedule_link_sent",
    ] as const;
    for (const status of activeStatuses) {
      const opportunities = await ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_assignedCloserId_and_status", (q) =>
          q
            .eq("tenantId", user.tenantId)
            .eq("assignedCloserId", userId)
            .eq("status", status),
        )
        .take(1);
      if (opportunities.length > 0) {
        throw new ConvexError(
          "Cannot remove a user who still has active assigned opportunities",
        );
      }
    }

    const now = Date.now();

    // Unlink Calendly org member (if linked)
    if (user.calendlyUserUri) {
      const member = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", user.tenantId).eq("calendlyUserUri", user.calendlyUserUri!)
        )
        .unique();
      if (member) {
        console.log("[WorkOS:Users] removeUser unlinking calendly member", { memberId: member._id });
        await ctx.db.patch(member._id, { matchedUserId: undefined });
      }
    }

    await ctx.db.patch(userId, {
      deletedAt: now,
      isActive: false,
    });
    await updateTenantStats(ctx, user.tenantId, {
      totalTeamMembers: -1,
      totalClosers: user.role === "closer" ? -1 : 0,
    });
    await emitDomainEvent(ctx, {
      tenantId: user.tenantId,
      entityType: "user",
      entityId: userId,
      eventType: "user.deactivated",
      source: "admin",
      fromStatus: user.role,
      toStatus: "inactive",
      occurredAt: now,
    });
    console.log("[WorkOS:Users] removeUser soft deleted", { userId });
  },
});
