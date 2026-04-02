import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { validateRequiredString } from "../lib/validation";

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
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const workosUserId =
      identity.tokenIdentifier ?? identity.subject ?? "";
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

    if (!tenant) {
      throw new Error("No tenant found for this organization");
    }

    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
      .unique();

    if (tenant.status === "pending_signup") {
      await ctx.db.patch(tenant._id, {
        inviteRedeemedAt: Date.now(),
        status: "pending_calendly",
      });
    }

    if (!existingUser) {
      await ctx.db.insert("users", {
        tenantId: tenant._id,
        workosUserId,
        email: identity.email ?? tenant.contactEmail,
        fullName: identity.name ?? undefined,
        role: "tenant_master",
      });
    } else if (existingUser.tenantId !== tenant._id) {
      // User exists in a different tenant — update to current tenant
      await ctx.db.patch(existingUser._id, { tenantId: tenant._id });
    }

    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      alreadyRedeemed: tenant.status !== "pending_signup",
      status: tenant.status,
    };
  },
});
