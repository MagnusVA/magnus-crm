# Phase 3 — Sync Triggers and Operational State

**Goal:** Wire the full sync into real operational entry points: OAuth completion, manual admin sync, and daily reconciliation. After this phase, the sync has visible latest status and can be safely triggered without accepting tenant IDs from the client.

**Prerequisite:** Phase 2 core sync action and lock/status mutations are implemented. Phase 1 connection-state fields are available through `convex/lib/tenantCalendlyConnection.ts`.

**Runs in PARALLEL with:** Phase 5 UI can implement read-only status rendering after 3D exposes query fields. Phase 4 can proceed independently once Phase 2 upsert helpers exist.

**Skills to invoke:**
- `convex` — public action authorization, internal scheduled fan-out, cron registration, and connection queries.
- `convex-dev-workos-authkit` — only if the identity/org matching logic diverges from existing WorkOS patterns.

**Acceptance Criteria:**
1. Completing Calendly OAuth schedules `internal.calendly.eventTypes.syncForTenant` with reason `"oauth_connected"`.
2. `api.calendly.eventTypes.syncMyTenantEventTypes` is callable only by authenticated `tenant_master` and `tenant_admin` users in their own WorkOS organization.
3. The public sync action never accepts `tenantId` from the client.
4. Daily cron `"sync-calendly-event-types"` fans out active tenants to independent sync actions.
5. If an event type sync lock is held, manual sync returns a skipped result instead of starting a second run.
6. `api.calendly.oauthQueries.getConnectionStatus` includes latest event type sync status, count, error, and in-progress state.
7. Existing org member sync, token refresh, and health check crons continue to register.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (OAuth trigger) ─────────────────────────┐
                                            ├── 3D (Connection status query)
3B (Manual admin action) ───────────────────┤
                                            │
3C (Cron fan-out) ──────────────────────────┘

3A + 3B + 3C + 3D complete ───────────────── 3E (Operational verification)
```

**Optimal execution:**
1. Implement 3B first if testing manually, because it gives a controlled trigger.
2. Implement 3A and 3C in parallel because they only schedule the existing internal action.
3. Implement 3D once sync completion fields are confirmed.
4. Finish with 3E to verify action authorization and cron registration.

**Estimated time:** 0.5-1 day

---

## Subphases

### 3A — OAuth Completion Trigger

**Type:** Backend
**Parallelizable:** Yes — depends only on Phase 2 internal action reference.

**What:** Schedule event type sync immediately after a tenant connects Calendly and the webhook subscription is stored.

**Why:** New tenants should see event types in Settings before the first `invitee.created` webhook arrives.

**Where:**
- `convex/calendly/oauth.ts` (modify)

**How:**

**Step 1: Schedule event type sync beside org member sync.**

```typescript
// Path: convex/calendly/oauth.ts

await ctx.scheduler.runAfter(0, internal.calendly.orgMembers.syncForTenant, {
  tenantId,
});
console.log(
  `[Calendly:OAuth] exchangeCodeAndProvision: org member sync scheduled`,
);

await ctx.scheduler.runAfter(0, internal.calendly.eventTypes.syncForTenant, {
  tenantId,
  reason: "oauth_connected",
});
console.log(
  `[Calendly:OAuth] exchangeCodeAndProvision: event type sync scheduled`,
);
```

**Step 2: Keep scheduling after webhook activation succeeds.**

```typescript
// Path: convex/calendly/oauth.ts

await ctx.runMutation(
  internal.calendly.webhookSetupMutations.storeWebhookAndActivate,
  {
    tenantId,
    webhookUri,
    webhookSecret: signingSecret,
  },
);

// Scheduling belongs here, after tokens and organization URI are stored.
```

**Key implementation notes:**
- Do not schedule event type sync before `storeConnectionTokens`; the sync action reads connection context.
- Do not block OAuth success on sync completion; scheduling is asynchronous.
- If webhook provisioning fails, existing rollback behavior still applies and no event type sync should be scheduled.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/oauth.ts` | Modify | Schedule full event type sync after successful connection |

---

### 3B — Manual Admin Sync Action

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 2 sync core and existing auth patterns.

**What:** Add `api.calendly.eventTypes.syncMyTenantEventTypes`, mirroring `syncMyTenantMembers` authorization and tenant resolution.

