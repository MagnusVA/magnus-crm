# Phase 1 — Metadata Ownership Model

**Goal:** Widen the Convex schema and local helper layer so Calendly-owned metadata can live beside CRM-owned configuration without overwriting production settings. After this phase, existing rows remain valid, new writes record ownership source fields, and later sync phases can rely on generated types.

**Prerequisite:** The design spec in `plans/calendly-event-type-sync/calendly-event-type-sync-design.md` is accepted for Phase 1 scope. No backfill is required because all new fields are optional and the first sync performs the online Calendly metadata backfill.

**Runs in PARALLEL with:** Nothing — Phase 2, Phase 3, Phase 4, and Phase 5 all depend on the widened schema and helper contracts from this phase.

**Skills to invoke:**
- `convex` — schema validators, indexed queries, internal helper patterns, and generated Convex types.
- `convex-migration-helper` — confirm this is a widen-only schema deployment with no `@convex-dev/migrations` backfill.

**Acceptance Criteria:**
1. `eventTypeConfigs` accepts optional Calendly metadata fields without invalidating existing documents.
2. `tenantCalendlyConnections` accepts optional latest event type sync state and sync lock fields.
3. `rawWebhookEvents` accepts separated `webhookEventKey` and `calendlyResourceUri` fields and has a matching dedupe index.
4. `bookingUrlSource` accepts `"calendly_synced"` while preserving existing `"admin_entered"` and `"imported_sheet"` values.
5. Admin saves mark CRM-owned `displayName` and manually-entered booking URLs with source fields.
6. Lazy `invitee.created` fallback rows are marked `displayNameSource = "webhook_discovered"` and do not claim Calendly API sync.
7. Field-key normalization is exported from a shared helper so booking webhooks and event type sync use the same catalog keys.
8. `npx convex dev` accepts the widened schema and regenerates Convex types.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema widen) ───────────────┬── 1B (Connection state mapping)
                                 ├── 1C (Shared field helpers)
                                 └── 1D (Ownership-aware writes)

1B + 1C + 1D complete ───────────── 1E (Schema/type verification)
```

**Optimal execution:**
1. Complete 1A first and run Convex type generation.
2. Run 1B, 1C, and 1D in parallel because they touch separate helper/write paths.
3. Finish with 1E to catch generated type drift before Phase 2 imports the new fields.

**Estimated time:** 0.5-1 day

---

## Subphases

### 1A — Widen Convex Schema

**Type:** Backend
**Parallelizable:** No — all later subphases depend on generated types from this schema.

**What:** Add optional Calendly sync metadata, sync lock/status fields, webhook idempotency fields, and the `"calendly_synced"` booking URL source literal.

**Why:** Convex rejects schema changes that do not match existing data. Widening with optional fields lets code deploy safely before any event type sync has run.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add optional Calendly-owned metadata to `eventTypeConfigs`.**

```typescript
// Path: convex/schema.ts

