"use node";

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { getValidAccessToken } from "./tokens";

type TenantMemberState = {
  calendlyOrgUri?: string;
  status: string;
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

async function syncTenantOrgMembers(
  ctx: Parameters<typeof getValidAccessToken>[0],
  tenantId: Id<"tenants">,
): Promise<SyncTenantOrgMembersResult> {
  const tenant = (await ctx.runQuery(internal.tenants.getCalendlyTokens, {
    tenantId,
  })) as TenantMemberState | null;

  if (!tenant?.calendlyOrgUri) {
    return { synced: 0, reason: "missing_org_uri" as const };
  }

  if (tenant.status !== "active" && tenant.status !== "provisioning_webhooks") {
    return { synced: 0, reason: "tenant_not_ready" as const };
  }

  const accessToken = await getValidAccessToken(ctx, tenantId);
  if (!accessToken) {
    return { synced: 0, reason: "missing_access_token" as const };
  }

  let nextPage: string | null = `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(tenant.calendlyOrgUri)}&count=100`;
  let synced = 0;

  while (nextPage) {
    const response = await fetch(nextPage, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to sync Calendly organization members: ${response.status} ${await response.text()}`,
      );
    }

    const data = (await response.json()) as CalendlyOrganizationMembershipPage;
    for (const membership of data.collection ?? []) {
      const calendlyUserUri = membership.user?.uri;
      const email = membership.user?.email;
      if (!calendlyUserUri || !email) {
        console.warn(
          `Skipping malformed Calendly organization membership for tenant ${tenantId}`,
        );
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
      console.log(
        `Skipped Calendly org member sync for tenant ${tenantId}: ${result.reason}`,
      );
      return { ...result, deleted: 0 };
    }

    // Clean up stale members not seen in the latest sync
    const cleanupResult: { deleted: number } = await ctx.runMutation(
      internal.calendly.orgMembersMutations.deleteStaleMembers,
      { tenantId, syncStartTimestamp },
    );

    console.log(
      `Synced ${result.synced} members for tenant ${tenantId}, ` +
      `cleaned up ${cleanupResult.deleted} stale records`,
    );

    return { ...result, deleted: cleanupResult.deleted };
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

    console.log(
      `[org-sync] Scheduling sync for ${tenantIds.length} tenants`,
    );

    // Fan out: each tenant gets its own action invocation
    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.orgMembers.syncForTenant,
        { tenantId },
      );
    }

    // The cron completes immediately after scheduling.
    // Individual sync actions run asynchronously and independently.
    // Failures in one tenant do not affect others.
  },
});
