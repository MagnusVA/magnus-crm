# Phase 6 — Schema Narrow

**Goal:** Tighten schema validators now that all data is backfilled (Phase 2) and all code is updated (Phases 3/4/5). Remove `v.optional()` wrappers from fields that are now guaranteed present, delete deprecated fields from documents and schema, and harden `v.any()` to a typed validator. After this phase, the schema is the single source of truth for data shape -- no runtime fallbacks or coalescing required.

**Prerequisite:** All Phase 2 backfills complete + all Phase 3/4/5 code updates deployed and verified. Specifically:
- Phase 2 backfilled `leads.status`, `users.isActive`, `meetings.assignedCloserId`, `paymentRecords.amountMinor`, `paymentRecords.contextType`, `followUps.type`
- Phase 3 mutations write all new required fields on creation
- Phase 4 queries no longer reference `paymentRecords.amount` or tenant-level OAuth fields
- Phase 5 OAuth consumers fully migrated to `tenantCalendlyConnections`

**Runs in PARALLEL with:** Nothing -- this is the convergence point. All prior phases must be complete.

**Skills to invoke:**
- `convex-migration-helper` -- for field stripping backfills (6B) and the widen-migrate-narrow narrowing deploy pattern

**Acceptance Criteria:**

1. Zero documents in `leads` have `status === undefined` (verified by validation query before deploy).
2. Zero documents in `users` have `isActive === undefined`.
3. Zero documents in `meetings` have `assignedCloserId === undefined`.
4. Zero documents in `followUps` have `type === undefined`.
5. Zero documents in `paymentRecords` have `contextType === undefined`.
6. Zero documents in `paymentRecords` contain an `amount` field (stripped, not just unused).
7. Zero documents in `tenants` contain any of the 10 deprecated OAuth fields (stripped from documents).
8. `leads.customFields` validates as `v.optional(v.record(v.string(), v.string()))` -- no `v.any()` in the final schema.
9. `npx convex deploy` succeeds against production data with the narrowed schema (Convex validates all existing documents).
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (Pre-Narrowing Validation Scripts)
    │
    ↓
6B (Field Stripping Backfills)
    │
    ├───────────────────────┐
    ↓                       ↓
6C (Schema Narrow:        6D (Schema Narrow:
    Required Fields)          Removals + Type Hardening)
    │                       │
    └───────────┬───────────┘
                ↓
6E (Post-Narrowing Verification)
```

**Optimal execution:**

1. Start and complete 6A -- run all 8 validation queries. Every query must return zero violations.
2. Once 6A passes, execute 6B -- strip `paymentRecords.amount` values and all OAuth fields from `tenants` documents.
3. After 6B completes, 6C and 6D can run in parallel -- they modify different tables in `schema.ts` and can merge into a single deploy.
4. After 6C + 6D schema changes are applied, run 6E -- deploy, verify queries, run TypeScript check.

**Estimated time:** 3-5 hours (6A = 45 min, 6B = 30 min, 6C + 6D = 1 hour, 6E = 45 min + buffer)

---

## Subphases

### 6A — Pre-Narrowing Validation Scripts

**Type:** Backend / Verification
**Parallelizable:** No -- this is the foundation. All subsequent subphases depend on every validation passing.

**What:** Write and execute verification queries for all 8 narrowing items. Each query scans for documents that would violate the narrowed schema. Every query must return zero results before proceeding.

**Why:** Convex validates ALL existing documents against the schema on deploy. If even one document has `status === undefined` when the schema says `status` is required, the deploy will fail. Running these checks upfront catches any missed backfills from Phase 2 before attempting a deploy that would be rejected.

**Where:**
- `convex/admin/narrowingValidation.ts` (new file)

**How:**

**Step 1: Create the validation module**

Create an internal action that runs all 8 checks and reports results:

```typescript
// Path: convex/admin/narrowingValidation.ts
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * Pre-narrowing validation: checks every document that would violate
 * the Phase 6 narrowed schema. Returns a report object.
 * Run via Convex dashboard or `npx convex run`.
 */
