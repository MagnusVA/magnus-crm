# Phase 5 — Token Lifecycle, Cron Jobs & Calendly Org Member Sync

**Goal:** Ensure the Calendly integration stays alive indefinitely without user intervention. This phase builds the proactive token refresh system, the concurrency mutex, health checks, and the initial Calendly org member sync for round-robin preparation.

**Prerequisite:** Phase 4 complete (tenant is `active`, tokens stored, webhook subscription live).

**Acceptance Criteria:**
1. The `refreshCalendlyTokens` cron runs every 90 minutes and successfully refreshes tokens for all active tenants.
2. After a refresh, the tenant record has a new `calendlyAccessToken`, a new `calendlyRefreshToken`, and an updated `calendlyTokenExpiresAt`.
3. Two concurrent refresh attempts for the same tenant do not both consume the refresh token — the mutex prevents it.
4. The `healthCheck` cron runs daily and:
   - Introspects each tenant's access token.
   - If a token is inactive, triggers a refresh.
   - If the refresh also fails, sets tenant `status: "calendly_disconnected"`.
   - Checks each tenant's webhook subscription state; if `disabled`, recreates it.
5. After onboarding completes, the `calendlyOrgMembers` table is populated with the tenant's Calendly org members.
6. A daily cron re-syncs org members to pick up changes.
7. All cron jobs are registered in `convex/crons.ts` and visible in the Convex dashboard.

---

## Subphases

### 5A — Token Refresh Logic (`convex/calendly/tokens.ts`)

**Type:** Backend
**Parallelizable:** Yes — core logic, no frontend dependency.

**What:** The `getValidAccessToken` helper and the `refreshCalendlyToken` function that implements single-use refresh token rotation with atomic storage.

**Where:** `convex/calendly/tokens.ts`

**How:**

This file needs `"use node"` for the `fetch` call to Calendly's token endpoint (although `fetch` is available in the default runtime, we use `"use node"` because this file will also house the mutex logic that's cleaner with Node.js patterns).

> **Convex guideline reminder:** Since this file uses `"use node"`, it can only export actions, not queries or mutations. Token storage mutations are in `convex/tenants.ts` (Phase 2A).

```typescript
// convex/calendly/tokens.ts
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
    await ctx.runMutation(internal.calendly.tokensMutations.acquireRefreshLock, {
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
        await ctx.runMutation(internal.calendly.tokensMutations.releaseRefreshLock, {
          tenantId,
        });
        return { refreshed: false, reason: "token_revoked" };
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Tenant ${tenantId}: refresh failed (${response.status}): ${errorText}`);
        await ctx.runMutation(internal.calendly.tokensMutations.releaseRefreshLock, {
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
      await ctx.runMutation(internal.calendly.tokensMutations.releaseRefreshLock, {
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
      internal.calendly.tokensMutations.listActiveTenantIds,
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
```

**Companion mutations/queries:**

```typescript
// convex/calendly/tokensMutations.ts
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const acquireRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: lockUntil });
  },
});

export const releaseRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await ctx.db.patch(tenantId, { calendlyRefreshLockUntil: undefined });
  },
});