eventTypeConfigs: defineTable({
  tenantId: v.id("tenants"),
  calendlyEventTypeUri: v.string(),
  displayName: v.string(),
  paymentLinks: v.optional(
    v.array(
      v.object({
        provider: v.string(),
        label: v.string(),
        url: v.string(),
      }),
    ),
  ),
  createdAt: v.number(),

  // Existing CRM-owned fields remain unchanged.
  customFieldMappings: v.optional(
    v.object({
      socialHandleField: v.optional(v.string()),
      socialHandleType: v.optional(
        v.union(
          v.literal("instagram"),
          v.literal("tiktok"),
          v.literal("twitter"),
          v.literal("other_social"),
        ),
      ),
      phoneField: v.optional(v.string()),
    }),
  ),
  knownCustomFieldKeys: v.optional(v.array(v.string())),
  bookingProgramId: v.optional(v.id("tenantPrograms")),
  bookingProgramName: v.optional(v.string()),
  bookingProgramMappingStatus: v.optional(bookingProgramMappingStatusValidator),
  bookingBaseUrl: v.optional(v.string()),
  bookingUrlSource: v.optional(
    v.union(
      v.literal("admin_entered"),
      v.literal("imported_sheet"),
      v.literal("calendly_synced"),
    ),
  ),
  linkPortalEnabled: v.optional(v.boolean()),

  // Calendly-owned metadata. All optional for zero-downtime rollout.
  calendlyName: v.optional(v.string()),
  displayNameSource: v.optional(
    v.union(
      v.literal("admin_entered"),
      v.literal("calendly_synced"),
      v.literal("webhook_discovered"),
    ),
  ),
  calendlySchedulingUrl: v.optional(v.string()),
  calendlySlug: v.optional(v.string()),
  calendlyActive: v.optional(v.boolean()),
  calendlyDeletedAt: v.optional(v.string()),
  calendlyCreatedAt: v.optional(v.string()),
  calendlyUpdatedAt: v.optional(v.string()),
  calendlyDurationMinutes: v.optional(v.number()),
  calendlyKind: v.optional(v.string()),
  calendlyType: v.optional(v.string()),
  calendlyBookingMethod: v.optional(v.string()),
  calendlyPoolingType: v.optional(v.string()),
  calendlySecret: v.optional(v.boolean()),
  calendlyAdminManaged: v.optional(v.boolean()),
  calendlyColor: v.optional(v.string()),
  calendlyLocale: v.optional(v.string()),
  calendlyOwnerUri: v.optional(v.string()),
  calendlyProfileName: v.optional(v.string()),
  calendlySyncStatus: v.optional(
    v.union(
      v.literal("active"),
      v.literal("inactive"),
      v.literal("deleted"),
      v.literal("not_returned"),
    ),
  ),
  lastCalendlySeenAt: v.optional(v.number()),
  lastCalendlySyncedAt: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_calendlyEventTypeUri", [
    "tenantId",
    "calendlyEventTypeUri",
  ])
  .index("by_tenantId_and_bookingProgramId", [
    "tenantId",
    "bookingProgramId",
  ]),
```

**Step 2: Add lightweight latest sync state to `tenantCalendlyConnections`.**

```typescript
// Path: convex/schema.ts

tenantCalendlyConnections: defineTable({
  tenantId: v.id("tenants"),
  calendlyAccessToken: v.optional(v.string()),
  calendlyRefreshToken: v.optional(v.string()),
  calendlyTokenExpiresAt: v.optional(v.number()),
  calendlyRefreshLockUntil: v.optional(v.number()),
  lastTokenRefreshAt: v.optional(v.number()),
  codeVerifier: v.optional(v.string()),
  calendlyOrganizationUri: v.optional(v.string()),
  calendlyUserUri: v.optional(v.string()),
  calendlyWebhookUri: v.optional(v.string()),
  calendlyWebhookSigningKey: v.optional(v.string()),
  connectionStatus: v.optional(
    v.union(
      v.literal("connected"),
      v.literal("disconnected"),
      v.literal("token_expired"),
    ),
  ),
  lastHealthCheckAt: v.optional(v.number()),
  webhookProvisioningStartedAt: v.optional(v.number()),
  eventTypeSyncLockUntil: v.optional(v.number()),
  lastEventTypeSyncStartedAt: v.optional(v.number()),
  lastEventTypeSyncCompletedAt: v.optional(v.number()),
  lastEventTypeSyncStatus: v.optional(
    v.union(v.literal("success"), v.literal("failed"), v.literal("skipped")),
  ),
  lastEventTypeSyncError: v.optional(v.string()),
  lastEventTypeSyncCount: v.optional(v.number()),
}).index("by_tenantId", ["tenantId"]),
```

**Step 3: Separate webhook delivery idempotency from Calendly resource identity.**

```typescript
// Path: convex/schema.ts