export const validateNarrowingReadiness = internalQuery({
  args: {},
  handler: async (ctx) => {
    const results: Record<string, number> = {};

    // 6.1: leads.status must not be undefined
    const leadsNoStatus = await ctx.db
      .query("leads")
      .filter((q) => q.eq(q.field("status"), undefined))
      .take(100);
    results["leads_missing_status"] = leadsNoStatus.length;

    // 6.2: paymentRecords.amount must not exist (field should be stripped)
    // We check for documents that still have the old `amount` field present.
    // After stripping, the field should be absent from all documents.
    const paymentsWithAmount = await ctx.db
      .query("paymentRecords")
      .filter((q) => q.neq(q.field("amount"), undefined))
      .take(100);
    results["payments_with_legacy_amount"] = paymentsWithAmount.length;

    // 6.3: users.isActive must not be undefined
    const usersNoIsActive = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("isActive"), undefined))
      .take(100);
    results["users_missing_isActive"] = usersNoIsActive.length;

    // 6.4: meetings.assignedCloserId must not be undefined
    const meetingsNoCloser = await ctx.db
      .query("meetings")
      .filter((q) => q.eq(q.field("assignedCloserId"), undefined))
      .take(100);
    results["meetings_missing_assignedCloserId"] = meetingsNoCloser.length;

    // 6.5: followUps.type must not be undefined
    const followUpsNoType = await ctx.db
      .query("followUps")
      .filter((q) => q.eq(q.field("type"), undefined))
      .take(100);
    results["followUps_missing_type"] = followUpsNoType.length;

    // 6.6: paymentRecords.contextType must not be undefined
    const paymentsNoContext = await ctx.db
      .query("paymentRecords")
      .filter((q) => q.eq(q.field("contextType"), undefined))
      .take(100);
    results["payments_missing_contextType"] = paymentsNoContext.length;

    // 6.7: leads.customFields values must be valid Record<string, string>
    // Check for any customFields that contain non-string values
    const leadsWithCustomFields = await ctx.db.query("leads").collect();
    let invalidCustomFields = 0;
    for (const lead of leadsWithCustomFields) {
      if (lead.customFields !== undefined) {
        if (typeof lead.customFields !== "object" || lead.customFields === null || Array.isArray(lead.customFields)) {
          invalidCustomFields++;
          continue;
        }
        for (const val of Object.values(lead.customFields as Record<string, unknown>)) {
          if (typeof val !== "string") {
            invalidCustomFields++;
            break;
          }
        }
      }
    }
    results["leads_invalid_customFields"] = invalidCustomFields;

    // 6.8: tenants must not have deprecated OAuth fields
    const allTenants = await ctx.db.query("tenants").collect();
    const oauthFields = [
      "calendlyAccessToken", "calendlyRefreshToken", "calendlyTokenExpiresAt",
      "calendlyRefreshLockUntil", "lastTokenRefreshAt", "codeVerifier",
      "calendlyOrgUri", "calendlyOwnerUri",
      "calendlyWebhookUri", "webhookSigningKey",
    ] as const;
    let tenantsWithOAuth = 0;
    for (const tenant of allTenants) {
      const doc = tenant as Record<string, unknown>;
      if (oauthFields.some((f) => doc[f] !== undefined)) {
        tenantsWithOAuth++;
      }
    }
    results["tenants_with_deprecated_oauth"] = tenantsWithOAuth;

    // Summary
    const allClear = Object.values(results).every((count) => count === 0);
    return { allClear, results };
  },
});
```

**Step 2: Run the validation**

```bash
npx convex run admin/narrowingValidation:validateNarrowingReadiness
```

**Step 3: Interpret results**

If `allClear === true`, proceed to 6B. If any count is non-zero, the corresponding Phase 2 backfill was incomplete -- re-run the relevant backfill before continuing.

**Key implementation notes:**

- The `.take(100)` limits are a safety measure to avoid unbounded results. At ~700 records total, `.collect()` is acceptable for the `leads` custom fields check but avoid it on larger tables in the future.
- The `6.7` check iterates all leads because `v.any()` means we cannot trust the shape. We must verify every value is `Record<string, string>`.
- The `6.8` check casts to `Record<string, unknown>` because TypeScript types from the current schema include these optional fields. After narrowing, the cast will become unnecessary.
- This module is `internalQuery` -- not exposed to clients. Run it from the Convex dashboard or CLI only.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/admin/narrowingValidation.ts` | Create | 8 validation queries, one per narrowing item |

