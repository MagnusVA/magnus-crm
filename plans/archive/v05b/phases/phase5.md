# Phase 5 — OAuth State Extraction

**Goal:** Separate high-churn Calendly OAuth state from the stable `tenants` identity table into a dedicated `tenantCalendlyConnections` table. Eliminate 16 reactive invalidations/day caused by the 90-minute token refresh cron writing to `tenants`.

**Prerequisite:** Phase 1 complete (`tenantCalendlyConnections` table exists in schema with `by_tenantId` index).

**Runs in PARALLEL with:** Phases 2, 3, and 4 — zero shared files with non-OAuth work.

**Skills to invoke:**
- `convex-migration-helper` — For widen-migrate-narrow discipline and backfill execution
- Calendly docs (`.docs/calendly/index.md`) — For OAuth flow understanding and field mapping

**Acceptance Criteria:**

1. `tenantCalendlyConnections` table contains one row per tenant with all OAuth fields populated from the backfill.
2. All OAuth token reads (`getCalendlyTokens`, `getCodeVerifier`, `getTenantSigningKey`, `getConnectionStatus`) resolve from `tenantCalendlyConnections`, not `tenants`.
3. All OAuth token writes (`storeCalendlyTokens`, `storeCodeVerifier`, `clearCodeVerifier`, `acquireRefreshLock`, `releaseRefreshLock`, `storeWebhookAndActivate`, `clearCalendlyConnection`) target `tenantCalendlyConnections`, not `tenants`.
4. The 90-minute `refresh-calendly-tokens` cron no longer writes to the `tenants` table.
5. Webhook signature verification in `convex/webhooks/calendly.ts` reads the signing key from `tenantCalendlyConnections`.
6. Tenant deletion (`resetTenantForReonboarding`) cleans up the `tenantCalendlyConnections` row.
7. A `grep` for `calendlyAccessToken\|calendlyRefreshToken\|calendlyOrgUri\|calendlyOwnerUri\|webhookSigningKey\|codeVerifier\|calendlyRefreshLockUntil\|lastTokenRefreshAt` in `convex/` returns hits only in `schema.ts` (deprecated fields still present until Phase 6), the backfill script, and the helper module — zero hits in consumers.
8. The OAuth connection status query (`oauthQueries.ts:getConnectionStatus`) reads from `tenantCalendlyConnections` and returns identical shape to callers.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Backfill tenantCalendlyConnections)
    ↓
5B (Create OAuth helper module)
    ↓
   ┌─────────────────┐
   │                  │
5C (Switch readers) 5D (Switch writers)
   │                  │
   └────────┬─────────┘
            ↓
5E (Verify + clean up)
```

**Optimal execution:**

1. Execute 5A backfill (requires Phase 1 schema deployed).
2. Create the helper module in 5B.
3. Run 5C and 5D in parallel (no shared files between readers and writers).
4. Run 5E validation after both 5C and 5D complete.

**Estimated time:** 4-6 hours (5A = 30 min, 5B = 45 min, 5C = 90 min, 5D = 90 min, 5E = 30 min)

---

## Subphases

### 5A — Backfill `tenantCalendlyConnections` from `tenants`

**Type:** Backend / Migration
**Parallelizable:** No — must run first; all subsequent subphases depend on data existing in the new table.

**What:** Create and execute a one-shot backfill script that copies all OAuth-related fields from each `tenants` row into a corresponding `tenantCalendlyConnections` row.

**Why:** The new table must be populated before any consumer can be switched to read from it. With 1 test tenant this is a single-document operation, but the script must handle N tenants for future-proofing.

**Where:**
- `convex/migrations/backfillTenantCalendlyConnections.ts` (create)

**How:**

**Step 1: Create the backfill mutation**

```typescript
// Path: convex/migrations/backfillTenantCalendlyConnections.ts
import { internalMutation } from "../_generated/server";

export const backfillTenantCalendlyConnections = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").collect();
    let created = 0;
    let skipped = 0;

    for (const tenant of tenants) {
      // Skip if already backfilled
      const existing = await ctx.db
        .query("tenantCalendlyConnections")
        .withIndex("by_tenantId", (q) => q.eq("tenantId", tenant._id))
        .first();

      if (existing) {
        skipped++;
        continue;
      }

      await ctx.db.insert("tenantCalendlyConnections", {
        tenantId: tenant._id,
        calendlyAccessToken: tenant.calendlyAccessToken,
        calendlyRefreshToken: tenant.calendlyRefreshToken,
        calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
        calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
        lastTokenRefreshAt: tenant.lastTokenRefreshAt,
        codeVerifier: tenant.codeVerifier,
        calendlyOrganizationUri: tenant.calendlyOrgUri,
        calendlyUserUri: tenant.calendlyOwnerUri,
        calendlyWebhookUri: tenant.calendlyWebhookUri,
        calendlyWebhookSigningKey: tenant.webhookSigningKey,
        connectionStatus: tenant.calendlyAccessToken ? "connected" : "disconnected",
      });
      created++;
    }

    console.log(
      `[Migration] backfillTenantCalendlyConnections: created=${created}, skipped=${skipped}`,
    );
    return { created, skipped };
  },
});
```

**Step 2: Execute via Convex dashboard or CLI**

Run the backfill from the Convex dashboard's Functions tab or via:

```bash
npx convex run migrations/backfillTenantCalendlyConnections:backfillTenantCalendlyConnections
```

**Step 3: Verify**

Confirm in the Convex dashboard that `tenantCalendlyConnections` has one row per active/provisioned tenant, with `calendlyAccessToken` populated for tenants that had Calendly connected.

**Key implementation notes:**

- Field name mapping is intentional: `tenants.calendlyOrgUri` maps to `tenantCalendlyConnections.calendlyOrganizationUri`, and `tenants.calendlyOwnerUri` maps to `calendlyUserUri`. The new table uses the canonical names from the design spec.
- `tenants.webhookSigningKey` maps to `calendlyWebhookSigningKey` (prefixed for clarity in the dedicated table).
- The `connectionStatus` field is derived: `"connected"` if the tenant had an access token, `"disconnected"` otherwise. This is a new field not present on `tenants`.
- The script is idempotent — safe to re-run if interrupted.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/backfillTenantCalendlyConnections.ts` | Create | One-shot backfill script |

