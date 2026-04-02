# Phase 9 — Data Lifecycle & Retention Management

**Goal:** Establish cleanup mechanisms for all accumulating data — stale org members, processed webhook events, expired invite tokens, and orphaned PKCE verifiers — and add explicit tracking fields that eliminate calculated approximations. This phase ensures data quality does not degrade over time and the system self-heals.

**Prerequisite:** Phase 8 complete (shared modules and validation in place). Phase 7 PKCE fix (8B.3 clears verifier on error) is merged.

**Acceptance Criteria:**
1. After each org member sync, `calendlyOrgMembers` records not seen in the latest Calendly API response are deleted. The `lastSyncedAt` timestamp correctly identifies orphans.
2. A daily cron deletes `rawWebhookEvents` older than 30 days (configurable), keeping the table bounded.
3. A daily cron identifies tenants with `status: "pending_signup"` and `inviteExpiresAt` older than 14 days, and marks them as `invite_expired` (or deletes the invite hash).
4. Every token refresh writes an explicit `lastTokenRefreshAt` timestamp to the tenant record. The admin dashboard reads this field directly instead of calculating from expiry.
5. A timeout mechanism auto-reverts tenants stuck in `provisioning_webhooks` for more than 10 minutes back to `pending_calendly`.

---

## Backend Subphases

### 9B.1 — Clean Stale `calendlyOrgMembers` During Sync

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Finding 5.4 from completeness report

**What:** The `syncForTenant` action creates and updates records but never deletes members removed from the Calendly organization. Over time, departed Calendly members accumulate and can cause incorrect round-robin matching.

**Where:**
- `convex/calendly/orgMembers.ts` (modify — add cleanup logic after sync)
- `convex/calendly/orgMembersMutations.ts` (modify — add `deleteStaleMembers` mutation)

**How:**

The strategy: record a "sync generation" timestamp before fetching. After upserting all members from the API, delete any records for this tenant where `lastSyncedAt < syncStartTimestamp`.

Add the cleanup mutation:

```typescript
// convex/calendly/orgMembersMutations.ts

export const deleteStaleMembers = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartTimestamp: v.number(),
  },
  handler: async (ctx, { tenantId, syncStartTimestamp }) => {
    let deleted = 0;
    let hasMore = true;

    while (hasMore) {
      const staleMembers = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId),
        )
        .filter((q) => q.lt(q.field("lastSyncedAt"), syncStartTimestamp))
        .take(128);

      for (const member of staleMembers) {
        await ctx.db.delete(member._id);
        deleted++;
      }

      hasMore = staleMembers.length === 128;
    }

    return { deleted };
  },
});
```

Update the sync action to call cleanup after fetching:

```typescript
// convex/calendly/orgMembers.ts — inside syncForTenant handler

export const syncForTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const syncStartTimestamp = Date.now();

    // ... existing fetch + upsert logic (each upsert sets lastSyncedAt = Date.now()) ...

    // After all pages are processed, delete stale members
    const cleanupResult = await ctx.runMutation(
      internal.calendly.orgMembersMutations.deleteStaleMembers,
      { tenantId, syncStartTimestamp },
    );

    console.log(
      `Synced ${totalSynced} members for tenant ${tenantId}, ` +
      `cleaned up ${cleanupResult.deleted} stale records`,
    );

    return { synced: totalSynced, deleted: cleanupResult.deleted };
  },
});
```

> **Important:** The `syncStartTimestamp` is captured **before** any API calls. All upserted records get a `lastSyncedAt >= syncStartTimestamp`. Any record with `lastSyncedAt < syncStartTimestamp` was NOT in the latest API response and is stale.

**Verification:**
- Add 3 org members in Calendly, run sync → 3 records in table.
- Remove 1 member in Calendly, run sync → 2 records remain; 1 deleted.
- Verify no orphan records exist: `db.query("calendlyOrgMembers").collect()` matches Calendly API exactly.

**Files touched:**
- `convex/calendly/orgMembers.ts` (modify — add cleanup call)
- `convex/calendly/orgMembersMutations.ts` (modify — add `deleteStaleMembers`)

---

### 9B.2 — Add `rawWebhookEvents` TTL Cleanup Cron

**Type:** Backend
**Parallelizable:** Yes — independent of 9B.1.
**Finding:** Data Lifecycle Gaps — "Stale rawWebhookEvents: processed events accumulate"

**What:** Processed webhook events accumulate indefinitely. Add a daily cron that deletes events older than a configurable retention window (default 30 days). Unprocessed events are never deleted regardless of age (they may need investigation).

**Where:**
- `convex/webhooks/cleanup.ts` (create)
- `convex/webhooks/cleanupMutations.ts` (create)
- `convex/crons.ts` (modify — register new cron)

