# Phase 1 — Schema & Backend Foundation

**Goal:** Add the `closerUnavailability` and `meetingReassignments` tables to the Convex schema, add `reassignedFromCloserId` to the `meetings` table, register three new RBAC permissions, and create the shared validation helpers. After this phase, `npx convex dev` deploys cleanly and all subsequent phases can compile against the generated types.

**Prerequisite:** Core team management, closer dashboard, pipeline processing, and meeting detail pages are deployed and operational. Schema tables `users`, `opportunities`, `meetings` exist with current indexes. No prior phases required — this is the foundation phase.

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on this.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).
> Start immediately.

**Skills to invoke:**
- `convex-migration-helper` — Adding new tables and a new optional field to `meetings` requires the widen step of widen-migrate-narrow. Since `reassignedFromCloserId` is `v.optional`, no backfill is needed for existing documents.

**Acceptance Criteria:**
1. `npx convex dev` runs without schema errors and both `closerUnavailability` and `meetingReassignments` tables are visible in the Convex dashboard.
2. The `meetings` table schema includes `reassignedFromCloserId: v.optional(v.id("users"))` and existing meeting documents remain valid (no backfill needed).
3. All new indexes follow the Convex naming convention (`by_<field1>_and_<field2>`): `closerUnavailability` has `by_tenantId_and_date` and `by_closerId_and_date`; `meetingReassignments` has `by_tenantId`, `by_meetingId`, `by_toCloserId`, `by_fromCloserId`, `by_unavailabilityId`.
4. `convex/lib/permissions.ts` exports `team:manage-availability`, `reassignment:execute`, and `reassignment:view-all` permissions, each granted to `["tenant_master", "tenant_admin"]`.
5. `hasPermission("tenant_master", "team:manage-availability")` returns `true` and `hasPermission("closer", "team:manage-availability")` returns `false`.
6. `convex/lib/unavailabilityValidation.ts` exports `getEffectiveRange`, `isMeetingInRange`, and `validateCloser` functions with correct TypeScript types.
7. `getEffectiveRange({ date: 1700000000000, isFullDay: true })` returns `{ rangeStart: 1700000000000, rangeEnd: 1700086400000 }` (exactly 24 hours later).
8. `getEffectiveRange({ date: 0, isFullDay: false, startTime: 1000, endTime: 2000 })` returns `{ rangeStart: 1000, rangeEnd: 2000 }`.
9. `getEffectiveRange({ date: 0, isFullDay: false })` throws an error about missing startTime/endTime.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema additions) ──────────────────────────────┐
                                                     ├── 1D (Deploy & verify)
1B (Permissions) ───────────────────────────────────┤
                                                     │
1C (Validation helpers) ────────────────────────────┘
```

**Optimal execution:**
1. Start 1A, 1B, 1C all in parallel (they touch different files).
2. Once all three are done → run 1D (deploy and verify).

**Estimated time:** 1-2 hours

---

## Subphases

### 1A — Schema Additions

**Type:** Backend
**Parallelizable:** Yes — touches only `convex/schema.ts`, no overlap with 1B or 1C.

**What:** Add `closerUnavailability` and `meetingReassignments` table definitions to `convex/schema.ts`, and add the `reassignedFromCloserId` optional field to the existing `meetings` table.

**Why:** Every subsequent phase imports types from `convex/_generated/dataModel`. Without these table definitions, TypeScript compilation fails for any unavailability or reassignment code.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add `closerUnavailability` table definition**

Add the new table after the existing table definitions in the schema:

```typescript
// Path: convex/schema.ts

// NEW TABLE: Track when closers are marked unavailable (Feature H)
closerUnavailability: defineTable({
  tenantId: v.id("tenants"),
  closerId: v.id("users"),           // The closer who is unavailable
  date: v.number(),                   // Start-of-day timestamp (midnight UTC of the target date)
  startTime: v.optional(v.number()), // Specific start timestamp (if partial day)
  endTime: v.optional(v.number()),   // Specific end timestamp (if partial day)
  isFullDay: v.boolean(),
  reason: v.union(
    v.literal("sick"),
    v.literal("emergency"),
    v.literal("personal"),
    v.literal("other"),
  ),
  note: v.optional(v.string()),       // Free-text note from admin
  createdByUserId: v.id("users"),     // Admin who created this record
  createdAt: v.number(),              // Unix ms
})
  .index("by_tenantId_and_date", ["tenantId", "date"])
  .index("by_closerId_and_date", ["closerId", "date"]),
```

**Step 2: Add `meetingReassignments` table definition**

```typescript
// Path: convex/schema.ts

