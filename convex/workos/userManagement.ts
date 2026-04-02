"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, type ActionCtx } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { ADMIN_ROLES, mapCrmRoleToWorkosSlug } from "../lib/roleMapping";
import { validateEmail, validateRequiredString } from "../lib/validation";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

type TenantSummary = {
  _id: Id<"tenants">;
  workosOrgId: string;
  status: Doc<"tenants">["status"];
  companyName: string;
  calendlyWebhookUri: Doc<"tenants">["calendlyWebhookUri"];
  tenantOwnerId: Doc<"tenants">["tenantOwnerId"];
};

type AdminContext = {
  caller: Doc<"users">;
  tenant: TenantSummary;
  callerWorkosUserId: string;
};

async function requireAdminContext(ctx: ActionCtx): Promise<AdminContext> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Not authenticated");
  }

  const callerWorkosUserId = identity.tokenIdentifier ?? identity.subject;
  if (!callerWorkosUserId) {
    throw new Error("Missing WorkOS user ID");
  }

  const caller: Doc<"users"> | null = await ctx.runQuery(
    internal.users.queries.getCurrentUserInternal,
    { workosUserId: callerWorkosUserId },
  );
  if (!caller || !ADMIN_ROLES.includes(caller.role)) {
    throw new Error("Insufficient permissions");
  }

  const tenant: TenantSummary | null = await ctx.runQuery(
    internal.tenants.getCalendlyTenant,
    {
      tenantId: caller.tenantId,
    },
  );
  if (!tenant) {
    throw new Error("Tenant not found");
  }

  const identityOrgId = getIdentityOrgId(identity);
  if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
    throw new Error("Not authorized");
  }

  return { caller, tenant, callerWorkosUserId };
}

async function getMembership(
  workosUserId: string,
  organizationId: string,
) {
  const memberships = await workos.userManagement.listOrganizationMemberships({
    userId: workosUserId,
    organizationId,
  });

  return memberships.data[0] ?? null;
}

async function getTenantUserOrThrow(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
  userId: Id<"users">,
) {
  const user = await ctx.runQuery(internal.users.queries.getById, { userId });
  if (!user || user.tenantId !== tenantId) {
    throw new Error("User not found");
  }

  return user;
}

async function getValidatedCalendlyMember(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
  calendlyMemberId: Id<"calendlyOrgMembers">,
): Promise<Doc<"calendlyOrgMembers">> {
  const member: Doc<"calendlyOrgMembers"> | null = await ctx.runQuery(
    internal.calendly.orgMembersQueries.getMember,
    { memberId: calendlyMemberId },
  );

  if (!member || member.tenantId !== tenantId) {
    throw new Error("Invalid Calendly member");
  }

  return member;
}

