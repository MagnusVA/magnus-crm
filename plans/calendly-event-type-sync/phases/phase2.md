# Phase 2 — Full Calendly Event Type Sync

**Goal:** Implement the core full reconciliation path that fetches all organization event types from Calendly, upserts metadata into `eventTypeConfigs`, merges custom questions into the field catalog, and marks missing/deleted/inactive states without overwriting CRM-owned configuration.

**Prerequisite:** Phase 1 is deployed or available locally so the optional metadata fields and connection sync state exist in generated Convex types. A tenant must already have a stored Calendly OAuth connection with `event_types:read`.

**Runs in PARALLEL with:** Phase 5 can start UI mock work after 2A defines the query/result shape, but full UI wiring should wait for Phase 3 public trigger/status fields. Phase 4 webhook processing depends on the shared upsert helpers from this phase.

**Skills to invoke:**
- `convex` — Node actions, internal mutations, validators, scheduler, and indexed query patterns.
- `convex-migration-helper` — validate that full sync is the online backfill and does not require a separate migration job.

**Acceptance Criteria:**
1. `internal.calendly.eventTypes.syncForTenant` fetches `GET /event_types?organization=<org>&count=100` and follows every Calendly page.
2. A new Calendly event type creates an `eventTypeConfigs` row with safe CRM defaults and `displayNameSource = "calendly_synced"`.
3. Existing CRM-owned `displayName`, `bookingBaseUrl`, `paymentLinks`, `bookingProgram*`, `customFieldMappings`, and `linkPortalEnabled` are not overwritten by sync.
4. Existing sync-owned or webhook-discovered display names can update from the latest Calendly name.
5. Enabled Calendly `custom_questions` add labels to `knownCustomFieldKeys` and upsert `eventTypeFieldCatalog` rows.
6. Deleted event types are marked `calendlySyncStatus = "deleted"` and `linkPortalEnabled = false`.
7. Event types absent from a completed full sync are marked `calendlySyncStatus = "not_returned"` without being deleted.
8. `401` responses refresh once and retry the current page; `429` responses release the lock and schedule a retry.
9. Partial sync failure does not mark missing/stale rows.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Resource normalization) ──────┬── 2B (Single/page upsert)
                                  │
2C (Lock/status mutations) ───────┤
                                  ├── 2D (Node sync action)
2B + 2C complete ─────────────────┘

2D complete ───────────────────────── 2E (Error/rate-limit polish)
2E complete ───────────────────────── 2F (Local verification)
```

**Optimal execution:**
1. Start 2A and 2C in parallel after Phase 1 type generation.
2. Implement 2B once 2A normalization is available.
3. Implement 2D after 2B and 2C exist.
4. Finish with 2E and 2F to verify failure semantics before exposing manual triggers.

**Estimated time:** 1.5-2.5 days

---

## Subphases

### 2A — Calendly Event Type Normalization

**Type:** Backend
**Parallelizable:** Yes — only depends on Phase 1 generated types.

**What:** Add strict resource normalization for Calendly event type payloads from both API pages and future webhook payloads.

**Why:** Calendly payloads are external input. Normalizing once keeps full sync and webhook reconciliation consistent and limits `v.any()` blast radius.

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
import { updateTenantCalendlyConnection } from "../lib/tenantCalendlyConnection";

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

function getBoolean(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getNumber(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
```

