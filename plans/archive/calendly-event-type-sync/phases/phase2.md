# Phase 2 — Full Calendly Event Type Sync

**Goal:** Implement the core manual reconciliation runtime that fetches all organization event types from Calendly, upserts Calendly-owned metadata into `eventTypeConfigs`, merges enabled custom questions, and marks inactive/deleted/not-returned states without overwriting CRM-owned configuration.

**Prerequisite:** Phase 1 is deployed or available locally so optional metadata fields and connection sync state exist in generated Convex types. A tenant must already have a stored Calendly OAuth connection with `event_types:read`.

**Runs in PARALLEL with:** Phase 5 can start UI mock work after 2A defines the result shape, but full UI wiring should wait for Phase 3 public trigger/status fields. Phase 4 can run as a boundary audit after Phase 2 introduces the internal sync.

**Skills to invoke:**
- `convex` — Node actions, internal mutations, argument validators, token refresh, and indexed query patterns.
- `convex-migration-helper` — validate that manual sync is the online metadata backfill and does not require a separate migration job.

**Acceptance Criteria:**
1. `internal.calendly.eventTypes.syncForTenant` fetches `GET /event_types?organization=<org>&count=100` and follows every `pagination.next_page`.
2. A new Calendly event type creates an `eventTypeConfigs` row with safe CRM defaults and `displayNameSource = "calendly_synced"`.
3. Existing CRM-owned `displayName`, `bookingBaseUrl`, `paymentLinks`, `bookingProgram*`, `customFieldMappings`, and `linkPortalEnabled` are not overwritten by sync.
4. Existing sync-owned or webhook-discovered display names can update from the latest Calendly name.
5. Enabled Calendly `custom_questions` add labels to `knownCustomFieldKeys` and upsert `eventTypeFieldCatalog` rows.
6. Deleted event types are marked `calendlySyncStatus = "deleted"` and `linkPortalEnabled = false`.
7. Previously synced event types absent from a completed full sync are marked `calendlySyncStatus = "not_returned"` without being deleted.
8. `401` responses refresh once and retry the current page; repeated `401` fails the manual sync.
9. `429` responses fail the manual sync with a retry-later message, clear the sync lock, and do not schedule an automatic retry.
10. Partial sync failure does not mark missing/not-returned rows.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Resource normalization) ──────┬── 2C (Page upsert + questions)
                                  │
2B (Lock/status mutations) ───────┤
                                  ├── 2D (Node sync action)
2C complete ──────────────────────┘

2D complete ───────────────────────── 2E (Missing/deleted finalization)
2E complete ───────────────────────── 2F (Backend verification)
```

**Optimal execution:**
1. Start 2A and 2B in parallel after Phase 1 type generation.
2. Implement 2C once normalization and shared field helpers are available.
3. Implement 2D after 2B and 2C exist.
4. Finish with 2E and 2F to verify failure semantics before exposing the public manual trigger.

**Estimated time:** 1.5-2.5 days

---

## Subphases

### 2A — Calendly Event Type Normalization

**Type:** Backend  
**Parallelizable:** Yes — depends only on Phase 1 generated types.

**What:** Add strict resource normalization for Calendly event type collection resources, including safe URL validation and enabled custom-question extraction.

**Why:** Calendly payloads are external input. Normalizing once limits `v.any()` blast radius and keeps sync writes conservative.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (new)

**How:**

**Step 1: Define normalized types and primitive extractors.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import {
  loadFieldCatalogByKey,
  normalizeFieldKey,
  upsertEventTypeFieldCatalogEntry,
} from "../lib/eventTypeFields";

type NormalizedCustomQuestion = {
  label: string;
  fieldKey: string;
  valueType?: string;
};

type NormalizedCalendlyEventType = {
  uri: string;
  name?: string;
  schedulingUrl?: string;
  active?: boolean;
  deletedAt?: string;
  enabledCustomQuestions: NormalizedCustomQuestion[];
  calendlyPatch: Partial<Doc<"eventTypeConfigs">>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
```