function normalizeInviteInput(
  email: string,
  firstName: string,
  lastName?: string,
) {
  const emailValidation = validateEmail(email);
  if (!emailValidation.valid) {
    throw new Error(emailValidation.error);
  }

  const firstNameValidation = validateRequiredString(firstName, {
    fieldName: "First name",
  });
  if (!firstNameValidation.valid) {
    throw new Error(firstNameValidation.error);
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedFirstName = firstName.trim();
  const normalizedLastName = lastName?.trim() || undefined;
  const fullName = [normalizedFirstName, normalizedLastName]
    .filter(Boolean)
    .join(" ");

  return {
    normalizedEmail,
    normalizedFirstName,
    normalizedLastName,
    fullName: fullName || undefined,
  };
}

/**
 * Invite a new user to the tenant organization.
 *
 * This single action handles the ENTIRE flow:
 * 1. Validate caller authorization (must be tenant_master or tenant_admin)
 * 2. Validate Calendly member selection (if provided)
 * 3. Create WorkOS user via SDK
 * 4. Create organization membership with correct role slug
 * 5. Send WorkOS invitation email
 * 6. Create fully-provisioned CRM user record
 * 7. Link Calendly org member (if applicable)
 *
 * After this action completes, the CRM record exists with role, org,
 * and Calendly linkage. The user just needs to accept the invite.
 */
export const inviteUser = action({
  args: {
    email: v.string(),
    firstName: v.string(),
    lastName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyMemberId: v.optional(v.id("calendlyOrgMembers")),
  },
  handler: async (
    ctx,
    { email, firstName, lastName, role, calendlyMemberId },
  ): Promise<{
    userId: Id<"users">;
    workosUserId: string;
    organizationMembershipId: string;
    invitationId: string;
  }> => {
    const { caller, tenant, callerWorkosUserId } = await requireAdminContext(ctx);
    const {
      normalizedEmail,
      normalizedFirstName,
      normalizedLastName,
      fullName,
    } = normalizeInviteInput(email, firstName, lastName);

    const existingTenantUser = await ctx.runQuery(
      internal.users.queries.getByTenantAndEmail,
      {
        tenantId: caller.tenantId,
        email: normalizedEmail,
      },
    );
    if (existingTenantUser) {
      throw new Error("A team member with this email already exists");
    }

    let calendlyUserUri: string | undefined;
    if (calendlyMemberId) {
      if (role !== "closer") {
        throw new Error("Only closers can be linked to Calendly members");
      }

      const member: Doc<"calendlyOrgMembers"> = await getValidatedCalendlyMember(
        ctx,
        caller.tenantId,
        calendlyMemberId,
      );
      if (member.matchedUserId) {
        throw new Error("This Calendly member is already linked to another user");
      }

      calendlyUserUri = member.calendlyUserUri;
    }

    const workosUser = await workos.userManagement.createUser({
      email: normalizedEmail,
      firstName: normalizedFirstName,
      lastName: normalizedLastName,
    });

    const organizationMembership =
      await workos.userManagement.createOrganizationMembership({
        userId: workosUser.id,
        organizationId: tenant.workosOrgId,
        roleSlug: mapCrmRoleToWorkosSlug(role),
      });

    const invitation = await workos.userManagement.sendInvitation({
      email: normalizedEmail,
      organizationId: tenant.workosOrgId,
      inviterUserId: callerWorkosUserId,
      roleSlug: mapCrmRoleToWorkosSlug(role),
    });

    const userId: Id<"users"> = await ctx.runMutation(
      internal.workos.userMutations.createUserWithCalendlyLink,
      {
        tenantId: caller.tenantId,
        workosUserId: workosUser.id,
        email: normalizedEmail,
        fullName,
        role,
        calendlyUserUri,
        calendlyMemberId,
      },
    );

    return {
      userId,
      workosUserId: workosUser.id,
      organizationMembershipId: organizationMembership.id,
      invitationId: invitation.id,
    };
  },
});

/**
 * Update a user's role in both WorkOS and the CRM.
 *
 * Steps:
 * 1. Validate caller is admin/owner
 * 2. Find the user's WorkOS membership
 * 3. Update the membership role slug
 * 4. Update the CRM user role
 *
 * Note: Role changes take effect on the user's NEXT session.
 */
export const updateUserRole = action({
  args: {
    userId: v.id("users"),
    newRole: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
  },
  handler: async (ctx, { userId, newRole }) => {
    const { caller, tenant } = await requireAdminContext(ctx);
    const user = await getTenantUserOrThrow(ctx, caller.tenantId, userId);

    if (tenant.tenantOwnerId === user._id && newRole !== "tenant_master") {
      throw new Error("Cannot change the tenant owner's role");
    }

    const membership = await getMembership(user.workosUserId, tenant.workosOrgId);
    if (!membership) {
      throw new Error("No WorkOS membership found for this user");
    }

    await workos.userManagement.updateOrganizationMembership(membership.id, {
      roleSlug: mapCrmRoleToWorkosSlug(newRole),
    });

    await ctx.runMutation(internal.workos.userMutations.updateRole, {
      userId,
      role: newRole,
    });

    return { userId, role: newRole };
  },
});

/**
 * Remove a user from the tenant organization.
 *
 * Steps:
 * 1. Validate caller is admin/owner
 * 2. Prevent self-removal
 * 3. Remove WorkOS org membership
 * 4. Delete CRM user record + unlink Calendly member
 */
export const removeUser = action({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const { caller, tenant } = await requireAdminContext(ctx);
    const user = await getTenantUserOrThrow(ctx, caller.tenantId, userId);

    if (user._id === caller._id) {
      throw new Error("Cannot remove yourself");
    }

    if (tenant.tenantOwnerId === user._id) {
      throw new Error("Cannot remove the tenant owner");
    }

    const membership = await getMembership(user.workosUserId, tenant.workosOrgId);
    if (membership) {
      await workos.userManagement.deleteOrganizationMembership(membership.id);
    }

    await ctx.runMutation(internal.workos.userMutations.removeUser, { userId });

    return { userId };
  },
});