---

### 5B — Create OAuth Helper Module

**Type:** Backend
**Parallelizable:** No — 5C and 5D both depend on this module.

**What:** Create `convex/lib/tenantCalendlyConnection.ts` — a shared helper module that provides `getCalendlyConnection(ctx, tenantId)` for reading the connection record, plus type exports for consumers.

**Why:** Every OAuth consumer currently calls `internal.tenants.getCalendlyTokens` to read token state from the `tenants` table. Rather than duplicating the lookup logic across 8+ files, a centralized helper provides a single point of change and consistent error handling. This follows the existing pattern of shared helpers in `convex/lib/`.

**Where:**
- `convex/lib/tenantCalendlyConnection.ts` (create)

**How:**

**Step 1: Create the helper module**

```typescript
// Path: convex/lib/tenantCalendlyConnection.ts
import type { GenericQueryCtx } from "convex/server";
import type { DataModel, Id } from "../_generated/dataModel";

/**
 * Shape returned by getCalendlyConnection().
 * Matches the fields consumers previously read from tenants.getCalendlyTokens.
 */
export type CalendlyConnectionState = {
  _id: Id<"tenantCalendlyConnections">;
  tenantId: Id<"tenants">;
  calendlyAccessToken?: string;
  calendlyRefreshToken?: string;
  calendlyTokenExpiresAt?: number;
  calendlyRefreshLockUntil?: number;
  lastTokenRefreshAt?: number;
  codeVerifier?: string;
  calendlyOrganizationUri?: string;
  calendlyUserUri?: string;
  calendlyWebhookUri?: string;
  calendlyWebhookSigningKey?: string;
  connectionStatus?: "connected" | "disconnected" | "token_expired";
  lastHealthCheckAt?: number;
};

/**
 * Fetch the Calendly connection record for a tenant.
 *
 * Returns null if no connection row exists (tenant never connected Calendly).
 * Usable from queries, mutations, and (via runQuery) actions.
 */
export async function getCalendlyConnection(
  ctx: GenericQueryCtx<DataModel>,
  tenantId: Id<"tenants">,
): Promise<CalendlyConnectionState | null> {
  const connection = await ctx.db
    .query("tenantCalendlyConnections")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .first();

  return connection;
}

/**
 * Fetch the Calendly connection record, throwing if not found.
 * Use in paths where a connection is expected to exist (e.g., token refresh).
 */
export async function requireCalendlyConnection(
  ctx: GenericQueryCtx<DataModel>,
  tenantId: Id<"tenants">,
): Promise<CalendlyConnectionState> {
  const connection = await getCalendlyConnection(ctx, tenantId);
  if (!connection) {
    throw new Error(
      `No Calendly connection found for tenant ${tenantId}`,
    );
  }
  return connection;
}
```

**Step 2: Create internal query wrappers for action consumers**

Actions cannot call `ctx.db` directly — they use `ctx.runQuery`. Create thin internal query wrappers that actions can call:

```typescript
// Path: convex/calendly/connectionQueries.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import {
  getCalendlyConnection,
  requireCalendlyConnection,
} from "../lib/tenantCalendlyConnection";

/**
 * Internal query: fetch Calendly connection state for a tenant.
 * Replaces internal.tenants.getCalendlyTokens for OAuth-specific reads.
 */
export const getConnection = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await getCalendlyConnection(ctx, tenantId);
  },
});

/**
 * Internal query: fetch connection, throw if missing.
 */
export const requireConnection = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await requireCalendlyConnection(ctx, tenantId);
  },
});

/**
 * Internal query: fetch connection for webhook signature verification.
 * Accepts string tenantId (from URL param) and normalizes it.
 * Replaces webhooks/calendlyQueries.getTenantSigningKey.
 */
export const getSigningKeyByTenantId = internalQuery({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    const normalizedTenantId = ctx.db.normalizeId("tenants", tenantId);
    if (!normalizedTenantId) {
      return null;
    }

    const connection = await getCalendlyConnection(ctx, normalizedTenantId);
    if (!connection?.calendlyWebhookSigningKey) {
      return null;
    }

    return {
      tenantId: normalizedTenantId,
      webhookSigningKey: connection.calendlyWebhookSigningKey,
    };
  },
});
```