**Why:** Tenant admins need an explicit repair/backfill button, and the backend must derive tenant scope from the authenticated user.

**Where:**
- `convex/calendly/eventTypes.ts` (modify)

**How:**

**Step 1: Add public action after the internal action.**

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

    const workosUserId = identity.tokenIdentifier ?? identity.subject;
    if (!workosUserId) {
      throw new Error("Missing WorkOS user ID");
    }

    const currentUser = await ctx.runQuery(
      internal.users.queries.getCurrentUserInternal,
      { workosUserId },
    );
    if (!currentUser || !ADMIN_ROLES.includes(currentUser.role)) {
      throw new Error("Insufficient permissions");
    }

    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
      tenantId: currentUser.tenantId,
    });
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    const identityOrgId = getIdentityOrgId(identity);
    if (!identityOrgId || identityOrgId !== tenant.workosOrgId) {
      throw new Error("Organization mismatch");
    }

    return await ctx.runAction(internal.calendly.eventTypes.syncForTenant, {
      tenantId: currentUser.tenantId,
      reason: "manual_admin",
    });
  },
});
```

**Step 2: Keep the result shape compatible with UI toasts.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Return examples:
// { status: "success", created, updated, unchanged, questionsMerged, notReturned }
// { status: "skipped", reason: "lock_held" }
// { status: "skipped", reason: "rate_limited_retry_scheduled" }
```

**Key implementation notes:**
- This public action intentionally takes `args: {}`.
- Reuse `ADMIN_ROLES` from `convex/lib/roleMapping.ts`.
- Use `getIdentityOrgId(identity)` exactly like existing Calendly admin actions to prevent cross-org tenant access.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Modify | Public manual admin sync action |

---

### 3C — Daily Reconciliation Cron

**Type:** Backend
**Parallelizable:** Yes — independent of 3A and 3B.

**What:** Add an internal fan-out action for all active tenants and register a daily cron.

**Why:** Webhooks are incremental signals, not the source of truth. Daily reconciliation repairs missed events and metadata drift.

**Where:**
- `convex/calendly/eventTypes.ts` (modify)
- `convex/crons.ts` (modify)

**How:**

**Step 1: Add internal fan-out action.**

```typescript
// Path: convex/calendly/eventTypes.ts

const EVENT_TYPE_SYNC_STAGGER_MS = 250;

export const syncAllTenants = internalAction({
  args: {},
  handler: async (ctx) => {
    const tenantIds: Array<Id<"tenants">> = await ctx.runQuery(
      internal.calendly.tokenMutations.listActiveTenantIds,
      {},
    );

    console.log("[Calendly:EventTypes] syncAllTenants scheduling", {
      tenantCount: tenantIds.length,
    });

    for (const [index, tenantId] of tenantIds.entries()) {
      await ctx.scheduler.runAfter(
        index * EVENT_TYPE_SYNC_STAGGER_MS,
        internal.calendly.eventTypes.syncForTenant,
        { tenantId, reason: "daily_reconciliation" },
      );
    }
  },
});
```

**Step 2: Register daily cron with existing cron style.**

```typescript
// Path: convex/crons.ts

crons.interval(
  "sync-calendly-event-types",
  { hours: 24 },
  internal.calendly.eventTypes.syncAllTenants,
  {},
);
```

**Key implementation notes:**
- Use `crons.interval()` to match current project standards.
- Fan out to independent tenant actions so one failure does not stop others.
- The stagger can be small for the current single-tenant production state; keep the constant for future growth.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Modify | Internal all-tenant fan-out |
| `convex/crons.ts` | Modify | Daily reconciliation cron |

---

### 3D — Expose Latest Sync Status

**Type:** Backend
**Parallelizable:** Yes — depends on Phase 1 connection mapping.

**What:** Return event type sync state from internal connection context and public Settings connection status.

**Why:** The Settings UI needs to show last sync time/status/count and disable duplicate manual sync while a lock is active.

**Where:**
- `convex/calendly/connectionQueries.ts` (modify)
- `convex/calendly/oauthQueries.ts` (modify)
- `app/workspace/settings/_components/calendly-connection.tsx` (type shape in Phase 5)

