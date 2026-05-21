# Phase 1 — Metadata Ownership Model

**Goal:** Widen the Convex schema and helper layer so Calendly-owned event type metadata can live beside CRM-owned configuration without invalidating existing production data. After this phase, generated Convex types expose optional sync fields, admin writes record ownership sources, and the webhook fallback path remains safe.

**Prerequisite:** The design spec in `plans/calendly-event-type-sync/calendly-event-type-sync-design.md` is accepted for Phase 1 scope. No backfill is required because all new fields are optional and the first manual sync performs the online Calendly metadata backfill.

**Runs in PARALLEL with:** Nothing — Phase 2, Phase 3, and Phase 5 depend on the widened schema and source-field contracts from this phase.

**Skills to invoke:**
- `convex` — schema validators, generated types, internal helpers, and indexed write patterns.
- `convex-migration-helper` — confirm this remains a widen-only deployment with no `@convex-dev/migrations` backfill.

**Acceptance Criteria:**
1. `eventTypeConfigs` accepts optional Calendly metadata fields without invalidating existing documents.
2. `tenantCalendlyConnections` accepts optional latest event type sync state and lock fields.
3. `bookingUrlSource` accepts `"calendly_synced"` while preserving existing `"admin_entered"` and `"imported_sheet"` values.
4. Existing source-less `displayName` values are treated as CRM-protected by later sync code.
5. Admin saves set `displayNameSource = "admin_entered"` and set `bookingUrlSource = "admin_entered"` only when a booking URL is provided.
6. Lazy `invitee.created` fallback rows set `displayNameSource = "webhook_discovered"` and do not claim Calendly API sync.
7. Field-key normalization and field-catalog upsert behavior are exported through a shared helper used by booking webhooks and event type sync.
8. `npx convex dev --once` accepts the widened schema and regenerates Convex types.
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
1. Complete 1A first and regenerate Convex types.
2. Run 1B, 1C, and 1D in parallel because they touch separate helper/write paths.
3. Finish with 1E before Phase 2 imports the new fields.

**Estimated time:** 0.5-1 day

---

## Subphases

### 1A — Widen Convex Schema

**Type:** Backend  
**Parallelizable:** No — all later subphases depend on generated types from this schema.

**What:** Add optional Calendly metadata fields to `eventTypeConfigs`, add optional latest sync state to `tenantCalendlyConnections`, and extend the `bookingUrlSource` union with `"calendly_synced"`.

**Why:** Convex schema validation must continue accepting all existing documents. Optional fields let the code deploy before any tenant has run event type sync.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add optional Calendly-owned metadata to `eventTypeConfigs`.**

```typescript
// Path: convex/schema.ts

bookingBaseUrl: v.optional(v.string()),
bookingUrlSource: v.optional(
  v.union(
    v.literal("admin_entered"),
    v.literal("imported_sheet"),
    v.literal("calendly_synced"),
  ),
),
linkPortalEnabled: v.optional(v.boolean()),

// Calendly-owned metadata from GET /event_types. Keep every field optional.
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
```

**Step 2: Add latest sync state to `tenantCalendlyConnections`.**

```typescript
// Path: convex/schema.ts

lastHealthCheckAt: v.optional(v.number()),
webhookProvisioningStartedAt: v.optional(v.number()),

eventTypeSyncLockUntil: v.optional(v.number()),
lastEventTypeSyncStartedAt: v.optional(v.number()),
lastEventTypeSyncCompletedAt: v.optional(v.number()),
lastEventTypeSyncStatus: v.optional(
  v.union(
    v.literal("success"),
    v.literal("failed"),
    v.literal("skipped"),
  ),
),
lastEventTypeSyncError: v.optional(v.string()),
lastEventTypeSyncCount: v.optional(v.number()),
lastEventTypeSyncSummary: v.optional(
  v.object({
    totalSeen: v.number(),
    created: v.number(),
    updated: v.number(),
    unchanged: v.number(),
    inactive: v.number(),
    deleted: v.number(),
    notReturned: v.number(),
    questionsMerged: v.number(),
  }),
),
```