---

### 6B — Field Stripping Backfills

**Type:** Backend / Migration
**Parallelizable:** No -- depends on 6A validation passing. Must complete before 6C and 6D.

**What:** Remove the `paymentRecords.amount` field value from all payment documents and strip all 10 deprecated OAuth fields from all tenant documents. This is a data mutation, not a schema change -- the fields are physically removed from documents so that a stricter schema can be deployed.

**Why:** Convex schema validation checks all fields present on a document. Removing a field from the schema definition while documents still contain that field will cause a deploy failure. We must strip field values first (while the schema still allows them as optional), then remove the field definition from the schema in 6C/6D.

**Where:**
- `convex/admin/narrowingBackfills.ts` (new file)

**How:**

**Step 1: Create the field-stripping backfill module**

```typescript
// Path: convex/admin/narrowingBackfills.ts
import { internalMutation } from "../_generated/server";
import { v } from "convex/values";

/**
 * Strip the deprecated `amount` field from all paymentRecords documents.
 * After Phase 3, all reads use `amountMinor`. This removes the old float field
 * so the schema can drop it in 6D.
 *
 * Convex `ctx.db.patch` with `undefined` values removes fields from documents.
 */
export const stripPaymentAmount = internalMutation({
  args: {},
  handler: async (ctx) => {
    const payments = await ctx.db.query("paymentRecords").collect();
    let stripped = 0;
    for (const payment of payments) {
      const doc = payment as Record<string, unknown>;
      if (doc.amount !== undefined) {
        // Setting a field to undefined in patch removes it from the document
        await ctx.db.patch(payment._id, { amount: undefined } as any);
        stripped++;
      }
    }
    console.log(`[Narrow:6B] Stripped amount from ${stripped} payment records`);
    return { stripped, total: payments.length };
  },
});

/**
 * Strip all deprecated Calendly OAuth fields from tenant documents.
 * After Phase 5, all OAuth state lives in `tenantCalendlyConnections`.
 * This removes the legacy fields so the schema can drop them in 6D.
 */
export const stripTenantOAuthFields = internalMutation({
  args: {},
  handler: async (ctx) => {
    const tenants = await ctx.db.query("tenants").collect();
    let stripped = 0;
    for (const tenant of tenants) {
      const doc = tenant as Record<string, unknown>;
      const fieldsToStrip: Record<string, undefined> = {};
      const oauthFields = [
        "calendlyAccessToken", "calendlyRefreshToken", "calendlyTokenExpiresAt",
        "calendlyRefreshLockUntil", "lastTokenRefreshAt", "codeVerifier",
        "calendlyOrgUri", "calendlyOwnerUri",
        "calendlyWebhookUri", "webhookSigningKey",
        "webhookProvisioningStartedAt",
      ];
      let hasAny = false;
      for (const field of oauthFields) {
        if (doc[field] !== undefined) {
          fieldsToStrip[field] = undefined;
          hasAny = true;
        }
      }
      if (hasAny) {
        await ctx.db.patch(tenant._id, fieldsToStrip as any);
        stripped++;
      }
    }
    console.log(`[Narrow:6B] Stripped OAuth fields from ${stripped} tenants`);
    return { stripped, total: tenants.length };
  },
});
```

