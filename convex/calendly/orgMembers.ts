"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Sync Calendly organization members for a specific tenant.
 *
 * Fetches all members from the Calendly API and upserts them
 * into the calendlyOrgMembers table.
 */
export const syncForTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Get a valid access token (refresh if needed)
    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
      tenantId,
    });
    if (!tenant?.calendlyAccessToken || !tenant.calendlyOrgUri) {
      return { synced: 0, reason: "missing_tokens_or_org" };
    }

    // Fetch organization memberships (paginated)
    let nextPage: string | null = `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(tenant.calendlyOrgUri)}&count=100`;
    let totalSynced = 0;

    while (nextPage) {
      const response = await fetch(nextPage, {
        headers: { Authorization: `Bearer ${tenant.calendlyAccessToken}` },
      });

      if (!response.ok) {
        throw new Error(`Calendly API error: ${response.status}`);
      }

      const data = await response.json();

      for (const membership of data.collection) {
        const user = membership.user;
        await ctx.runMutation(
          internal.calendly.orgMembersMutations.upsertMember,
          {
            tenantId,
            calendlyUserUri: user.uri,
            email: user.email,
            name: user.name,
            calendlyRole: membership.role,
          },
        );
        totalSynced++;
      }

      nextPage = data.pagination?.next_page ?? null;
    }

    return { synced: totalSynced };
  },
});

/**
 * Cron: sync org members for all active tenants.
 */
export const syncAllTenants = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
    );

    for (const tenantId of tenantIds) {
      try {
        const result = await ctx.runAction(
          internal.calendly.orgMembers.syncForTenant,
          { tenantId },
        );
        console.log(`Synced ${result.synced} members for tenant ${tenantId}`);
      } catch (error) {
        console.error(`Org member sync failed for ${tenantId}:`, error);
      }
    }
  },
});