**Step 3: Regenerate types locally.**

```bash
# Path: terminal
npx convex dev --once
```

**Key implementation notes:**
- This is a widen-only migration. Do not add required fields and do not remove legacy data.
- No new index is needed for MVP because Settings and portal paths query by tenant first.
- Keep `knownCustomFieldKeys` optional; the sync path merges labels rather than replacing the array.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add optional Calendly sync metadata and latest sync state |

---

### 1B — Connection State Mapping

**Type:** Backend  
**Parallelizable:** Yes — depends only on 1A generated types.

**What:** Extend the tenant Calendly connection helper and connection queries so Phase 2 can update sync state and Phase 5 can read it.

**Why:** Sync status lives on `tenantCalendlyConnections`, but code should continue using `TenantCalendlyConnectionState` instead of directly leaking storage field names across modules.

**Where:**
- `convex/lib/tenantCalendlyConnection.ts` (modify)
- `convex/calendly/connectionQueries.ts` (modify)
- `convex/calendly/oauthQueries.ts` (modify)

**How:**

**Step 1: Extend the helper state and patch types.**

```typescript
// Path: convex/lib/tenantCalendlyConnection.ts

type EventTypeSyncStatus = "success" | "failed" | "skipped";

export type EventTypeSyncSummary = {
  totalSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  inactive: number;
  deleted: number;
  notReturned: number;
  questionsMerged: number;
};

export type TenantCalendlyConnectionState = {
  // existing fields...
  eventTypeSyncLockUntil?: number;
  lastEventTypeSyncStartedAt?: number;
  lastEventTypeSyncCompletedAt?: number;
  lastEventTypeSyncStatus?: EventTypeSyncStatus;
  lastEventTypeSyncError?: string;
  lastEventTypeSyncCount?: number;
  lastEventTypeSyncSummary?: EventTypeSyncSummary;
};

export type TenantCalendlyConnectionPatch = {
  // existing fields...
  eventTypeSyncLockUntil?: number | undefined;
  lastEventTypeSyncStartedAt?: number | undefined;
  lastEventTypeSyncCompletedAt?: number | undefined;
  lastEventTypeSyncStatus?: EventTypeSyncStatus | undefined;
  lastEventTypeSyncError?: string | undefined;
  lastEventTypeSyncCount?: number | undefined;
  lastEventTypeSyncSummary?: EventTypeSyncSummary | undefined;
};
```

**Step 2: Map stored fields in both directions.**

```typescript
// Path: convex/lib/tenantCalendlyConnection.ts

function mapStoredConnection(
  connection: StoredCalendlyConnection,
): TenantCalendlyConnectionState {
  return {
    // existing mappings...
    eventTypeSyncLockUntil: connection.eventTypeSyncLockUntil,
    lastEventTypeSyncStartedAt: connection.lastEventTypeSyncStartedAt,
    lastEventTypeSyncCompletedAt: connection.lastEventTypeSyncCompletedAt,
    lastEventTypeSyncStatus: connection.lastEventTypeSyncStatus,
    lastEventTypeSyncError: connection.lastEventTypeSyncError,
    lastEventTypeSyncCount: connection.lastEventTypeSyncCount,
    lastEventTypeSyncSummary: connection.lastEventTypeSyncSummary,
  };
}

export function toStoredPatch(
  patch: TenantCalendlyConnectionPatch,
): Partial<StoredCalendlyConnection> {
  const storedPatch: Partial<StoredCalendlyConnection> = {};

  // existing mappings...
  if ("eventTypeSyncLockUntil" in patch) {
    storedPatch.eventTypeSyncLockUntil = patch.eventTypeSyncLockUntil;
  }
  if ("lastEventTypeSyncSummary" in patch) {
    storedPatch.lastEventTypeSyncSummary = patch.lastEventTypeSyncSummary;
  }

  return storedPatch;
}
```

**Step 3: Return sync status through existing queries.**