**Step 2: Run the stripping backfills**

```bash
# Strip payment amount field
npx convex run admin/narrowingBackfills:stripPaymentAmount

# Strip tenant OAuth fields
npx convex run admin/narrowingBackfills:stripTenantOAuthFields
```

**Step 3: Re-run 6A validation to confirm**

```bash
npx convex run admin/narrowingValidation:validateNarrowingReadiness
```

Verify that `payments_with_legacy_amount` and `tenants_with_deprecated_oauth` are now both `0`.

**Key implementation notes:**

- Setting a field to `undefined` in `ctx.db.patch()` removes it from the document in Convex. This is the standard Convex pattern for field removal.
- The `as any` cast is needed because TypeScript's generated types include these fields as part of the schema. Once the schema is narrowed in 6C/6D, these casts become unnecessary (and the stripping code becomes dead code).
- `webhookProvisioningStartedAt` is included in the stripping list even though it was not in the Phase 5.4 list -- it is a transient field on `tenants` related to the webhook provisioning flow that also moves to `tenantCalendlyConnections`.
- At ~50 payment records and ~1 tenant, these run well within Convex transaction limits. For larger datasets, batch with `.take(100)` and `ctx.scheduler.runAfter(0, ...)`.
- Run the two stripping mutations sequentially, not in parallel, to keep the audit trail clear.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/admin/narrowingBackfills.ts` | Create | `stripPaymentAmount` + `stripTenantOAuthFields` mutations |

---

### 6C — Schema Narrowing Batch 1: Required Fields

**Type:** Backend / Schema
**Parallelizable:** Yes -- can run in parallel with 6D. Both modify different table definitions in `schema.ts`.

**What:** Remove `v.optional()` wrappers from 5 fields that are now guaranteed present on all documents after Phase 2 backfills:
- `leads.status` -- `v.optional(v.union(...))` becomes `v.union(...)`
- `users.isActive` -- `v.optional(v.boolean())` becomes `v.boolean()`
- `meetings.assignedCloserId` -- `v.optional(v.id("users"))` becomes `v.id("users")`
- `followUps.type` -- `v.optional(v.union(...))` becomes `v.union(...)`
- `paymentRecords.contextType` -- `v.optional(v.union(...))` becomes `v.union(...)`

**Why:** Making these fields required aligns the schema with reality (all documents have values) and provides compile-time guarantees. TypeScript types generated from the schema will no longer include `| undefined` for these fields, eliminating the need for runtime fallbacks (`?? "active"`, `?? true`, etc.) across all queries and mutations.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Narrow `leads.status`**

```typescript
// Path: convex/schema.ts (within leads table definition)
// BEFORE:
status: v.optional(
  v.union(v.literal("active"), v.literal("converted"), v.literal("merged")),
),

// AFTER:
status: v.union(v.literal("active"), v.literal("converted"), v.literal("merged")),
```

**Step 2: Narrow `users.isActive`**

```typescript
// Path: convex/schema.ts (within users table definition)
// BEFORE (added in Phase 1):
isActive: v.optional(v.boolean()),

// AFTER:
isActive: v.boolean(),
```

**Step 3: Narrow `meetings.assignedCloserId`**

```typescript
// Path: convex/schema.ts (within meetings table definition)
// BEFORE (added in Phase 1):
assignedCloserId: v.optional(v.id("users")),

// AFTER:
assignedCloserId: v.id("users"),
```

**Step 4: Narrow `followUps.type`**

```typescript
// Path: convex/schema.ts (within followUps table definition)
// BEFORE:
type: v.optional(
  v.union(
    v.literal("scheduling_link"),
    v.literal("manual_reminder"),
  ),
),