**How:**

```typescript
// convex/webhooks/cleanupMutations.ts
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/** Default retention: 30 days in milliseconds. */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete a batch of processed webhook events older than the retention window.
 * Returns { deleted, hasMore } to support batched iteration.
 */
export const deleteExpiredEvents = internalMutation({
  args: {
    cutoffTimestamp: v.number(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, { cutoffTimestamp, batchSize }) => {
    const limit = batchSize ?? 128;

    const expired = await ctx.db
      .query("rawWebhookEvents")
      .filter((q) =>
        q.and(
          q.eq(q.field("processed"), true),
          q.lt(q.field("receivedAt"), cutoffTimestamp),
        ),
      )
      .take(limit);

    for (const event of expired) {
      await ctx.db.delete(event._id);
    }

    return { deleted: expired.length, hasMore: expired.length === limit };
  },
});

/**
 * Count unprocessed events older than retention (for alerting, not deletion).
 */
export const countStaleUnprocessed = internalQuery({
  args: { cutoffTimestamp: v.number() },
  handler: async (ctx, { cutoffTimestamp }) => {
    const stale = await ctx.db
      .query("rawWebhookEvents")
      .filter((q) =>
        q.and(
          q.eq(q.field("processed"), false),
          q.lt(q.field("receivedAt"), cutoffTimestamp),
        ),
      )
      .take(100);
    return { count: stale.length, capped: stale.length === 100 };
  },
});
```

```typescript
// convex/webhooks/cleanup.ts
"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const cleanupExpiredEvents = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    let totalDeleted = 0;
    let hasMore = true;

    while (hasMore) {
      const result = await ctx.runMutation(
        internal.webhooks.cleanupMutations.deleteExpiredEvents,
        { cutoffTimestamp: cutoff },
      );
      totalDeleted += result.deleted;
      hasMore = result.hasMore;
    }

    // Alert on stale unprocessed events (never auto-delete these)
    const stale = await ctx.runQuery(
      internal.webhooks.cleanupMutations.countStaleUnprocessed,
      { cutoffTimestamp: cutoff },
    );
    if (stale.count > 0) {
      console.warn(
        `[webhook-cleanup] ${stale.count}${stale.capped ? "+" : ""} ` +
        `unprocessed events older than 30 days — investigate.`,
      );
    }

    console.log(`[webhook-cleanup] Deleted ${totalDeleted} expired events.`);
  },
});
```

Register the cron:

```typescript
// convex/crons.ts — add:

crons.interval(
  "cleanup-expired-webhook-events",
  { hours: 24 },
  internal.webhooks.cleanup.cleanupExpiredEvents,
  {},
);
```

> **Convex guideline note:** The mutation uses `ctx.db.delete` in a batch loop (max 128 per mutation call), staying well within Convex mutation limits. The action loops until `hasMore: false`, matching the pattern used in `resetTenantForReonboarding`.

**Verification:**
- Insert test webhook events with `receivedAt` set to 31 days ago, `processed: true`.
- Run `cleanupExpiredEvents` → records deleted.
- Insert events with `receivedAt` 31 days ago, `processed: false` → NOT deleted; warning logged.
- Insert events with `receivedAt` 1 day ago, `processed: true` → NOT deleted (within retention).

**Files touched:**
- `convex/webhooks/cleanup.ts` (create)
- `convex/webhooks/cleanupMutations.ts` (create)
- `convex/crons.ts` (modify — add cron)

---

### 9B.3 — Add Expired Invite Token Cleanup Cron

**Type:** Backend
**Parallelizable:** Yes — independent of 9B.1 and 9B.2.
**Finding:** Data Lifecycle Gaps — "Expired invite tokens: tenant records with pending_signup accumulate"

**What:** Tenants with `status: "pending_signup"` and expired invite tokens linger indefinitely. Add a daily cron that identifies these and either clears the invite hash (allowing admin to regenerate) or marks them as `invite_expired`.

**Where:**
- `convex/admin/inviteCleanup.ts` (create — `"use node"` action)
- `convex/admin/inviteCleanupMutations.ts` (create — mutation for status update)
- `convex/crons.ts` (modify — register cron)
- `convex/schema.ts` (modify — add `invite_expired` to status union if not present)

**How:**

First, check if the schema status union needs updating:

```typescript
// convex/schema.ts — tenants table status field
// Current:
status: v.union(
  v.literal("pending_signup"),
  v.literal("pending_calendly"),
  v.literal("provisioning_webhooks"),
  v.literal("active"),
  v.literal("calendly_disconnected"),
  v.literal("suspended"),
),

// Add:
  v.literal("invite_expired"),
```

Create the cleanup mutation:

```typescript
// convex/admin/inviteCleanupMutations.ts
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Grace period after invite expiry before marking as expired.
 * Gives admins time to notice and regenerate.
 */
const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const listExpiredInvites = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - GRACE_PERIOD_MS;

    const expired = await ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "pending_signup"))
      .filter((q) =>
        q.and(
          q.neq(q.field("inviteExpiresAt"), undefined),
          q.lt(q.field("inviteExpiresAt"), cutoff),
        ),
      )
      .take(500);

    return expired.map((t) => ({
      tenantId: t._id,
      companyName: t.companyName,
      inviteExpiresAt: t.inviteExpiresAt,
    }));
  },
});

export const markInviteExpired = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant || tenant.status !== "pending_signup") return;

    await ctx.db.patch(tenantId, {
      status: "invite_expired",
      inviteTokenHash: undefined, // Clear the expired hash
    });
  },
});
```

Create the cron action:

```typescript
// convex/admin/inviteCleanup.ts
"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

export const cleanupExpiredInvites = internalAction({
  args: {},
  handler: async (ctx) => {
    const expired = await ctx.runQuery(
      internal.admin.inviteCleanupMutations.listExpiredInvites,
    );

    for (const { tenantId, companyName } of expired) {
      await ctx.runMutation(
        internal.admin.inviteCleanupMutations.markInviteExpired,
        { tenantId },
      );
      console.log(
        `[invite-cleanup] Marked invite expired for "${companyName}" (${tenantId})`,
      );
    }

    if (expired.length > 0) {
      console.log(
        `[invite-cleanup] Processed ${expired.length} expired invites.`,
      );
    }
  },
});
```

Register the cron:

```typescript
// convex/crons.ts — add:

crons.interval(
  "cleanup-expired-invites",
  { hours: 24 },
  internal.admin.inviteCleanup.cleanupExpiredInvites,
  {},
);
```

**Verification:**
- Create a tenant invite → set `inviteExpiresAt` to 15 days ago manually in dashboard.
- Run `cleanupExpiredInvites` → tenant status changes to `invite_expired`.
- Tenant is no longer included in `pending_signup` queries.
- Admin can still see the tenant and regenerate the invite (which re-sets status to `pending_signup`).

**Files touched:**
- `convex/schema.ts` (modify — add `invite_expired` status literal)
- `convex/admin/inviteCleanup.ts` (create)
- `convex/admin/inviteCleanupMutations.ts` (create)
- `convex/crons.ts` (modify — add cron)

---

### 9B.4 — Store Explicit `lastTokenRefreshAt` Timestamp

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Finding 6.1 from completeness report

**What:** `getConnectionStatus` approximates last refresh time by subtracting 2 hours from `calendlyTokenExpiresAt`. This breaks if Calendly changes token lifetimes. Store an explicit `lastTokenRefreshAt` field.

**Where:**
- `convex/schema.ts` (modify — add field)
- `convex/tenants.ts` — `storeCalendlyTokens` mutation (modify — write new field)
- `convex/calendly/oauthQueries.ts` (modify — read new field instead of calculating)

**How:**

Add the field to schema:

```typescript
// convex/schema.ts — tenants table, add:
lastTokenRefreshAt: v.optional(v.number()),
```

Update token storage to write it:

```typescript
// convex/tenants.ts — storeCalendlyTokens mutation handler

await ctx.db.patch(tenantId, {
  calendlyAccessToken: args.calendlyAccessToken,
  calendlyRefreshToken: args.calendlyRefreshToken,
  calendlyTokenExpiresAt: args.calendlyTokenExpiresAt,
  calendlyRefreshLockUntil: args.calendlyRefreshLockUntil,
  lastTokenRefreshAt: Date.now(), // NEW: explicit timestamp
});
```

Update the query to use the new field:

```typescript
// convex/calendly/oauthQueries.ts — getConnectionStatus

// Before:
lastTokenRefresh: tenant.calendlyTokenExpiresAt
  ? tenant.calendlyTokenExpiresAt - 7_200_000
  : null,

// After:
lastTokenRefresh: tenant.lastTokenRefreshAt ?? null,
```

> **Convex guideline:** Adding an `v.optional()` field requires no migration — existing documents simply lack the field, which resolves to `undefined`. The `?? null` fallback handles this gracefully in queries.

**Verification:**
- Trigger a token refresh (via cron or manually).
- Check the tenant document in the Convex dashboard → `lastTokenRefreshAt` is set to current timestamp.
- `getConnectionStatus` returns the correct refresh time.
- New tenants that haven't refreshed yet show `null` for last refresh (no crash).

**Files touched:**
- `convex/schema.ts` (modify — add field)
- `convex/tenants.ts` (modify — write field in storeCalendlyTokens)
- `convex/calendly/oauthQueries.ts` (modify — read field)

---