```typescript
// Path: convex/calendly/oauthQueries.ts

const now = Date.now();
const eventTypeSyncInProgress =
  connection?.eventTypeSyncLockUntil !== undefined &&
  connection.eventTypeSyncLockUntil > now;

return {
  // existing result fields...
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

**Key implementation notes:**
- Keep client-facing values nullable instead of `undefined`; this makes UI conditionals clearer.
- Do not expose access or refresh tokens through `oauthQueries`.
- `connectionQueries.getTenantConnectionContext` may return sync state for internal actions, but Phase 2 should still use mutation helpers for lock writes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/tenantCalendlyConnection.ts` | Modify | Add sync state mapping and patch support |
| `convex/calendly/connectionQueries.ts` | Modify | Include sync state for internal callers if needed |
| `convex/calendly/oauthQueries.ts` | Modify | Expose latest sync status to Settings |

---

### 1C — Shared Field Catalog Helpers

**Type:** Backend  
**Parallelizable:** Yes — depends only on 1A generated types.

**What:** Move field-key normalization and event type field catalog upsert behavior into a shared helper used by booking webhook writes and Calendly event type sync.

**Why:** The same Calendly question label should produce the same `eventTypeFieldCatalog.fieldKey` whether it is first seen from a booking webhook or from `GET /event_types`.

**Where:**
- `convex/lib/eventTypeFields.ts` (new)
- `convex/lib/meetingFormResponses.ts` (modify)

**How:**

**Step 1: Create shared normalization and catalog functions.**

```typescript
// Path: convex/lib/eventTypeFields.ts

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export function normalizeFieldKey(question: string): string {
  return (
    question
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "unknown"
  );
}

export function getUniqueFieldKey(baseKey: string, usedKeys: Set<string>) {
  if (!usedKeys.has(baseKey)) {
    return baseKey;
  }

  let suffix = 2;
  while (usedKeys.has(`${baseKey}_${suffix}`)) {
    suffix += 1;
  }
  return `${baseKey}_${suffix}`;
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
```

**Step 2: Export an upsert that supports Calendly value types.**

```typescript
// Path: convex/lib/eventTypeFields.ts

export async function upsertEventTypeFieldCatalogEntry(
  ctx: MutationCtx,
  args: {
    existingEntriesByFieldKey: Map<string, Doc<"eventTypeFieldCatalog">>;
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    fieldKey: string;
    currentLabel: string;
    seenAt: number;
    valueType?: string;
  },
) {
  const existing = args.existingEntriesByFieldKey.get(args.fieldKey) ?? null;
  if (existing) {
    const patch: Partial<Doc<"eventTypeFieldCatalog">> = {};
    if (args.seenAt > existing.lastSeenAt) {
      patch.lastSeenAt = args.seenAt;
      patch.currentLabel = args.currentLabel;
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
      return "updated" as const;
    }
    return "unchanged" as const;
  }

  const id = await ctx.db.insert("eventTypeFieldCatalog", {
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.currentLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
    valueType: args.valueType,
  });
  args.existingEntriesByFieldKey.set(args.fieldKey, {
    _id: id,
    _creationTime: args.seenAt,
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
    fieldKey: args.fieldKey,
    currentLabel: args.currentLabel,
    firstSeenAt: args.seenAt,
    lastSeenAt: args.seenAt,
    valueType: args.valueType,
  });
  return "created" as const;
}
```

**Step 3: Replace private helpers in `meetingFormResponses`.**

```typescript
// Path: convex/lib/meetingFormResponses.ts

import {
  getUniqueFieldKey,
  loadFieldCatalogByKey,
  normalizeFieldKey,
  upsertEventTypeFieldCatalogEntry,
} from "./eventTypeFields";
```