**Key implementation notes:**

- The helper uses `GenericQueryCtx<DataModel>` so it works from both queries and mutations (both have `ctx.db`).
- The `CalendlyConnectionState` type mirrors what consumers previously got from `getCalendlyTokens`, but with the new field names. Callers will need to update field references (e.g., `calendlyOrgUri` to `calendlyOrganizationUri`).
- `connectionQueries.ts` lives in `convex/calendly/` to keep OAuth-related queries co-located with the rest of the Calendly module.
- The `getSigningKeyByTenantId` query replicates the tenantId normalization logic from `webhooks/calendlyQueries.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/tenantCalendlyConnection.ts` | Create | Shared helper: `getCalendlyConnection()`, `requireCalendlyConnection()`, types |
| `convex/calendly/connectionQueries.ts` | Create | Internal query wrappers for action consumers |

---

### 5C — Switch OAuth Readers

**Type:** Backend
**Parallelizable:** Yes — can run in parallel with 5D (no shared files).

**What:** Update all files that **read** OAuth state from the `tenants` table to read from `tenantCalendlyConnections` instead, using the helper module from 5B.

**Why:** Once readers are switched, the high-frequency token refresh writes to `tenants` no longer invalidate reactive queries that need OAuth data. This is the core win of the extraction.

**Where:**
- `convex/calendly/tokens.ts` (modify)
- `convex/calendly/healthCheck.ts` (modify)
- `convex/calendly/orgMembers.ts` (modify)
- `convex/calendly/oauth.ts` (modify)
- `convex/calendly/oauthQueries.ts` (modify)
- `convex/webhooks/calendly.ts` (modify)
- `convex/testing/calendly.ts` (modify)
- `convex/admin/tenants.ts` (modify)

**How:**

**Step 1: Update `tokens.ts` — `getTenantTokenState` and `refreshAllTokens`**

The `getTenantTokenState` helper reads OAuth fields. Switch it to call `connectionQueries.getConnection`:

```typescript
// Path: convex/calendly/tokens.ts

// BEFORE:
async function getTenantTokenState(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<TenantTokenState | null> {
  const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
    tenantId,
  });
  return tenant as TenantTokenState | null;
}

// AFTER:
async function getTenantTokenState(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<TenantTokenState | null> {
  const connection = await ctx.runQuery(
    internal.calendly.connectionQueries.getConnection,
    { tenantId },
  );
  if (!connection) return null;

  // Also need tenant status (stays on tenants table)
  const tenant = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
    tenantId,
  });
  if (!tenant) return null;

  return {
    calendlyAccessToken: connection.calendlyAccessToken,
    calendlyRefreshToken: connection.calendlyRefreshToken,
    calendlyTokenExpiresAt: connection.calendlyTokenExpiresAt,
    calendlyRefreshLockUntil: connection.calendlyRefreshLockUntil,
    calendlyOrgUri: connection.calendlyOrganizationUri,
    calendlyOwnerUri: connection.calendlyUserUri,
    status: tenant.status,
  };
}
```

Note: `tenant.status` remains on the `tenants` table (it is stable identity data, not OAuth churn). The `TenantTokenState` type stays the same to minimize downstream changes within `tokens.ts`.

**Step 2: Update `healthCheck.ts` — `runTenantHealthCheck`**

```typescript
// Path: convex/calendly/healthCheck.ts

// BEFORE:
const tenant = (await ctx.runQuery(internal.tenants.getCalendlyTokens, {
  tenantId,
})) as TenantHealthState | null;

// AFTER:
const connection = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
const tenantRecord = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
  tenantId,
});
if (!connection || !tenantRecord) {
  return { status: "skipped" as const, reason: "missing_tokens_or_org" };
}

const tenant: TenantHealthState = {
  calendlyAccessToken: connection.calendlyAccessToken,
  calendlyOrgUri: connection.calendlyOrganizationUri,
  calendlyWebhookUri: connection.calendlyWebhookUri,
  webhookSigningKey: connection.calendlyWebhookSigningKey,
  status: tenantRecord.status,
};
```

**Step 3: Update `orgMembers.ts` — `syncTenantOrgMembers`**

```typescript
// Path: convex/calendly/orgMembers.ts

// BEFORE:
const tenant = (await ctx.runQuery(internal.tenants.getCalendlyTokens, {
  tenantId,
})) as TenantMemberState | null;

// AFTER:
const connection = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
const tenantRecord = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
  tenantId,
});
if (!connection || !tenantRecord) {
  return { synced: 0, reason: "missing_org_uri" as const };
}

const tenant: TenantMemberState = {
  calendlyOrgUri: connection.calendlyOrganizationUri,
  status: tenantRecord.status,
};
```

**Step 4: Update `oauth.ts` — `prepareReconnect` and `exchangeCodeAndProvision`**

In `prepareReconnect`, the token read for revocation:

```typescript
// Path: convex/calendly/oauth.ts

// BEFORE (in prepareReconnect):
const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
  tenantId,
});

// AFTER:
const connection = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
if (!connection) {
  throw new Error("No Calendly connection found");
}

// Use connection fields for revocation:
const accessToken = await revokeCalendlyToken(connection.calendlyAccessToken);
const refreshToken = await revokeCalendlyToken(connection.calendlyRefreshToken);
```