// AFTER:
type: v.union(
  v.literal("scheduling_link"),
  v.literal("manual_reminder"),
),
```

**Step 5: Narrow `paymentRecords.contextType`**

```typescript
// Path: convex/schema.ts (within paymentRecords table definition)
// BEFORE (added in Phase 1):
contextType: v.optional(v.union(
  v.literal("opportunity"),
  v.literal("customer"),
)),

// AFTER:
contextType: v.union(
  v.literal("opportunity"),
  v.literal("customer"),
),
```

**Key implementation notes:**

- Do NOT deploy after this subphase alone unless 6D is also ready. Deploying 6C without 6D means the schema still contains `paymentRecords.amount` and tenant OAuth fields, which is fine but wastes a deploy cycle. Prefer combining 6C + 6D into a single deploy.
- After these changes, Convex-generated TypeScript types will change: `status` will no longer be `string | undefined`. Any remaining `?? "active"` or `?? true` fallbacks in query code will produce TypeScript errors (which is the desired behavior -- Phase 4 should have already removed them).
- If TypeScript errors appear, they indicate Phase 4 fallback removal was incomplete. Fix the affected queries before deploying.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Remove `v.optional()` from 5 field definitions |

---

### 6D — Schema Narrowing Batch 2: Removals + Type Hardening

**Type:** Backend / Schema
**Parallelizable:** Yes -- can run in parallel with 6C. Touches different table definitions in `schema.ts`.

**What:** Three schema changes:
1. **Remove** `paymentRecords.amount` from the schema definition (field already stripped from documents in 6B)
2. **Harden** `leads.customFields` from `v.optional(v.any())` to `v.optional(v.record(v.string(), v.string()))`
3. **Remove** all 10 deprecated Calendly OAuth fields from the `tenants` schema definition (field values already stripped in 6B)

**Why:**
- Removing `amount` completes the money model migration (F3). No code references it; no documents contain it. Keeping it in the schema is misleading.
- Hardening `customFields` from `v.any()` to `v.record()` prevents untyped data from entering the system. The blob remains optional (some leads have no custom fields) but its contents are now validated.
- Removing OAuth fields from `tenants` completes the table split (F14). All OAuth state now lives exclusively in `tenantCalendlyConnections`, and the `tenants` table is a stable identity record that does not churn on token refresh.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Remove `paymentRecords.amount`**

```typescript
// Path: convex/schema.ts (within paymentRecords table definition)
// BEFORE:
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  closerId: v.id("users"),
  amount: v.number(),        // <-- DELETE THIS LINE
  amountMinor: v.number(),   // Integer cents (added Phase 1, backfilled Phase 2, required after 6C)
  currency: v.string(),
  // ... rest of fields ...
})

// AFTER:
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  closerId: v.id("users"),
  amountMinor: v.number(),   // Integer cents — sole money field
  currency: v.string(),
  // ... rest of fields ...
})
```

**Step 2: Harden `leads.customFields`**

```typescript
// Path: convex/schema.ts (within leads table definition)
// BEFORE:
customFields: v.optional(v.any()),