**Step 2: Normalize custom questions.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function normalizeCustomQuestions(value: unknown): NormalizedCustomQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const questions: NormalizedCustomQuestion[] = [];
  const seenKeys = new Set<string>();

  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    if (getBoolean(item, "enabled") === false) {
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
    while (seenKeys.has(fieldKey)) {
      fieldKey = `${baseKey}_${suffix}`;
      suffix += 1;
    }
    seenKeys.add(fieldKey);

    questions.push({
      label,
      fieldKey,
      valueType: getString(item, "type"),
    });
  }

  return questions;
}
```

**Step 3: Normalize the event type resource.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export function normalizeCalendlyEventTypeResource(
  value: unknown,
): NormalizedCalendlyEventType | null {
  if (!isRecord(value)) {
    return null;
  }

  const uri = getString(value, "uri");
  if (!uri) {
    console.warn("[Calendly:EventTypes] Skipping malformed event type resource");
    return null;
  }

  const name = getString(value, "name");
  const schedulingUrl = getString(value, "scheduling_url");
  const active = getBoolean(value, "active");
  const deletedAt = getString(value, "deleted_at");
  const profile = isRecord(value.profile) ? value.profile : undefined;

  const calendlyPatch: Partial<Doc<"eventTypeConfigs">> = {
    calendlyName: name,
    calendlySchedulingUrl: schedulingUrl,
    calendlySlug: getString(value, "slug"),
    calendlyActive: active,
    calendlyDeletedAt: deletedAt,
    calendlyCreatedAt: getString(value, "created_at"),
    calendlyUpdatedAt: getString(value, "updated_at"),
    calendlyDurationMinutes: getNumber(value, "duration"),
    calendlyKind: getString(value, "kind"),
    calendlyType: getString(value, "type"),
    calendlyBookingMethod: getString(value, "booking_method"),
    calendlyPoolingType: getString(value, "pooling_type"),
    calendlySecret: getBoolean(value, "secret"),
    calendlyAdminManaged: getBoolean(value, "admin_managed"),
    calendlyColor: getString(value, "color"),
    calendlyLocale: getString(value, "locale"),
    calendlyOwnerUri: profile ? getString(profile, "owner") : undefined,
    calendlyProfileName: profile ? getString(profile, "name") : undefined,
    calendlySyncStatus: deletedAt
      ? "deleted"
      : active === false
        ? "inactive"
        : "active",
  };

  return {
    uri,
    name,
    schedulingUrl,
    active,
    deletedAt,
    enabledCustomQuestions: normalizeCustomQuestions(value.custom_questions),
    calendlyPatch,
  };
}
```

**Key implementation notes:**
- Do not throw for malformed records inside a page; skip and log so one bad Calendly row does not block the tenant.
- Treat missing `active` as bookable only after Phase 5 helper review; for metadata status, default to `"active"` unless `deleted_at` or explicit `active = false`.
- Keep Calendly snake_case confined to this normalization function.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Create | Normalizers and later mutation exports |

---

### 2B — Upsert Event Type Configs and Questions

**Type:** Backend
**Parallelizable:** No — depends on 2A normalized resource shape.

**What:** Implement single-resource and page-level upsert helpers that preserve CRM-owned fields and merge custom question catalog data.

**Why:** Full sync, webhook reconciliation, and future repair jobs should all use one ownership-aware write path.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (modify)

**How:**

**Step 1: Build the ownership-aware patch helper.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

function buildEventTypeConfigSyncPatch(
  existing: Doc<"eventTypeConfigs">,
  normalized: NormalizedCalendlyEventType,
  now: number,
) {
  const patch: Partial<Doc<"eventTypeConfigs">> = {
    ...normalized.calendlyPatch,
    lastCalendlySeenAt: now,
    lastCalendlySyncedAt: now,
    updatedAt: now,
  };

  if (
    normalized.name &&
    (existing.displayNameSource === "calendly_synced" ||
      existing.displayNameSource === "webhook_discovered")
  ) {
    patch.displayName = normalized.name;
  }

  if (
    normalized.schedulingUrl &&
    (!existing.bookingBaseUrl ||
      existing.bookingUrlSource === "calendly_synced")
  ) {
    patch.bookingBaseUrl = normalized.schedulingUrl;
    patch.bookingUrlSource = "calendly_synced";
  }

  if (normalized.deletedAt) {
    patch.calendlyActive = false;
    patch.calendlySyncStatus = "deleted";
    patch.calendlyDeletedAt = normalized.deletedAt;
    patch.linkPortalEnabled = false;
  }

  return patch;
}
```

**Step 2: Merge field keys and field catalog rows.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

async function mergeQuestionCatalog(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    eventTypeConfigId: Id<"eventTypeConfigs">;
    existingConfig: Doc<"eventTypeConfigs"> | null;
    questions: NormalizedCustomQuestion[];
    seenAt: number;
  },
) {
  if (args.questions.length === 0) {
    return 0;
  }

  const config = args.existingConfig ?? (await ctx.db.get(args.eventTypeConfigId));
  const knownKeys = config?.knownCustomFieldKeys ?? [];
  const knownSet = new Set(knownKeys);
  const labelsToAdd = args.questions
    .map((question) => question.label)
    .filter((label) => !knownSet.has(label));

  if (labelsToAdd.length > 0) {
    await ctx.db.patch(args.eventTypeConfigId, {
      knownCustomFieldKeys: [...knownKeys, ...labelsToAdd],
      updatedAt: args.seenAt,
    });
  }

  const catalogByKey = await loadFieldCatalogByKey(ctx, {
    tenantId: args.tenantId,
    eventTypeConfigId: args.eventTypeConfigId,
  });

  let changed = labelsToAdd.length;
  for (const question of args.questions) {
    const result = await upsertEventTypeFieldCatalogEntry(ctx, {
      tenantId: args.tenantId,
      eventTypeConfigId: args.eventTypeConfigId,
      fieldKey: question.fieldKey,
      questionLabel: question.label,
      valueType: question.valueType,
      seenAt: args.seenAt,
      existingEntriesByFieldKey: catalogByKey,
    });
    if (result.action !== "unchanged") {
      changed += 1;
    }
  }

  return changed;
}
```

