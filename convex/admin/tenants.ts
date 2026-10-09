"use node";

import { NotFoundException, WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import type { ActionCtx } from "../_generated/server";
import { action, internalAction, env } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { getValidAccessToken } from "../calendly/tokens";
import { deleteWebhookSubscription } from "../calendly/webhookSetup";
import { generateInviteToken } from "../lib/inviteToken";
import { rejectRequest } from "../lib/observability/errors";
import { log, reportError } from "../lib/observability/log";
import { requireSystemAdminSession } from "../requireSystemAdmin";
import { validateCompanyName, validateEmail } from "../lib/validation";

const workos = new WorkOS(env.WORKOS_API_KEY, {
  clientId: env.WORKOS_CLIENT_ID,
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

type TenantWithConnectionState = Doc<"tenants"> & {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  webhookUri?: string;
  webhookSecret?: string;
};

function getAppUrl() {
  return env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

function getInviteSigningSecret() {
  const signingSecret = env.INVITE_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("Missing INVITE_SIGNING_SECRET");
  }

  return signingSecret;
}

function getCalendlyClientId() {
  return env.CALENDLY_CLIENT_ID;
}

function getCalendlyClientSecret() {
  return env.CALENDLY_CLIENT_SECRET;
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
  tenant: TenantWithConnectionState,
) {
  const now = Date.now();
  const hasUsableStoredToken =
    tenant.accessToken &&
    (!tenant.tokenExpiresAt || tenant.tokenExpiresAt > now + 60_000);

  if (hasUsableStoredToken) {
    return tenant.accessToken;
  }

  try {
    return await getValidAccessToken(ctx, tenantId);
  } catch (error) {
    // Swallowed: offboarding then aborts with a generic "no valid token"
    // message, so this is the only record of why the refresh failed.
    reportError("tenant.offboarding.calendly_token_refresh_failed", error, {
      severity: "warning",
      integration: "calendly",
      tenantId,
    });
    return null;
  }
}

async function cleanupCalendlyWebhook(
  ctx: ActionCtx,
  tenant: TenantWithConnectionState,
): Promise<WebhookCleanupResult> {
  if (!tenant.webhookUri) {
    log.info("tenant.offboarding.calendly_webhook", {
      tenantId: tenant._id,
      outcome: "not_configured",
    });
    return { status: "not_configured" };
  }

  const accessToken = await resolveCalendlyAccessToken(ctx, tenant._id, tenant);
  if (!accessToken) {
    log.warn("tenant.offboarding.calendly_webhook", {
      tenantId: tenant._id,
      outcome: "skipped_missing_access_token",
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
      webhookUri: tenant.webhookUri,
    });
    log.info("tenant.offboarding.calendly_webhook", {
      tenantId: tenant._id,
      outcome: "deleted",
    });
    return { status: "deleted" };
  } catch (error) {
    // The caller aborts offboarding with this message, which is reported as
    // a failed execution; the log keeps the original error and stack.
    log.error("tenant.offboarding.calendly_webhook", {
      tenantId: tenant._id,
      outcome: "failed",
      error,
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

  // The body can echo request details, so only the status is kept.
  throw new Error(`Calendly token revoke failed: HTTP ${response.status}`);
}

async function cleanupCalendlyTokens(
  tenant: TenantWithConnectionState,
): Promise<CalendlyTokenCleanupResult> {
  const accessToken = await revokeCalendlyToken(tenant.accessToken);
  const refreshToken = await revokeCalendlyToken(tenant.refreshToken);

  // Revocation statuses only, never the tokens.
  log.info("tenant.offboarding.calendly_tokens", {
    tenantId: tenant._id,
    accessTokenRevocation: accessToken,
    refreshTokenRevocation: refreshToken,
  });

  return {
    accessToken,
    refreshToken,
  };
}

async function cleanupWorkOSOrganization(
  tenant: Doc<"tenants">,
): Promise<WorkOSCleanupResult> {
  let memberships;

  try {
    memberships = await workos.userManagement.listOrganizationMemberships({
      organizationId: tenant.workosOrgId,
      limit: 100,
    });
  } catch (error) {
    if (error instanceof NotFoundException) {
      log.warn("tenant.offboarding.workos", {
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        outcome: "organization_absent",
      });
      return {
        deletedUsers: 0,
        deletedOrganization: false,
      };
    }
    throw error;
  }

  const allMemberships = await memberships.autoPagination();
  const userIds = [...new Set(allMemberships.map((membership) => membership.userId))];

  let deletedUsers = 0;
  let alreadyAbsentUsers = 0;
  for (const userId of userIds) {
    try {
      await workos.userManagement.deleteUser(userId);
      deletedUsers += 1;
    } catch (error) {
      if (error instanceof NotFoundException) {
        alreadyAbsentUsers += 1;
        continue;
      }
      // Rethrown, so the failed execution is reported on its own.
      log.error("tenant.offboarding.workos_user", {
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        workosUserId: userId,
        outcome: "failed",
        deletedUsers,
        alreadyAbsentUsers,
        errorName: error instanceof Error ? error.name : "Error",
      });
      throw error;
    }
  }

  try {
    await workos.organizations.deleteOrganization(tenant.workosOrgId);
    log.info("tenant.offboarding.workos", {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      outcome: "organization_deleted",
      deletedUsers,
      alreadyAbsentUsers,
      userCount: userIds.length,
    });
    return {
      deletedUsers,
      deletedOrganization: true,
    };
  } catch (error) {
    if (error instanceof NotFoundException) {
      log.warn("tenant.offboarding.workos", {
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        outcome: "organization_absent",
        deletedUsers,
        alreadyAbsentUsers,
        userCount: userIds.length,
      });
      return {
        deletedUsers,
        deletedOrganization: false,
      };
    }
    // Rethrown, so the failed execution is reported on its own.
    log.error("tenant.offboarding.workos", {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      outcome: "failed",
      deletedUsers,
      alreadyAbsentUsers,
      userCount: userIds.length,
      errorName: error instanceof Error ? error.name : "Error",
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

    const companyNameValidation = validateCompanyName(args.companyName);
    if (!companyNameValidation.valid) {
      throw new Error(companyNameValidation.error);
    }
    const emailValidation = validateEmail(args.contactEmail);
    if (!emailValidation.valid) {
      throw new Error(emailValidation.error);
    }

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
      if (
        existingTenant.status !== "pending_signup" &&
        existingTenant.status !== "invite_expired"
      ) {
        throw rejectRequest(
          "tenant.invite.tenant_exists",
          "Tenant already exists for this contact email",
          {
            tenantId: existingTenant._id,
            tenantStatus: existingTenant.status,
          },
        );
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

      if (existingTenant.status === "invite_expired") {
        await ctx.runMutation(internal.tenants.updateStatus, {
          tenantId: existingTenant._id,
          status: "pending_signup",
        });
      }

      log.info("tenant.invite.created", {
        tenantId: existingTenant._id,
        workosOrgId: existingTenant.workosOrgId,
        outcome: "reissued_existing_tenant",
        previousStatus: existingTenant.status,
        inviteExpiresAt: expiresAt,
      });

      return {
        tenantId: existingTenant._id,
        workosOrgId: existingTenant.workosOrgId,
        inviteUrl,
        expiresAt,
      };
    }

    let org;
    let workosOrgOutcome: "reused" | "created";
    try {
      org = await workos.organizations.getOrganizationByExternalId(
        pendingOrganizationExternalId,
      );
      workosOrgOutcome = "reused";
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
      workosOrgOutcome = "created";
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

    log.info("tenant.invite.created", {
      tenantId,
      workosOrgId: org.id,
      outcome: "new_tenant",
      workosOrg: workosOrgOutcome,
      inviteExpiresAt: expiresAt,
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

    if (
      tenant.status !== "pending_signup" &&
      tenant.status !== "invite_expired"
    ) {
      throw rejectRequest(
        "tenant.invite.invalid_status",
        "Can only regenerate invite for pending_signup or invite_expired tenants",
        { tenantId, tenantStatus: tenant.status },
      );
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

    // If the invite had expired, reset status back to pending_signup
    if (tenant.status === "invite_expired") {
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "pending_signup",
      });
    }

    log.info("tenant.invite.regenerated", {
      tenantId,
      workosOrgId: tenant.workosOrgId,
      previousStatus: tenant.status,
      inviteExpiresAt: expiresAt,
    });

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
    deletedCounts: Record<string, number>;
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

    log.info("tenant.offboarding.started", {
      tenantId: tenant._id,
      workosOrgId: tenant.workosOrgId,
      status: tenant.status,
      hasCalendlyWebhook: Boolean(tenant.webhookUri),
      hasCalendlyAccessToken: Boolean(tenant.accessToken),
      hasCalendlyRefreshToken: Boolean(tenant.refreshToken),
    });

    const webhookCleanup = await cleanupCalendlyWebhook(ctx, tenant);
    if (
      webhookCleanup.status === "skipped_missing_access_token" ||
      webhookCleanup.status === "failed"
    ) {
      throw new Error(webhookCleanup.message);
    }

    const refreshedTenant = await ctx.runQuery(
      internal.admin.tenantsQueries.getTenantInternal,
      { tenantId },
    );
    if (!refreshedTenant) {
      throw new Error("Tenant not found after Calendly webhook cleanup");
    }

    const tokenCleanup = await cleanupCalendlyTokens(refreshedTenant);
    const workosCleanup = await cleanupWorkOSOrganization(refreshedTenant);

    const deletedCounts: Record<string, number> = {};

    while (true) {
      const batch: {
        deletedCounts: Record<string, number>;
        hasMore: boolean;
      } = await ctx.runMutation(
        internal.admin.tenantsMutations.deleteTenantRuntimeDataBatch,
        { tenantId },
      );

      for (const [table, count] of Object.entries(batch.deletedCounts)) {
        deletedCounts[table] = (deletedCounts[table] ?? 0) + count;
      }

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

    log.info("tenant.offboarding.completed", {
      tenantId,
      previousWorkosOrgId: tenant.workosOrgId,
      webhookCleanup: webhookCleanup.status,
      accessTokenRevocation: tokenCleanup.accessToken,
      refreshTokenRevocation: tokenCleanup.refreshToken,
      workosDeletedUsers: workosCleanup.deletedUsers,
      workosDeletedOrganization: workosCleanup.deletedOrganization,
      deletedCounts,
    });

    return {
      tenantId,
      deletedTenant: true,
      webhookCleanup,
      tokenCleanup,
      workosCleanup,
      deletedRawWebhookEvents: deletedCounts.rawWebhookEvents ?? 0,
      deletedCalendlyOrgMembers: deletedCounts.calendlyOrgMembers ?? 0,
      deletedUsers: deletedCounts.users ?? 0,
      deletedCounts,
    };
  },
});