**Step 2: Validate Calendly invite links before storing them.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function normalizeHttpUrl(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
```

**Step 3: Normalize custom questions and resource metadata.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function normalizeCustomQuestions(value: unknown): NormalizedCustomQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const questions: NormalizedCustomQuestion[] = [];
  const usedKeys = new Set<string>();

  for (const item of value) {
    if (!isRecord(item) || item.enabled === false) {
      continue;
    }
    const label = getString(item, "name");
    if (!label) {
      console.warn("[Calendly:EventTypes] Skipping malformed custom question");
      continue;
    }

    const baseKey = normalizeFieldKey(label);
    let fieldKey = baseKey;
    let suffix = 2;
    while (usedKeys.has(fieldKey)) {
      fieldKey = `${baseKey}_${suffix}`;
      suffix += 1;
    }
    usedKeys.add(fieldKey);

    questions.push({
      label,
      fieldKey,
      valueType: getString(item, "type"),
    });
  }

  return questions;
}

export function normalizeCalendlyEventTypeResource(
  value: unknown,
): NormalizedCalendlyEventType | null {
  if (!isRecord(value)) {
    return null;
  }

  const uri = getString(value, "uri");
  if (!uri) {
    console.warn("[Calendly:EventTypes] Skipping event type without uri");
    return null;
  }

  const schedulingUrl = normalizeHttpUrl(getString(value, "scheduling_url"));
  const deletedAt = getString(value, "deleted_at");
  const active = typeof value.active === "boolean" ? value.active : undefined;

  return {
    uri,
    name: getString(value, "name"),
    schedulingUrl,
    active,
    deletedAt,
    enabledCustomQuestions: normalizeCustomQuestions(value.custom_questions),
    calendlyPatch: {
      calendlyName: getString(value, "name"),
      calendlySchedulingUrl: schedulingUrl,
      calendlySlug: getString(value, "slug"),
      calendlyActive: active,
      calendlyDeletedAt: deletedAt,
      calendlyDurationMinutes:
        typeof value.duration === "number" ? value.duration : undefined,
      calendlyKind: getString(value, "kind"),
      calendlyType: getString(value, "type"),
      calendlyBookingMethod: getString(value, "booking_method"),
      calendlySyncStatus: deletedAt
        ? "deleted"
        : active === false
          ? "inactive"
          : "active",
    },
  };
}
```

**Key implementation notes:**
- Store `scheduling_url` only if it is an absolute `http` or `https` URL.
- Skip malformed resources rather than failing the whole sync.
- Do not add disabled Calendly questions to current mapping candidates.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Create | Normalization helpers live beside sync mutations |

---

### 2B — Sync Lock and Status Mutations

**Type:** Backend  
**Parallelizable:** Yes — independent of resource upsert logic.

**What:** Add internal mutations to acquire/release the per-tenant event type sync lock and persist latest sync status.

**Why:** The manual button must not run overlapping syncs, and Settings needs latest operational state without a sync-run history table.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (modify)

**How:**

**Step 1: Acquire a bounded lock on the connection row.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const acquireEventTypeSyncLock = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lockUntil: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, lockUntil, reason }) => {
    const now = Date.now();
    const connection = await ctx.db
      .query("tenantCalendlyConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();

    if (!connection) {
      throw new Error("Calendly connection not found.");
    }
    if (connection.eventTypeSyncLockUntil && connection.eventTypeSyncLockUntil > now) {
      return { acquired: false as const };
    }

    await ctx.db.patch(connection._id, {
      eventTypeSyncLockUntil: lockUntil,
      lastEventTypeSyncStartedAt: now,
      lastEventTypeSyncStatus: undefined,
      lastEventTypeSyncError: undefined,
    });

    console.log("[Calendly:EventTypes] sync lock acquired", {
      tenantId,
      reason,
      lockUntil,
    });
    return { acquired: true as const };
  },
});
```

**Step 2: Complete sync and always clear the lock.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const completeEventTypeSync = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("success"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    error: v.optional(v.string()),
    totals: v.optional(
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
  },
  handler: async (ctx, { tenantId, status, error, totals }) => {
    const connection = await ctx.db
      .query("tenantCalendlyConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .first();
    if (!connection) {
      return;
    }

    await ctx.db.patch(connection._id, {
      eventTypeSyncLockUntil: undefined,
      lastEventTypeSyncCompletedAt: Date.now(),
      lastEventTypeSyncStatus: status,
      lastEventTypeSyncError: error,
      lastEventTypeSyncCount: totals?.totalSeen,
      lastEventTypeSyncSummary: totals,
    });
  },
});
```

**Key implementation notes:**
- Clear the lock on both success and failure.
- Do not keep unbounded sync run history for MVP.
- If a tenant ever has enough pages to exceed the lock window, extend the lock per page.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Modify | Lock and latest status mutations |

---

### 2C — Page Upsert and Custom Question Merge

**Type:** Backend  
**Parallelizable:** No — depends on 2A normalization and Phase 1 shared field helpers.

