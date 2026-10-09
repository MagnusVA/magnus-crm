"use node";

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { rejectRequest } from "../lib/observability/errors";
import { log, logRequestContext } from "../lib/observability/log";
import { ADMIN_ROLES } from "../lib/roleMapping";
import { getRawWorkosUserId } from "../lib/workosUserId";
import { requireIdentity } from "../requireIdentity";
import { CALENDLY_FETCH_TIMEOUT_MS, calendlyHttpError } from "./apiErrors";
import { getValidAccessToken } from "./tokens";

type TenantMemberState = {
  organizationUri?: string;
  tenantStatus: string;
};

type CalendlyOrganizationMembership = {
  uri?: string;
  role?: string;
  user?: {
    uri?: string;
    email?: string;
    name?: string;
  };
};

type CalendlyOrganizationMembershipPage = {
  collection?: CalendlyOrganizationMembership[];
  pagination?: {
    next_page?: string | null;
  };
};

type SyncTenantOrgMembersResult =
  | { synced: number }
  | {
      synced: number;
      reason: "missing_org_uri" | "tenant_not_ready" | "missing_access_token";
    };

type SyncForTenantResult = SyncTenantOrgMembersResult & { deleted: number };

function logOrgMemberSync(
  tenantId: Id<"tenants">,
  trigger: "scheduled" | "manual",
  startedAt: number,
  result: SyncTenantOrgMembersResult,
  deleted: number,
) {
  const attrs = {
    tenantId,
    trigger,
    outcome: "reason" in result ? result.reason : "synced",
    synced: result.synced,
    deleted,
    durationMs: Date.now() - startedAt,
  };
  if ("reason" in result) {
    log.warn("calendly.org_members.sync", attrs);
  } else {
    log.info("calendly.org_members.sync", attrs);
  }
}

async function syncTenantOrgMembers(
  ctx: Parameters<typeof getValidAccessToken>[0],
  tenantId: Id<"tenants">,
): Promise<SyncTenantOrgMembersResult> {
  const tenant = (await ctx.runQuery(
    internal.calendly.connectionQueries.getTenantConnectionContext,
    {
      tenantId,
    },
  )) as TenantMemberState | null;

  if (!tenant?.organizationUri) {
    return { synced: 0, reason: "missing_org_uri" as const };
  }

  if (
    tenant.tenantStatus !== "active" &&
    tenant.tenantStatus !== "provisioning_webhooks"
  ) {
    return { synced: 0, reason: "tenant_not_ready" as const };
  }

  const accessToken = await getValidAccessToken(ctx, tenantId);
  if (!accessToken) {
    return { synced: 0, reason: "missing_access_token" as const };
  }

  let nextPage: string | null = `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(tenant.organizationUri)}&count=100`;
  let synced = 0;
  let pageNum = 0;
  let skippedMalformed = 0;

  while (nextPage) {
    pageNum++;

    const response = await fetch(nextPage, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw await calendlyHttpError("organization memberships", response);
    }

    const data = (await response.json()) as CalendlyOrganizationMembershipPage;

    for (const membership of data.collection ?? []) {
      const calendlyUserUri = membership.user?.uri;
      const email = membership.user?.email;
      if (!calendlyUserUri || !email) {
        skippedMalformed += 1;
        continue;
      }

      await ctx.runMutation(internal.calendly.orgMembersMutations.upsertMember, {
        tenantId,
        calendlyUserUri,
        email,
        name: membership.user?.name,
        calendlyRole: membership.role,
      });
      synced += 1;
    }

    nextPage = data.pagination?.next_page ?? null;
  }

  if (skippedMalformed > 0) {
    log.warn("calendly.org_members.malformed_skipped", {
      tenantId,
      skippedMalformed,
      pages: pageNum,
    });
  }
  return { synced };
}

/**
 * Fetch all Calendly organization members for a tenant and upsert them.
 */
export const syncForTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<SyncForTenantResult> => {
    const syncStartTimestamp = Date.now();

    const result = await syncTenantOrgMembers(ctx, tenantId);

    if ("reason" in result) {
      logOrgMemberSync(tenantId, "scheduled", syncStartTimestamp, result, 0);
      return { ...result, deleted: 0 };
    }

    // Clean up stale members not seen in the latest sync
    const cleanupResult: { deleted: number } = await ctx.runMutation(
      internal.calendly.orgMembersMutations.deleteStaleMembers,
      { tenantId, syncStartTimestamp },
    );

    logOrgMemberSync(
      tenantId,
      // Scheduled by the daily cron fan-out or after OAuth connect.
      "scheduled",
      syncStartTimestamp,
      result,
      cleanupResult.deleted,
    );

    return { ...result, deleted: cleanupResult.deleted };
  },
});

/**
 * On-demand org member sync for the current user's tenant.
 * Callable by tenant_master and tenant_admin from the Settings page.
 */
export const syncMyTenantMembers = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ synced: number; deleted: number; reason?: string }> => {
    const identity = await requireIdentity(ctx);

    const workosUserId = identity.tokenIdentifier ?? identity.subject;
    if (!workosUserId) {
      throw rejectRequest("auth.missing_workos_user_id", "Missing WorkOS user ID");
    }

    const currentUser: Doc<"users"> | null = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    if (currentUser) {
      logRequestContext({
        distinctId: getRawWorkosUserId(workosUserId),
        tenantId: currentUser.tenantId,
        userId: currentUser._id,
        role: currentUser.role,
      });
    }
    if (!currentUser || !ADMIN_ROLES.includes(currentUser.role)) {
      throw rejectRequest("auth.insufficient_permissions", "Insufficient permissions", {
        userFound: currentUser !== null,
        role: currentUser?.role,
      });
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: currentUser.tenantId,
    });
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw rejectRequest("auth.organization_mismatch", "Organization mismatch", {
        tenantId: currentUser.tenantId,
        hasIdentityOrgId: Boolean(identityOrgId),
      });
    }

    const syncStartTimestamp = Date.now();
    const result = await syncTenantOrgMembers(ctx, currentUser.tenantId);

    if ("reason" in result) {
      logOrgMemberSync(
        currentUser.tenantId,
        "manual",
        syncStartTimestamp,
        result,
        0,
      );
      return { synced: 0, deleted: 0, reason: result.reason };
    }

    const cleanupResult: { deleted: number } = await ctx.runMutation(
      internal.calendly.orgMembersMutations.deleteStaleMembers,
      { tenantId: currentUser.tenantId, syncStartTimestamp },
    );

    logOrgMemberSync(
      currentUser.tenantId,
      "manual",
      syncStartTimestamp,
      result,
      cleanupResult.deleted,
    );

    return { synced: result.synced, deleted: cleanupResult.deleted };
  },
});

/**
 * Cron: fan out org member sync for all active tenants.
 * Each tenant is processed as an independent action invocation,
 * allowing Convex to parallelize them.
 */
export const syncAllTenants = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    // Fan out: each tenant gets its own action invocation
    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.orgMembers.syncForTenant,
        { tenantId },
      );
    }

    log.info("calendly.org_members.sync_scheduled", {
      tenantCount: tenantIds.length,
    });
    // The cron completes immediately after scheduling.
    // Individual sync actions run asynchronously and independently.
    // Failures in one tenant do not affect others.
  },
});