In `exchangeCodeAndProvision`, the code verifier read and post-store verification:

```typescript
// Path: convex/calendly/oauth.ts

// BEFORE (code verifier read):
const tenantData = await ctx.runQuery(
  internal.calendly.oauthMutations.getCodeVerifier,
  { tenantId },
);

// AFTER (reads from connectionQueries):
const connection = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
if (!connection?.codeVerifier) {
  throw new Error("No code verifier found — OAuth flow may have expired");
}
```

And for the post-token-store webhook signing key read:

```typescript
// BEFORE:
const tenantAfterTokenStore = await ctx.runQuery(
  internal.tenants.getCalendlyTokens,
  { tenantId },
);
if (!tenantAfterTokenStore?.calendlyOrgUri) { ... }
// signingKey: tenantAfterTokenStore.webhookSigningKey ?? undefined,

// AFTER:
const connectionAfterTokenStore = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
if (!connectionAfterTokenStore?.calendlyOrganizationUri) { ... }
// signingKey: connectionAfterTokenStore.calendlyWebhookSigningKey ?? undefined,
```

**Step 5: Update `oauthQueries.ts` — `getConnectionStatus`**

```typescript
// Path: convex/calendly/oauthQueries.ts

// BEFORE:
const tenant = await ctx.db.get(tenantId);
// ...reads tenant.calendlyTokenExpiresAt, tenant.calendlyWebhookUri, etc.

// AFTER:
import { getCalendlyConnection } from "../lib/tenantCalendlyConnection";

const tenant = await ctx.db.get(tenantId);
if (!tenant) return null;

const connection = await getCalendlyConnection(ctx, tenantId);

const result = {
  tenantId: tenant._id,
  status: tenant.status,
  needsReconnect: tenant.status === "calendly_disconnected",
  lastTokenRefresh: connection?.lastTokenRefreshAt ?? null,
  tokenExpiresAt: connection?.calendlyTokenExpiresAt ?? null,
  calendlyWebhookUri: connection?.calendlyWebhookUri ?? null,
  hasWebhookSigningKey: Boolean(connection?.calendlyWebhookSigningKey),
  hasAccessToken: Boolean(connection?.calendlyAccessToken),
  hasRefreshToken: Boolean(connection?.calendlyRefreshToken),
};
```

Note: `oauthQueries.ts` is a query (not an action), so it can use the direct helper function via `ctx.db` rather than `ctx.runQuery`.

**Step 6: Update `webhooks/calendly.ts` — webhook signature verification**

```typescript
// Path: convex/webhooks/calendly.ts

// BEFORE:
const tenant = await ctx.runQuery(
  internal.webhooks.calendlyQueries.getTenantSigningKey,
  { tenantId: tenantIdParam },
);

// AFTER:
const tenant = await ctx.runQuery(
  internal.calendly.connectionQueries.getSigningKeyByTenantId,
  { tenantId: tenantIdParam },
);
```

The return shape is identical (`{ tenantId, webhookSigningKey }` or `null`), so no downstream changes needed.

**Step 7: Update `testing/calendly.ts` — `getTenantCalendlyAccess`**

```typescript
// Path: convex/testing/calendly.ts

// BEFORE:
const tenant: TenantCalendlyTokens | null = await ctx.runQuery(
  internal.tenants.getCalendlyTokens,
  { tenantId },
);

// AFTER:
const connection = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
const tenantRecord = await ctx.runQuery(internal.tenants.getCalendlyTenant, {
  tenantId,
});

// Map to expected shape:
const tenant: TenantCalendlyTokens | null = connection && tenantRecord
  ? {
      calendlyOrgUri: connection.calendlyOrganizationUri,
      calendlyOwnerUri: connection.calendlyUserUri,
      status: tenantRecord.status,
    }
  : null;
```

**Step 8: Update `admin/tenants.ts` — `resolveCalendlyAccessToken` and `cleanupCalendlyTokens`**

```typescript
// Path: convex/admin/tenants.ts

// In resolveCalendlyAccessToken, change the direct tenant field reads:
// BEFORE:
const hasUsableStoredToken =
  tenant.calendlyAccessToken &&
  (!tenant.calendlyTokenExpiresAt || tenant.calendlyTokenExpiresAt > now + 60_000);
if (hasUsableStoredToken) {
  return tenant.calendlyAccessToken;
}

// AFTER: Fetch connection for token check
const connection = await ctx.runQuery(
  internal.calendly.connectionQueries.getConnection,
  { tenantId },
);
const hasUsableStoredToken =
  connection?.calendlyAccessToken &&
  (!connection.calendlyTokenExpiresAt || connection.calendlyTokenExpiresAt > now + 60_000);
if (hasUsableStoredToken) {
  return connection.calendlyAccessToken;
}
```

Similarly for `cleanupCalendlyTokens` and `cleanupCalendlyWebhook`:

```typescript
// BEFORE (cleanupCalendlyTokens):
const accessToken = await revokeCalendlyToken(tenant.calendlyAccessToken);
const refreshToken = await revokeCalendlyToken(tenant.calendlyRefreshToken);

// AFTER: Read tokens from connection (passed in or fetched)
// The caller already has the connection data from the earlier fetch
```

**Key implementation notes:**

- **Tenant status stays on `tenants`**: The `status` field (e.g., `"active"`, `"calendly_disconnected"`) is tenant identity state, not OAuth churn. It remains on the `tenants` table and is read separately via `getCalendlyTenant`.
- **Field name mapping**: Callers must update references: `calendlyOrgUri` to `calendlyOrganizationUri`, `calendlyOwnerUri` to `calendlyUserUri`, `webhookSigningKey` to `calendlyWebhookSigningKey`. This is intentional — the new table uses canonical names.
- **Two-query pattern in actions**: Actions that previously made one `getCalendlyTokens` call now make two calls: one to `connectionQueries.getConnection` (OAuth data) and one to `tenants.getCalendlyTenant` (status). This is the intended split — OAuth reads no longer subscribe to `tenants`.
- **Query-context consumers** (`oauthQueries.ts`) can use the direct `getCalendlyConnection(ctx, tenantId)` helper instead of going through `runQuery`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/tokens.ts` | Modify | `getTenantTokenState` reads from connection + tenant status |
| `convex/calendly/healthCheck.ts` | Modify | `runTenantHealthCheck` reads from connection |
| `convex/calendly/orgMembers.ts` | Modify | `syncTenantOrgMembers` reads org URI from connection |
| `convex/calendly/oauth.ts` | Modify | `prepareReconnect` + `exchangeCodeAndProvision` read from connection |
| `convex/calendly/oauthQueries.ts` | Modify | `getConnectionStatus` reads OAuth fields from connection |
| `convex/webhooks/calendly.ts` | Modify | Webhook handler reads signing key from `connectionQueries` |
| `convex/testing/calendly.ts` | Modify | `getTenantCalendlyAccess` reads from connection |
| `convex/admin/tenants.ts` | Modify | Offboarding reads tokens/webhook from connection |

---

### 5D — Switch OAuth Writers

**Type:** Backend
**Parallelizable:** Yes — can run in parallel with 5C (no shared files).

**What:** Update all files that **write** OAuth state to the `tenants` table to write to `tenantCalendlyConnections` instead.

**Why:** Once writes target the new table, the `tenants` document is no longer mutated by token refreshes, lock acquisitions, webhook storage, or code verifier management. This eliminates the 16 daily reactive invalidations on every `tenants` subscriber.

**Where:**
- `convex/calendly/tokenMutations.ts` (modify)
- `convex/calendly/oauthMutations.ts` (modify)
- `convex/calendly/webhookSetupMutations.ts` (modify)
- `convex/tenants.ts` (modify)
- `convex/admin/tenantsMutations.ts` (modify)

**How:**

**Step 1: Update `tokenMutations.ts` — lock acquisition, release, and tenant listing**

```typescript
// Path: convex/calendly/tokenMutations.ts
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireCalendlyConnection } from "../lib/tenantCalendlyConnection";

export const acquireRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants"), lockUntil: v.number() },
  handler: async (ctx, { tenantId, lockUntil }) => {
    console.log(
      `[token-refresh] acquireRefreshLock: attempting for tenant ${tenantId}`,
    );
    const connection = await requireCalendlyConnection(ctx, tenantId);

    const now = Date.now();
    if (
      connection.calendlyRefreshLockUntil &&
      connection.calendlyRefreshLockUntil > now
    ) {
      console.warn(
        `[token-refresh] acquireRefreshLock: lock already held`,
      );
      return { acquired: false as const, lockUntil: connection.calendlyRefreshLockUntil };
    }

    await ctx.db.patch(connection._id, { calendlyRefreshLockUntil: lockUntil });
    console.log(`[token-refresh] acquireRefreshLock: lock acquired`);
    return { acquired: true as const, lockUntil };
  },
});

export const releaseRefreshLock = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[token-refresh] releaseRefreshLock: releasing for tenant ${tenantId}`);
    const connection = await requireCalendlyConnection(ctx, tenantId);
    await ctx.db.patch(connection._id, { calendlyRefreshLockUntil: undefined });
  },
});

export const listActiveTenantIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    console.log(`[token-refresh] listActiveTenantIds: querying active tenants`);
    const tenantIds: Array<Id<"tenants">> = [];
    for await (const tenant of ctx.db
      .query("tenants")
      .withIndex("by_status", (q) => q.eq("status", "active"))) {
      tenantIds.push(tenant._id);
    }
    console.log(
      `[token-refresh] listActiveTenantIds: found ${tenantIds.length} active tenants`,
    );
    return tenantIds;
  },
});
```

Note: `listActiveTenantIds` still queries the `tenants` table — tenant `status` is identity data, not OAuth state. This is correct.

**Step 2: Update `tenants.ts` — `storeCalendlyTokens` and `clearCalendlyConnection`**

