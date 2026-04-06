# Phase 2 — Schema Hardening (VULN-08)

**Goal:** Tighten the `leads.customFields` validator from `v.optional(v.any())` to `v.optional(v.record(v.string(), v.string()))`, ensuring the database enforces the same shape the pipeline already produces and the UI already expects.

**Prerequisite:** Phase 1 complete — the `BookingAnswersCard` component is live and its `isStringRecord` guard confirms no UI breakage from the schema change.

**Runs in PARALLEL with:** Nothing — this is the final phase.

**Skills to invoke:**
- `convex-migration-helper` — safe widen–migrate–narrow execution of the schema change

**Acceptance Criteria:**

1. Running the validation migration reports zero dirty records (all existing `customFields` values are either `undefined` or valid `Record<string, string>`).
2. After narrowing the schema, `npx convex dev` starts without schema validation errors.
3. The webhook pipeline (`inviteeCreated.ts`) continues to create and update leads with `customFields` without runtime errors.
4. The `BookingAnswersCard` continues to render correctly for leads with custom fields.
5. A lead with `customFields: undefined` (no booking-form answers) remains valid under the new schema.
6. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Validate existing data) ──→ 2B (Narrow schema) ──→ 2C (Deploy & verify)
```

**Optimal execution:** Sequential — each step depends on the previous.

**Estimated time:** 30 minutes

---

## Subphases

### 2A — Validate Existing Data

**Type:** Backend
**Parallelizable:** No — must confirm data cleanliness before narrowing the schema.

**What:** Create and run a one-shot migration that audits every `leads` document's `customFields` value and remediates any that don't match `Record<string, string>`.

**Why:** The current schema is `v.any()`, so in theory any shape could have been stored. Before narrowing to `v.record(v.string(), v.string())`, we must verify (and fix) every existing document. Deploying the narrowed schema without this step would cause a schema validation error if even one document has a mismatched value.

**Where:**
- `convex/migrations/validateCustomFields.ts` (new)

**How:**

**Step 1: Create the migration file**

```typescript
// Path: convex/migrations/validateCustomFields.ts
import { internalMutation } from "../_generated/server";

/**
 * One-shot audit of leads.customFields values.
 *
 * For each lead:
 * - undefined → valid (skip)
 * - Record<string, string> → valid (skip)
 * - anything else → remediate by setting customFields to undefined
 *
 * Run via Convex dashboard: `npx convex run migrations/validateCustomFields:validate`
 */
export const validate = internalMutation({
  args: {},
  handler: async (ctx) => {
    const leads = await ctx.db.query("leads").collect();
    let clean = 0;
    let dirty = 0;

    for (const lead of leads) {
      if (lead.customFields === undefined) {
        clean++;
        continue;
      }

      const cf = lead.customFields;
      if (
        typeof cf === "object" &&
        cf !== null &&
        !Array.isArray(cf) &&
        Object.values(cf).every((v) => typeof v === "string")
      ) {
        clean++;
      } else {
        dirty++;
        console.warn(
          `[Migration] Lead ${lead._id} has invalid customFields:`,
          JSON.stringify(cf).slice(0, 200),
        );
        await ctx.db.patch(lead._id, { customFields: undefined });
      }
    }

    console.log(
      `[Migration] customFields audit complete: ${clean} clean, ${dirty} remediated`,
    );
  },
});
```

**Step 2: Run the migration**

```bash
npx convex run migrations/validateCustomFields:validate
```

Verify the console output shows `0 remediated`. If any records were remediated, the migration has already fixed them — proceed to 2B.

**Key implementation notes:**
- This is an `internalMutation` — it cannot be called from the client, only from the dashboard or other server functions.
- The `collect()` call loads all leads into memory. For tenants with very large lead counts (>10k), this should be paginated. Current product scale makes this safe.
- The remediation strategy (set to `undefined`) is conservative — it removes bad data rather than attempting to coerce it. The raw webhook payloads are retained in `rawWebhookEvents` for audit if needed.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations/validateCustomFields.ts` | Create | One-shot data validation migration |