// NEW TABLE: Audit log for meeting reassignments (Feature H)
meetingReassignments: defineTable({
  tenantId: v.id("tenants"),
  meetingId: v.id("meetings"),
  opportunityId: v.id("opportunities"),
  fromCloserId: v.id("users"),        // Original closer
  toCloserId: v.id("users"),          // New closer
  reason: v.string(),                  // Human-readable reason (e.g., "Sick - auto-distributed")
  unavailabilityId: v.optional(v.id("closerUnavailability")),  // Link to trigger (if from unavailability flow)
  reassignedByUserId: v.id("users"),  // Admin who executed the reassignment
  reassignedAt: v.number(),           // Unix ms
})
  .index("by_tenantId", ["tenantId"])
  .index("by_meetingId", ["meetingId"])
  .index("by_toCloserId", ["toCloserId"])
  .index("by_fromCloserId", ["fromCloserId"])
  .index("by_unavailabilityId", ["unavailabilityId"]),
```

**Step 3: Add `reassignedFromCloserId` to `meetings` table**

Locate the existing `meetings` table definition and add the new optional field:

```typescript
// Path: convex/schema.ts (MODIFIED: meetings table)

meetings: defineTable({
  // ... all existing fields remain unchanged ...
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  calendlyEventUri: v.string(),
  calendlyInviteeUri: v.string(),
  zoomJoinUrl: v.optional(v.string()),
  meetingJoinUrl: v.optional(v.string()),
  meetingLocationType: v.optional(v.string()),
  scheduledAt: v.number(),
  durationMinutes: v.number(),
  status: v.union(
    v.literal("scheduled"),
    v.literal("in_progress"),
    v.literal("completed"),
    v.literal("canceled"),
    v.literal("no_show"),
  ),
  notes: v.optional(v.string()),
  leadName: v.optional(v.string()),
  createdAt: v.number(),
  utmParams: v.optional(utmParamsValidator),
  meetingOutcome: v.optional(
    v.union(
      v.literal("interested"),
      v.literal("needs_more_info"),
      v.literal("price_objection"),
      v.literal("not_qualified"),
      v.literal("ready_to_buy"),
    ),
  ),

  // NEW: Feature H — Denormalized reassignment source for display efficiency.
  // Points to the closer who originally owned this meeting before the most recent reassignment.
  // Undefined = never reassigned (original assignment from Calendly pipeline).
  reassignedFromCloserId: v.optional(v.id("users")),
})
  // ... all existing indexes remain unchanged ...
  .index("by_opportunityId", ["opportunityId"])
  .index("by_tenantId_and_scheduledAt", ["tenantId", "scheduledAt"])
  .index("by_tenantId_and_calendlyEventUri", ["tenantId", "calendlyEventUri"]),
```

**Key implementation notes:**
- `reassignedFromCloserId` is `v.optional()` — existing meeting documents without this field remain valid. No backfill needed.
- Keep all existing table definitions and indexes unchanged.
- The `closerUnavailability.date` field stores a start-of-day UTC timestamp (midnight). This is not a date string — it's a Unix ms number for consistent querying.
- `meetingReassignments.unavailabilityId` is optional because future versions may allow ad-hoc reassignments not tied to an unavailability record.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 2 new tables, add 1 optional field to `meetings` |

---

### 1B — New Permissions

**Type:** Backend
**Parallelizable:** Yes — touches only `convex/lib/permissions.ts`, no overlap with 1A or 1C.

**What:** Add three new permission entries to the RBAC permission table: `team:manage-availability`, `reassignment:execute`, `reassignment:view-all`.

**Why:** The Mark Unavailable UI (Phase 2) and Redistribution Wizard (Phase 3) use `RequirePermission` and `hasPermission()` to gate UI elements and actions. Without these entries, the permission checks would fail or need to be hardcoded.

**Where:**
- `convex/lib/permissions.ts` (modify)

**How:**

**Step 1: Add new permission entries**

```typescript
// Path: convex/lib/permissions.ts

export const PERMISSIONS = {
  // ... existing permissions ...
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],

  // NEW: Feature H — Closer Unavailability & Redistribution
  "team:manage-availability": ["tenant_master", "tenant_admin"],
  "reassignment:execute": ["tenant_master", "tenant_admin"],
  "reassignment:view-all": ["tenant_master", "tenant_admin"],
} as const;
```

**Key implementation notes:**
- No `reassignment:view-own` permission is needed — closers access reassignment metadata through the existing `meeting:view-own` permission gate.
- The `Permission` type (`keyof typeof PERMISSIONS`) auto-expands to include the new keys — no manual type changes needed.
- `hasPermission(role, permission)` works immediately for the new entries with no code changes to the function itself.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | Add 3 new permission entries |

---

### 1C — Validation Helpers

**Type:** Backend
**Parallelizable:** Yes — creates a new file, no overlap with 1A or 1B.

**What:** Create `convex/lib/unavailabilityValidation.ts` with three pure/query helper functions: `getEffectiveRange`, `isMeetingInRange`, `validateCloser`.

**Why:** These helpers are shared across the `createCloserUnavailability` mutation (Phase 2) and the `getUnavailabilityWithMeetings` query (Phase 2). Centralizing them prevents duplicate logic and makes the range calculation testable in isolation.

**Where:**
- `convex/lib/unavailabilityValidation.ts` (new)

**How:**

**Step 1: Create the validation helper file**

```typescript
// Path: convex/lib/unavailabilityValidation.ts