```typescript
// Path: convex/tenants.ts

// BEFORE (storeCalendlyTokens):
export const storeCalendlyTokens = internalMutation({
  // ...
  handler: async (ctx, args) => {
    const { tenantId, calendlyRefreshLockUntil, ...fields } = args;
    await ctx.db.patch(tenantId, {
      ...fields,
      calendlyRefreshLockUntil: calendlyRefreshLockUntil ?? undefined,
      lastTokenRefreshAt: Date.now(),
    });
  },
});

// AFTER: Write to tenantCalendlyConnections
import { requireCalendlyConnection } from "./lib/tenantCalendlyConnection";

export const storeCalendlyTokens = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyAccessToken: v.string(),
    calendlyRefreshToken: v.string(),
    calendlyTokenExpiresAt: v.number(),
    calendlyOrgUri: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyRefreshLockUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId, calendlyRefreshLockUntil, ...tokenFields } = args;
    console.log("[Tenants] storeCalendlyTokens called", { tenantId });

    const connection = await requireCalendlyConnection(ctx, tenantId);

    await ctx.db.patch(connection._id, {
      calendlyAccessToken: tokenFields.calendlyAccessToken,
      calendlyRefreshToken: tokenFields.calendlyRefreshToken,
      calendlyTokenExpiresAt: tokenFields.calendlyTokenExpiresAt,
      calendlyOrganizationUri: tokenFields.calendlyOrgUri,
      calendlyUserUri: tokenFields.calendlyOwnerUri,
      calendlyRefreshLockUntil: calendlyRefreshLockUntil ?? undefined,
      lastTokenRefreshAt: Date.now(),
      connectionStatus: "connected",
    });

    console.log("[Tenants] storeCalendlyTokens: written to tenantCalendlyConnections");
  },
});
```

```typescript
// Path: convex/tenants.ts

// BEFORE (clearCalendlyConnection):
export const clearCalendlyConnection = internalMutation({
  handler: async (ctx, { tenantId, status }) => {
    await ctx.db.patch(tenantId, {
      status,
      codeVerifier: undefined,
      calendlyAccessToken: undefined,
      // ...all OAuth fields cleared on tenants
    });
  },
});

// AFTER: Clear the connection row, update tenant status only
export const clearCalendlyConnection = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("pending_calendly"),
      v.literal("calendly_disconnected"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    console.log("[Tenants] clearCalendlyConnection called", { tenantId, status });

    // Update tenant status (identity data)
    await ctx.db.patch(tenantId, {
      status,
      webhookProvisioningStartedAt: undefined,
    });

    // Clear OAuth data on the connection row
    const connection = await ctx.db
      .query("tenantCalendlyConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (connection) {
      await ctx.db.patch(connection._id, {
        codeVerifier: undefined,
        calendlyAccessToken: undefined,
        calendlyRefreshToken: undefined,
        calendlyTokenExpiresAt: undefined,
        calendlyOrganizationUri: undefined,
        calendlyUserUri: undefined,
        calendlyRefreshLockUntil: undefined,
        lastTokenRefreshAt: undefined,
        calendlyWebhookUri: undefined,
        calendlyWebhookSigningKey: undefined,
        connectionStatus: "disconnected",
      });
    }

    console.log("[Tenants] clearCalendlyConnection completed", { tenantId, status });
  },
});
```

**Step 3: Update `oauthMutations.ts` — code verifier storage**

```typescript
// Path: convex/calendly/oauthMutations.ts
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { requireCalendlyConnection } from "../lib/tenantCalendlyConnection";

export const storeCodeVerifier = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    codeVerifier: v.string(),
  },
  handler: async (ctx, { tenantId, codeVerifier }) => {
    console.log(`[Calendly:OAuth] storeCodeVerifier: storing for tenant ${tenantId}`);
    const connection = await requireCalendlyConnection(ctx, tenantId);
    await ctx.db.patch(connection._id, { codeVerifier });
  },
});

export const getCodeVerifier = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[Calendly:OAuth] getCodeVerifier: retrieving for tenant ${tenantId}`);
    const connection = await ctx.db
      .query("tenantCalendlyConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!connection) {
      console.warn(`[Calendly:OAuth] getCodeVerifier: no connection for tenant ${tenantId}`);
      return null;
    }
    return { codeVerifier: connection.codeVerifier };
  },
});

export const clearCodeVerifier = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    console.log(`[Calendly:OAuth] clearCodeVerifier: clearing for tenant ${tenantId}`);
    const connection = await requireCalendlyConnection(ctx, tenantId);
    await ctx.db.patch(connection._id, { codeVerifier: undefined });
  },
});
```

**Step 4: Update `webhookSetupMutations.ts` — webhook storage**

```typescript
// Path: convex/calendly/webhookSetupMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import { requireCalendlyConnection } from "../lib/tenantCalendlyConnection";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyWebhookUri: v.string(),
    webhookSigningKey: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyWebhookUri, webhookSigningKey }) => {
    console.log(
      `[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId}`,
    );

    // Store webhook config on the connection row
    const connection = await requireCalendlyConnection(ctx, tenantId);
    await ctx.db.patch(connection._id, {
      calendlyWebhookUri,
      calendlyWebhookSigningKey: webhookSigningKey,
      connectionStatus: "connected",
    });

    // Activate the tenant (identity/status data stays on tenants)
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) {
      throw new Error("Tenant not found");
    }

    await ctx.db.patch(tenantId, {
      status: "active" as const,
      onboardingCompletedAt: tenant.onboardingCompletedAt ?? Date.now(),
      webhookProvisioningStartedAt: undefined,
    });

    console.log(
      `[Webhook:Setup] storeWebhookAndActivate: tenant ${tenantId} activated`,
    );
  },
});
```

**Step 5: Update `admin/tenantsMutations.ts` — tenant deletion cleanup**

Add cleanup of the `tenantCalendlyConnections` row to the batch deletion:

```typescript
// Path: convex/admin/tenantsMutations.ts

