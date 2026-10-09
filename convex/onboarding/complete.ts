import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { getIdentityOrgId } from "../lib/identity";
import {
  log,
  logRequestContext,
  reportError,
} from "../lib/observability/log";
import { rejectRequest } from "../lib/observability/errors";
import { validateRequiredString } from "../lib/validation";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
  getWorkosUserIdCandidates,
} from "../lib/workosUserId";
import { requireIdentity } from "../requireIdentity";
import { internal } from "../_generated/api";

export const redeemInviteAndCreateUser = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, { workosOrgId }) => {
    const orgIdValidation = validateRequiredString(workosOrgId, {
      fieldName: "WorkOS organization ID",
    });
    if (!orgIdValidation.valid) {
      throw new Error(orgIdValidation.error);
    }

    const normalizedWorkosOrgId = workosOrgId.trim();
    const identity = await requireIdentity(ctx);

    const workosUserId = getCanonicalIdentityWorkosUserId(identity) ?? "";
    const userIdValidation = validateRequiredString(workosUserId, {
      fieldName: "WorkOS user ID",
    });
    if (!userIdValidation.valid) {
      throw new Error(userIdValidation.error);
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== normalizedWorkosOrgId) {
      throw rejectRequest("auth.organization_mismatch", "Not authorized", {
        flow: "onboarding",
        identityOrgId,
      });
    }

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", identityOrgId))
      .unique();

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

    let userId: Id<"users">;

    if (!existingUser) {
      userId = await ctx.db.insert("users", {
        tenantId: tenant._id,
        workosUserId,
        email: identity.email ?? tenant.contactEmail,
        fullName: identity.name ?? undefined,
        role: "tenant_master",
        isActive: true,
      });
    } else {
      userId = existingUser._id;
      const userPatch: {
        deletedAt?: undefined;
        isActive?: boolean;
        tenantId?: Id<"tenants">;
        workosUserId?: string;
      } = {};
      if (existingUser.tenantId !== tenant._id) {
        // User exists in a different tenant — update to current tenant
        userPatch.tenantId = tenant._id;
        reportError(
          "onboarding.user_tenant_reassigned",
          new Error("Existing user moved to another tenant during onboarding"),
          {
            severity: "warning",
            fingerprint: "onboarding.user_tenant_reassigned",
            fromTenantId: existingUser.tenantId,
            toTenantId: tenant._id,
            userId: existingUser._id,
          },
        );
      }
      if (existingUser.workosUserId !== workosUserId) {
        userPatch.workosUserId = workosUserId;
      }
      if (existingUser.isActive === false) {
        userPatch.isActive = true;
        userPatch.deletedAt = undefined;
      }
      if (Object.keys(userPatch).length > 0) {
        await ctx.db.patch("users", existingUser._id, userPatch);
      }
    }

    logRequestContext({
      distinctId: getRawWorkosUserId(workosUserId),
      tenantId: tenant._id,
      workosOrgId: identityOrgId,
      userId,
      role: existingUser?.role ?? "tenant_master",
    });

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
      await ctx.db.patch("tenants", tenant._id, tenantPatch);
    }

    const roleAssignmentScheduled =
      tenant.status === "pending_signup" || tenant.tenantOwnerId !== userId;
    if (roleAssignmentScheduled) {
      await ctx.scheduler.runAfter(0, internal.workos.roles.assignRoleToMembership, {
        workosUserId,
        organizationId: tenant.workosOrgId,
        roleSlug: "owner",
      });
    }

    log.info("onboarding.invite_redeemed", {
      tenantId: tenant._id,
      userId,
      userCreated: !existingUser,
      alreadyRedeemed: tenant.status !== "pending_signup",
      status: nextTenantStatus,
      roleAssignmentScheduled,
    });
    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      alreadyRedeemed: tenant.status !== "pending_signup",
      status: nextTenantStatus,
    };
  },
});
