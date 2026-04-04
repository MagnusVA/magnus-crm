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
  console.log(`[org-sync] syncTenantOrgMembers: entry for tenant ${tenantId}`);

  const tenant = (await ctx.runQuery(internal.tenants.getCalendlyTokens, {
    tenantId,
  })) as TenantMemberState | null;

  if (!tenant?.calendlyOrgUri) {
    console.warn(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} missing org URI`);
    return { synced: 0, reason: "missing_org_uri" as const };
  }

  if (tenant.status !== "active" && tenant.status !== "provisioning_webhooks") {
    console.warn(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} not ready, status=${tenant.status}`);
    return { synced: 0, reason: "tenant_not_ready" as const };
  }

  console.log(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} obtaining access token`);
  const accessToken = await getValidAccessToken(ctx, tenantId);
  if (!accessToken) {
    console.warn(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} no valid access token`);
    return { synced: 0, reason: "missing_access_token" as const };
  }

  let nextPage: string | null = `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(tenant.calendlyOrgUri)}&count=100`;
  let synced = 0;
  let pageNum = 0;

  while (nextPage) {
    pageNum++;
    console.log(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} fetching page ${pageNum}`);

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
    const pageSize = data.collection?.length ?? 0;
    console.log(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} page ${pageNum} has ${pageSize} members`);

    for (const membership of data.collection ?? []) {
      const calendlyUserUri = membership.user?.uri;
      const email = membership.user?.email;
      if (!calendlyUserUri || !email) {
        console.warn(
          `[org-sync] syncTenantOrgMembers: skipping malformed membership for tenant ${tenantId}, hasUri=${Boolean(calendlyUserUri)}, hasEmail=${Boolean(email)}`,
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

  console.log(`[org-sync] syncTenantOrgMembers: tenant ${tenantId} complete, synced=${synced} members across ${pageNum} pages`);
  return { synced };
}

/**
 * Fetch all Calendly organization members for a tenant and upsert them.
 */
export const syncForTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }): Promise<SyncForTenantResult> => {
    console.log(`[org-sync] syncForTenant: entry for tenant ${tenantId}`);
    const syncStartTimestamp = Date.now();

    const result = await syncTenantOrgMembers(ctx, tenantId);

    if ("reason" in result) {
      console.log(
        `[org-sync] syncForTenant: skipped for tenant ${tenantId}, reason=${result.reason}`,
      );
      return { ...result, deleted: 0 };
    }

    // Clean up stale members not seen in the latest sync
    const cleanupResult: { deleted: number } = await ctx.runMutation(
      internal.calendly.orgMembersMutations.deleteStaleMembers,
      { tenantId, syncStartTimestamp },
    );

    console.log(
      `[org-sync] syncForTenant: tenant ${tenantId} complete, synced=${result.synced}, deleted=${cleanupResult.deleted} stale records`,
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
    console.log(`[org-sync] syncAllTenants: entry`);

    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    console.log(
      `[org-sync] syncAllTenants: scheduling sync for ${tenantIds.length} tenants`,
    );

    // Fan out: each tenant gets its own action invocation
    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.orgMembers.syncForTenant,
        { tenantId },
      );
    }

    console.log(`[org-sync] syncAllTenants: all ${tenantIds.length} tenants scheduled`);
    // The cron completes immediately after scheduling.
    // Individual sync actions run asynchronously and independently.
    // Failures in one tenant do not affect others.
  },
});