export const listActiveTenantIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .take(500);
    return tenants.map((t) => t._id);
  },
});
```

**Files touched:** `convex/calendly/tokens.ts`, `convex/calendly/tokensMutations.ts` (create)

---

### 5B — Health Check Cron (`convex/calendly/healthCheck.ts`)

**Type:** Backend
**Parallelizable:** Yes — independent of 5A.

**What:** A daily cron action that introspects each active tenant's token, checks webhook subscription state, and triggers corrective actions.

**Where:** `convex/calendly/healthCheck.ts`

**How:**

```typescript
// convex/calendly/healthCheck.ts
"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const runHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds = await ctx.runQuery(
      internal.calendly.tokensMutations.listActiveTenantIds,
    );

    for (const tenantId of tenantIds) {
      try {
        const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
          tenantId,
        });
        if (!tenant?.calendlyAccessToken) continue;

        // 1. Introspect access token
        const clientId = process.env.CALENDLY_CLIENT_ID!;
        const clientSecret = process.env.CALENDLY_CLIENT_SECRET!;

        const introspectRes = await fetch("https://auth.calendly.com/oauth/introspect", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token: tenant.calendlyAccessToken,
          }),
        });

        if (introspectRes.ok) {
          const data = await introspectRes.json();
          if (!data.active) {
            console.log(`Tenant ${tenantId}: token inactive, triggering refresh`);
            await ctx.runAction(internal.calendly.tokens.refreshTenantToken, {
              tenantId,
            });
          }
        }

        // 2. Check webhook subscription state
        // Fetch the full tenant record to get webhookUri
        // (getCalendlyTokens doesn't return it — add to the query or
        //  create a separate query)
        // GET /webhook_subscriptions/{uuid} → check state
        // If disabled, delete and recreate via provisionWebhooks

      } catch (error) {
        console.error(`Health check failed for tenant ${tenantId}:`, error);
      }
    }
  },
});
```

**Note:** The webhook state check requires fetching the tenant's full record (including `calendlyWebhookUri`) and calling `GET /webhook_subscriptions/{uuid}`. If `state: "disabled"`, delete the old one and call `provisionWebhooks` from Phase 4C. This is omitted here for brevity but must be implemented.

**Files touched:** `convex/calendly/healthCheck.ts`

---

### 5C — Calendly Org Member Sync (`convex/calendly/orgMembers.ts`)

**Type:** Backend
**Parallelizable:** Yes — independent of 5A and 5B.

**What:** Fetch all Calendly organization members for a tenant and store them in the `calendlyOrgMembers` table, attempting automatic email matching with existing CRM users.

**Where:** `convex/calendly/orgMembers.ts`

**How:**

```typescript
// convex/calendly/orgMembers.ts
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
    let nextPage: string | null =
      `https://api.calendly.com/organization_memberships?organization=${encodeURIComponent(tenant.calendlyOrgUri)}&count=100`;
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
      internal.calendly.tokensMutations.listActiveTenantIds,
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
```

**Companion mutations:**

```typescript
// convex/calendly/orgMembersMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const upsertMember = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyUserUri: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    calendlyRole: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if this member already exists
    const existing = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", args.tenantId).eq("calendlyUserUri", args.calendlyUserUri),
      )
      .unique();

    // Attempt email match with CRM users
    const matchedUser = await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_email", (q) =>
        q.eq("tenantId", args.tenantId).eq("email", args.email),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        email: args.email,
        name: args.name,
        calendlyRole: args.calendlyRole,
        matchedUserId: matchedUser?._id ?? existing.matchedUserId,
        lastSyncedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("calendlyOrgMembers", {
        tenantId: args.tenantId,
        calendlyUserUri: args.calendlyUserUri,
        email: args.email,
        name: args.name,
        calendlyRole: args.calendlyRole,
        matchedUserId: matchedUser?._id,
        lastSyncedAt: Date.now(),
      });
    }
  },
});
```

**Files touched:** `convex/calendly/orgMembers.ts`, `convex/calendly/orgMembersMutations.ts` (create)

---

### 5D — Register Cron Jobs (`convex/crons.ts`)

**Type:** Backend
**Parallelizable:** Depends on 5A, 5B, 5C being complete (references their functions).

**What:** Create the `convex/crons.ts` file registering all scheduled jobs.

**Where:** `convex/crons.ts`

**How:**

```typescript
// convex/crons.ts
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Proactively refresh Calendly tokens every 90 minutes
crons.interval(
  "refresh-calendly-tokens",
  { minutes: 90 },
  internal.calendly.tokens.refreshAllTokens,
  {},
);

// Daily health check: token introspection + webhook state
crons.interval(
  "calendly-health-check",
  { hours: 24 },
  internal.calendly.healthCheck.runHealthCheck,
  {},
);

// Daily org member sync
crons.interval(
  "sync-calendly-org-members",
  { hours: 24 },
  internal.calendly.orgMembers.syncAllTenants,
  {},
);

export default crons;
```

**Convex cron guideline:** Both `crons.interval` and `crons.cron` take a `FunctionReference` (from `internal.*`), NOT the function itself. The `{}` at the end is the args object (empty for these crons).

**Files touched:** `convex/crons.ts` (create)

---

### 5E — Trigger Org Member Sync After Onboarding

**Type:** Backend
**Parallelizable:** Yes — small change to existing flow.

**What:** After webhook provisioning completes in Phase 4 (`exchangeCodeAndProvision`), schedule an immediate org member sync.

**Where:** `convex/calendly/oauth.ts` (Phase 4A) — add one line after `provisionWebhooks`:

```typescript
// After webhook provisioning succeeds:
ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, { tenantId });
```

**Why:** Using `ctx.scheduler.runAfter(0, ...)` instead of `ctx.runAction` because the org member sync is not blocking — the onboarding can complete before it finishes.

**Files touched:** `convex/calendly/oauth.ts` (modify — add scheduler call)

---

## Parallelization Summary

```
5A (token refresh) ─────────────────────┐
5B (health check) ──────────────────────┤
5C (org member sync) ───────────────────┤
                                        ├── 5D (register crons)
5E (trigger sync after onboarding) ─────┘
```

5A, 5B, 5C can all be built simultaneously. 5D needs all three to be importable. 5E is a one-line addition.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/tokens.ts` | Implemented | 5A |
| `convex/calendly/tokensMutations.ts` | Created | 5A |
| `convex/calendly/healthCheck.ts` | Implemented | 5B |
| `convex/calendly/orgMembers.ts` | Implemented | 5C |
| `convex/calendly/orgMembersMutations.ts` | Created | 5C |
| `convex/crons.ts` | Created | 5D |
| `convex/calendly/oauth.ts` | Modified (add scheduler) | 5E |
