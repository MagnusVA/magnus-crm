import { v } from "convex/values";
import type { UserIdentity } from "convex/server";
import { mutation } from "../_generated/server";

function getIdentityOrgId(identity: UserIdentity) {
  const rawIdentity = identity as Record<string, unknown>;

  return (
    (typeof rawIdentity.organization_id === "string"
      ? rawIdentity.organization_id
      : undefined) ??
    (typeof rawIdentity.organizationId === "string"
      ? rawIdentity.organizationId
      : undefined) ??
    (typeof rawIdentity.org_id === "string" ? rawIdentity.org_id : undefined)
  );
}

export const redeemInviteAndCreateUser = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, { workosOrgId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== workosOrgId) {
      throw new Error("Not authorized");
    }

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", identityOrgId))
      .unique();

    if (!tenant) {
      throw new Error("No tenant found for this organization");
    }

    const workosUserId = identity.subject ?? identity.tokenIdentifier;
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
    }

    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      alreadyRedeemed: tenant.status !== "pending_signup",
      status: tenant.status,
    };
  },
});