// Inside deleteTenantRuntimeDataBatch handler, add:
const connections = await ctx.db
  .query("tenantCalendlyConnections")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .take(CLEANUP_BATCH_SIZE);

for (const connection of connections) {
  await ctx.db.delete(connection._id);
}
console.log("[Admin] deleteTenantRuntimeDataBatch: tenantCalendlyConnections deleted", {
  tenantId,
  count: connections.length,
});
```

**Key implementation notes:**

- **`storeCalendlyTokens` arg names are unchanged**: The function signature keeps `calendlyOrgUri` and `calendlyOwnerUri` as arg names (callers pass these), but the handler maps them to the new table's `calendlyOrganizationUri` and `calendlyUserUri` internally. This minimizes changes in callers (`tokens.ts`, `oauth.ts`).
- **`clearCalendlyConnection` splits writes**: Tenant `status` is patched on `tenants` (identity), OAuth fields are cleared on `tenantCalendlyConnections`.
- **`storeWebhookAndActivate` splits writes**: Webhook config goes to connection, `status: "active"` and `onboardingCompletedAt` go to tenant.
- **`listActiveTenantIds` is unchanged**: It queries `tenants.by_status` — tenant status is identity data, not being extracted.
- **Connection creation during onboarding**: If `startOAuth` is called for a tenant that has no connection row yet (new tenant, first Calendly connection), `storeCodeVerifier` will fail. Add a fallback in `storeCodeVerifier` to create the row if missing:

```typescript
// Path: convex/calendly/oauthMutations.ts (storeCodeVerifier, create-if-missing)
const connection = await ctx.db
  .query("tenantCalendlyConnections")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .first();