rawWebhookEvents: defineTable({
  tenantId: v.id("tenants"),
  calendlyEventUri: v.string(),
  webhookEventKey: v.optional(v.string()),
  calendlyResourceUri: v.optional(v.string()),
  eventType: v.string(),
  payload: v.string(),
  processed: v.boolean(),
  receivedAt: v.number(),
})
  .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
  .index("by_tenantId_and_receivedAt", ["tenantId", "receivedAt"])
  .index("by_calendlyEventUri", ["calendlyEventUri"])
  .index("by_processed", ["processed"])
  .index("by_processed_and_receivedAt", ["processed", "receivedAt"])
  .index("by_tenantId_and_eventType_and_calendlyEventUri", [
    "tenantId",
    "eventType",
    "calendlyEventUri",
  ])
  .index("by_tenantId_and_eventType_and_webhookEventKey", [
    "tenantId",
    "eventType",
    "webhookEventKey",
  ]),
```

**Key implementation notes:**
- Do not make any new field required in MVP.
- Do not add a `calendlySyncStatus` index yet; Settings and portal reads are tenant-scoped.
- Keep the legacy `calendlyEventUri` field because existing scheduling webhooks already use it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Widen three existing tables and one union literal |

---

### 1B — Map New Connection Fields

**Type:** Backend
**Parallelizable:** Yes — depends on 1A schema types only.

**What:** Extend the tenant Calendly connection helper and internal/public connection queries so later phases can read and write event type sync lock/status.

**Why:** The codebase centralizes connection storage in `convex/lib/tenantCalendlyConnection.ts`; bypassing it would create drift between stored field names and app-facing state names.

**Where:**
- `convex/lib/tenantCalendlyConnection.ts` (modify)
- `convex/calendly/connectionQueries.ts` (modify)
- `convex/calendly/oauthQueries.ts` (modify)

**How:**

**Step 1: Extend helper state and patch types.**

```typescript
// Path: convex/lib/tenantCalendlyConnection.ts

export type TenantCalendlyConnectionState = {
  connectionId: Id<"tenantCalendlyConnections"> | null;
  tenantId: Id<"tenants">;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  refreshLockUntil?: number;
  lastRefreshedAt?: number;
  pkceVerifier?: string;
  organizationUri?: string;
  userUri?: string;
  webhookUri?: string;
  webhookSecret?: string;
  connectionStatus?: StoredCalendlyConnectionStatus;
  lastHealthCheckAt?: number;
  webhookProvisioningStartedAt?: number;
  eventTypeSyncLockUntil?: number;
  lastEventTypeSyncStartedAt?: number;
  lastEventTypeSyncCompletedAt?: number;
  lastEventTypeSyncStatus?: "success" | "failed" | "skipped";
  lastEventTypeSyncError?: string;
  lastEventTypeSyncCount?: number;
};

export type TenantCalendlyConnectionPatch = {
  accessToken?: string | undefined;
  refreshToken?: string | undefined;
  tokenExpiresAt?: number | undefined;
  refreshLockUntil?: number | undefined;
  lastRefreshedAt?: number | undefined;
  pkceVerifier?: string | undefined;
  organizationUri?: string | undefined;
  userUri?: string | undefined;
  webhookUri?: string | undefined;
  webhookSecret?: string | undefined;
  connectionStatus?: StoredCalendlyConnectionStatus | undefined;
  lastHealthCheckAt?: number | undefined;
  webhookProvisioningStartedAt?: number | undefined;
  eventTypeSyncLockUntil?: number | undefined;
  lastEventTypeSyncStartedAt?: number | undefined;
  lastEventTypeSyncCompletedAt?: number | undefined;
  lastEventTypeSyncStatus?: "success" | "failed" | "skipped" | undefined;
  lastEventTypeSyncError?: string | undefined;
  lastEventTypeSyncCount?: number | undefined;
};
```

**Step 2: Map stored fields both directions.**

```typescript
// Path: convex/lib/tenantCalendlyConnection.ts

