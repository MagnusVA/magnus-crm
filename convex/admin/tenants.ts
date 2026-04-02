"use node";

import { NotFoundException, WorkOS } from "@workos-inc/node";
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

type CalendlyTokenRevocationStatus =
  | "revoked"
  | "not_present"
  | "already_invalid";

type CalendlyTokenCleanupResult = {
  accessToken: CalendlyTokenRevocationStatus;
  refreshToken: CalendlyTokenRevocationStatus;
};

type WorkOSCleanupResult = {
  deletedUsers: number;
  deletedOrganization: boolean;
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

function getCalendlyClientId() {
  return (
    process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID
  );
}

function getCalendlyClientSecret() {
  return process.env.CALENDLY_CLIENT_SECRET;
}

function buildPendingOrganizationExternalId(contactEmail: string) {
  return `system_admin_invite:${contactEmail}`;
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
      `Unable to refresh Calendly token before tenant deletion for ${tenantId}:`,
      error,
    );
    return null;
  }
}

async function cleanupCalendlyWebhook(
  ctx: ActionCtx,
  tenant: Doc<"tenants">,
): Promise<WebhookCleanupResult> {
  console.log("[tenant-offboarding] Calendly webhook cleanup starting", {
    tenantId: tenant._id,
    workosOrgId: tenant.workosOrgId,
    hasWebhook: Boolean(tenant.calendlyWebhookUri),
    status: tenant.status,
  });

  if (!tenant.calendlyWebhookUri) {
    console.log("[tenant-offboarding] Calendly webhook cleanup skipped", {
      tenantId: tenant._id,
      reason: "not_configured",
    });
    return { status: "not_configured" };
  }

  const accessToken = await resolveCalendlyAccessToken(ctx, tenant._id, tenant);
  if (!accessToken) {
    console.warn("[tenant-offboarding] Calendly webhook cleanup skipped", {
      tenantId: tenant._id,
      reason: "missing_access_token",
    });
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
    console.log("[tenant-offboarding] Calendly webhook cleanup finished", {
      tenantId: tenant._id,
      result: "deleted",
    });
    return { status: "deleted" };
  } catch (error) {
    console.error("[tenant-offboarding] Calendly webhook cleanup failed", {
      tenantId: tenant._id,
      message: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Calendly webhook deletion failed.",
    };
  }
}

async function revokeCalendlyToken(
  token: string | undefined,
): Promise<CalendlyTokenRevocationStatus> {
  if (!token) {
    return "not_present";
  }

  const clientId = getCalendlyClientId();
  const clientSecret = getCalendlyClientSecret();
  if (!clientId || !clientSecret) {
    throw new Error("Missing Calendly OAuth configuration");
  }

  const response = await fetch("https://auth.calendly.com/oauth/revoke", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      token,
    }).toString(),
  });

  if (response.ok) {
    return "revoked";
  }

  if (response.status === 400 || response.status === 403) {
    return "already_invalid";
  }

  throw new Error(
    `Calendly token revocation failed: ${response.status} ${await response.text()}`,
  );
}

async function cleanupCalendlyTokens(
  tenant: Doc<"tenants">,
): Promise<CalendlyTokenCleanupResult> {
  console.log("[tenant-offboarding] Calendly token cleanup starting", {
    tenantId: tenant._id,
    hasAccessToken: Boolean(tenant.calendlyAccessToken),
    hasRefreshToken: Boolean(tenant.calendlyRefreshToken),
  });

  const accessToken = await revokeCalendlyToken(tenant.calendlyAccessToken);
  const refreshToken = await revokeCalendlyToken(tenant.calendlyRefreshToken);

  console.log("[tenant-offboarding] Calendly token cleanup finished", {
    tenantId: tenant._id,
    accessToken,
    refreshToken,
  });

  return {
    accessToken,
    refreshToken,
  };
}