if (connection) {
  await ctx.db.patch(connection._id, { codeVerifier });
} else {
  await ctx.db.insert("tenantCalendlyConnections", {
    tenantId,
    codeVerifier,
    connectionStatus: "disconnected",
  });
}
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/tokenMutations.ts` | Modify | Lock acquire/release writes to connection row |
| `convex/calendly/oauthMutations.ts` | Modify | Code verifier read/write/clear on connection row; create-if-missing |
| `convex/calendly/webhookSetupMutations.ts` | Modify | Webhook storage on connection row; tenant status on tenants |
| `convex/tenants.ts` | Modify | `storeCalendlyTokens` and `clearCalendlyConnection` write to connection |
| `convex/admin/tenantsMutations.ts` | Modify | Batch deletion includes `tenantCalendlyConnections` cleanup |

---

### 5E — Verify and Clean Up

**Type:** Backend / Validation
**Parallelizable:** No — must run after both 5C and 5D complete.

**What:** Validate that no OAuth reads or writes touch the `tenants` table, run a health check to confirm end-to-end OAuth flow, and document the deprecated `tenants` fields for Phase 6 removal.

**Why:** Before declaring Phase 5 complete, we must confirm the extraction is total: the `tenants` document is no longer mutated by token refresh, and all reactive queries subscribed to `tenants` data are isolated from OAuth churn.

**Where:**
- `convex/tenants.ts` (modify — remove now-dead functions)
- `convex/webhooks/calendlyQueries.ts` (modify — deprecation notice or removal)

**How:**

**Step 1: Grep audit — confirm no OAuth field references in consumers**

Run a comprehensive grep to verify no consumer code reads or writes OAuth fields from `tenants`:

```bash
# From repo root:
grep -rn 'tenant\.calendlyAccessToken\|tenant\.calendlyRefreshToken\|tenant\.calendlyOrgUri\|tenant\.calendlyOwnerUri\|tenant\.webhookSigningKey\|tenant\.codeVerifier\|tenant\.calendlyRefreshLockUntil\|tenant\.lastTokenRefreshAt\|tenant\.calendlyWebhookUri\|tenant\.calendlyTokenExpiresAt' convex/
```

Expected results: hits only in `convex/schema.ts` (the deprecated field definitions) and `convex/migrations/backfillTenantCalendlyConnections.ts` (the backfill script reads them). Zero hits in any consumer file.

**Step 2: Remove dead code from `convex/tenants.ts`**

The `getCalendlyTokens` internal query is now unused (all callers switched to `connectionQueries`). Remove it:

```typescript
// Path: convex/tenants.ts
// DELETE the entire getCalendlyTokens function (lines ~41-76)
// All callers now use internal.calendly.connectionQueries.getConnection
```

Also verify `getCalendlyTenant` is still needed (it provides `status`, `workosOrgId`, `companyName` — yes, still needed for tenant identity reads).

**Step 3: Deprecate or remove `webhooks/calendlyQueries.ts`**

The `getTenantSigningKey` query has been replaced by `connectionQueries.getSigningKeyByTenantId`. If no other consumers reference it, remove the file:

```bash
grep -rn 'calendlyQueries' convex/
```

If the only reference is in `convex/webhooks/calendly.ts` (which was updated in 5C), delete `convex/webhooks/calendlyQueries.ts`.

**Step 4: Health check validation**

Trigger a manual health check to confirm the end-to-end flow works:

1. From the Convex dashboard, run `internal.calendly.healthCheck.checkSingleTenant` for the test tenant.
2. Verify it completes with `status: "checked"`, `tokenActive: true`.
3. Trigger a manual token refresh via `internal.calendly.tokens.refreshTenantToken` for the test tenant.
4. Verify it returns `refreshed: true`.
5. Wait for the next cron cycle (90 min) and confirm the `tenants` document `_modifiedTime` does NOT change, while `tenantCalendlyConnections._modifiedTime` does.

**Step 5: Document Phase 6 removal scope**

The following `tenants` fields are now deprecated and will be removed in Phase 6 (subphase 6.8):

| Deprecated field | Moved to `tenantCalendlyConnections` as |
|---|---|
| `calendlyAccessToken` | `calendlyAccessToken` |
| `calendlyRefreshToken` | `calendlyRefreshToken` |
| `calendlyTokenExpiresAt` | `calendlyTokenExpiresAt` |
| `calendlyRefreshLockUntil` | `calendlyRefreshLockUntil` |
| `lastTokenRefreshAt` | `lastTokenRefreshAt` |
| `codeVerifier` | `codeVerifier` |
| `calendlyOrgUri` | `calendlyOrganizationUri` |
| `calendlyOwnerUri` | `calendlyUserUri` |
| `calendlyWebhookUri` | `calendlyWebhookUri` |
| `webhookSigningKey` | `calendlyWebhookSigningKey` |

Phase 6 will: (1) run a cleanup migration removing these fields from all tenant documents, (2) remove the field validators from `convex/schema.ts`, (3) deploy and confirm Convex accepts the narrowed schema.

**Key implementation notes:**

- The grep audit is the primary verification gate. If any consumer still references OAuth fields on `tenants`, 5C or 5D has a gap.
- Do NOT remove the deprecated fields from `convex/schema.ts` in Phase 5. Convex validates schema against all existing documents — the old field values are still on the tenant documents. Removal happens in Phase 6 after a cleanup backfill strips them.
- The `webhookProvisioningStartedAt` field stays on `tenants` — it tracks onboarding state, not OAuth state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenants.ts` | Modify | Remove dead `getCalendlyTokens` function |
| `convex/webhooks/calendlyQueries.ts` | Delete | Replaced by `calendly/connectionQueries.getSigningKeyByTenantId` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/migrations/backfillTenantCalendlyConnections.ts` | Create | 5A |
| `convex/lib/tenantCalendlyConnection.ts` | Create | 5B |
| `convex/calendly/connectionQueries.ts` | Create | 5B |
| `convex/calendly/tokens.ts` | Modify | 5C |
| `convex/calendly/healthCheck.ts` | Modify | 5C |
| `convex/calendly/orgMembers.ts` | Modify | 5C |
| `convex/calendly/oauth.ts` | Modify | 5C |
| `convex/calendly/oauthQueries.ts` | Modify | 5C |
| `convex/webhooks/calendly.ts` | Modify | 5C |
| `convex/testing/calendly.ts` | Modify | 5C |
| `convex/admin/tenants.ts` | Modify | 5C |
| `convex/calendly/tokenMutations.ts` | Modify | 5D |
| `convex/calendly/oauthMutations.ts` | Modify | 5D |
| `convex/calendly/webhookSetupMutations.ts` | Modify | 5D |
| `convex/tenants.ts` | Modify | 5D, 5E |
| `convex/admin/tenantsMutations.ts` | Modify | 5D |
| `convex/webhooks/calendlyQueries.ts` | Delete | 5E |

---

## Notes for Implementer

- **Field name mapping cheat sheet**: `calendlyOrgUri` -> `calendlyOrganizationUri`, `calendlyOwnerUri` -> `calendlyUserUri`, `webhookSigningKey` -> `calendlyWebhookSigningKey`. All other field names are identical between the old `tenants` fields and the new `tenantCalendlyConnections` table.
- **Two-query pattern**: Actions that previously called `getCalendlyTokens` once now call both `connectionQueries.getConnection` (OAuth) and `tenants.getCalendlyTenant` (status/identity). This is the intended split that eliminates cross-concern invalidation.
- **Create-on-first-connect**: For tenants connecting Calendly for the first time (backfill row has `connectionStatus: "disconnected"`), the `storeCodeVerifier` mutation handles the create-if-missing case. All subsequent writes use `requireCalendlyConnection`.
- **No schema changes in this phase**: The `tenantCalendlyConnections` table was created in Phase 1. The deprecated `tenants` fields are not removed until Phase 6. This phase only moves data and code.
- **Cron behavior**: After Phase 5, the 90-minute token refresh cron writes to `tenantCalendlyConnections` only. Queries subscribed to `tenants` (e.g., `getCurrentTenant`, `getCalendlyTenant`) are no longer invalidated.