function mapStoredConnection(
  connection: StoredCalendlyConnection,
): TenantCalendlyConnectionState {
  return {
    connectionId: connection._id,
    tenantId: connection.tenantId,
    accessToken: connection.calendlyAccessToken,
    refreshToken: connection.calendlyRefreshToken,
    tokenExpiresAt: connection.calendlyTokenExpiresAt,
    refreshLockUntil: connection.calendlyRefreshLockUntil,
    lastRefreshedAt: connection.lastTokenRefreshAt,
    pkceVerifier: connection.codeVerifier,
    organizationUri: connection.calendlyOrganizationUri,
    userUri: connection.calendlyUserUri,
    webhookUri: connection.calendlyWebhookUri,
    webhookSecret: connection.calendlyWebhookSigningKey,
    connectionStatus: deriveConnectionStatus({
      accessToken: connection.calendlyAccessToken,
      refreshToken: connection.calendlyRefreshToken,
      connectionStatus: connection.connectionStatus,
    }),
    lastHealthCheckAt: connection.lastHealthCheckAt,
    webhookProvisioningStartedAt: connection.webhookProvisioningStartedAt,
    eventTypeSyncLockUntil: connection.eventTypeSyncLockUntil,
    lastEventTypeSyncStartedAt: connection.lastEventTypeSyncStartedAt,
    lastEventTypeSyncCompletedAt: connection.lastEventTypeSyncCompletedAt,
    lastEventTypeSyncStatus: connection.lastEventTypeSyncStatus,
    lastEventTypeSyncError: connection.lastEventTypeSyncError,
    lastEventTypeSyncCount: connection.lastEventTypeSyncCount,
  };
}

export function toStoredPatch(
  patch: TenantCalendlyConnectionPatch,
): Partial<StoredCalendlyConnection> {
  const storedPatch: Partial<StoredCalendlyConnection> = {};
  // Keep existing mappings above this point.
  if ("eventTypeSyncLockUntil" in patch) {
    storedPatch.eventTypeSyncLockUntil = patch.eventTypeSyncLockUntil;
  }
  if ("lastEventTypeSyncStartedAt" in patch) {
    storedPatch.lastEventTypeSyncStartedAt = patch.lastEventTypeSyncStartedAt;
  }
  if ("lastEventTypeSyncCompletedAt" in patch) {
    storedPatch.lastEventTypeSyncCompletedAt = patch.lastEventTypeSyncCompletedAt;
  }
  if ("lastEventTypeSyncStatus" in patch) {
    storedPatch.lastEventTypeSyncStatus = patch.lastEventTypeSyncStatus;
  }
  if ("lastEventTypeSyncError" in patch) {
    storedPatch.lastEventTypeSyncError = patch.lastEventTypeSyncError;
  }
  if ("lastEventTypeSyncCount" in patch) {
    storedPatch.lastEventTypeSyncCount = patch.lastEventTypeSyncCount;
  }
  return storedPatch;
}
```

**Step 3: Expose status to Convex callers.**

```typescript
// Path: convex/calendly/oauthQueries.ts

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
    connection.eventTypeSyncLockUntil > Date.now(),
};
```

**Key implementation notes:**
- Preserve legacy tenant-to-connection migration behavior in `ensureTenantCalendlyConnection`.
- Do not expose tokens or webhook signing keys in public queries.
- Public query fields should be `null` when absent so client types are easier to render.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/tenantCalendlyConnection.ts` | Modify | Map new sync state fields |
| `convex/calendly/connectionQueries.ts` | Modify | Return event type state internally |
| `convex/calendly/oauthQueries.ts` | Modify | Return latest sync status to Settings |

---

### 1C — Shared Event Type Field Helpers

**Type:** Backend
**Parallelizable:** Yes — depends on 1A schema types only.

**What:** Create a shared helper for normalizing Calendly question labels and upserting `eventTypeFieldCatalog` rows, then reuse it from existing meeting form response writes.

**Why:** Phase 2 sync will import Calendly `custom_questions` before any booking. It must generate the same field keys as `questions_and_answers` from booking webhooks.

**Where:**
- `convex/lib/eventTypeFields.ts` (new)
- `convex/lib/meetingFormResponses.ts` (modify)

**How:**

