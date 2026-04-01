"use node";

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Refresh a single tenant's Calendly access token.
 *
 * Implements:
 * 1. Mutex check (optimistic lock via calendlyRefreshLockUntil)
 * 2. Calendly POST /oauth/token with grant_type=refresh_token
 * 3. Atomic storage of new access_token + refresh_token
 * 4. Mutex release
 *
 * If the refresh fails with 400/401 (invalid_grant), marks the
 * tenant as calendly_disconnected.
 */
export const refreshTenantToken = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Step 1: Read current tokens and check mutex
    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
      tenantId,
    });
    if (!tenant) throw new Error("Tenant not found");
    if (tenant.status !== "active" && tenant.status !== "provisioning_webhooks") {
      return { refreshed: false, reason: "tenant_not_active" };
    }
    if (!tenant.calendlyRefreshToken) {
      return { refreshed: false, reason: "no_refresh_token" };
    }

    // Check mutex: if another refresh is in progress, skip
    const now = Date.now();
    if (tenant.calendlyRefreshLockUntil && tenant.calendlyRefreshLockUntil > now) {
      // Check if current access token is still valid
      if (tenant.calendlyTokenExpiresAt && tenant.calendlyTokenExpiresAt > now) {
        return { refreshed: false, reason: "lock_held_token_valid" };
      }
      // Lock held but token expired — wait and retry would be ideal,
      // but for cron simplicity, just skip this tenant this cycle
      return { refreshed: false, reason: "lock_held_token_expired" };
    }

    // Step 2: Acquire mutex (30-second lock)
    await ctx.runMutation(internal.calendly.tokenMutations.acquireRefreshLock, {
      tenantId,
      lockUntil: now + 30_000,
    });

    // Step 3: Perform the refresh
    const clientId = process.env.CALENDLY_CLIENT_ID!;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET!;

    try {
      const response = await fetch("https://auth.calendly.com/oauth/token", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tenant.calendlyRefreshToken,
        }),
      });

      if (response.status === 400 || response.status === 401) {
        // Refresh token is invalid/expired/already used
        console.error(`Tenant ${tenantId}: refresh token invalid (${response.status})`);
        await ctx.runMutation(internal.tenants.updateStatus, {
          tenantId,
          status: "calendly_disconnected",
        });
        await ctx.runMutation(internal.calendly.tokenMutations.releaseRefreshLock, {
          tenantId,
        });
        return { refreshed: false, reason: "token_revoked" };
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Tenant ${tenantId}: refresh failed (${response.status}): ${errorText}`);
        await ctx.runMutation(internal.calendly.tokenMutations.releaseRefreshLock, {
          tenantId,
        });
        return { refreshed: false, reason: "api_error" };
      }

      const tokens = await response.json();

      // Step 4: Atomic storage of new tokens + release lock
      await ctx.runMutation(internal.tenants.storeCalendlyTokens, {
        tenantId,
        calendlyAccessToken: tokens.access_token,
        calendlyRefreshToken: tokens.refresh_token,
        calendlyTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
        calendlyRefreshLockUntil: undefined, // Release lock
      });

      return { refreshed: true };
    } catch (error) {
      // Network error or unexpected failure — release lock
      await ctx.runMutation(internal.calendly.tokenMutations.releaseRefreshLock, {
        tenantId,
      });
      throw error;
    }
  },
});

/**
 * Cron job: refresh tokens for all active tenants.
 */
export const refreshAllTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
    );

    for (const tenantId of tenants) {
      try {
        const result = await ctx.runAction(
          internal.calendly.tokens.refreshTenantToken,
          { tenantId },
        );
        if (result.refreshed) {
          console.log(`Refreshed token for tenant ${tenantId}`);
        } else {
          console.log(`Skipped tenant ${tenantId}: ${result.reason}`);
        }
      } catch (error) {
        console.error(`Failed to refresh tenant ${tenantId}:`, error);
      }
    }
  },
});
