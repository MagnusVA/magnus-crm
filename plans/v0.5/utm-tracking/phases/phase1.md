# Phase 1 — Schema Widen: Add `utmParams` Fields

**Goal:** Add optional `utmParams` fields to the `meetings` and `opportunities` tables. This is a widen-only migration that does not affect existing documents. The schema change is deployed and verified in the Convex dashboard.

**Prerequisite:** None — this is a standalone backend phase with no dependency on other v0.5 phases. The existing schema and pipeline infrastructure remain unchanged.

**Runs in PARALLEL with:** Nothing — Phase 2 (pipeline extraction) depends on this schema deployment.

**Skills to invoke:**
- `convex-migration-helper` — Not needed for this phase (optional fields, widen-only). Reference for future phases requiring backfill.

**Acceptance Criteria:**
1. `convex/lib/utmParams.ts` is created with the `utmParamsValidator` and `UtmParams` type.
2. `convex/schema.ts` is updated: `meetings` table has `utmParams: v.optional(utmParamsValidator)` field.
3. `convex/schema.ts` is updated: `opportunities` table has `utmParams: v.optional(utmParamsValidator)` field.
4. Schema is deployed with `npx convex dev` (or `npx convex deploy` for production) — deployment succeeds with zero data migration.
5. Convex dashboard confirms existing meeting and opportunity documents are unchanged (no data backfill).
6. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (UTM validator + type) ───────────────────────┐
                                                ├── 1B (Deploy schema to Convex)
1A also feeds into 1C directly
```

**Optimal execution:**
1. Complete 1A (create validator file).
2. Complete 1B and 1C in parallel (both update schema.ts and deploy — can be done as a single edit + deploy).

**Estimated time:** 0.5–1 day (straightforward additive change).

---

## Subphases

### 1A — UTM Validator & Type Definition

**Type:** Backend
**Parallelizable:** Yes — independent of schema.ts updates. Creates a shared export.

**What:** Create `convex/lib/utmParams.ts` with the `utmParamsValidator` Convex validator and `UtmParams` TypeScript type. This file is imported by both the schema and the pipeline processor in Phase 2.

**Why:** Centralizing the validator ensures consistency across table definitions and makes it reusable for the extraction helper in Phase 2. Defining the validator once prevents duplication and reduces the risk of schema/type mismatches.

**Where:**
- `convex/lib/utmParams.ts` (new)

**How:**

**Step 1: Create the UTM validator and type**

```typescript
// Path: convex/lib/utmParams.ts

import { v } from "convex/values";

/**
 * Convex validator for the Calendly tracking/UTM object.
 *
 * Mirrors Calendly's `tracking` object structure (minus `salesforce_uuid`).
 * All fields are optional — a booking with no UTMs produces `undefined`
 * at the parent level, not an empty object.
 */
export const utmParamsValidator = v.object({
  utm_source: v.optional(v.string()),
  utm_medium: v.optional(v.string()),
  utm_campaign: v.optional(v.string()),
  utm_term: v.optional(v.string()),
  utm_content: v.optional(v.string()),
});

/**
 * TypeScript type derived from the validator.
 * Use this for function signatures and helper return types.
 */
export type UtmParams = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_term?: string;
  utm_content?: string;
};
```

**Key implementation notes:**
- The validator is `v.object({...})` with each field wrapped in `v.optional(v.string())`. This allows the Convex database to store objects with any subset of the five UTM fields.
- We use `v.optional(...)` on individual fields (not on the object itself) because the field-level optional allows partial objects like `{ utm_source: "facebook" }` without the other fields.
- The `UtmParams` type mirrors the validator structure for TypeScript use in function signatures.
- We intentionally exclude `salesforce_uuid` — Calendly includes it, but it's not relevant to our use case and would be perpetually `null`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/utmParams.ts` | Create | Shared validator and type |

---

### 1B — Update Schema: `meetings` Table

**Type:** Backend
**Parallelizable:** Yes — independent update to schema.ts. Can be done alongside 1C.

**What:** Add `utmParams: v.optional(utmParamsValidator)` field to the `meetings` table definition in `convex/schema.ts`.

**Why:** Every meeting needs to store the UTM parameters that Calendly captured from the booking link. The Phase 2 pipeline processor will populate this field from the webhook payload. Adding the field now ensures the schema is ready before the pipeline starts writing to it.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Import the validator**

At the top of `convex/schema.ts`, add the import:

```typescript
// Path: convex/schema.ts

import { utmParamsValidator } from "./lib/utmParams";
```

**Step 2: Add the field to the `meetings` table**