// AFTER:
customFields: v.optional(v.record(v.string(), v.string())),
```

**Step 3: Remove deprecated OAuth fields from `tenants`**

Remove all 10 OAuth-related field definitions and the transient `webhookProvisioningStartedAt` field:

```typescript
// Path: convex/schema.ts (within tenants table definition)
// DELETE these lines:
codeVerifier: v.optional(v.string()),
calendlyAccessToken: v.optional(v.string()),
calendlyRefreshToken: v.optional(v.string()),
calendlyTokenExpiresAt: v.optional(v.number()),
calendlyOrgUri: v.optional(v.string()),
calendlyOwnerUri: v.optional(v.string()),
calendlyRefreshLockUntil: v.optional(v.number()),
lastTokenRefreshAt: v.optional(v.number()),
webhookProvisioningStartedAt: v.optional(v.number()),
calendlyWebhookUri: v.optional(v.string()),
webhookSigningKey: v.optional(v.string()),
```

The `tenants` table after narrowing should look like:

```typescript
// Path: convex/schema.ts
tenants: defineTable({
  // Identity
  companyName: v.string(),
  contactEmail: v.string(),
  workosOrgId: v.string(),
  status: v.union(
    v.literal("pending_signup"),
    v.literal("pending_calendly"),
    v.literal("provisioning_webhooks"),
    v.literal("active"),
    v.literal("calendly_disconnected"),
    v.literal("suspended"),
    v.literal("invite_expired"),
  ),

  // Invite
  inviteTokenHash: v.optional(v.string()),
  inviteExpiresAt: v.number(),
  inviteRedeemedAt: v.optional(v.number()),

  // Metadata
  notes: v.optional(v.string()),
  createdBy: v.string(),
  onboardingCompletedAt: v.optional(v.number()),
  tenantOwnerId: v.optional(v.id("users")),
})
  .index("by_contactEmail", ["contactEmail"])
  .index("by_workosOrgId", ["workosOrgId"])
  .index("by_status", ["status"])
  .index("by_inviteTokenHash", ["inviteTokenHash"])
  .index("by_status_and_inviteExpiresAt", ["status", "inviteExpiresAt"]),
