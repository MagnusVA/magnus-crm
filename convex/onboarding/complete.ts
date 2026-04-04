import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
import { validateRequiredString } from "../lib/validation";
import {
  getCanonicalIdentityWorkosUserId,
  getWorkosUserIdCandidates,
} from "../lib/workosUserId";
import { internal } from "../_generated/api";

export const redeemInviteAndCreateUser = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, { workosOrgId }) => {
    console.log("[Onboarding] redeemInviteAndCreateUser called", { workosOrgId });
    const orgIdValidation = validateRequiredString(workosOrgId, {
      fieldName: "WorkOS organization ID",
    });
    if (!orgIdValidation.valid) {
      throw new Error(orgIdValidation.error);
    }

    const normalizedWorkosOrgId = workosOrgId.trim();
    const identity = await ctx.auth.getUserIdentity();
    console.log("[Onboarding] identity check", { hasIdentity: !!identity });
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity) ?? "";
    const userIdValidation = validateRequiredString(workosUserId, {
      fieldName: "WorkOS user ID",
    });
    if (!userIdValidation.valid) {
      throw new Error(userIdValidation.error);
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== normalizedWorkosOrgId) {
      throw new Error("Not authorized");
    }

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", identityOrgId))
      .unique();

    console.log("[Onboarding] tenant lookup", { found: !!tenant, tenantId: tenant?._id });
    if (!tenant) {
      throw new Error("No tenant found for this organization");
    }

    let existingUser = null;
    for (const candidateWorkosUserId of getWorkosUserIdCandidates(workosUserId)) {
      existingUser = await ctx.db
        .query("users")
        .withIndex("by_workosUserId", (q) => q.eq("workosUserId", candidateWorkosUserId))
        .unique();
      if (existingUser) {
        break;
      }
    }

    console.log("[Onboarding] existing user check", { exists: !!existingUser, existingUserId: existingUser?._id });
    let userId: Id<"users">;

    if (!existingUser) {
      userId = await ctx.db.insert("users", {
        tenantId: tenant._id,
        workosUserId,
        email: identity.email ?? tenant.contactEmail,
        fullName: identity.name ?? undefined,
        role: "tenant_master",
      });
      console.log("[Onboarding] user created", { userId });
    } else {
      userId = existingUser._id;
      console.log("[Onboarding] using existing user", { userId });
      const userPatch: {
        tenantId?: Id<"tenants">;
        workosUserId?: string;
      } = {};
      if (existingUser.tenantId !== tenant._id) {
        // User exists in a different tenant — update to current tenant
        userPatch.tenantId = tenant._id;
      }
      if (existingUser.workosUserId !== workosUserId) {
        userPatch.workosUserId = workosUserId;
      }
      if (Object.keys(userPatch).length > 0) {
        await ctx.db.patch(existingUser._id, userPatch);
      }
    }

    let nextTenantStatus = tenant.status;
    const tenantPatch: {
      tenantOwnerId?: Id<"users">;
      inviteRedeemedAt?: number;
      status?: typeof tenant.status;
    } = {};

    if (tenant.tenantOwnerId !== userId) {
      tenantPatch.tenantOwnerId = userId;
    }

    if (tenant.status === "pending_signup") {
      tenantPatch.inviteRedeemedAt = Date.now();
      tenantPatch.status = "pending_calendly";
      nextTenantStatus = "pending_calendly";
    }

    if (Object.keys(tenantPatch).length > 0) {
      console.log("[Onboarding] patching tenant", { tenantId: tenant._id, patchKeys: Object.keys(tenantPatch) });
      await ctx.db.patch(tenant._id, tenantPatch);
    }

    if (tenant.status === "pending_signup" || tenant.tenantOwnerId !== userId) {
      console.log("[Onboarding] scheduling role assignment", { workosUserId, organizationId: tenant.workosOrgId });
      await ctx.scheduler.runAfter(0, internal.workos.roles.assignRoleToMembership, {
        workosUserId,
        organizationId: tenant.workosOrgId,
        roleSlug: "owner",
      });
    }

    console.log("[Onboarding] redeemInviteAndCreateUser completed", {
      tenantId: tenant._id,
      alreadyRedeemed: tenant.status !== "pending_signup",
      status: nextTenantStatus,
    });
    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      alreadyRedeemed: tenant.status !== "pending_signup",
      status: nextTenantStatus,
    };
  },
});