**Step 1: Create the shared helper module.**

```typescript
// Path: convex/lib/eventTypeFields.ts

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type EventTypeFieldInput = {
  label: string;
  valueType?: string;
};

export function normalizeFieldKey(question: string): string {
  const normalized = question
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return normalized.length > 0 ? normalized : "unknown";
}

export async function loadFieldCatalogByKey(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
  },
) {
  const entries = new Map<string, Doc<"eventTypeFieldCatalog">>();
  const rows = ctx.db
    .query("eventTypeFieldCatalog")
    .withIndex("by_tenantId_and_eventTypeConfigId", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("eventTypeConfigId", args.eventTypeConfigId),
    );

  for await (const row of rows) {
    entries.set(row.fieldKey, row);
  }

  return entries;
}

export async function upsertEventTypeFieldCatalogEntry(
  ctx: MutationCtx,
  args: {
    existingEntriesByFieldKey: Map<string, Doc<"eventTypeFieldCatalog">>;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    fieldKey: string;
    questionLabel: string;
    seenAt: number;
    tenantId: Id<"tenants">;
    valueType?: string;
  },
) {
  const existing = args.existingEntriesByFieldKey.get(args.fieldKey) ?? null;
  if (existing) {
    const patch: Partial<Doc<"eventTypeFieldCatalog">> = {};
    if (args.seenAt > existing.lastSeenAt) {
      patch.lastSeenAt = args.seenAt;
      patch.currentLabel = args.questionLabel;
    }
    if (args.valueType && existing.valueType !== args.valueType) {
      patch.valueType = args.valueType;
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, patch);
      args.existingEntriesByFieldKey.set(args.fieldKey, {
        ...existing,
        ...patch,
      });
      return { action: "updated" as const, fieldCatalogId: existing._id };
    }
    return { action: "unchanged" as const, fieldCatalogId: existing._id };
  }

  const fieldCatalogId = await ctx.db.insert("eventTypeFieldCatalog", {
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.questionLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
    valueType: args.valueType,
  });

  return { action: "created" as const, fieldCatalogId };
}
```

**Step 2: Import `normalizeFieldKey` and the upsert helper in `meetingFormResponses`.**

```typescript
// Path: convex/lib/meetingFormResponses.ts

import {
  loadFieldCatalogByKey,
  normalizeFieldKey,
  upsertEventTypeFieldCatalogEntry,
} from "./eventTypeFields";

// Remove the private normalizeFieldKey implementation from this file.
// Replace existing manual catalog-map loading with loadFieldCatalogByKey().
```

**Key implementation notes:**
- Keep `getUniqueFieldKey` local to `meetingFormResponses` because booking responses need collision suffixes.
- Phase 2 should pass Calendly `custom_questions[].type` as `valueType`; booking responses can leave it unset.
- Do not delete old field catalog rows when Calendly no longer returns a question.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/eventTypeFields.ts` | Create | Shared field-key/catalog helpers |
| `convex/lib/meetingFormResponses.ts` | Modify | Reuse shared helpers |

---

### 1D — Preserve CRM Ownership on Existing Writes

**Type:** Backend
**Parallelizable:** Yes — depends on 1A schema types only.

**What:** Update existing admin and fallback write paths so they set ownership source fields without changing user-visible behavior.

**Why:** Phase 2 sync needs to know which fields it may update. Source-less existing rows are protected by design; new admin/fallback writes should be explicit.

**Where:**
- `convex/eventTypeConfigs/mutations.ts` (modify)
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Mark admin edits as CRM-owned.**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts

if (existing) {
  await ctx.db.patch(existing._id, {
    displayName: normalizedDisplayName,
    displayNameSource: "admin_entered",
    paymentLinks:
      normalizedPaymentLinks === undefined
        ? existing.paymentLinks
        : normalizedPaymentLinks,
    ...bookingProgramPatch,
    bookingBaseUrl: trimmedBookingBaseUrl,
    bookingUrlSource: trimmedBookingBaseUrl ? "admin_entered" : undefined,
    updatedAt: Date.now(),
  });
  return existing._id;
}

const configId = await ctx.db.insert("eventTypeConfigs", {
  tenantId,
  calendlyEventTypeUri: normalizedEventTypeUri,
  displayName: normalizedDisplayName,
  displayNameSource: "admin_entered",
  paymentLinks: normalizedPaymentLinks,
  ...bookingProgramPatch,
  bookingBaseUrl: trimmedBookingBaseUrl,
  bookingUrlSource: trimmedBookingBaseUrl ? "admin_entered" : undefined,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});
```

