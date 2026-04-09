# Phase 10 — Scalability & Cron Performance

**Goal:** Eliminate serial-processing bottlenecks in cron jobs and add pagination to bounded queries so the system handles hundreds of tenants without hitting timeouts or hiding data behind hard limits. This phase transitions the architecture from "works for 10 tenants" to "works for 1,000+."

**Prerequisite:** Phase 9 complete (data lifecycle crons registered, `lastTokenRefreshAt` field in place). Phase 7 critical fixes merged.

**Acceptance Criteria:**
1. Token refresh, health check, and org member sync crons fan out individual tenant processing as separate scheduled actions, running in parallel.
2. No single action processes more than one tenant (eliminates the serial-loop timeout risk).
3. `listTenants` supports cursor-based pagination; the admin dashboard loads tenants page-by-page.
4. At 500 tenants, all cron jobs complete within 2 minutes (parallel fan-out) versus ~250 seconds (serial).
5. The admin dashboard renders the first page in under 1 second, with smooth pagination for subsequent pages.

---

## Backend Subphases

### 10B.1 — Fan-Out Cron Jobs for Parallel Tenant Processing

**Type:** Backend
**Parallelizable:** Yes — core scalability change.
**Finding:** Finding 5.2 from completeness report

**What:** Replace the sequential `for (const tenantId of tenantIds)` loop in all three cron actions (`refreshAllTokens`, `runHealthCheck`, `syncAllTenants`) with `ctx.scheduler.runAfter(0, ...)` fan-out. Each tenant is processed as an independent action invocation, allowing Convex to parallelize them.

**Where:**
- `convex/calendly/tokens.ts` — `refreshAllTokens`
- `convex/calendly/healthCheck.ts` — `runHealthCheck`
- `convex/calendly/orgMembers.ts` — `syncAllTenants`

**How:**

**Token refresh fan-out:**

```typescript
// convex/calendly/tokens.ts

/**
 * Cron job: fan out token refresh for all active tenants.
 *
 * Instead of processing tenants sequentially (which risks timeout
 * at ~1200 tenants), schedule each refresh as a separate action.
 * Convex will process them in parallel, respecting platform concurrency limits.
 */
export const refreshAllTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
    );

    console.log(
      `[token-refresh] Scheduling refresh for ${tenantIds.length} tenants`,
    );

    // Fan out: each tenant gets its own action invocation
    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.tokens.refreshTenantToken,
        { tenantId },
      );
    }

    // The cron completes immediately after scheduling.
    // Individual refresh actions run asynchronously and independently.
    // Failures in one tenant do not affect others.
  },
});
```

> **Key difference from the old pattern:** Previously, a failure in tenant N would be caught by `try/catch` but still block subsequent tenants from processing (they wait in the loop). With fan-out, failures are isolated — each tenant's action is independent and has its own error boundary.

**Health check fan-out:**

```typescript
// convex/calendly/healthCheck.ts

export const runHealthCheck = internalAction({
  args: {},
  handler: async (ctx) => {
    // Step 1: Handle stuck provisioning tenants (from Phase 9B.5) — still sequential, fast
    const stuckTenants = await ctx.runQuery(
      internal.calendly.healthCheckMutations.listStuckProvisioningTenants,
    );
    for (const { tenantId, companyName } of stuckTenants) {
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "pending_calendly",
      });
      console.warn(
        `[health-check] Reverted stuck tenant "${companyName}" (${tenantId})`,
      );
    }

    // Step 2: Fan out per-tenant health checks
    const tenantIds = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
    );

    console.log(
      `[health-check] Scheduling health check for ${tenantIds.length} tenants`,
    );

    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.healthCheck.checkSingleTenant,
        { tenantId },
      );
    }
  },
});

/**
 * Health check for a single tenant. Extracted from the old inline loop body.
 */
export const checkSingleTenant = internalAction({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    try {
      const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
        tenantId,
      });
      if (!tenant?.calendlyAccessToken) return;

      // 1. Introspect access token
      const clientId = process.env.CALENDLY_CLIENT_ID!;
      const clientSecret = process.env.CALENDLY_CLIENT_SECRET!;

      const introspectRes = await fetch(
        "https://auth.calendly.com/oauth/introspect",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            token: tenant.calendlyAccessToken,
          }),
        },
      );

      if (introspectRes.ok) {
        const data = await introspectRes.json();
        if (!data.active) {
          console.log(
            `Tenant ${tenantId}: token inactive, triggering refresh`,
          );
          await ctx.runAction(
            internal.calendly.tokens.refreshTenantToken,
            { tenantId },
          );
        }
      }

      // 2. Check webhook subscription state
      // (existing webhook check logic — fetch tenant's webhookUri,
      //  GET /webhook_subscriptions/{uuid}, if disabled → recreate)

    } catch (error) {
      console.error(`Health check failed for tenant ${tenantId}:`, error);
    }
  },
});
```