---

### 2B — Narrow the Schema

**Type:** Backend
**Parallelizable:** No — depends on 2A confirming clean data.

**What:** Change the `customFields` validator in `convex/schema.ts` from `v.optional(v.any())` to `v.optional(v.record(v.string(), v.string()))`.

**Why:** This closes VULN-08 — the database now rejects any write that tries to store a non-string-record value on `customFields`. This protects against webhook payload tampering, pipeline bugs, and schema drift.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Update the validator**

```typescript
// Path: convex/schema.ts

// BEFORE:
  leads: defineTable({
    tenantId: v.id("tenants"),
    email: v.string(),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    customFields: v.optional(v.any()),
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })

// AFTER:
  leads: defineTable({
    tenantId: v.id("tenants"),
    email: v.string(),
    fullName: v.optional(v.string()),
    phone: v.optional(v.string()),
    customFields: v.optional(v.record(v.string(), v.string())),
    firstSeenAt: v.number(),
    updatedAt: v.number(),
  })
```

The indexes remain unchanged — `customFields` is not indexed.

**Key implementation notes:**
- This is a **narrowing** change — `v.record(v.string(), v.string())` is a strict subset of `v.any()`. Convex will validate all existing documents against the new schema on deploy. If any document doesn't match, the deploy fails — which is why 2A must run first.
- The `extractQuestionsAndAnswers` function in `inviteeCreated.ts` already returns `Record<string, string> | undefined`, so the pipeline continues to work without changes.
- The `mergeCustomFields` function uses spread (`{ ...existing, ...incoming }`) which preserves the `Record<string, string>` shape as long as both inputs are string records — which they will be after this schema change enforces it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Narrow `customFields` from `v.any()` to `v.record(v.string(), v.string())` |

---

### 2C — Deploy and Verify

**Type:** Manual
**Parallelizable:** No — depends on 2B.

**What:** Deploy the narrowed schema and verify the pipeline and UI continue to work correctly.

**Why:** Confirms the schema change doesn't break anything in production.

**Where:**
- No file changes — deployment and verification only.

**How:**

**Step 1: Deploy**

```bash
npx convex dev
```

Verify it starts without schema validation errors. If it fails, a document with invalid `customFields` was missed — re-run 2A and retry.

**Step 2: Type check**

```bash
pnpm tsc --noEmit
```

Must pass. The narrowed schema changes the generated types for `Doc<"leads">["customFields"]` from `any` to `Record<string, string> | undefined`, which may surface type issues in consuming code. The `BookingAnswersCard` prop is typed as `unknown`, so it's unaffected.

**Step 3: Pipeline verification**

Trigger a test Calendly booking (or use a test webhook payload) to create a new lead with custom fields. Verify:

- The lead is created in the Convex dashboard with `customFields` as a proper `Record<string, string>`
- The `BookingAnswersCard` renders the answers correctly on the meeting detail page

**Step 4: Existing lead verification**

Navigate to the meeting detail page for an existing lead with custom fields. Verify the "Booking Answers" card renders correctly — the schema change should have no visible effect on the UI.

**Key implementation notes:**
- After this deploy, the `Doc<"leads">["customFields"]` type changes from `any` to `Record<string, string> | undefined`. Any future code that reads `customFields` gets proper type safety without needing runtime guards. The `BookingAnswersCard`'s `isStringRecord` guard becomes redundant but harmless — it can be kept as a defense-in-depth measure or removed in a future cleanup.
- The migration file (`validateCustomFields.ts`) can be deleted after this phase is complete — it's a one-shot script. However, keeping it in `convex/migrations/` as a record of the migration is acceptable.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (none) | — | Deployment and verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/migrations/validateCustomFields.ts` | Create | 2A |
| `convex/schema.ts` | Modify | 2B |