async function cleanupWorkOSOrganization(
  tenant: Doc<"tenants">,
): Promise<WorkOSCleanupResult> {
  console.log("[tenant-offboarding] WorkOS cleanup starting", {
    tenantId: tenant._id,
    workosOrgId: tenant.workosOrgId,
  });

  let memberships;

  try {
    memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId: tenant.workosOrgId,
      limit: 100,
    });
  } catch (error) {
    if (error instanceof NotFoundException) {
      return {
        deletedUsers: 0,
        deletedOrganization: false,
      };
    }
    throw error;
  }

  const allMemberships = await memberships.autoPagination();
  const userIds = [...new Set(allMemberships.map((membership) => membership.userId))];

  console.log("[tenant-offboarding] WorkOS memberships resolved", {
    tenantId: tenant._id,
    workosOrgId: tenant.workosOrgId,
    membershipCount: allMemberships.length,
    uniqueUserCount: userIds.length,
  });

  let deletedUsers = 0;
  for (const userId of userIds) {
    try {
      await workos.userManagement.deleteUser(userId);
      deletedUsers += 1;
      console.log("[tenant-offboarding] WorkOS user deleted", {
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        userId,
      });
    } catch (error) {
      if (error instanceof NotFoundException) {
        console.warn("[tenant-offboarding] WorkOS user already absent", {
          tenantId: tenant._id,
          workosOrgId: tenant.workosOrgId,
          userId,
        });
        continue;
      }
      console.error("[tenant-offboarding] WorkOS user deletion failed", {
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        userId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  try {
    await workos.organizations.deleteOrganization(tenant.workosOrgId);
    console.log("[tenant-offboarding] WorkOS organization deleted", {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      deletedUsers,
    });
    return {
      deletedUsers,
      deletedOrganization: true,
    };
  } catch (error) {
    if (error instanceof NotFoundException) {
      console.warn("[tenant-offboarding] WorkOS organization already absent", {
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        deletedUsers,
      });
      return {
        deletedUsers,
        deletedOrganization: false,
      };
    }
    console.error("[tenant-offboarding] WorkOS organization deletion failed", {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      deletedUsers,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
    const pendingOrganizationExternalId =
      buildPendingOrganizationExternalId(contactEmail);

    // Check if a tenant already exists for this email to avoid duplicate WorkOS orgs
    const existingTenant = await ctx.runQuery(
      internal.admin.tenantsQueries.getTenantByContactEmail,
      { contactEmail },
    );

    if (existingTenant) {
      if (existingTenant.status !== "pending_signup") {
        throw new Error("Tenant already exists for this contact email");
      }

      // Return the existing tenant's invite
      const { tokenHash, expiresAt, inviteUrl } =
        await buildInviteLinkForTenant(existingTenant);

      await ctx.runMutation(
        internal.admin.tenantsMutations.patchInviteToken,
        {
          tenantId: existingTenant._id,
          inviteTokenHash: tokenHash,
          inviteExpiresAt: expiresAt,
        },
      );

      return {
        tenantId: existingTenant._id,
        workosOrgId: existingTenant.workosOrgId,
        inviteUrl,
        expiresAt,
      };
    }

    let org;
    try {
      org = await workos.organizations.getOrganizationByExternalId(
        pendingOrganizationExternalId,
      );
    } catch (error) {
      if (!(error instanceof NotFoundException)) {
        throw error;
      }

      org = await workos.organizations.createOrganization({
        name: companyName,
        externalId: pendingOrganizationExternalId,
        metadata: {
          source: "system_admin_onboarding",
          contactEmail,
        },
      });
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
  ): Promise<{
    tenantId: Id<"tenants">;
    deletedTenant: true;
    webhookCleanup: WebhookCleanupResult;
    tokenCleanup: CalendlyTokenCleanupResult;
    workosCleanup: WorkOSCleanupResult;
    deletedRawWebhookEvents: number;
    deletedCalendlyOrgMembers: number;
    deletedUsers: number;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    console.log("[tenant-offboarding] Tenant deletion requested", {
      tenantId,
      requestedBy: identity.tokenIdentifier,
    });

    const tenant = await ctx.runQuery(
      internal.admin.tenantsQueries.getTenantInternal,
      { tenantId },
    );
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    console.log("[tenant-offboarding] Tenant loaded", {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      hasCalendlyWebhook: Boolean(tenant.calendlyWebhookUri),
      hasCalendlyAccessToken: Boolean(tenant.calendlyAccessToken),
      hasCalendlyRefreshToken: Boolean(tenant.calendlyRefreshToken),
    });

    const webhookCleanup = await cleanupCalendlyWebhook(ctx, tenant);
    if (
      webhookCleanup.status === "skipped_missing_access_token" ||
      webhookCleanup.status === "failed"
    ) {
      console.error("[tenant-offboarding] Tenant deletion aborted during webhook cleanup", {
        tenantId,
        webhookCleanup,
      });
      throw new Error(webhookCleanup.message);
    }

    const refreshedTenant = await ctx.runQuery(
      internal.admin.tenantsQueries.getTenantInternal,
      { tenantId },
    );
    if (!refreshedTenant) {
      throw new Error("Tenant not found after Calendly webhook cleanup");
    }

    console.log("[tenant-offboarding] Tenant reloaded after webhook cleanup", {
      tenantId: refreshedTenant._id,
      workosOrgId: refreshedTenant.workosOrgId,
      status: refreshedTenant.status,
    });

    const tokenCleanup = await cleanupCalendlyTokens(refreshedTenant);
    const workosCleanup = await cleanupWorkOSOrganization(refreshedTenant);

    let deletedRawWebhookEvents = 0;
    let deletedCalendlyOrgMembers = 0;
    let deletedUsers = 0;

    while (true) {
      const batch = await ctx.runMutation(
        internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
        { tenantId },
      );

      deletedRawWebhookEvents += batch.deletedRawWebhookEvents;
      deletedCalendlyOrgMembers += batch.deletedCalendlyOrgMembers;
      deletedUsers += batch.deletedUsers;

      console.log("[tenant-offboarding] Tenant data batch deleted", {
        tenantId,
        batch,
        totals: {
          deletedRawWebhookEvents,
          deletedCalendlyOrgMembers,
          deletedUsers,
        },
      });

      if (!batch.hasMore) {
        break;
      }
    }

    await ctx.runMutation(
      internal.admin.tenantsMutations.deleteTenant,
      {
        tenantId,
      },
    );

    console.log("[tenant-offboarding] Tenant deletion completed", {
      tenantId,
      deletedTenant: true,
      previousWorkosOrgId: tenant.workosOrgId,
      webhookCleanup,
      tokenCleanup,
      workosCleanup,
      deletedRawWebhookEvents,
      deletedCalendlyOrgMembers,
      deletedUsers,
    });

    return {
      tenantId,
      deletedTenant: true,
      webhookCleanup,
      tokenCleanup,
      workosCleanup,
      deletedRawWebhookEvents,
      deletedCalendlyOrgMembers,
      deletedUsers,
    };
  },
});
