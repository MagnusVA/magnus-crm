# Phase 1 — Schedule Schema and Shared Work Schedule Library

**Goal:** Add the additive Slack qualifier and DM closer weekly schedule tables, extract a shared weekday validator/helper, and preserve existing Lead Gen schedule behavior. After this phase, Convex generated types include the new schedule tables and all weekday math is centralized without changing existing Lead Gen data.

**Prerequisite:** Phase 0 complete. The additive-table MVP path is accepted.

**Runs in PARALLEL with:** Nothing at the phase level. Phases 2, 3, and 4 depend on generated types from this phase.

**Skills to invoke:**
- `convex-migration-helper` — verify this is an additive schema change and no migration job is required.
- `convex-performance-audit` — keep indexes minimal and avoid write overhead from redundant indexes.
- `convex` — schema validators, table definitions, generated types, and indexed query constraints.

**Acceptance Criteria:**
1. `convex/lib/workSchedule.ts` exports `weekdayValidator`, `weekdays`, `Weekday`, and `weekdayForBusinessDate()`.
2. `weekdayForBusinessDate()` maps `Date.getUTCDay()` through a Sunday-first lookup while UI ordering remains Monday-first.
3. `convex/leadGen/validators.ts` re-exports `leadGenWeekdayValidator` from the shared validator without changing the accepted literal values.
4. `convex/schema.ts` defines `slackQualifierSchedules` with tenant, Slack user, weekday, scheduled hours, editor, and update timestamp fields.
5. `convex/schema.ts` defines `dmCloserSchedules` with tenant, DM closer ID, weekday, scheduled hours, editor, and update timestamp fields.
6. No existing table gets a new required field.
7. `leadGenWorkerSchedules` remains physically unchanged except for the validator import path.
8. New schedule table indexes support tenant list, actor list, and actor+weekday unique lookup patterns.
9. `npx convex dev --once` or the project’s Convex type generation step completes without schema errors.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (shared weekday module) ───────┬── 1B (schema tables) ─────┐
                                 └── 1C (lead-gen alias) ────┤── 1D (generated types + schema gate)
                                                               │
1D complete ───────────────────────────────────────────────────┘
```

**Optimal execution:**
1. Complete 1A first because schema imports the shared validator.
2. Run 1B and 1C in parallel after 1A; they touch different files.
3. Finish with 1D generated-type and schema validation.

**Estimated time:** 0.5-1 day

---

## Subphases

### 1A — Shared Weekday Validator and Business-Date Helper

**Type:** Backend  
**Parallelizable:** No — schema and lead-gen alias depend on this module.

**What:** Create a neutral schedule utility with the shared weekday validator, UI weekday ordering, and safe business-date-to-weekday conversion.

**Why:** Slack qualifier and DM closer schedules should copy the Lead Gen Ops schedule shape. Centralizing the validator prevents duplicate literal unions, and centralizing weekday math prevents Sunday/Monday shifts.

**Where:**
- `convex/lib/workSchedule.ts` (create)

**How:**

**Step 1: Create the shared module.**

```typescript
// Path: convex/lib/workSchedule.ts
import { v } from "convex/values";
import { businessDateToUtcStart } from "../reporting/lib/hondurasBusinessTime";

export const weekdayValidator = v.union(
  v.literal("monday"),
  v.literal("tuesday"),
  v.literal("wednesday"),
  v.literal("thursday"),
  v.literal("friday"),
  v.literal("saturday"),
  v.literal("sunday"),
);

export const weekdays = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type Weekday = (typeof weekdays)[number];

