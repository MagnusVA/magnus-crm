# Phase 3 — Manual Sync Trigger and Operational State

**Goal:** Expose the full event type sync through a tenant-scoped admin action and make latest sync state readable by Settings. After this phase, admins can trigger sync manually without passing tenant IDs from the client, and the backend records a toast-friendly result summary.

**Prerequisite:** Phase 2 core sync action and lock/status mutations are implemented. Phase 1 connection-state fields are available through `convex/lib/tenantCalendlyConnection.ts`.

**Runs in PARALLEL with:** Phase 4 boundary audit can run independently. Phase 5 UI can implement the button and status display after 3A and 3B define the public action and query shape.

**Skills to invoke:**
- `convex` — public action authorization, internal action calls, identity/org validation, and query result shaping.
- `convex-dev-workos-authkit` — only if the identity/org matching logic diverges from existing WorkOS patterns.

**Acceptance Criteria:**
1. `api.calendly.eventTypes.syncMyTenantEventTypes` is callable only by authenticated `tenant_master` and `tenant_admin` users in their own WorkOS organization.
2. The public sync action has `args: {}` and never accepts `tenantId` from the client.
3. The public action calls the Phase 2 sync for the current user's tenant with `reason = "manual_admin"`.
4. If an event type sync lock is held, manual sync returns a skipped result instead of starting a second run.
5. `api.calendly.oauthQueries.getConnectionStatus` includes latest event type sync status, count, summary, error, and in-progress state.
6. Completing Calendly OAuth does not automatically trigger event type sync.
7. No event type sync cron is registered.
8. Existing org member sync, token refresh, and health check behavior remains unchanged.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Public manual action) ───────────┬── 3C (Result contract polish)
                                     │
3B (Connection status query) ────────┤
                                     └── 3D (Manual-only trigger audit)

3A + 3B + 3C + 3D complete ───────────── 3E (Operational verification)
```

**Optimal execution:**
1. Implement 3A first because it provides the controlled manual trigger for all downstream testing.
2. Implement 3B in parallel so the UI can observe lock and latest status fields.
3. Polish result/error semantics in 3C.
4. Run 3D before UI work to ensure no automatic triggers slip into the MVP.
5. Finish with 3E authorization and status verification.

**Estimated time:** 0.5-1 day

---

## Subphases

### 3A — Public Manual Admin Action

**Type:** Backend  
**Parallelizable:** No — UI work depends on this public API shape.

**What:** Add `api.calendly.eventTypes.syncMyTenantEventTypes`, mirroring `syncMyTenantMembers` authorization and tenant resolution.

**Why:** Tenant admins need an explicit repair/backfill button, and the backend must derive tenant scope from the authenticated user.

**Where:**
- `convex/calendly/eventTypes.ts` (modify)

**How:**

**Step 1: Add imports used by the public action.**

```typescript
// Path: convex/calendly/eventTypes.ts

import type { Doc } from "../_generated/dataModel";
import { action, internalAction } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { ADMIN_ROLES } from "../lib/roleMapping";
import { getCanonicalIdentityWorkosUserId } from "../lib/workosUserId";
```

**Step 2: Add the public action with no arguments.**

```typescript
// Path: convex/calendly/eventTypes.ts

export const syncMyTenantEventTypes = action({
  args: {},
  handler: async (ctx) => {
    console.log("[Calendly:EventTypes] syncMyTenantEventTypes called");

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) {
      throw new Error("Missing WorkOS user ID");
    }

    const currentUser: Doc<"users"> | null = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    if (!currentUser || !ADMIN_ROLES.includes(currentUser.role)) {
      throw new Error("Insufficient permissions");
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: currentUser.tenantId,
    });
    const identityOrgId = getIdentityOrgId(identity);
    if (!tenant || !identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw new Error("Organization mismatch");
    }

    return await ctx.runAction(internal.calendly.eventTypes.syncForTenant, {
      tenantId: currentUser.tenantId,
      reason: "manual_admin",
    });
  },
});
```

**Key implementation notes:**
- Keep `args: {}`. Client-supplied `tenantId` is not allowed.
- Reuse the canonical WorkOS user helper used elsewhere in Convex auth logic.
- Do not expose this as a mutation; the runtime performs external fetches and must remain an action.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Modify | Add public manual admin sync action |

---

### 3B — Connection Status Query Shape

**Type:** Backend  
**Parallelizable:** Yes — depends on Phase 1 connection helper fields.

**What:** Extend `getConnectionStatus` so Settings can render latest sync time, status, count, summary, error text, and current in-progress state.

**Why:** The sync button must be disabled while a sync is active, and admins need freshness/status without inspecting Convex data.

**Where:**
- `convex/calendly/oauthQueries.ts` (modify)
- `convex/calendly/connectionQueries.ts` (verify / modify)

**How:**

**Step 1: Add event type sync state to the client query.**

```typescript
// Path: convex/calendly/oauthQueries.ts