```

**Key implementation notes:**

- The `amount` field removal is destructive and irreversible. Confirm via 6A validation and 6B stripping that zero documents contain this field before deploying. The `amountMinor` field (added Phase 1, backfilled Phase 2) is the sole money field going forward.
- The `v.record(v.string(), v.string())` validator for `customFields` is intentionally less strict than a fully typed object -- custom fields are user-defined and vary per event type. The `v.record()` validator ensures all keys and values are strings, which is sufficient for the current use case. Structured per-meeting answers live in `meetingFormResponses` (Phase 1 new table).
- Removing 11 fields from `tenants` significantly shrinks the tenant document size and eliminates all high-churn fields from the table. The 90-minute token refresh cron will no longer invalidate any query that reads `tenants`.
- If any query or mutation still references `tenant.calendlyAccessToken` (etc.), TypeScript will produce a compile error. This is the desired safety net -- any such references indicate an incomplete Phase 5 migration.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Remove `amount` from `paymentRecords`; harden `customFields` on `leads`; remove 11 OAuth fields from `tenants` |

---

### 6E — Post-Narrowing Verification

**Type:** Backend / Verification
**Parallelizable:** No -- depends on 6C + 6D both complete.

**What:** Deploy the narrowed schema to production, verify the deploy succeeds, confirm all queries and mutations still function correctly, and pass the TypeScript check. Then clean up the temporary validation and backfill modules created in 6A and 6B.

**Why:** The deploy itself is the ultimate validation -- Convex will reject it if any existing document violates the narrowed schema. But a successful deploy alone is not sufficient. We must also verify that:
- No runtime errors appear in Convex logs (queries expecting optional fields that are now required)
- TypeScript types are consistent (no compile errors from the new non-optional field types)
- The validation module confirms the final state matches expectations

**Where:**
- `convex/schema.ts` (already modified in 6C + 6D)
- `convex/admin/narrowingValidation.ts` (run, then mark for cleanup)
- `convex/admin/narrowingBackfills.ts` (mark for cleanup)

**How:**

**Step 1: TypeScript check before deploy**

```bash
pnpm tsc --noEmit
```

Fix any errors. Common expected errors after narrowing:
- Unnecessary nullish coalescing operators (`?? "active"`) on fields that are now required. Remove them.
- Unnecessary optional chaining (`?.`) on fields that are now required. Remove it.
- References to deleted fields (`tenant.calendlyAccessToken`). These indicate incomplete Phase 5 migration -- fix before deploying.

**Step 2: Deploy the narrowed schema**

```bash
npx convex deploy
```

If the deploy fails with a schema validation error, the error message will identify which table and document(s) are non-conforming. Use the 6A validation module to diagnose, then re-run the relevant 6B backfill.

**Step 3: Post-deploy validation**

```bash
# Re-run the validation to confirm clean state
npx convex run admin/narrowingValidation:validateNarrowingReadiness
```

All counts should be `0` and `allClear` should be `true`.

**Step 4: Smoke test critical paths**

Verify in the Convex dashboard logs (or locally via `npx convex dev`) that the following operations produce no errors:
- Admin dashboard loads (reads `tenantStats`, no longer reads OAuth fields from `tenants`)
- Pipeline processes a test webhook (`invitee.created` -- writes `meetings.assignedCloserId` as required)
- Payment recording works (`amountMinor` written, no `amount` field present)
- Follow-up creation works (`type` written as required)
- Calendly token refresh runs (reads from `tenantCalendlyConnections`, not `tenants`)

**Step 5: Remove narrowing utility files**

After verification passes, remove the temporary modules. They are one-shot utilities with no ongoing purpose:

```bash
# These files are migration artifacts -- safe to delete after verification
rm convex/admin/narrowingValidation.ts
rm convex/admin/narrowingBackfills.ts
```

Alternatively, keep them as a reference by moving to a `convex/admin/archive/` directory. They will not affect runtime behavior since they are `internalQuery` / `internalMutation` and are not referenced by any scheduled jobs or HTTP routes.

**Key implementation notes:**

- If `pnpm tsc --noEmit` reveals errors in query/mutation files, those are Phase 4 or Phase 5 regressions that must be fixed before deploying. Do not use `@ts-ignore` or `as any` to bypass them.
- The deploy is atomic -- either all schema changes take effect or none do. There is no partial narrowing state.
- If the deploy fails and you need to revert, the pre-narrowing schema (with `v.optional()` wrappers) is still valid because all documents now have the required values. You can re-deploy the wider schema safely.
- The smoke test is manual for this single-tenant setup. For multi-tenant production, automate these checks as an integration test suite.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/admin/narrowingValidation.ts` | Run, then delete | One-shot validation utility |
| `convex/admin/narrowingBackfills.ts` | Delete | One-shot stripping utility |
| Various query/mutation files | Modify (if needed) | Remove unnecessary `??` / `?.` fallbacks flagged by TypeScript |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/admin/narrowingValidation.ts` | Create | 6A |
| `convex/admin/narrowingBackfills.ts` | Create | 6B |
| `convex/schema.ts` | Modify (required fields) | 6C |
| `convex/schema.ts` | Modify (removals + type hardening) | 6D |
| `convex/admin/narrowingValidation.ts` | Run + delete | 6E |
| `convex/admin/narrowingBackfills.ts` | Delete | 6E |
| Various query/mutation files | Modify (remove fallbacks) | 6E |

---

## Notes for Implementer

- **Combine 6C + 6D into a single deploy.** They are separated in this plan to reduce cognitive load and blast radius during review, but they modify different parts of `convex/schema.ts` and can be applied together. A single `npx convex deploy` with all narrowing changes is preferred over two separate deploys.
- **The order matters: strip first, then narrow.** The 6A -> 6B -> 6C/6D sequence is critical. Attempting to narrow the schema before stripping field values from documents will cause a deploy failure.
- **Fallback removal is mechanical.** After narrowing, TypeScript will flag every `?? "active"`, `?? true`, and `lead.status!` assertion that is no longer needed. These are safe to remove -- the schema now guarantees the field is present.
- **No rollback risk.** Even if you need to revert to the wider schema, all documents already have the required values. The wider schema is a superset of the narrower one, so re-deploying it is always safe.
- **Phase 7 (Frontend Updates) does NOT depend on Phase 6.** Phase 7 depends on Phase 4 (query shapes finalized). Phase 6 is the convergence point for data integrity, not a blocker for UI work.
- **Post-narrowing, the `convex-migration-helper` skill is no longer needed for these fields.** The widen-migrate-narrow cycle is complete.