**What:** Upsert each Calendly event type resource into `eventTypeConfigs`, merge enabled custom question labels, and update `eventTypeFieldCatalog`.

**Why:** This is the core ownership boundary: sync fills Calendly metadata while preserving CRM-owned configuration.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (modify)

**How:**

**Step 1: Build a conservative patch for existing rows.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function canSyncDisplayName(config: Doc<"eventTypeConfigs">) {
  return (
    config.displayNameSource === "calendly_synced" ||
    config.displayNameSource === "webhook_discovered"
  );
}

function buildEventTypeConfigSyncPatch(
  existing: Doc<"eventTypeConfigs">,
  normalized: NormalizedCalendlyEventType,
  syncStartedAt: number,
) {
  const patch: Partial<Doc<"eventTypeConfigs">> = {
    ...normalized.calendlyPatch,
    lastCalendlySeenAt: syncStartedAt,
    lastCalendlySyncedAt: Date.now(),
    updatedAt: Date.now(),
  };

  if (normalized.name && canSyncDisplayName(existing)) {
    patch.displayName = normalized.name;
    patch.displayNameSource = existing.displayNameSource ?? "calendly_synced";
  }

  if (
    normalized.schedulingUrl &&
    (!existing.bookingBaseUrl || existing.bookingUrlSource === "calendly_synced")
  ) {
    patch.bookingBaseUrl = normalized.schedulingUrl;
    patch.bookingUrlSource = "calendly_synced";
  }

  if (normalized.deletedAt) {
    patch.linkPortalEnabled = false;
  }

  return patch;
}
```

**Step 2: Merge known field labels and catalog rows.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

async function mergeQuestionCatalog(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    questions: NormalizedCustomQuestion[];
    seenAt: number;
  },
) {
  if (args.questions.length === 0) {
    return 0;
  }

  const config = await ctx.db.get(args.eventTypeConfigId);
  if (!config) {
    return 0;
  }

  const labels = args.questions.map((question) => question.label);
  const knownKeys = new Set(config.knownCustomFieldKeys ?? []);
  const mergedKeys = [...(config.knownCustomFieldKeys ?? [])];
  for (const label of labels) {
    if (!knownKeys.has(label)) {
      knownKeys.add(label);
      mergedKeys.push(label);
    }
  }

  if (mergedKeys.length !== (config.knownCustomFieldKeys ?? []).length) {
    await ctx.db.patch(args.eventTypeConfigId, {
      knownCustomFieldKeys: mergedKeys.slice(0, 200),
      updatedAt: Date.now(),
    });
  }

  const catalog = await loadFieldCatalogByKey(ctx, args);
  let changed = 0;
  for (const question of args.questions) {
    const action = await upsertEventTypeFieldCatalogEntry(ctx, {
      existingEntriesByFieldKey: catalog,
      tenantId: args.tenantId,
      eventTypeConfigId: args.eventTypeConfigId,
      fieldKey: question.fieldKey,
      currentLabel: question.label,
      valueType: question.valueType,
      seenAt: args.seenAt,
    });
    if (action !== "unchanged") {
      changed += 1;
    }
  }
  return changed;
}
```