const now = Date.now();
const eventTypeSyncInProgress =
  connection?.eventTypeSyncLockUntil !== undefined &&
  connection.eventTypeSyncLockUntil > now;

const result = {
  tenantId: tenant._id,
  status: tenant.status,
  needsReconnect: tenant.status === "calendly_disconnected",
  lastTokenRefresh: connection?.lastRefreshedAt ?? null,
  tokenExpiresAt: connection?.tokenExpiresAt ?? null,
  calendlyWebhookUri: connection?.webhookUri ?? null,
  hasWebhookSigningKey: Boolean(connection?.webhookSecret),
  hasAccessToken: Boolean(connection?.accessToken),
  hasRefreshToken: Boolean(connection?.refreshToken),
  eventTypeSyncInProgress,
  eventTypeSyncLockUntil: connection?.eventTypeSyncLockUntil ?? null,
  lastEventTypeSyncStartedAt: connection?.lastEventTypeSyncStartedAt ?? null,
  lastEventTypeSyncCompletedAt: connection?.lastEventTypeSyncCompletedAt ?? null,
  lastEventTypeSyncStatus: connection?.lastEventTypeSyncStatus ?? null,
  lastEventTypeSyncError: connection?.lastEventTypeSyncError ?? null,
  lastEventTypeSyncCount: connection?.lastEventTypeSyncCount ?? null,
  lastEventTypeSyncSummary: connection?.lastEventTypeSyncSummary ?? null,
};
```

**Step 2: Include internal sync state only where needed.**

```typescript
// Path: convex/calendly/connectionQueries.ts

return {
  tenantId: tenant._id,
  companyName: tenant.companyName,
  workosOrgId: tenant.workosOrgId,
  tenantStatus: tenant.status,
  organizationUri: connection?.organizationUri,
  eventTypeSyncLockUntil: connection?.eventTypeSyncLockUntil,
  lastEventTypeSyncStatus: connection?.lastEventTypeSyncStatus,
};
```

**Key implementation notes:**
- Keep sensitive token fields off `oauthQueries.getConnectionStatus`.
- Return nullable fields to the client so TypeScript props are easy to model.
- `eventTypeSyncInProgress` is derived from wall-clock `Date.now()` and the lock timeout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/oauthQueries.ts` | Modify | Expose latest sync state for Settings |
| `convex/calendly/connectionQueries.ts` | Verify / Modify | Internal connection context remains consistent |

---

### 3C — Result Contract and Error Semantics

**Type:** Backend  
**Parallelizable:** Yes — depends on 3A public action and Phase 2 return values.

**What:** Keep manual sync return values stable for the Settings toast and avoid throwing for expected lock-held skips.

**Why:** The UI should distinguish "sync already running" from real failures, while real Calendly/API failures should surface as errors and persist latest failed status.

**Where:**
- `convex/calendly/eventTypes.ts` (modify)
- `convex/calendly/eventTypeMutations.ts` (verify)

**How:**

**Step 1: Use a discriminated result shape.**

```typescript
// Path: convex/calendly/eventTypes.ts

type ManualEventTypeSyncResult =
  | ({
      status: "success";
      totalSeen: number;
      created: number;
      updated: number;
      unchanged: number;
      inactive: number;
      deleted: number;
      notReturned: number;
      questionsMerged: number;
    })
  | {
      status: "skipped";
      reason: "lock_held";
    };
```

**Step 2: Return lock-held skips without throwing.**

```typescript
// Path: convex/calendly/eventTypes.ts

const lock = await ctx.runMutation(
  internal.calendly.eventTypeMutations.acquireEventTypeSyncLock,
  { tenantId, lockUntil: startedAt + 2 * 60 * 1000, reason },
);
if (!lock.acquired) {
  await ctx.runMutation(
    internal.calendly.eventTypeMutations.completeEventTypeSync,
    {
      tenantId,
      status: "skipped",
      error: "An event type sync is already running.",
    },
  );
  return { status: "skipped" as const, reason: "lock_held" as const };
}
```

