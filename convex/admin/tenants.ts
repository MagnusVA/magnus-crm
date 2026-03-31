"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { generateInviteToken } from "../lib/inviteToken";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

// Internal diagnostic for Phase 1 environment validation.
export const testWorkosConnection = internalAction({
  args: {},
  handler: async () => {
    const orgs = await workos.organizations.listOrganizations({ limit: 1 });

    return {
      ok: true,
      orgCount: orgs.data.length,
    };
  },
});

export const createTenantInvite = action({
  args: {
    companyName: v.string(),
    contactEmail: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    tenantId: Id<"tenants">;
    workosOrgId: string;
    inviteUrl: string;
    expiresAt: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const companyName = args.companyName.trim();
    const contactEmail = args.contactEmail.trim().toLowerCase();
    const notes = args.notes?.trim() || undefined;

    const org = await workos.organizations.createOrganization({
      name: companyName,
      metadata: {
        source: "system_admin_onboarding",
        contactEmail,
      },
    });

    const now = Date.now();
    const signingSecret = process.env.INVITE_SIGNING_SECRET;
    if (!signingSecret) {
      throw new Error("Missing INVITE_SIGNING_SECRET");
    }

    const tenantId: Id<"tenants"> = await ctx.runMutation(
      internal.admin.tenantsMutations.insertTenant,
      {
        companyName,
        contactEmail,
        workosOrgId: org.id,
        notes,
        createdBy: identity.tokenIdentifier,
        inviteTokenHash: "pending_invite_hash",
        inviteExpiresAt: 0,
      },
    );

    const { token, tokenHash, expiresAt } = generateInviteToken(
      {
        tenantId,
        workosOrgId: org.id,
        contactEmail,
        createdAt: now,
      },
      signingSecret,
    );

    await ctx.runMutation(
      internal.admin.tenantsMutations.patchInviteToken,
      {
        tenantId,
        inviteTokenHash: tokenHash,
        inviteExpiresAt: expiresAt,
      },
    );

    await workos.organizations.updateOrganization({
      organization: org.id,
      externalId: tenantId,
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    return {
      tenantId,
      workosOrgId: org.id,
      inviteUrl: `${appUrl}/onboarding?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  },
});

export const regenerateInvite = action({
  args: { tenantId: v.id("tenants") },
  handler: async (
    ctx,
    { tenantId },
  ): Promise<{
    tenantId: Id<"tenants">;
    inviteUrl: string;
    expiresAt: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.runQuery(
      internal.admin.tenantsQueries.getTenantInternal,
      { tenantId },
    );
    if (!tenant) {
      throw new Error("Tenant not found");
    }
    if (tenant.status !== "pending_signup") {
      throw new Error("Can only regenerate invite for pending_signup tenants");
    }

    const signingSecret = process.env.INVITE_SIGNING_SECRET;
    if (!signingSecret) {
      throw new Error("Missing INVITE_SIGNING_SECRET");
    }

    const { token, tokenHash, expiresAt } = generateInviteToken(
      {
        tenantId,
        workosOrgId: tenant.workosOrgId,
        contactEmail: tenant.contactEmail,
        createdAt: Date.now(),
      },
      signingSecret,
    );

    await ctx.runMutation(
      internal.admin.tenantsMutations.patchInviteToken,
      {
        tenantId,
        inviteTokenHash: tokenHash,
        inviteExpiresAt: expiresAt,
      },
    );

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

    return {
      tenantId,
      inviteUrl: `${appUrl}/onboarding?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  },
});