import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Determine the effective time range for an unavailability record.
 *
 * For full-day records, returns midnight-to-midnight of the target date.
 * For partial-day records, returns the specified startTime-endTime range.
 */
export function getEffectiveRange(unavailability: {
  date: number;
  isFullDay: boolean;
  startTime?: number;
  endTime?: number;
}): { rangeStart: number; rangeEnd: number } {
  if (unavailability.isFullDay) {
    // Full day: from the start-of-day timestamp to +24 hours
    return {
      rangeStart: unavailability.date,
      rangeEnd: unavailability.date + 24 * 60 * 60 * 1000,
    };
  }

  // Partial day: use explicit start/end times
  if (!unavailability.startTime || !unavailability.endTime) {
    throw new Error(
      "Partial-day unavailability must have startTime and endTime",
    );
  }

  return {
    rangeStart: unavailability.startTime,
    rangeEnd: unavailability.endTime,
  };
}

/**
 * Check if a meeting falls within an unavailability time range.
 *
 * A meeting is "affected" if its scheduled time falls within [rangeStart, rangeEnd).
 * Uses half-open interval: includes rangeStart, excludes rangeEnd.
 */
export function isMeetingInRange(
  meetingScheduledAt: number,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  return meetingScheduledAt >= rangeStart && meetingScheduledAt < rangeEnd;
}

/**
 * Validate that a closer exists, belongs to the tenant, and has the "closer" role.
 *
 * Throws descriptive errors on failure — callers should not catch these
 * (they propagate as user-facing error messages in the mutation response).
 */
export async function validateCloser(
  ctx: QueryCtx | MutationCtx,
  closerId: Id<"users">,
  tenantId: Id<"tenants">,
): Promise<void> {
  const user = await ctx.db.get(closerId);
  if (!user || user.tenantId !== tenantId) {
    throw new Error("Closer not found in this tenant");
  }
  if (user.role !== "closer") {
    throw new Error("User is not a closer");
  }
}
```

**Key implementation notes:**
- `getEffectiveRange` uses `24 * 60 * 60 * 1000` (86,400,000 ms) for full-day range. This is exact — no DST edge cases since we store UTC timestamps.
- `isMeetingInRange` uses a half-open interval `[rangeStart, rangeEnd)` — a meeting at exactly `rangeEnd` is NOT affected (consistent with Calendly's scheduling model).
- `validateCloser` throws on failure (not null return) — consistent with `requireTenantUser` pattern of failing loud for invalid states.
- All functions are pure (except `validateCloser` which reads DB) and have no side effects.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/unavailabilityValidation.ts` | Create | 3 shared validation/utility functions |

---

### 1D — Deploy & Verify

**Type:** Manual
**Parallelizable:** No — depends on 1A, 1B, 1C all completing first.

**What:** Run `npx convex dev` to deploy the schema changes and verify everything compiles cleanly.

**Why:** Schema deployment generates the types that Phase 2, 3, and 4 depend on. This step also catches any schema errors before other phases begin.

**Where:**
- No files modified (verification step)

**How:**

**Step 1: Run TypeScript type check**

```bash
pnpm tsc --noEmit
```

Verify zero errors. If there are errors, they indicate a type mismatch in the schema or imports.

**Step 2: Deploy to Convex dev**

```bash
npx convex dev
```

Verify the deployment succeeds and the Convex dashboard shows:
- `closerUnavailability` table with `by_tenantId_and_date` and `by_closerId_and_date` indexes
- `meetingReassignments` table with all 5 indexes
- `meetings` table with the same existing indexes (no new indexes added to meetings)

**Step 3: Verify existing data is unaffected**

Navigate to the Convex dashboard → `meetings` table. Confirm existing documents do not have `reassignedFromCloserId` (field should be absent, which is valid because it's `v.optional`).

**Key implementation notes:**
- If `npx convex dev` fails with a schema validation error, check that the `v.optional(v.id("users"))` field was added correctly to `meetings` — it must be optional to avoid breaking existing documents.
- The `convex-migration-helper` skill should be consulted if there are any deployment failures related to schema validation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification step only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/permissions.ts` | Modify | 1B |
| `convex/lib/unavailabilityValidation.ts` | Create | 1C |
