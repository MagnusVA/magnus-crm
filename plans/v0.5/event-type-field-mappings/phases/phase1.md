# Phase 1 — Schema: Custom Field Mapping Fields

**Goal:** Add `customFieldMappings` and `knownCustomFieldKeys` as optional fields on the `eventTypeConfigs` table and deploy the schema so that all subsequent phases can import the generated types. After this phase, `npx convex dev` succeeds, TypeScript sees the new fields, and no existing functionality is broken.

**Prerequisite:** Feature G (UTM Tracking & Attribution) complete and deployed. Feature J (Form Handling Modernization) complete. v0.4 fully deployed. `convex/lib/utmParams.ts` exists and is imported by `convex/schema.ts`.

**Runs in PARALLEL with:** Nothing — this is the foundation phase. Phases 2, 3, and 4 all depend on the schema types generated here.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 3 → Phase 4). Deploy immediately.

> **Feature I coordination:** Feature I (Meeting Detail Enhancements) also adds schema fields in Window 1. Feature I modifies the `meetings` table; Feature F modifies the `eventTypeConfigs` table. **No conflict.** However, serialize `npx convex dev` deployments: deploy Feature I's schema first, then Feature F's, per the parallelization strategy in `plans/v0.5/feature-area-parallelization-strat.md`.

**Skills to invoke:**
- None required — this is a pure schema change with no UI or complex backend logic.

**Acceptance Criteria:**
1. `convex/schema.ts` contains `customFieldMappings: v.optional(v.object({ ... }))` on `eventTypeConfigs` with `socialHandleField`, `socialHandleType`, and `phoneField` subfields.
2. `convex/schema.ts` contains `knownCustomFieldKeys: v.optional(v.array(v.string()))` on `eventTypeConfigs`.
3. `socialHandleType` uses `v.union(v.literal("instagram"), v.literal("tiktok"), v.literal("twitter"), v.literal("other_social"))`.
4. `npx convex dev` deploys without schema errors.
5. Existing `eventTypeConfigs` records in the database are unaffected (new fields are `undefined` on existing docs).
6. The existing `listEventTypeConfigs` query returns configs without error (new fields are simply `undefined`).
7. The existing `upsertEventTypeConfig` mutation works unchanged (it doesn't touch the new fields).
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Schema modification) ────────── 1B (Deploy & verify)
```

**Optimal execution:**
1. Complete 1A (modify `convex/schema.ts`).
2. Immediately run 1B (deploy and type-check).

**Estimated time:** 15-20 minutes

---

## Subphases

### 1A — Add Custom Field Mapping Fields to `eventTypeConfigs`

**Type:** Backend
**Parallelizable:** No — must complete first. 1B depends on this file change.

**What:** Add two new optional fields (`customFieldMappings` and `knownCustomFieldKeys`) to the `eventTypeConfigs` table definition in `convex/schema.ts`.

**Why:** Every subsequent phase needs these fields:
- Phase 2 writes to `knownCustomFieldKeys` in the pipeline.
- Phase 3 defines a mutation that writes to `customFieldMappings` and a query that reads both fields.
- Phase 4 builds UI that displays and edits both fields.
Without the schema change, Convex will reject any writes to these fields and TypeScript won't see them in `Doc<"eventTypeConfigs">`.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Locate the `eventTypeConfigs` table definition**

The table is defined at approximately line 187-207 of `convex/schema.ts`. Currently:

```typescript
// Path: convex/schema.ts
// CURRENT (lines 187-207):

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
    roundRobinEnabled: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index(
      "by_tenantId_and_calendlyEventTypeUri",
      ["tenantId", "calendlyEventTypeUri"],
    ),
```

**Step 2: Add the two new optional fields after `createdAt`**

Insert the new fields between `createdAt: v.number(),` and the closing `})`. Add a Feature F comment header for clear ownership boundaries (per `plans/v0.5/feature-area-parallelization-strat.md` — each feature's schema additions are grouped under a comment header).

```typescript
// Path: convex/schema.ts
// AFTER modification:

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
    roundRobinEnabled: v.boolean(),
    createdAt: v.number(),

    // === Feature F: Event Type Field Mappings ===
    // CRM-only overlays (not from Calendly).
    // Tells the pipeline which Calendly form question maps to which identity field.
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
    // Auto-discovered from incoming bookings (system-managed, read-only from admin perspective).
    // Populates the dropdown options in the field mapping configuration dialog.
    knownCustomFieldKeys: v.optional(v.array(v.string())),
    // === End Feature F ===
  })
    .index("by_tenantId", ["tenantId"])
    .index(
      "by_tenantId_and_calendlyEventTypeUri",
      ["tenantId", "calendlyEventTypeUri"],
    ),
```

**Key implementation notes:**
- Both fields are `v.optional(...)` — no migration or backfill needed. Existing records remain valid with `undefined` for both fields.
- `socialHandleType` is a strict union of 4 literals — not a freeform string. This prevents invalid platform values from entering the database.
- `knownCustomFieldKeys` is `v.array(v.string())` (not `v.record`) because the keys are question texts that serve as both the identifier and the display label. Arrays preserve insertion order (discovery order).
- No new indexes are needed — queries access these fields by loading the config document directly (by ID or by the existing `by_tenantId_and_calendlyEventTypeUri` index).
- The `// === Feature F ===` comment boundary is required by the parallelization strategy for merge conflict prevention across feature areas.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 2 optional fields to `eventTypeConfigs` table definition |

---

### 1B — Deploy Schema and Verify Type Generation

**Type:** Config / Manual
**Parallelizable:** No — depends on 1A. Validates that the schema change is correct before any subsequent phase starts.

**What:** Deploy the updated schema to the Convex development environment and verify that TypeScript type generation includes the new fields.

**Why:** Convex regenerates `convex/_generated/dataModel.d.ts` on each `npx convex dev`. All subsequent phases import types from this generated file. Deploying now catches any schema syntax errors before downstream work begins.

**Where:**
- Terminal (commands only — no file changes)

**How:**

**Step 1: Deploy the schema**

```bash
npx convex dev
```

Verify output includes:
- No schema validation errors
- Tables list includes `eventTypeConfigs` with the updated field count
- Convex dashboard shows the `eventTypeConfigs` table with both new fields as optional

**Step 2: Run TypeScript type check**

```bash
pnpm tsc --noEmit
```

Verify: zero errors. The generated types now include `customFieldMappings` and `knownCustomFieldKeys` on `Doc<"eventTypeConfigs">`.

**Step 3: Verify existing functionality is unaffected**

Open the Settings page in the browser (`/workspace/settings` → "Event Types" tab). Confirm:
- Existing event type configs still display correctly
- Edit dialog (payment links, round robin) still works
- No console errors

**Key implementation notes:**
- If Feature I has not yet deployed its schema changes, deploy Feature F's schema independently. Both features add fields to **different tables** — no conflict.
- If Feature I has already deployed, Feature F's schema change adds on top of I's changes. No special handling needed.
- If `npx convex dev` fails, check for syntax errors in the `v.object` nesting (matching parentheses on `v.optional(v.object({ ... }))` and `v.optional(v.union(...))`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/dataModel.d.ts` | Auto-generated | Updated by `npx convex dev` — includes new fields in type |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/_generated/dataModel.d.ts` | Auto-generated | 1B |