### 9B.5 — Auto-Revert `provisioning_webhooks` Timeout

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Finding 5.5 from completeness report

**What:** A tenant stuck in `provisioning_webhooks` (e.g., webhook creation partially failed and never completed) has its token never refreshed by cron jobs (which only query `status: "active"`). Add a timeout mechanism that reverts stuck tenants to `pending_calendly` after 10 minutes.

**Where:**
- `convex/admin/inviteCleanupMutations.ts` (add — or create a dedicated `convex/tenants/statusCleanup.ts`)
- `convex/crons.ts` (modify — or piggyback on health check)

**How:**

The simplest approach is to add this check to the existing health check cron, since it already iterates tenants:

```typescript
// convex/calendly/healthCheck.ts — add at the top of runHealthCheck handler,
// BEFORE the active tenant loop:

// Check for stuck provisioning_webhooks tenants
const stuckTenants = await ctx.runQuery(
  internal.calendly.healthCheckMutations.listStuckProvisioningTenants,
);

for (const { tenantId, companyName } of stuckTenants) {
  await ctx.runMutation(internal.tenants.updateStatus, {
    tenantId,
    status: "pending_calendly",
  });
  console.warn(
    `[health-check] Reverted stuck tenant "${companyName}" (${tenantId}) ` +
    `from provisioning_webhooks → pending_calendly`,
  );
}
```

Add the query:

```typescript
// convex/calendly/healthCheckMutations.ts (create or add to existing)
import { internalQuery } from "../_generated/server";

const PROVISIONING_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const listStuckProvisioningTenants = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - PROVISIONING_TIMEOUT_MS;

    const stuck = await ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "provisioning_webhooks"))
      .filter((q) => q.lt(q.field("_creationTime"), cutoff))
      .take(100);

    return stuck.map((t) => ({
      tenantId: t._id,
      companyName: t.companyName,
    }));
  },
});
```

> **Design note:** Using `_creationTime` as a proxy for "when provisioning started" is imprecise for tenants that reached `provisioning_webhooks` long after creation. A more precise approach would add a `statusChangedAt` field. For MVP, `_creationTime` works because `provisioning_webhooks` is normally reached within minutes of tenant creation.

**Verification:**
- Manually set a tenant's status to `provisioning_webhooks` and wait 10+ minutes.
- Run health check → tenant reverts to `pending_calendly`.
- Verify the tenant can re-attempt Calendly connection from the onboarding UI.
- Active tenants and recently-provisioning tenants are NOT reverted.

**Files touched:**
- `convex/calendly/healthCheck.ts` (modify — add stuck tenant check)
- `convex/calendly/healthCheckMutations.ts` (create — add query)

---

## Frontend Subphases

_This phase has no frontend subphases. All work is backend data management logic._

_The admin dashboard will surface `invite_expired` status badges automatically via the existing status-to-badge mapping once the schema update (9B.3) is deployed. Add the badge color mapping:_

```typescript
// app/admin/page.tsx — in the status badge color map, add:
"invite_expired": "outline", // or "destructive" if you want it to stand out
```

_This is a one-line change and does not warrant a full subphase._

---

## Parallelization Summary

```
9B.1 (stale org members cleanup) ──────────┐
9B.2 (webhook event TTL cleanup) ──────────┤
9B.3 (expired invite cleanup + schema) ────┤── all independent
9B.4 (lastTokenRefreshAt field) ───────────┤
9B.5 (provisioning timeout revert) ────────┘
```

All five subphases can be built simultaneously. No frontend dependencies.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/orgMembers.ts` | Modify (add cleanup call) | 9B.1 |
| `convex/calendly/orgMembersMutations.ts` | Modify (add `deleteStaleMembers`) | 9B.1 |
| `convex/webhooks/cleanup.ts` | Create | 9B.2 |
| `convex/webhooks/cleanupMutations.ts` | Create | 9B.2 |
| `convex/schema.ts` | Modify (add `invite_expired`, `lastTokenRefreshAt`) | 9B.3, 9B.4 |
| `convex/admin/inviteCleanup.ts` | Create | 9B.3 |
| `convex/admin/inviteCleanupMutations.ts` | Create | 9B.3 |
| `convex/tenants.ts` | Modify (write `lastTokenRefreshAt`) | 9B.4 |
| `convex/calendly/oauthQueries.ts` | Modify (read `lastTokenRefreshAt`) | 9B.4 |
| `convex/calendly/healthCheck.ts` | Modify (add stuck tenant check) | 9B.5 |
| `convex/calendly/healthCheckMutations.ts` | Create | 9B.5 |
| `convex/crons.ts` | Modify (add 2 crons) | 9B.2, 9B.3 |
| `app/admin/page.tsx` | Modify (1-line badge mapping) | 9B.3 |