const weekdaysByUtcDay: readonly Weekday[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function weekdayForBusinessDate(dayKey: string): Weekday {
  businessDateToUtcStart(dayKey);
  const date = new Date(`${dayKey}T12:00:00.000Z`);
  const weekday = weekdaysByUtcDay[date.getUTCDay()];
  if (!weekday) {
    throw new Error("Invalid business date weekday");
  }
  return weekday;
}
```

**Key implementation notes:**
- `weekdays` is Monday-first because that is the editor order.
- `weekdaysByUtcDay` is Sunday-first because `Date.getUTCDay()` returns Sunday as `0`.
- `businessDateToUtcStart(dayKey)` is called for validation and consistency with existing reporting helpers.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/workSchedule.ts` | Create | Shared weekday validator/helper |

### 1B — Add Slack and DM Schedule Tables

**Type:** Backend  
**Parallelizable:** Yes — can run after 1A while 1C updates the lead-gen alias.

**What:** Add additive schedule tables to `convex/schema.ts`.

**Why:** Schedule rows must be tenant-scoped, actor-scoped, and typed. Separate tables avoid a migration of existing Lead Gen schedules.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Import the shared validator.**

```typescript
// Path: convex/schema.ts
import { weekdayValidator } from "./lib/workSchedule";
```

**Step 2: Add the two schedule tables near `leadGenWorkerSchedules` or other work/schedule domain tables.**

```typescript
// Path: convex/schema.ts
slackQualifierSchedules: defineTable({
  tenantId: v.id("tenants"),
  slackUserId: v.string(),
  weekday: weekdayValidator,
  scheduledHours: v.number(),
  updatedByUserId: v.id("users"),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_slackUserId", ["tenantId", "slackUserId"])
  .index("by_tenantId_and_slackUserId_and_weekday", [
    "tenantId",
    "slackUserId",
    "weekday",
  ]),

dmCloserSchedules: defineTable({
  tenantId: v.id("tenants"),
  dmCloserId: v.id("dmClosers"),
  weekday: weekdayValidator,
  scheduledHours: v.number(),
  updatedByUserId: v.id("users"),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_dmCloserId", ["tenantId", "dmCloserId"])
  .index("by_tenantId_and_dmCloserId_and_weekday", [
    "tenantId",
    "dmCloserId",
    "weekday",
  ]),
```

**Key implementation notes:**
- `scheduledHours` remains `v.number()` to match Lead Gen Ops and support quarter-hour decimals.
- The single-field tenant indexes are acceptable because the settings UI lists all schedules for the tenant.
- The actor+weekday indexes support `.unique()` in upsert mutations.
- Do not add `userId` to these tables; Slack qualifiers and DM closers are not CRM users.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add additive schedule tables |

### 1C — Preserve Lead Gen Validator Compatibility

**Type:** Backend  
**Parallelizable:** Yes — can run after 1A while 1B updates schema.

**What:** Replace the local `leadGenWeekdayValidator` definition with a compatibility export from the shared module.

**Why:** Existing Lead Gen files should keep importing `leadGenWeekdayValidator`, but all schedule domains should share one validator source.

**Where:**
- `convex/leadGen/validators.ts` (modify)

**How:**

**Step 1: Replace only the weekday validator export.**

```typescript
// Path: convex/leadGen/validators.ts
export { weekdayValidator as leadGenWeekdayValidator } from "../lib/workSchedule";
```

**Key implementation notes:**
- Keep all other Lead Gen validators unchanged.
- Verify no circular dependency is introduced. `convex/lib/workSchedule.ts` must not import from `convex/leadGen/*`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/validators.ts` | Modify | Re-export shared weekday validator |

### 1D — Schema and Generated-Type Verification

**Type:** Backend / QA  
**Parallelizable:** No — validates all Phase 1 edits together.

**What:** Run schema/type generation and check for accidental migration scope.

**Why:** Phases 2-5 import generated `Id<"slackQualifierSchedules">` and `Id<"dmCloserSchedules">` types.

**Where:**
- `convex/_generated/*` (generated)

**How:**

**Step 1: Run Convex validation.**

```bash
npx convex dev --once
```

**Step 2: Run TypeScript.**

```bash
pnpm tsc --noEmit
```

**Step 3: Confirm no migration job is needed.**

```text
Pass if:
- no existing schema field became required,
- no existing table changed shape,
- no historical data must be rewritten,
- missing schedule rows are handled by later code.
```

**Key implementation notes:**
- If generated type files are committed in this repo, include the generated changes with Phase 1.
- If Convex deploy rejects schema, stop before UI work starts.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | Only if repo tracks generated updates |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/workSchedule.ts` | Create | 1A |
| `convex/schema.ts` | Modify | 1B |
| `convex/leadGen/validators.ts` | Modify | 1C |
| `convex/_generated/*` | Generate | 1D |