**Org member sync fan-out:**

```typescript
// convex/calendly/orgMembers.ts

export const syncAllTenants = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
    );

    console.log(
      `[org-sync] Scheduling sync for ${tenantIds.length} tenants`,
    );

    for (const tenantId of tenantIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.calendly.orgMembers.syncForTenant,
        { tenantId },
      );
    }
  },
});
```

> **Convex guideline reminder:** `ctx.scheduler.runAfter(0, ref, args)` schedules the action to run immediately but asynchronously. The parent action completes without waiting for the children. Each child has its own 10-minute timeout. This means 1,000 tenants can be processed concurrently (subject to Convex's per-deployment concurrency limits).

**Rate limiting consideration:** Calendly's API has rate limits (typically ~100 requests/minute for OAuth token operations). If 500 tenants all refresh simultaneously, the API may return 429. Add backoff per-tenant:

```typescript
// convex/calendly/tokens.ts — inside refreshTenantToken, after receiving 429:

if (response.status === 429) {
  const retryAfter = parseInt(
    response.headers.get("Retry-After") ?? "60",
    10,
  );
  console.warn(
    `Tenant ${tenantId}: rate limited, scheduling retry in ${retryAfter}s`,
  );
  await ctx.scheduler.runAfter(
    retryAfter * 1000,
    internal.calendly.tokens.refreshTenantToken,
    { tenantId },
  );
  return { refreshed: false, reason: "rate_limited_retry_scheduled" };
}
```

For the fan-out itself, add staggered scheduling to spread load:

```typescript
// In refreshAllTokens:
for (let i = 0; i < tenantIds.length; i++) {
  // Stagger by 500ms per tenant to avoid rate limit spikes
  // 500 tenants = 250 seconds of staggering, well within the 90-minute interval
  await ctx.scheduler.runAfter(
    i * 500,  // 0ms, 500ms, 1000ms, ...
    internal.calendly.tokens.refreshTenantToken,
    { tenantId: tenantIds[i] },
  );
}
```

**Verification:**
- With 5 active tenants, run `refreshAllTokens` → verify 5 separate `refreshTenantToken` action invocations in the Convex dashboard logs (not one long sequential log).
- Simulate a 429 response for one tenant → verify it schedules a retry and other tenants are unaffected.
- Verify cron job completes in seconds (scheduling only) instead of minutes (processing).
- `runHealthCheck` and `syncAllTenants` behave identically.

**Files touched:**
- `convex/calendly/tokens.ts` (modify — fan-out + 429 handling)
- `convex/calendly/healthCheck.ts` (modify — fan-out + extract `checkSingleTenant`)
- `convex/calendly/orgMembers.ts` (modify — fan-out)

---

### 10B.2 — Implement Cursor-Based Pagination for `listTenants`

**Type:** Backend
**Parallelizable:** Yes — independent of 10B.1.
**Finding:** Finding 2.5 from completeness report

**What:** `listTenants` returns max 100 results with `.take(100)` and no pagination. If more than 100 tenants exist, older ones are invisible. Implement cursor-based pagination using Convex's built-in `.paginate()` API.

**Where:** `convex/admin/tenantsQueries.ts`

**How:**

```typescript
// convex/admin/tenantsQueries.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireSystemAdminSession } from "../requireSystemAdmin";
import { paginationOptsValidator } from "convex/server";

/**
 * List tenants with cursor-based pagination.
 *
 * Uses Convex's built-in pagination API. The client passes
 * `paginationOpts: { numItems: N, cursor: null | string }`.
 * Returns `{ page: Tenant[], isDone: boolean, continueCursor: string }`.
 */
export const listTenants = query({
  args: {
    paginationOpts: paginationOptsValidator,
    statusFilter: v.optional(
      v.union(
        v.literal("pending_signup"),
        v.literal("pending_calendly"),
        v.literal("provisioning_webhooks"),
        v.literal("active"),
        v.literal("calendly_disconnected"),
        v.literal("suspended"),
        v.literal("invite_expired"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    await requireSystemAdminSession(ctx);

    let baseQuery = ctx.db.query("tenants");

    if (args.statusFilter) {
      baseQuery = baseQuery.withIndex("by_status", (q) =>
        q.eq("status", args.statusFilter!),
      );
    }

    const result = await baseQuery
      .order("desc") // newest first
      .paginate(args.paginationOpts);

    return result;
  },
});

/**
 * Get a single tenant by ID (unchanged — no pagination needed).
 */
export const getTenant = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await requireSystemAdminSession(ctx);
    return await ctx.db.get(tenantId);
  },
});

/**
 * Internal query for backend use (unchanged).
 */
export const getTenantInternal = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await ctx.db.get(tenantId);
  },
});
```

> **Convex guideline:** `paginationOptsValidator` is imported from `"convex/server"`. It defines `{ numItems: v.number(), cursor: v.union(v.string(), v.null()) }`. The `.paginate()` method returns `{ page: Doc[], isDone: boolean, continueCursor: string }`. The cursor is opaque — clients should not parse or construct it.

**Note on breaking change:** The return type changes from `Tenant[]` to `{ page: Tenant[], isDone: boolean, continueCursor: string }`. The admin dashboard frontend (10F.1) must be updated simultaneously.

**Verification:**
- With 5 tenants, `listTenants({ paginationOpts: { numItems: 2, cursor: null } })` returns 2 tenants + a cursor.
- Passing the cursor back returns the next 2 tenants.
- Eventually `isDone: true` when all tenants are listed.
- Status filter works: filtering by `"active"` returns only active tenants.

**Files touched:**
- `convex/admin/tenantsQueries.ts` (modify — add pagination + filter)

---

## Frontend Subphases

### 10F.1 — Paginated Tenant List in Admin Dashboard

**Type:** Frontend
**Parallelizable:** After 10B.2 (backend pagination API must exist).

**What:** Update the admin dashboard to use the paginated `listTenants` query. Replace the flat list with a "Load More" button (or infinite scroll). Add a status filter dropdown to narrow the view.

**Where:** `app/admin/page.tsx`, `app/admin/_components/` (possibly extract tenant table)

**How:**

Use Convex's `usePaginatedQuery` hook for reactive paginated data:

```typescript
// app/admin/page.tsx

"use client";

import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";

const PAGE_SIZE = 25;

export default function AdminPage() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(
    undefined,
  );

  const {
    results: tenants,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.admin.tenantsQueries.listTenants,
    { statusFilter: statusFilter as any },
    { initialNumItems: PAGE_SIZE },
  );

  // Stats: compute from the loaded results (or add a separate count query)
  const stats = {
    total: tenants.length,
    active: tenants.filter((t) => t.status === "active").length,
    pendingSignup: tenants.filter((t) => t.status === "pending_signup").length,
    pendingCalendly: tenants.filter((t) => t.status === "pending_calendly")
      .length,
  };

  return (
    <div className="container mx-auto py-8">
      {/* Stats cards (existing) */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {/* ... stat cards ... */}
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-4 mb-4">
        <label className="text-sm font-medium">Filter by status:</label>
        <select
          value={statusFilter ?? "all"}
          onChange={(e) =>
            setStatusFilter(
              e.target.value === "all" ? undefined : e.target.value,
            )
          }
          className="border rounded-md px-3 py-1.5 text-sm"
        >
          <option value="all">All statuses</option>
          <option value="pending_signup">Pending Signup</option>
          <option value="pending_calendly">Pending Calendly</option>
          <option value="active">Active</option>
          <option value="calendly_disconnected">Disconnected</option>
          <option value="suspended">Suspended</option>
          <option value="invite_expired">Invite Expired</option>
        </select>
      </div>

      {/* Tenant table (existing structure, now fed by paginated data) */}
      <table className="w-full">
        <thead>
          <tr>
            <th>Company</th>
            <th>Contact</th>
            <th>Status</th>
            <th>Created</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {tenants.map((tenant) => (
            <TenantRow key={tenant._id} tenant={tenant} />
          ))}
        </tbody>
      </table>

      {/* Load More button */}
      {paginationStatus === "CanLoadMore" && (
        <div className="flex justify-center mt-4">
          <button
            onClick={() => loadMore(PAGE_SIZE)}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md"
          >
            Load More
          </button>
        </div>
      )}

      {paginationStatus === "LoadingMore" && (
        <div className="flex justify-center mt-4">
          <span className="text-muted-foreground">Loading...</span>
        </div>
      )}

      {paginationStatus === "Exhausted" && tenants.length > PAGE_SIZE && (
        <div className="flex justify-center mt-4">
          <span className="text-muted-foreground text-sm">
            All {tenants.length} tenants loaded
          </span>
        </div>
      )}
    </div>
  );
}
```

> **Convex guideline:** `usePaginatedQuery` is the reactive hook for paginated queries. It returns `{ results, status, loadMore }`. `status` is one of `"LoadingFirstPage"`, `"CanLoadMore"`, `"LoadingMore"`, `"Exhausted"`. The `results` array grows as pages are loaded (it doesn't replace — it appends).

**Handling stats separately:** The stats shown at the top (Total Tenants, Active, etc.) should ideally come from a separate aggregation query rather than counting the loaded page. For now, the stats from loaded data are approximate. A `getTenantStats` internal query could be added later.

**Verification:**
- With 50+ tenants, the page initially shows 25.
- Click "Load More" → next 25 appear below.
- Select "Active" filter → only active tenants shown.
- Select "All statuses" → full unfiltered paginated list.
- Page loads in < 1 second (verified in browser DevTools Network tab).

**Files touched:**
- `app/admin/page.tsx` (modify — replace flat query with paginated query + filter)

---

## Parallelization Summary

```
10B.1 (cron fan-out) ───────────────────────┐
10B.2 (cursor-based pagination) ────────────┤── independent backend work
                                            │
10B.2 ──────────────────────────────────────→ 10F.1 (paginated admin UI)
```

10B.1 and 10B.2 can be built in parallel. 10F.1 depends on 10B.2 (the paginated query API must exist before the frontend can consume it).

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/tokens.ts` | Modify (fan-out + 429 + stagger) | 10B.1 |
| `convex/calendly/healthCheck.ts` | Modify (fan-out + extract single-tenant action) | 10B.1 |
| `convex/calendly/orgMembers.ts` | Modify (fan-out) | 10B.1 |
| `convex/admin/tenantsQueries.ts` | Modify (pagination + filter) | 10B.2 |
| `app/admin/page.tsx` | Modify (paginated query + filter UI + load more) | 10F.1 |