**How:**

**Step 1: Add fields to internal connection context.**

```typescript
// Path: convex/calendly/connectionQueries.ts

return {
  tenantId: tenant._id,
  companyName: tenant.companyName,
  workosOrgId: tenant.workosOrgId,
  tenantStatus: tenant.status,
  accessToken: connection?.accessToken,
  refreshToken: connection?.refreshToken,
  tokenExpiresAt: connection?.tokenExpiresAt,
  refreshLockUntil: connection?.refreshLockUntil,
  lastRefreshedAt: connection?.lastRefreshedAt,
  pkceVerifier: connection?.pkceVerifier,
  organizationUri: connection?.organizationUri,
  userUri: connection?.userUri,
  webhookUri: connection?.webhookUri,
  webhookSecret: connection?.webhookSecret,
  connectionStatus: connection?.connectionStatus,
  lastHealthCheckAt: connection?.lastHealthCheckAt,
  eventTypeSyncLockUntil: connection?.eventTypeSyncLockUntil,
  lastEventTypeSyncStartedAt: connection?.lastEventTypeSyncStartedAt,
  lastEventTypeSyncCompletedAt: connection?.lastEventTypeSyncCompletedAt,
  lastEventTypeSyncStatus: connection?.lastEventTypeSyncStatus,
  lastEventTypeSyncError: connection?.lastEventTypeSyncError,
  lastEventTypeSyncCount: connection?.lastEventTypeSyncCount,
};
```

**Step 2: Return public status values with `null` fallbacks.**

```typescript
// Path: convex/calendly/oauthQueries.ts

const now = Date.now();
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
  lastEventTypeSyncStartedAt: connection?.lastEventTypeSyncStartedAt ?? null,
  lastEventTypeSyncCompletedAt: connection?.lastEventTypeSyncCompletedAt ?? null,
  lastEventTypeSyncStatus: connection?.lastEventTypeSyncStatus ?? null,
  lastEventTypeSyncError: connection?.lastEventTypeSyncError ?? null,
  lastEventTypeSyncCount: connection?.lastEventTypeSyncCount ?? null,
  eventTypeSyncInProgress:
    typeof connection?.eventTypeSyncLockUntil === "number" &&
    connection.eventTypeSyncLockUntil > now,
};
```

**Key implementation notes:**
- Public status must not include access tokens, refresh tokens, or webhook signing keys.
- `eventTypeSyncInProgress` is derived server-side from the lock timestamp.
- Keep `null` rather than `undefined` in the public query response for stable client rendering.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/connectionQueries.ts` | Modify | Internal sync state |
| `convex/calendly/oauthQueries.ts` | Modify | Public Settings status |

---

### 3E — Operational Verification

**Type:** Manual
**Parallelizable:** No — runs after 3A-3D.

**What:** Verify that triggers schedule the correct internal action and public authorization blocks non-admin callers.

**Why:** The sync is now reachable from admin UI and cron; tenant isolation and lock behavior must be validated before UI rollout.

**Where:**
- Local terminal verification
- Convex dashboard logs
- Settings client in Phase 5

**How:**

**Step 1: Run codegen and TypeScript.**

```bash
// Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Manually trigger the public action in a dev authenticated admin session.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Expected admin result:
// { status: "success", created, updated, unchanged, questionsMerged, notReturned }
```

**Step 3: Confirm non-admin rejection.**

```typescript
// Path: convex/calendly/eventTypes.ts

// A closer session calling api.calendly.eventTypes.syncMyTenantEventTypes
// must throw "Insufficient permissions".
```

**Key implementation notes:**
- Do not force production manual sync until Phase 6 rollout.
- The cron registration can be verified by `npx convex dev` startup logs and generated API references.
- If lock behavior is hard to exercise manually, use two quick manual action calls and confirm the second returns `lock_held`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | New public/internal function references |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/oauth.ts` | Modify | 3A |
| `convex/calendly/eventTypes.ts` | Modify | 3B, 3C |
| `convex/crons.ts` | Modify | 3C |
| `convex/calendly/connectionQueries.ts` | Modify | 3D |
| `convex/calendly/oauthQueries.ts` | Modify | 3D |
| `convex/_generated/*` | Generate | 3E |
