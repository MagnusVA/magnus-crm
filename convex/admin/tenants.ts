"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getValidAccessToken } from "../calendly/tokens";
import { deleteWebhookSubscription } from "../calendly/webhookSetup";
import { generateInviteToken } from "../lib/inviteToken";
import { requireSystemAdminSession } from "../requireSystemAdmin";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

type InviteLinkResult = {
  tenantId: Id<"tenants">;
  workosOrgId: string;
  inviteUrl: string;
  expiresAt: number;
};

type WebhookCleanupResult =
  | {
      status: "deleted";
    }
  | {
      status: "not_configured";
    }
  | {
      status: "skipped_missing_access_token";
      message: string;
    }
  | {
      status: "failed";
      message: string;
    };

function getAppUrl() {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

function getInviteSigningSecret() {
  const signingSecret = process.env.INVITE_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("Missing INVITE_SIGNING_SECRET");
  }

  return signingSecret;
}

function buildInviteLinkForTenant(
  tenant: Pick<Doc<"tenants">, "_id" | "contactEmail" | "workosOrgId">,
): {
  token: string;
  tokenHash: string;
  expiresAt: number;
  inviteUrl: string;
} {
  const { token, tokenHash, expiresAt } = generateInviteToken(
    {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      contactEmail: tenant.contactEmail,
      createdAt: Date.now(),
    },
    getInviteSigningSecret(),
  );

  return {
    token,
    tokenHash,
    expiresAt,
    inviteUrl: `${getAppUrl()}/onboarding?token=${encodeURIComponent(token)}`,
  };
}

async function resolveCalendlyAccessToken(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
  tenant: Doc<"tenants">,
) {
  const now = Date.now();
  const hasUsableStoredToken =
    tenant.calendlyAccessToken &&
    (!tenant.calendlyTokenExpiresAt || tenant.calendlyTokenExpiresAt > now + 60_000);

  if (hasUsableStoredToken) {
    return tenant.calendlyAccessToken;
  }

  try {
    return await getValidAccessToken(ctx, tenantId);
  } catch (error) {
    console.error(
      `Unable to refresh Calendly token before tenant reset for ${tenantId}:`,
      error,
    );
    return null;
  }
}

async function cleanupCalendlyWebhook(
  ctx: ActionCtx,
  tenant: Doc<"tenants">,
): Promise<WebhookCleanupResult> {
  if (!tenant.calendlyWebhookUri) {
    return { status: "not_configured" };
  }

  const accessToken = await resolveCalendlyAccessToken(ctx, tenant._id, tenant);
  if (!accessToken) {
    return {
      status: "skipped_missing_access_token",
      message:
        "No valid Calendly access token was available, so the remote webhook was not deleted.",
    };
  }

  try {
    await deleteWebhookSubscription({
      accessToken,
      webhookUri: tenant.calendlyWebhookUri,
    });
    return { status: "deleted" };
  } catch (error) {
    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Calendly webhook deletion failed.",
    };
  }
}

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
  handler: async (ctx, args): Promise<InviteLinkResult> => {
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

    const { tokenHash, expiresAt, inviteUrl } = await buildInviteLinkForTenant({
      _id: tenantId,
      workosOrgId: org.id,
      contactEmail,
    });

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

    return {
      tenantId,
      workosOrgId: org.id,
      inviteUrl,
      expiresAt,
    };
  },
});

export const regenerateInvite = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<InviteLinkResult> => {
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

    const { tokenHash, expiresAt, inviteUrl } = await buildInviteLinkForTenant(
      tenant,
    );

    await ctx.runMutation(
      internal.admin.tenantsMutations.patchInviteToken,
      {
        tenantId,
        inviteTokenHash: tokenHash,
        inviteExpiresAt: expiresAt,
      },
    );

    return {
      tenantId,
      workosOrgId: tenant.workosOrgId,
      inviteUrl,
      expiresAt,
    };
  },
});

export const resetTenantForReonboarding = action({
  args: { tenantId: v.id("tenants") },
  handler: async (
    ctx,
    { tenantId },
  ): Promise<
    InviteLinkResult & {
      webhookCleanup: WebhookCleanupResult;
      deletedRawWebhookEvents: number;
      deletedCalendlyOrgMembers: number;
    }
  > => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.runQuery(
      internal.admin.tenantsQueries.getTenantInternal,
      { tenantId },
    );
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const webhookCleanup = await cleanupCalendlyWebhook(ctx, tenant);

    let deletedRawWebhookEvents = 0;
    let deletedCalendlyOrgMembers = 0;

    while (true) {
      const batch = await ctx.runMutation(
        internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
        { tenantId },
      );

      deletedRawWebhookEvents += batch.deletedRawWebhookEvents;
      deletedCalendlyOrgMembers += batch.deletedCalendlyOrgMembers;

      if (!batch.hasMore) {
        break;
      }
    }

    const { tokenHash, expiresAt, inviteUrl } = await buildInviteLinkForTenant(
      tenant,
    );

    await ctx.runMutation(
      internal.admin.tenantsMutations.resetTenantForReonboarding,
      {
        tenantId,
        inviteTokenHash: tokenHash,
        inviteExpiresAt: expiresAt,
      },
    );

    return {
      tenantId,
      workosOrgId: tenant.workosOrgId,
      inviteUrl,
      expiresAt,
      webhookCleanup,
      deletedRawWebhookEvents,
      deletedCalendlyOrgMembers,
    };
  },
});