**Key implementation notes:**
- Do not swallow Calendly `403`, `401` after refresh, or `429`; those are real failed syncs.
- Persist the failed status before rethrowing so Settings reflects the latest attempt.
- Keep result field names identical to the design contract.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Modify | Stable manual result contract |
| `convex/calendly/eventTypeMutations.ts` | Verify | Latest status persists skipped/failed states |

---

### 3D — Manual-Only Trigger Audit

**Type:** Backend / Manual  
**Parallelizable:** Yes — independent audit after 3A exists.

**What:** Verify that no OAuth-completion trigger, cron, or webhook path starts event type sync in the MVP.

**Why:** The design intentionally makes sync explicit so admins control when Calendly metadata is imported.

**Where:**
- `convex/calendly/oauth.ts` (verify)
- `convex/crons.ts` (verify)
- `convex/pipeline/processor.ts` (verify)

**How:**

**Step 1: Keep OAuth completion unchanged.**

```typescript
// Path: convex/calendly/oauth.ts

// Existing org member sync may remain scheduled after connection.
await ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, {
  tenantId,
});

// Do not add:
// internal.calendly.eventTypes.syncForTenant
```

**Step 2: Keep crons free of event type sync.**

```typescript
// Path: convex/crons.ts

crons.interval(
  "sync-calendly-org-members",
  { hours: 24 },
  internal.calendly.orgMembers.syncAllTenants,
  {},
);

// Do not add a "sync-calendly-event-types" cron for MVP.
```

**Step 3: Keep webhook processor dispatch unchanged for event type events.**

```typescript
// Path: convex/pipeline/processor.ts

default:
  console.log(`[Pipeline] Unhandled event type "${rawEvent.eventType}"`);
  await ctx.runMutation(internal.pipeline.mutations.markProcessed, {
    rawEventId,
  });
```

**Key implementation notes:**
- This is an audit subphase. If earlier work added automatic triggers, remove them.
- The only public trigger after this phase should be `api.calendly.eventTypes.syncMyTenantEventTypes`.
- Phase 4 documents the broader manual-sync-only boundary.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/oauth.ts` | Verify | No automatic sync on OAuth completion |
| `convex/crons.ts` | Verify | No event type sync cron |
| `convex/pipeline/processor.ts` | Verify | No event type webhook dispatch |

---

### 3E — Operational Verification

**Type:** Manual  
**Parallelizable:** No — verifies the public action and query shape together.

**What:** Confirm action authorization, manual result shape, lock handling, and latest status query output.

**Why:** Phase 5 depends on this contract for the Settings button and status display.

**Where:**
- `convex/calendly/eventTypes.ts` (verify)
- `convex/calendly/oauthQueries.ts` (verify)

**How:**

**Step 1: Run compile gates.**

```bash
# Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Verify role behavior.**

```typescript
// Path: convex/calendly/eventTypes.ts

// tenant_master / tenant_admin:
// - api.calendly.eventTypes.syncMyTenantEventTypes succeeds or returns skipped.
//
// closer:
// - throws "Insufficient permissions".
//
// unauthenticated:
// - throws "Not authenticated".
```

**Step 3: Verify status query.**

```typescript
// Path: convex/calendly/oauthQueries.ts

// During lock:
// eventTypeSyncInProgress === true
//
// After success:
// lastEventTypeSyncStatus === "success"
// lastEventTypeSyncCount === totalSeen
//
// After failure:
// lastEventTypeSyncStatus === "failed"
// lastEventTypeSyncError is non-empty
```

**Key implementation notes:**
- Do not rely on client role context for security; Convex action revalidates role and org.
- If the public action can be called from Convex dashboard without auth, it should fail.
- Keep logs tagged with `[Calendly:EventTypes]`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Verify | Manual action authorization and result shape |
| `convex/calendly/oauthQueries.ts` | Verify | Latest status query output |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Modify | 3A, 3C |
| `convex/calendly/oauthQueries.ts` | Modify | 3B |
| `convex/calendly/connectionQueries.ts` | Verify / Modify | 3B |
| `convex/calendly/eventTypeMutations.ts` | Verify | 3C |
| `convex/calendly/oauth.ts` | Verify | 3D |
| `convex/crons.ts` | Verify | 3D |
| `convex/pipeline/processor.ts` | Verify | 3D |