**Step 3: Upsert a Calendly page.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const upsertEventTypesPage = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartedAt: v.number(),
    collection: v.array(v.any()),
  },
  handler: async (ctx, { tenantId, syncStartedAt, collection }) => {
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let questionsMerged = 0;

    for (const resource of collection) {
      const normalized = normalizeCalendlyEventTypeResource(resource);
      if (!normalized) {
        continue;
      }

      const existing = await ctx.db
        .query("eventTypeConfigs")
        .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
          q.eq("tenantId", tenantId).eq("calendlyEventTypeUri", normalized.uri),
        )
        .unique();

      const now = Date.now();
      const eventTypeConfigId = existing
        ? existing._id
        : await ctx.db.insert("eventTypeConfigs", {
            tenantId,
            calendlyEventTypeUri: normalized.uri,
            displayName: normalized.name ?? "Calendly Event Type",
            displayNameSource: "calendly_synced",
            bookingProgramMappingStatus: "unmapped",
            bookingBaseUrl: normalized.schedulingUrl,
            bookingUrlSource: normalized.schedulingUrl
              ? "calendly_synced"
              : undefined,
            knownCustomFieldKeys: normalized.enabledCustomQuestions.map(
              (question) => question.label,
            ),
            ...normalized.calendlyPatch,
            lastCalendlySeenAt: syncStartedAt,
            lastCalendlySyncedAt: now,
            createdAt: now,
            updatedAt: now,
          });

      if (existing) {
        await ctx.db.patch(
          existing._id,
          buildEventTypeConfigSyncPatch(existing, normalized, syncStartedAt),
        );
        updated += 1;
      } else {
        created += 1;
      }

      questionsMerged += await mergeQuestionCatalog(ctx, {
        tenantId,
        eventTypeConfigId,
        questions: normalized.enabledCustomQuestions,
        seenAt: syncStartedAt,
      });
    }

    return { created, updated, unchanged, questionsMerged };
  },
});
```

**Key implementation notes:**
- Sync never enables `linkPortalEnabled`.
- `paymentLinks`, `bookingProgram*`, and `customFieldMappings` are never patched by sync.
- Keep arrays bounded. If question labels approach the bound, favor the relational catalog long term.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Modify | Upsert page and merge questions |

---

### 2D — Node Sync Action

**Type:** Backend  
**Parallelizable:** No — depends on 2B lock/status and 2C page upsert.

**What:** Add the internal Node action that owns Calendly API pagination, token refresh retry, and page-by-page writes.

**Why:** External API calls belong in actions, while database writes stay in mutations. This follows Convex transaction boundaries.

**Where:**
- `convex/calendly/eventTypes.ts` (new)

**How:**

**Step 1: Create the Node action shell.**

```typescript
// Path: convex/calendly/eventTypes.ts

"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { getValidAccessToken, refreshTenantTokenCore } from "./tokens";

type EventTypeSyncTotals = {
  totalSeen: number;
  created: number;
  updated: number;
  unchanged: number;
  inactive: number;
  deleted: number;
  notReturned: number;
  questionsMerged: number;
};
```

**Step 2: Fetch pages and write each page through an internal mutation.**

```typescript
// Path: convex/calendly/eventTypes.ts