**Step 3: Upsert a single resource and expose page mutation.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

async function upsertSingleEventTypeResource(
  ctx: MutationCtx,
  args: {
    tenantId: Id<"tenants">;
    normalized: NormalizedCalendlyEventType;
    syncStartedAt: number;
    source: "api" | "webhook";
  },
) {
  const existing = await ctx.db
    .query("eventTypeConfigs")
    .withIndex("by_tenantId_and_calendlyEventTypeUri", (q) =>
      q
        .eq("tenantId", args.tenantId)
        .eq("calendlyEventTypeUri", args.normalized.uri),
    )
    .unique();

  let eventTypeConfigId: Id<"eventTypeConfigs">;
  let action: "created" | "updated" | "unchanged";

  if (!existing) {
    eventTypeConfigId = await ctx.db.insert("eventTypeConfigs", {
      tenantId: args.tenantId,
      calendlyEventTypeUri: args.normalized.uri,
      displayName: args.normalized.name ?? "Calendly Event Type",
      displayNameSource:
        args.source === "api" ? "calendly_synced" : "webhook_discovered",
      bookingProgramMappingStatus: "unmapped",
      bookingBaseUrl: args.normalized.schedulingUrl,
      bookingUrlSource: args.normalized.schedulingUrl
        ? "calendly_synced"
        : undefined,
      ...args.normalized.calendlyPatch,
      knownCustomFieldKeys:
        args.normalized.enabledCustomQuestions.length > 0
          ? args.normalized.enabledCustomQuestions.map((question) => question.label)
          : undefined,
      lastCalendlySeenAt: args.syncStartedAt,
      lastCalendlySyncedAt: args.syncStartedAt,
      createdAt: args.syncStartedAt,
      updatedAt: args.syncStartedAt,
    });
    action = "created";
  } else {
    eventTypeConfigId = existing._id;
    const patch = buildEventTypeConfigSyncPatch(
      existing,
      args.normalized,
      args.syncStartedAt,
    );
    await ctx.db.patch(existing._id, patch);
    action = Object.keys(patch).length > 0 ? "updated" : "unchanged";
  }

  const questionsMerged = await mergeQuestionCatalog(ctx, {
    tenantId: args.tenantId,
    eventTypeConfigId,
    existingConfig: existing,
    questions: args.normalized.enabledCustomQuestions,
    seenAt: args.syncStartedAt,
  });

  return { eventTypeConfigId, action, questionsMerged };
}

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
      const result = await upsertSingleEventTypeResource(ctx, {
        tenantId,
        normalized,
        syncStartedAt,
        source: "api",
      });
      if (result.action === "created") created += 1;
      if (result.action === "updated") updated += 1;
      if (result.action === "unchanged") unchanged += 1;
      questionsMerged += result.questionsMerged;
    }

    return { created, updated, unchanged, questionsMerged };
  },
});
```

**Key implementation notes:**
- Existing source-less display names are protected because only explicit sync/webhook sources may update `displayName`.
- `paymentLinks`, `bookingProgram*`, `customFieldMappings`, and `linkPortalEnabled` are never set except deleted rows disabling portal visibility.
- Always query by `by_tenantId_and_calendlyEventTypeUri`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Modify | Ownership-aware upsert helpers |

---

### 2C — Sync Lock, Completion, and Missing-State Mutations

**Type:** Backend
**Parallelizable:** Yes — can start after Phase 1 schema fields exist.

**What:** Add mutations for acquiring/releasing the per-tenant event type sync lock, recording latest status, and marking previously synced rows absent from a completed full sync.

**Why:** Manual, cron, OAuth, and webhook-triggered syncs can overlap. A lock prevents concurrent stale marking and duplicate API work.

**Where:**
- `convex/calendly/eventTypeMutations.ts` (modify)

**How:**

**Step 1: Add lock mutation.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const acquireEventTypeSyncLock = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lockUntil: v.number(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, lockUntil, reason }) => {
    const connection = await ctx.db
      .query("tenantCalendlyConnections")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    const now = Date.now();

    if (connection?.eventTypeSyncLockUntil && connection.eventTypeSyncLockUntil > now) {
      return { acquired: false as const, lockUntil: connection.eventTypeSyncLockUntil };
    }

    await updateTenantCalendlyConnection(ctx, tenantId, {
      eventTypeSyncLockUntil: lockUntil,
      lastEventTypeSyncStartedAt: now,
      lastEventTypeSyncStatus: "skipped",
      lastEventTypeSyncError: reason ? `Sync started: ${reason}` : undefined,
    });

    return { acquired: true as const, lockUntil };
  },
});
```