**Key implementation notes:**
- Keep labels, not normalized keys, in `knownCustomFieldKeys` because the Settings dialog validates against display labels.
- The catalog key collision strategy should remain stable for bookings and sync.
- Do not delete historical catalog rows when Calendly removes a question.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/eventTypeFields.ts` | Create | Shared normalization and catalog helpers |
| `convex/lib/meetingFormResponses.ts` | Modify | Reuse shared helper |

---

### 1D — Ownership-Aware Existing Writes

**Type:** Backend  
**Parallelizable:** Yes — depends on 1A generated types.

**What:** Mark admin-edited rows and lazy webhook-discovered rows with source fields so Phase 2 can safely decide what it may update.

**Why:** Sync must preserve production CRM names, URLs, program mappings, payment links, and field mappings. Source fields make that boundary explicit.

**Where:**
- `convex/eventTypeConfigs/mutations.ts` (modify)
- `convex/pipeline/inviteeCreated.ts` (modify)

**How:**

**Step 1: Mark admin writes as CRM-owned.**

```typescript
// Path: convex/eventTypeConfigs/mutations.ts

const displayNamePatch = {
  displayName: normalizedDisplayName,
  displayNameSource: "admin_entered" as const,
};

const bookingUrlPatch = trimmedBookingBaseUrl
  ? {
      bookingBaseUrl: trimmedBookingBaseUrl,
      bookingUrlSource: "admin_entered" as const,
    }
  : {
      bookingBaseUrl: undefined,
      bookingUrlSource: undefined,
    };

await ctx.db.patch(existing._id, {
  ...displayNamePatch,
  paymentLinks:
    normalizedPaymentLinks === undefined
      ? existing.paymentLinks
      : normalizedPaymentLinks,
  ...bookingProgramPatch,
  ...bookingUrlPatch,
  updatedAt: Date.now(),
});
```

**Step 2: Mark webhook fallback rows.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts

const eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
  tenantId,
  calendlyEventTypeUri: eventTypeUri,
  displayName: eventDisplayName,
  displayNameSource: "webhook_discovered",
  bookingProgramMappingStatus: "unmapped",
  createdAt: now,
  updatedAt: now,
  knownCustomFieldKeys:
    initialKeys && initialKeys.length > 0 ? initialKeys : undefined,
});
```

**Step 3: Keep source-less existing rows protected.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function canSyncDisplayName(config: Doc<"eventTypeConfigs">) {
  return (
    config.displayNameSource === "calendly_synced" ||
    config.displayNameSource === "webhook_discovered"
  );
}
```

**Key implementation notes:**
- Do not retroactively mark existing source-less rows as `calendly_synced`; treat them as admin-protected.
- Admin clears of `bookingBaseUrl` should clear `bookingUrlSource` as well.
- The webhook fallback still creates rows during races with manual sync.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/eventTypeConfigs/mutations.ts` | Modify | Mark admin-entered display name and booking URL source |
| `convex/pipeline/inviteeCreated.ts` | Modify | Mark lazy fallback rows as webhook-discovered |

---

### 1E — Schema and Type Verification

**Type:** Manual  
**Parallelizable:** No — verifies all Phase 1 edits together.

**What:** Run schema/type checks and inspect the generated types used by later phases.

**Why:** Phase 2 imports `Doc<"eventTypeConfigs">` and connection patch fields. Catching type drift here prevents sync implementation churn.

**Where:**
- `convex/schema.ts` (verify)
- `convex/_generated/dataModel.d.ts` (generated / verify)

**How:**

**Step 1: Run Convex once.**

```bash
# Path: terminal
npx convex dev --once
```

**Step 2: Run TypeScript.**

```bash
# Path: terminal
pnpm tsc --noEmit
```

**Step 3: Confirm no data migration is required.**

```typescript
// Path: convex/schema.ts

// All added fields in eventTypeConfigs and tenantCalendlyConnections are v.optional(...).
// No existing field is deleted, renamed, or narrowed in this phase.
```

**Key implementation notes:**
- If any field becomes required during implementation, stop and re-plan with `convex-migration-helper`.
- Do not introduce `@convex-dev/migrations` for this MVP widen-only phase.
- Keep rollback simple: leaving optional fields in schema is safe.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/dataModel.d.ts` | Generated | Convex generated type output |
| `convex/_generated/api.d.ts` | Generated | Convex generated function references if helpers changed |

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
| `convex/_generated/dataModel.d.ts` | Generated | 1E |
| `convex/_generated/api.d.ts` | Generated | 1E |