Locate the `meetings` table definition in `convex/schema.ts`. Add the `utmParams` field after the existing fields (e.g., after `createdAt`):

```typescript
// Path: convex/schema.ts

meetings: defineTable({
  // ... existing fields (tenantId, opportunityId, calendlyEventUri, etc.) ...

  createdAt: v.number(),

  // NEW: UTM attribution data extracted from Calendly's tracking object.
  // Populated from the invitee.created webhook payload.
  // undefined for meetings created before UTM tracking was enabled.
  utmParams: v.optional(utmParamsValidator),
})
  // ... existing indexes remain unchanged ...
```

**Key implementation notes:**
- The field is at the table level, not nested — `utmParams: v.optional(utmParamsValidator)` means the entire field can be absent.
- For meetings without UTM data, the `utmParams` field will not be present on the document (not stored as `{}`).
- Existing meetings continue to work unchanged — they simply won't have this field.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `utmParams` field to meetings table |

---

### 1C — Update Schema: `opportunities` Table

**Type:** Backend
**Parallelizable:** Yes — independent update to schema.ts. Can be done alongside 1B.

**What:** Add `utmParams: v.optional(utmParamsValidator)` field to the `opportunities` table definition in `convex/schema.ts`.

**Why:** Opportunities track the original acquisition channel of a lead. The first booking's UTM parameters capture how the lead initially arrived. Subsequent follow-up bookings may have different UTMs (e.g., CRM-generated), but the opportunity preserves the original attribution. This enables lifecycle analytics.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the field to the `opportunities` table**

Locate the `opportunities` table definition in `convex/schema.ts` (same file as 1B). Add the `utmParams` field after the existing fields (e.g., after `updatedAt`):

```typescript
// Path: convex/schema.ts

opportunities: defineTable({
  // ... existing fields (tenantId, leadId, assignedCloserId, status, etc.) ...

  updatedAt: v.number(),

  // NEW: UTM attribution from the FIRST booking that created this opportunity.
  // Subsequent follow-up bookings do NOT overwrite this field.
  // undefined for opportunities created before UTM tracking was enabled.
  utmParams: v.optional(utmParamsValidator),
})
  // ... existing indexes remain unchanged ...
```

**Key implementation notes:**
- Same pattern as the `meetings` field — the entire field is optional.
- The comment emphasizes that this field is set once (on first booking) and never overwritten. The pipeline processor enforces this in Phase 2.
- Existing opportunities continue to work unchanged.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `utmParams` field to opportunities table |

---

### 1D — Deploy Schema and Verify

**Type:** Backend
**Parallelizable:** No — must occur after 1A, 1B, 1C are complete. This is the final deployment step.

**What:** Deploy the schema changes to Convex (dev or production) and verify that the schema push succeeds with zero data migration. Check the Convex dashboard to confirm existing documents are unchanged.

**Why:** Schema deployment activates the new fields. Verification ensures the widen-only change worked as expected and didn't inadvertently trigger a migration or cause data loss.

**Where:**
- Convex dev/production environment
- Convex dashboard (inspection only)

**How:**

**Step 1: Run the development server (or deploy to production)**

```bash
# For development:
npx convex dev

# For production:
npx convex deploy
```

The schema push should succeed immediately. Convex will report something like:

```
✓ Schema deployed successfully
✓ No data migration required
✓ Existing documents unaffected
```

**Step 2: Verify in the Convex dashboard**

1. Open the Convex dashboard (local or production as appropriate).
2. Navigate to the **Data** section.
3. Click into the `meetings` table — confirm that recent meetings have the same fields as before (no existing documents show `utmParams`).
4. Click into the `opportunities` table — same check.
5. Create a test meeting or opportunity (via the dashboard or a manual query) — the new field should be optional and the document should be creatable without it.

**Step 3: Check TypeScript compilation**

```bash
pnpm tsc --noEmit
```

Should pass without errors. The import of `utmParamsValidator` and `UtmParams` is now valid.

**Key implementation notes:**
- This is a pure additive change. Convex does not require explicit migration steps for optional fields on existing tables.
- If the deploy fails, check:
  - Are the imports correct? (`import { utmParamsValidator } from "./lib/utmParams"`)
  - Is the validator exported from `convex/lib/utmParams.ts`?
  - Is the syntax correct? (`v.optional(utmParamsValidator)`)
- If deployment still fails, the error message will be specific. Common issue: typo in import path.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| Convex deployment environment | N/A | Schema deployed; no rollback needed if successful |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/utmParams.ts` | Create | 1A |
| `convex/schema.ts` | Modify | 1B, 1C |