export const syncForTenant = internalAction({
  args: {
    tenantId: v.id("tenants"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, reason }) => {
    const startedAt = Date.now();
    const lock = await ctx.runMutation(
      internal.calendly.eventTypeMutations.acquireEventTypeSyncLock,
      { tenantId, lockUntil: startedAt + 2 * 60 * 1000, reason },
    );
    if (!lock.acquired) {
      return { status: "skipped" as const, reason: "lock_held" as const };
    }

    const totals: EventTypeSyncTotals = {
      totalSeen: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      inactive: 0,
      deleted: 0,
      notReturned: 0,
      questionsMerged: 0,
    };

    try {
      let accessToken = await getValidAccessToken(ctx, tenantId);
      const tenant = await ctx.runQuery(
        internal.calendly.connectionQueries.getTenantConnectionContext,
        { tenantId },
      );
      if (!accessToken || !tenant?.organizationUri) {
        throw new Error("Missing Calendly access token or organization URI");
      }

      let nextPage: string | null =
        `https://api.calendly.com/event_types?organization=${encodeURIComponent(
          tenant.organizationUri,
        )}&count=100`;

      while (nextPage) {
        let response = await fetch(nextPage, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (response.status === 401) {
          const refreshed = await refreshTenantTokenCore(ctx, tenantId);
          if (refreshed.refreshed) {
            accessToken = refreshed.accessToken;
            response = await fetch(nextPage, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
          }
        }

        if (response.status === 429) {
          const retryAt = response.headers.get("X-RateLimit-Reset") ?? "later";
          throw new Error(`Calendly rate limited event type sync. Try again ${retryAt}.`);
        }
        if (!response.ok) {
          throw new Error(
            `Calendly event type sync failed: ${response.status} ${await response.text()}`,
          );
        }

        const page = await response.json();
        const result = await ctx.runMutation(
          internal.calendly.eventTypeMutations.upsertEventTypesPage,
          {
            tenantId,
            syncStartedAt: startedAt,
            collection: page.collection ?? [],
          },
        );

        totals.totalSeen += page.collection?.length ?? 0;
        totals.created += result.created;
        totals.updated += result.updated;
        totals.unchanged += result.unchanged;
        totals.questionsMerged += result.questionsMerged;
        nextPage = page.pagination?.next_page ?? null;
      }

      return await finalizeSuccessfulSync(ctx, tenantId, startedAt, totals);
    } catch (error) {
      await ctx.runMutation(
        internal.calendly.eventTypeMutations.completeEventTypeSync,
        {
          tenantId,
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        },
      );
      throw error;
    }
  },
});
```

**Key implementation notes:**
- Follow `pagination.next_page` exactly; do not reconstruct `page_token`.
- Retry the current page after a `401` at most once.
- Do not schedule an automatic retry for `429` in MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Create | Internal full-sync action |

---

### 2E — Missing, Deleted, and Final Status

**Type:** Backend  
**Parallelizable:** No — depends on completed page writes from 2D.

**What:** Finalize successful full syncs by marking previously synced rows not seen in the current run and persisting summary counts.

**Why:** Missing/not-returned marking is only correct after every Calendly page has been fetched. Partial failures must not make rows stale.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (modify)
- `convex/calendly/eventTypes.ts` (modify)

**How:**

**Step 1: Mark missing rows only after success.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const markMissingEventTypes = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartedAt: v.number(),
  },
  handler: async (ctx, { tenantId, syncStartedAt }) => {
    let notReturned = 0;
    const rows = ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId));

    for await (const config of rows) {
      if (
        config.lastCalendlySyncedAt !== undefined &&
        config.lastCalendlySeenAt !== syncStartedAt &&
        config.calendlySyncStatus !== "deleted"
      ) {
        await ctx.db.patch(config._id, {
          calendlySyncStatus: "not_returned",
          calendlyActive: false,
          updatedAt: Date.now(),
        });
        notReturned += 1;
      }
    }

    return { notReturned };
  },
});
```

**Step 2: Finalize the successful sync from the action.**

```typescript
// Path: convex/calendly/eventTypes.ts

async function finalizeSuccessfulSync(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
  startedAt: number,
  totals: EventTypeSyncTotals,
) {
  const stale = await ctx.runMutation(
    internal.calendly.eventTypeMutations.markMissingEventTypes,
    { tenantId, syncStartedAt: startedAt },
  );
  const summary = { ...totals, ...stale };

  await ctx.runMutation(
    internal.calendly.eventTypeMutations.completeEventTypeSync,
    { tenantId, status: "success", totals: summary },
  );

  return { status: "success" as const, ...summary };
}
```

**Key implementation notes:**
- Do not mark rows without `lastCalendlySyncedAt` as not returned; those may be old webhook fallback rows that have never been API-synced.
- Deleted rows returned by Calendly are handled during page upsert and should also disable portal visibility.
- If the loop could grow large, batch this mutation later. MVP tenant scale is small enough for tenant-bounded iteration.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Modify | Missing/not-returned finalization |
| `convex/calendly/eventTypes.ts` | Modify | Success summary completion |

---

### 2F — Backend Verification

**Type:** Manual  
**Parallelizable:** No — verifies the integrated sync runtime.

**What:** Compile the backend and run targeted sync scenarios against a dev tenant or mocked Calendly responses.

**Why:** The most dangerous regressions are ownership overwrites and stale marking after partial failure.

**Where:**
- `convex/calendly/eventTypes.ts` (verify)
- `convex/calendly/eventTypeMutations.ts` (verify)
- Convex dashboard data (verify)

**How:**

**Step 1: Run compile gates.**

```bash
# Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Step 2: Verify preservation before and after sync.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

// Seed or identify a config:
// displayNameSource: "admin_entered"
// bookingUrlSource: "admin_entered"
// bookingBaseUrl: "https://example.com/custom"
//
// After sync:
// displayName and bookingBaseUrl are unchanged.
// calendlyName and calendlySchedulingUrl are updated from Calendly.
```

**Step 3: Verify failure behavior.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Simulate:
// - 401 once, then successful refresh and retry.
// - 401 after refresh, resulting in failed sync.
// - 429 response, resulting in failed sync and cleared lock.
// - failure after page 1, with no markMissingEventTypes call.
```

**Key implementation notes:**
- Record created/updated/unchanged counts; they should add up to `totalSeen`.
- Confirm `lastEventTypeSyncStatus` is `failed` when sync throws.
- Confirm `eventTypeSyncLockUntil` clears after both success and failure.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Verify | Pagination, token retry, failure handling |
| `convex/calendly/eventTypeMutations.ts` | Verify | Upsert and status transitions |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Create / Modify | 2A, 2B, 2C, 2E |
| `convex/calendly/eventTypes.ts` | Create / Modify | 2D, 2E |
| `convex/lib/eventTypeFields.ts` | Reference | 2C |
| `convex/calendly/tokens.ts` | Reference | 2D |
| `convex/calendly/connectionQueries.ts` | Reference | 2D |
