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

async function syncTenantOrgMembers(
  ctx: Parameters<typeof getValidAccessToken>[0],
  tenantId: Id<"tenants">,
) {
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
  handler: async (ctx, { tenantId }) => {
    return await syncTenantOrgMembers(ctx, tenantId);
  },
});

/**
 * Cron: sync org members for all active tenants.
 */
export const syncAllTenants = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    for (const tenantId of tenantIds) {
      try {
        const result = await syncTenantOrgMembers(ctx, tenantId);
        console.log(`Synced ${result.synced} Calendly org members for tenant ${tenantId}`);
      } catch (error) {
        console.error(`Calendly org member sync failed for tenant ${tenantId}:`, error);
      }
    }
  },
});