**Step 2: Mark lazy booking-discovered rows as webhook fallback rows.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
  tenantId,
  calendlyEventTypeUri: eventTypeUri,
  displayName: eventDisplayName,
  displayNameSource: "webhook_discovered",
  calendlyName: eventDisplayName,
  bookingProgramMappingStatus: "unmapped",
  createdAt: now,
  updatedAt: now,
  knownCustomFieldKeys:
    initialKeys && initialKeys.length > 0 ? initialKeys : undefined,
});
```

**Step 3: Leave source-less existing rows protected.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function canSyncDisplayName(config: Doc<"eventTypeConfigs">) {
  return (
    config.displayNameSource === "calendly_synced" ||
    config.displayNameSource === "webhook_discovered"
  );
}
```

This helper is implemented in Phase 2, but Phase 1 should document and preserve the rule.

**Key implementation notes:**
- Admin saves should set `displayNameSource = "admin_entered"` even if the typed name equals the Calendly name.
- If an admin clears `bookingBaseUrl`, leave `bookingUrlSource` undefined so future sync can safely initialize it.
- Do not backfill source fields for existing rows; source-less rows remain protected.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/eventTypeConfigs/mutations.ts` | Modify | Mark admin-owned fields |
| `convex/pipeline/inviteeCreated.ts` | Modify | Mark webhook fallback rows |

---

### 1E — Verify Widen-Only Deployment

**Type:** Manual
**Parallelizable:** No — runs after 1A-1D.

**What:** Regenerate Convex types and run TypeScript validation before Phase 2 imports the new schema fields.

**Why:** Schema/type failures are cheapest to catch before the sync implementation fans new fields through actions, mutations, and UI queries.

**Where:**
- `convex/_generated/*` (generated)
- Local terminal verification

**How:**

**Step 1: Run Convex codegen/schema validation.**

```bash
// Path: terminal
npx convex dev --once
```

If this project’s installed Convex CLI does not support `--once`, run `npx convex dev`, wait for schema/codegen success, then stop it.

**Step 2: Run TypeScript validation.**

```bash
// Path: terminal
pnpm tsc --noEmit
```

**Step 3: Confirm no migration component is needed.**

```typescript
// Path: plans/calendly-event-type-sync/phases/phase1.md

// Migration decision:
// - All added fields are optional.
// - The only union change widens an optional field.
// - No field is deleted or narrowed.
// - No existing document requires a backfill before deploy.
```

**Key implementation notes:**
- Generated files may change after `npx convex dev`; review them but do not hand-edit generated code.
- If a field accidentally becomes required, stop and use a widen-migrate-narrow plan before deployment.
- Keep the first production rollout as a schema-and-safe-write deploy before the sync action deploy if extra caution is needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | Convex generated API/types |
| `plans/calendly-event-type-sync/phases/phase1.md` | Reference | Records migration decision |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/tenantCalendlyConnection.ts` | Modify | 1B |
| `convex/calendly/connectionQueries.ts` | Modify | 1B |
| `convex/calendly/oauthQueries.ts` | Modify | 1B |
| `convex/lib/eventTypeFields.ts` | Create | 1C |
| `convex/lib/meetingFormResponses.ts` | Modify | 1C |
| `convex/eventTypeConfigs/mutations.ts` | Modify | 1D |
| `convex/pipeline/inviteeCreated.ts` | Modify | 1D |
| `convex/_generated/*` | Generate | 1E |