**Step 2: Mark rows not seen in a completed sync.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const markMissingEventTypes = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    syncStartedAt: v.number(),
  },
  handler: async (ctx, { tenantId, syncStartedAt }) => {
    const candidates = await ctx.db
      .query("eventTypeConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(500);

    let notReturned = 0;
    for (const config of candidates) {
      if (
        config.displayNameSource === "calendly_synced" &&
        (config.lastCalendlySeenAt ?? 0) < syncStartedAt &&
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

**Step 3: Complete sync and release lock for every terminal path.**

```typescript
// Path: convex/calendly/eventTypeMutations.ts

export const completeEventTypeSync = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(v.literal("success"), v.literal("failed"), v.literal("skipped")),
    count: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, status, count, error }) => {
    await updateTenantCalendlyConnection(ctx, tenantId, {
      eventTypeSyncLockUntil: undefined,
      lastEventTypeSyncCompletedAt: Date.now(),
      lastEventTypeSyncStatus: status,
      lastEventTypeSyncError: error,
      lastEventTypeSyncCount: count,
    });
  },
});
```

**Key implementation notes:**
- `markMissingEventTypes` should only run after the final page succeeds.
- The initial `.take(500)` is acceptable for MVP but should be revisited before many tenants or very large Calendly orgs.
- Lock release belongs in the completion mutation, including skipped retry cases.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Modify | Sync lock/status/stale mutations |

---

### 2D — Node Action for Full Sync

**Type:** Backend
**Parallelizable:** No — depends on 2B upsert and 2C lock/status mutations.

**What:** Create the Node action that owns external Calendly API pagination, token refresh retry, rate-limit retry scheduling, and page-by-page internal mutation calls.

**Why:** Convex mutations must not perform external API calls. The action can use `fetch`, call token helpers, and batch writes into transactions.

**Where:**
- `convex/calendly/eventTypes.ts` (new)

**How:**

**Step 1: Create retry-delay helper.**

```typescript
// Path: convex/calendly/eventTypes.ts
"use node";

import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { action, internalAction } from "../_generated/server";
import { getIdentityOrgId } from "../lib/identity";
import { ADMIN_ROLES } from "../lib/roleMapping";
import { getValidAccessToken, refreshTenantTokenCore } from "./tokens";

function getCalendlyRetryDelayMs(response: Response) {
  const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 15 * 60 * 1000);
  }

  const reset = Number.parseInt(response.headers.get("X-RateLimit-Reset") ?? "", 10);
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(reset * 1000 - Date.now(), 30_000), 15 * 60 * 1000);
  }

  return 60_000;
}
```

**Step 2: Implement the internal tenant sync action.**

```typescript
// Path: convex/calendly/eventTypes.ts

type EventTypeSyncTotals = {
  created: number;
  updated: number;
  unchanged: number;
  questionsMerged: number;
  notReturned: number;
};

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
      created: 0,
      updated: 0,
      unchanged: 0,
      questionsMerged: 0,
      notReturned: 0,
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
          const retryAfterMs = getCalendlyRetryDelayMs(response);
          await ctx.runMutation(
            internal.calendly.eventTypeMutations.completeEventTypeSync,
            {
              tenantId,
              status: "skipped",
              error: "Calendly rate limited event type sync; retry scheduled",
            },
          );
          await ctx.scheduler.runAfter(
            retryAfterMs,
            internal.calendly.eventTypes.syncForTenant,
            { tenantId, reason: "rate_limited_retry" },
          );
          return { status: "skipped" as const, reason: "rate_limited_retry_scheduled" as const };
        }

        if (!response.ok) {
          throw new Error(
            `Calendly event type sync failed: ${response.status} ${await response.text()}`,
          );
        }

        const page = (await response.json()) as {
          collection?: unknown[];
          pagination?: { next_page?: string | null };
        };
        const pageResult = await ctx.runMutation(
          internal.calendly.eventTypeMutations.upsertEventTypesPage,
          {
            tenantId,
            syncStartedAt: startedAt,
            collection: page.collection ?? [],
          },
        );
        totals.created += pageResult.created;
        totals.updated += pageResult.updated;
        totals.unchanged += pageResult.unchanged;
        totals.questionsMerged += pageResult.questionsMerged;
        nextPage = page.pagination?.next_page ?? null;
      }

      const stale = await ctx.runMutation(
        internal.calendly.eventTypeMutations.markMissingEventTypes,
        { tenantId, syncStartedAt: startedAt },
      );
      totals.notReturned = stale.notReturned;

      await ctx.runMutation(
        internal.calendly.eventTypeMutations.completeEventTypeSync,
        {
          tenantId,
          status: "success",
          count: totals.created + totals.updated + totals.unchanged,
        },
      );

      return { status: "success" as const, ...totals };
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
- Keep `"use node"` at the top because this file performs external `fetch` and uses token helpers in the action runtime.
- Retry a `401` at most once for the current page.
- Do not call `markMissingEventTypes` if any page fails.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Create | Internal action for full sync |

---

### 2E — Error Semantics and Logging

**Type:** Backend
**Parallelizable:** No — depends on 2D.

**What:** Make errors distinguish permission problems, missing connection context, rate limits, and partial failures in logs and latest sync status.

**Why:** The Settings UI and rollout runbook need actionable status. A `403` means reconnect with a Calendly owner/admin token, not that the tenant has no event types.

**Where:**
- `convex/calendly/eventTypes.ts` (modify)
- `convex/calendly/eventTypeMutations.ts` (modify)

**How:**

**Step 1: Add response error formatter.**

```typescript
// Path: convex/calendly/eventTypes.ts

async function readCalendlyError(response: Response) {
  const body = await response.text();
  if (response.status === 403) {
    return "Calendly refused event type sync. Reconnect with an owner/admin Calendly account that can read organization event types.";
  }
  return body || response.statusText;
}
```

**Step 2: Use structured log tags.**

```typescript
// Path: convex/calendly/eventTypes.ts

console.log("[Calendly:EventTypes] syncForTenant page synced", {
  tenantId,
  created: pageResult.created,
  updated: pageResult.updated,
  unchanged: pageResult.unchanged,
  questionsMerged: pageResult.questionsMerged,
});
```

**Step 3: Store clear latest error text.**

```typescript
// Path: convex/calendly/eventTypes.ts

if (!response.ok) {
  throw new Error(
    `Calendly event type sync failed: ${response.status} ${await readCalendlyError(response)}`,
  );
}
```

**Key implementation notes:**
- Keep error messages useful but avoid logging access tokens or refresh tokens.
- Partial sync can create/update rows; the failure status should explain that stale marking was skipped.
- Do not mark tenant disconnected on `403`; only existing token refresh logic should change tenant connection status.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/calendly/eventTypes.ts` | Modify | Error handling/logging |
| `convex/calendly/eventTypeMutations.ts` | Modify | Completion status text if needed |

---

### 2F — Local Sync Verification

**Type:** Manual
**Parallelizable:** No — runs after 2A-2E.

**What:** Validate generated Convex references, TypeScript, and core sync behavior against a development tenant or mocked manual inspection.

**Why:** Phase 3 exposes this action to admins and crons; the internal sync should be proven before it is triggered automatically.

**Where:**
- Local terminal verification
- Convex dashboard or dev deployment

**How:**

**Step 1: Generate Convex API references.**

```bash
// Path: terminal
npx convex dev --once
```

**Step 2: Run TypeScript.**

```bash
// Path: terminal
pnpm tsc --noEmit
```

**Step 3: Verify internal result shape in a dev run.**

```typescript
// Path: convex/calendly/eventTypes.ts

// Expected successful result:
// {
//   status: "success",
//   created: number,
//   updated: number,
//   unchanged: number,
//   questionsMerged: number,
//   notReturned: number
// }
```

**Key implementation notes:**
- Manual invocation of an internal action should be done only in dev or through a temporary local console flow.
- Compare synced count against the Calendly UI for the tenant during Phase 6 rollout.
- If the current tenant has no Calendly connection in dev, TypeScript and codegen are still required pass/fail gates.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | API references for new functions |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/eventTypeMutations.ts` | Create | 2A, 2B, 2C, 2E |
| `convex/calendly/eventTypes.ts` | Create | 2D, 2E |
| `convex/_generated/*` | Generate | 2F |
