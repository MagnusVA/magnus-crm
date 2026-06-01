# Phase 1 — Tenant Programs Registry (Backend)

**Goal:** Establish the `tenantPrograms` first-class table with full admin-only CRUD, a shared `listPrograms` query that closers can consume for payment dialogs, an internal paginated rename-sync job, and an idempotent seed helper that lets deploy orchestration guarantee every active tenant has at least one active program before the frontend ships.

**Prerequisite:**
- v0.5 Feature D (Lead → Customer conversion) and v0.5b domain events infrastructure are deployed.
- `convex/eventTypeConfigs/mutations.ts::upsertEventTypeConfig` exists and is the canonical CRUD template to mirror.
- `convex/requireTenantUser.ts` and `convex/lib/validation.ts::validateRequiredString` exist.

**Runs in PARALLEL with:** Phase 2 (Payment/Customer/Stats Schema Rewrite). Phase 1 creates a brand-new directory (`convex/tenantPrograms/`) and a brand-new table, while Phase 2 touches `paymentRecords`, `customers`, and `tenantStats`. The only shared file is `convex/schema.ts`, where Phase 1 adds a new table block and Phase 2 rewrites existing table blocks — schema edits are non-conflicting by virtue of touching different table definitions. Deploy to the shared Convex dev stack must still be coordinated (see §Parallelization Strategy).

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 3 → Phase 4 → Phase 5 → all frontend phases). Every payment write path references `tenantPrograms` via `requireActiveProgram`, and `ProgramSelect` in the frontend depends on `listPrograms`. Start as early as possible.

**Skills to invoke:**
- `convex-create-component` — not strictly required (this is a new table, not a component), but the isolation discipline it teaches applies to the new `convex/tenantPrograms/` module directory.
- `convex-performance-audit` — after adding indexes, verify `by_tenantId`, `by_tenantId_and_archivedAt`, and `by_tenantId_and_normalizedName` are the only indexes needed (no over-indexing) and that `listPrograms` returns 200 max (bounded).

**Acceptance Criteria:**
1. `npx convex dev` pushes the new `tenantPrograms` table with three indexes (`by_tenantId`, `by_tenantId_and_archivedAt`, `by_tenantId_and_normalizedName`) without schema errors.
2. `listPrograms({ includeArchived: false })` returns an empty array for a tenant with zero programs, is callable by `closer`, `tenant_master`, and `tenant_admin` roles, and is rejected for unauthenticated identities.
3. `upsertProgram({ name: "Launchpad" })` called by a `tenant_master` inserts a row with `normalizedName === "launchpad"`, `archivedAt: undefined`, `createdByUserId` equal to the caller, and returns its `Id<"tenantPrograms">`.
4. `upsertProgram({ name: "launchpad" })` called a second time for the same tenant throws `A program named "launchpad" already exists.` and does NOT insert a duplicate.
5. `upsertProgram({ programId, name: "Launchpad 2.0" })` patches the existing row's `name`, `normalizedName`, and `updatedAt`, returns the same `programId`, and schedules `internal.tenantPrograms.sync.syncRenamedProgram` via `ctx.scheduler.runAfter(0, ...)` **only when the name actually changed**.
6. `archiveProgram({ programId })` called when only one active program exists throws `At least one active program is required. Create or restore another program before archiving this one.` and does not patch.
7. `archiveProgram({ programId })` called when two+ active programs exist patches `archivedAt: Date.now()` and is idempotent on a second call.
8. `restoreProgram({ programId })` clears `archivedAt` when no active name clash exists, and throws `Cannot restore "<name>" because an active program with that name already exists.` when a clash is present.
9. Cross-tenant access is impossible: `upsertProgram({ programId: <other tenant's ID> })`, `archiveProgram`, and `restoreProgram` all throw `Program not found` when the caller's tenant does not own the row.
10. `internal.tenantPrograms.sync.syncRenamedProgram({ programId })` is a no-op in Phase 1 because `paymentRecords` and `customers` still carry `closerId`/`programType` (no `programName` field yet). The function is wired with the correct pagination skeleton that will be exercised once Phase 2 lands.
11. `internal.tenantPrograms.seed.ensureInitialProgramForTenant({ tenantId, name })` is idempotent on `{ tenantId, normalizedName }`, callable only from internal contexts (system admin / deploy orchestration), and returns the existing program's id rather than inserting a duplicate.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (schema) ───────────────────────────────────────────┐
                                                       │
                                        ┌─────────────▶│ Generated types available
                                        │              │
        ┌───────────────────────────────┘              │
        │                                              │
        ├── 1B (mutations — upsert / archive / restore)│
        ├── 1C (query — listPrograms)                  ├── 1D (rename-sync internal mutation, uses 1B scheduler hook)
        └── 1E (seed helper, uses 1B's normalized-name logic)
```

**Optimal execution:**
1. **Start 1A alone.** Schema must deploy first; every other subphase imports types from `convex/_generated/dataModel`.
2. Once `npx convex dev` reports the schema is live, start **1B, 1C, 1D, and 1E in parallel.** They touch four different new files (`mutations.ts`, `queries.ts`, `sync.ts`, `seed.ts`) under `convex/tenantPrograms/`, no shared imports across them.
3. 1B's `upsertProgram` must land BEFORE the `ctx.scheduler.runAfter` reference to 1D resolves — but because TypeScript only resolves `internal.tenantPrograms.sync.syncRenamedProgram` at typecheck time from the generated `_generated/api.d.ts`, the order of merging within step 2 is fungible provided all four land in the same deploy.

**Estimated time:** 1 day (solo), 0.5 day with 2 parallel streams.

---

## Subphases

### 1A — Schema: `tenantPrograms` Table

**Type:** Backend
**Parallelizable:** No — must complete first. All other subphases import `Id<"tenantPrograms">` from `convex/_generated/dataModel`.

**What:** Add the `tenantPrograms` table definition and three indexes to `convex/schema.ts`.

**Why:** Without the table definition, no type is generated, so none of the CRUD mutations, the query, the sync job, or the seed helper can compile. This is the unavoidable first step.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the table block**

Insert the new table definition alongside other per-tenant-config tables (co-locate with `eventTypeConfigs` for reviewer discoverability):

```typescript
// Path: convex/schema.ts
// (Insert near eventTypeConfigs, before paymentRecords.)
tenantPrograms: defineTable({
  tenantId: v.id("tenants"),
  // Human-visible label shown in the payment dialog dropdown and in reports.
  name: v.string(),
  // Lowercased/trimmed version used for uniqueness checks and lookup.
  normalizedName: v.string(),
  // Optional longer description shown only in the admin Programs list.
  description: v.optional(v.string()),
  // Hint used as the default currency for payments logged against this program
  // (closers can still override). Uses the same ISO codes as paymentRecords.currency.
  defaultCurrency: v.optional(v.string()),
  // Soft-delete timestamp. Archived programs are hidden from the dropdown
  // but kept around so historical payments still resolve their name.
  archivedAt: v.optional(v.number()),
  createdAt: v.number(),
  createdByUserId: v.id("users"),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  // Drives the Settings list (active first, then archived); reports use
  // the same index because archived programs still need to be joinable.
  .index("by_tenantId_and_archivedAt", ["tenantId", "archivedAt"])
  // Uniqueness check on upsert — prevents duplicate names per tenant.
  .index("by_tenantId_and_normalizedName", ["tenantId", "normalizedName"]),
```

**Step 2: Push the schema to Convex dev**

```bash
npx convex dev
```

Verify:
- Convex CLI logs `Table 'tenantPrograms' added with 3 indexes` (or similar).
- Convex dashboard shows the table with zero rows.
- `convex/_generated/dataModel.d.ts` exposes `Id<"tenantPrograms">` — run `pnpm tsc --noEmit` to confirm.

**Key implementation notes:**
- The `by_tenantId_and_archivedAt` index uses `archivedAt` as the second key so sorted reads can separate active (`archivedAt === undefined`) from archived (`archivedAt === number`) rows without a filter pass. It also ensures reports that walk archived programs stay bounded.
- `by_tenantId_and_normalizedName` is the uniqueness-check index. It **must** be lowercased + trimmed at write time (`name.trim().toLocaleLowerCase()`). The mutation handler does this; don't rely on the database to normalize.
- `createdByUserId` is required, not optional — every row is created by a specific authenticated admin and we want the audit trail to be non-nullable.
- No `contextType` or `origin` columns — this table is pure config, not a business-event ledger.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add the `tenantPrograms` block with three indexes. No other tables touched here. |

---

### 1B — Admin Mutations: `upsertProgram`, `archiveProgram`, `restoreProgram`

**Type:** Backend
**Parallelizable:** Yes — independent of 1C, 1D, 1E once 1A schema is live.

**What:** Three `mutation` entries in a new `convex/tenantPrograms/mutations.ts` file — `upsertProgram` (create or rename), `archiveProgram` (soft-delete with last-active guard), `restoreProgram` (clear `archivedAt` with name-clash guard).

**Why:** Programs are tenant-scoped configuration. Admins need create / rename / archive / restore over a stable set of row identifiers. No other phase can safely insert or reference programs until these mutations exist — Phase 2 schema assumes programs exist, Phase 3 write helpers (`requireActiveProgram`) look them up by id, Phase 6 UI invokes them.

**Where:**
- `convex/tenantPrograms/mutations.ts` (new)

**How:**

**Step 1: Create the file with imports and `upsertProgram`**

```typescript
// Path: convex/tenantPrograms/mutations.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireTenantUser } from "../requireTenantUser";
import { validateRequiredString } from "../lib/validation";

export const upsertProgram = mutation({
  args: {
    programId: v.optional(v.id("tenantPrograms")),
    name: v.string(),
    description: v.optional(v.string()),
    defaultCurrency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log("[Programs] upsertProgram called", {
      isUpdate: !!args.programId,
    });
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Validate the name up front; reject empty / too-long / whitespace-only.
    const nameValidation = validateRequiredString(args.name, {
      fieldName: "Program name",
      maxLength: 80,
    });
    if (!nameValidation.valid) throw new Error(nameValidation.error);

    const name = args.name.trim();
    const normalizedName = name.toLocaleLowerCase();
    const now = Date.now();

    // Uniqueness check — reject if a DIFFERENT active program holds the name.
    const clash = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_normalizedName", (q) =>
        q.eq("tenantId", tenantId).eq("normalizedName", normalizedName),
      )
      .first();
    if (clash && clash._id !== args.programId && !clash.archivedAt) {
      throw new Error(`A program named "${name}" already exists.`);
    }

    // === Update branch ===
    if (args.programId) {
      const existing = await ctx.db.get(args.programId);
      if (!existing || existing.tenantId !== tenantId) {
        throw new Error("Program not found");
      }
      await ctx.db.patch(args.programId, {
        name,
        normalizedName,
        description: args.description?.trim() || undefined,
        defaultCurrency: args.defaultCurrency?.trim() || undefined,
        updatedAt: now,
      });
      // Only fire the rename-sync job when the name actually changed.
      // `description` / `defaultCurrency` don't propagate to payments/customers.
      if (existing.name !== name) {
        await ctx.scheduler.runAfter(
          0,
          internal.tenantPrograms.sync.syncRenamedProgram,
          { programId: args.programId },
        );
      }
      return args.programId;
    }

    // === Create branch ===
    return await ctx.db.insert("tenantPrograms", {
      tenantId,
      name,
      normalizedName,
      description: args.description?.trim() || undefined,
      defaultCurrency: args.defaultCurrency?.trim() || undefined,
      createdAt: now,
      createdByUserId: userId,
      updatedAt: now,
    });
  },
});
```

**Step 2: Add `archiveProgram` with last-active guard**

```typescript
// Path: convex/tenantPrograms/mutations.ts (append)

export const archiveProgram = mutation({
  args: { programId: v.id("tenantPrograms") },
  handler: async (ctx, { programId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const program = await ctx.db.get(programId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Program not found");
    }
    if (program.archivedAt) return; // idempotent — already archived

    // Count active programs so we never archive the LAST active one
    // (payment-entry pickers need at least one active option).
    const activePrograms = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200); // same bound as listPrograms
    const activeCount = activePrograms.filter((row) => !row.archivedAt).length;
    if (activeCount <= 1) {
      throw new Error(
        "At least one active program is required. Create or restore another program before archiving this one.",
      );
    }
    await ctx.db.patch(programId, {
      archivedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});
```

**Step 3: Add `restoreProgram` with name-clash guard**

```typescript
// Path: convex/tenantPrograms/mutations.ts (append)

export const restoreProgram = mutation({
  args: { programId: v.id("tenantPrograms") },
  handler: async (ctx, { programId }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const program = await ctx.db.get(programId);
    if (!program || program.tenantId !== tenantId) {
      throw new Error("Program not found");
    }
    if (!program.archivedAt) return; // idempotent — already active

    // Reject if an ACTIVE program with the same normalized name exists
    // (restoring would create a duplicate and re-break the uniqueness invariant).
    const clash = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_normalizedName", (q) =>
        q.eq("tenantId", tenantId).eq("normalizedName", program.normalizedName),
      )
      .first();
    if (clash && clash._id !== programId && !clash.archivedAt) {
      throw new Error(
        `Cannot restore "${program.name}" because an active program with that name already exists.`,
      );
    }
    await ctx.db.patch(programId, {
      archivedAt: undefined,
      updatedAt: Date.now(),
    });
  },
});
```

**Step 4: Smoke-test via Convex CLI**

```bash
# Create (as tenant_master)
npx convex run tenantPrograms:upsertProgram '{ "name": "Launchpad" }'
# Attempt duplicate — should throw
npx convex run tenantPrograms:upsertProgram '{ "name": "launchpad" }'
# Archive the only program — should throw (last-active guard)
npx convex run tenantPrograms:archiveProgram '{ "programId": "<id>" }'
```

**Key implementation notes:**
- The `normalizedName` uniqueness check uses `.first()` not `.unique()` — we only want the first active clash, and a duplicate under a different `programId` is a write-time bug we catch here rather than in the DB constraint. Convex does not enforce schema-level uniqueness.
- `archivedAt: undefined` on patch clears the field; this is the canonical way to "unset" an optional column in Convex (`null` would fail the schema).
- `description?.trim() || undefined` pattern: we want empty-string inputs to be stored as `undefined` (no stale whitespace), but preserve deliberate content.
- `upsertProgram` is used for BOTH create and rename; the `programId` arg is optional. This mirrors the `upsertEventTypeConfig` shape that the frontend RHF code expects.
- `ctx.scheduler.runAfter(0, ...)` fires after the current mutation commits, giving us read-your-writes safety when `syncRenamedProgram` queries the freshly-patched row.
- `validateRequiredString` already rejects empty strings, whitespace-only, and > maxLength. Do NOT duplicate its logic in the handler.
- Error messages must stay stable — frontend dialogs display them verbatim in `<Alert variant="destructive">`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenantPrograms/mutations.ts` | Create | Three mutations: upsert, archive, restore. |

---

### 1C — Query: `listPrograms`

**Type:** Backend
**Parallelizable:** Yes — independent of 1B, 1D, 1E. Closer-readable.

**What:** A single `query` function `listPrograms({ includeArchived? })` in `convex/tenantPrograms/queries.ts`. Returns an array of tenant programs sorted `active first, then archived`, alphabetical within each group.

**Why:** Every payment dialog needs a dropdown populated by this. Closers need to read programs (they can't manage them, but must be able to pick one) — so the role list includes `closer`. Reports also call this with `includeArchived: true` so they can join historical payments to archived programs by name.

**Where:**
- `convex/tenantPrograms/queries.ts` (new)

**How:**

**Step 1: Create the file**

```typescript
// Path: convex/tenantPrograms/queries.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listPrograms = query({
  args: {
    // When true, include archived programs (for reports + settings archive toggle).
    // When false/undefined, payment pickers see active-only.
    includeArchived: v.optional(v.boolean()),
  },
  handler: async (ctx, { includeArchived }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(200); // Bounded — we never expect hundreds of programs per tenant.

    // Stable ordering: active before archived, then alphabetical (case-insensitive).
    const sorted = [...rows].sort(
      (left, right) =>
        Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)) ||
        left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    );
    return includeArchived ? sorted : sorted.filter((r) => !r.archivedAt);
  },
});
```

**Step 2: Smoke-test via Convex CLI**

```bash
# As a closer identity — should succeed with active-only rows
npx convex run tenantPrograms:listPrograms '{}'
# Include archived (admin-only path; closer can call but rarely needs to)
npx convex run tenantPrograms:listPrograms '{ "includeArchived": true }'
```

**Key implementation notes:**
- `.take(200)` is the bound; document this in inline comments. Exceeding 200 active programs per tenant would be unusual and should be surfaced to ops, not silently truncated.
- Sort key is `Number(Boolean(archivedAt))` → 0 for active, 1 for archived. Short-circuits to the name comparator within each group.
- Do NOT call `.filter()` server-side for role checks; rely on `requireTenantUser`'s allowed-role enforcement.
- Closer reading is intentional — closers need the picker data. Admins are a strict superset of closer read permissions.
- This query is invoked by `ProgramSelect` in Phase 6; the shared component reads the unchanging shape (name, `_id`, `archivedAt`) and won't break on added fields.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenantPrograms/queries.ts` | Create | Single query `listPrograms`. |

---

### 1D — Rename-Sync Internal Mutation (Phase-1-Skeleton)

**Type:** Backend
**Parallelizable:** Yes — independent of 1B, 1C, 1E. Shipped as a no-op in Phase 1; becomes live once Phase 2 adds `programName` fields to `paymentRecords` and `customers`.

**What:** An `internalMutation` `syncRenamedProgram({ programId })` in `convex/tenantPrograms/sync.ts` that paginates through `paymentRecords` and `customers` rows referencing the renamed program and patches their denormalized `programName` cache. In Phase 1, the schema fields don't yet exist, so the function ships as a correctly-shaped skeleton that deploys successfully and is a no-op at runtime. Phase 2 fills in the field references.

**Why:**
1. `upsertProgram` schedules this job at rename time (Subphase 1B). The function **must** exist before 1B can typecheck through `internal.tenantPrograms.sync.syncRenamedProgram`.
2. Shipping the skeleton now means no Phase-2 crossover edits to 1B — Phase 2 will only add field references inside 1D's body, not re-wire the call site.
3. Paginated batch pattern is explicitly required by the design (§4.3) to stay under the Convex transaction limit of ~8,000 writes.

**Where:**
- `convex/tenantPrograms/sync.ts` (new)

**How:**

**Step 1: Create the skeleton with the correct shape**

```typescript
// Path: convex/tenantPrograms/sync.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/**
 * Patches `programName` on every `paymentRecords` row and `customers` row
 * that references the renamed program. Paginated to stay under the Convex
 * transaction write limit. Self-reschedules with a cursor until done.
 *
 * Phase 1: `paymentRecords.programName` and `customers.programName` do not
 * yet exist (they're added in Phase 2), so the body is a no-op that logs
 * the invocation and returns early. Phase 2 fills in the actual patches.
 */
export const syncRenamedProgram = internalMutation({
  args: {
    programId: v.id("tenantPrograms"),
    // Optional cursor for paginated continuation. Phase 2 will use this.
    paymentCursor: v.optional(v.string()),
    customerCursor: v.optional(v.string()),
  },
  handler: async (ctx, { programId, paymentCursor, customerCursor }) => {
    console.log("[Programs] syncRenamedProgram tick", {
      programId,
      paymentCursor,
      customerCursor,
    });

    const program = await ctx.db.get(programId);
    if (!program) {
      console.warn(
        "[Programs] syncRenamedProgram: program vanished mid-sync",
        { programId },
      );
      return { done: true, patched: 0 };
    }

    // ==== PHASE 1: no-op. Phase 2 will replace this block with the actual
    //      pagination over paymentRecords (by_programId index) and customers
    //      (by_programId index), patching programName on each row. ====
    // See Phase 2 / Subphase 2A for the full implementation.

    return { done: true, patched: 0 };
  },
});
```

**Step 2: Verify `internal.tenantPrograms.sync.syncRenamedProgram` resolves**

After deploy, confirm that `convex/_generated/api.d.ts` exposes the internal handle and that `convex/tenantPrograms/mutations.ts::upsertProgram` compiles cleanly against the scheduler call.

**Key implementation notes:**
- Internal mutation (not public) — only callable from other Convex functions via `internal.` namespace.
- The `paymentCursor` / `customerCursor` args are already present in Phase 1 so Phase 2 can fill in the body without touching the args validator (no re-typegen needed on call sites).
- Return shape `{ done: boolean; patched: number }` is stable — Phase 2 preserves it so ops monitoring (log greps, PostHog events) doesn't need re-wiring.
- The `program.tenantId` isolation check isn't strictly needed here (internal callers pass a valid id), but the `ctx.db.get` ensures the row still exists — if an admin archives + hard-deletes between rename and sync (not possible today, see §14.10), the sync degrades gracefully.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenantPrograms/sync.ts` | Create | Internal mutation skeleton; no-op in Phase 1. |

---

### 1E — Seed Helper: `ensureInitialProgramForTenant`

**Type:** Backend
**Parallelizable:** Yes — independent of 1B, 1C, 1D.

**What:** An internal `mutation` `ensureInitialProgramForTenant({ tenantId, name, description?, defaultCurrency? })` in `convex/tenantPrograms/seed.ts` that is **idempotent on `{ tenantId, normalizedName }`** and returns the existing program's id if one already exists. Used by deploy orchestration between the Convex deploy and the Vercel promotion (§18.2 of the design doc) so that every active tenant has at least one active program before the frontend ships.

**Why:**
1. The rollout (Phase 2) makes `paymentRecords.programId` required. Any closer opening a payment dialog BEFORE a program has been seeded sees "No programs configured yet" and cannot log a payment.
2. A one-off `internalMutation` is safer than hand-running `upsertProgram` via CLI for every tenant at deploy time — idempotent, tenant-scoped, returns the same id on replay.
3. It's also used by the smoke-test harness (§18.3) to guarantee a known-good program exists without re-running the whole fixture setup.

**Where:**
- `convex/tenantPrograms/seed.ts` (new)

**How:**

**Step 1: Create the file**

```typescript
// Path: convex/tenantPrograms/seed.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/**
 * Deploy-time seed: guarantees at least one active program per tenant.
 * Idempotent on (tenantId, normalizedName). Safe to run repeatedly.
 *
 * Callable ONLY from internal contexts — system admin tooling, deploy
 * orchestration, smoke-test fixtures. Not exposed to tenant users.
 *
 * This function is kept forever as operational tooling — do NOT delete
 * it after rollout. It's still the canonical way to reset a tenant's
 * program list to a known state during migrations or demos.
 */
export const ensureInitialProgramForTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    // Caller provides the creator user ID explicitly; the internal context
    // doesn't have a WorkOS JWT identity to resolve it automatically.
    createdByUserId: v.id("users"),
    name: v.string(),
    description: v.optional(v.string()),
    defaultCurrency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const name = args.name.trim();
    if (!name) {
      throw new Error("[Programs:seed] name must be non-empty");
    }
    const normalizedName = name.toLocaleLowerCase();

    // Idempotent lookup on the normalized-name index.
    const existing = await ctx.db
      .query("tenantPrograms")
      .withIndex("by_tenantId_and_normalizedName", (q) =>
        q.eq("tenantId", args.tenantId).eq("normalizedName", normalizedName),
      )
      .first();
    if (existing) {
      console.log("[Programs:seed] existing program found; no-op", {
        tenantId: args.tenantId,
        programId: existing._id,
      });
      return existing._id;
    }

    const now = Date.now();
    const programId = await ctx.db.insert("tenantPrograms", {
      tenantId: args.tenantId,
      name,
      normalizedName,
      description: args.description?.trim() || undefined,
      defaultCurrency: args.defaultCurrency?.trim() || undefined,
      createdAt: now,
      createdByUserId: args.createdByUserId,
      updatedAt: now,
    });
    console.log("[Programs:seed] inserted", {
      tenantId: args.tenantId,
      programId,
    });
    return programId;
  },
});
```

**Step 2: Smoke-test via Convex CLI (as internal caller)**

```bash
# First run — inserts
npx convex run --no-push tenantPrograms:seed:ensureInitialProgramForTenant \
  '{ "tenantId": "<tenantId>", "createdByUserId": "<tenantMasterId>", "name": "Launchpad" }'
# Second run — no-op, returns same id
npx convex run --no-push tenantPrograms:seed:ensureInitialProgramForTenant \
  '{ "tenantId": "<tenantId>", "createdByUserId": "<tenantMasterId>", "name": "Launchpad" }'
```

Both invocations must return the same id.

**Key implementation notes:**
- This is an **internal** mutation — exposed only via `internal.tenantPrograms.seed.ensureInitialProgramForTenant`. Tenant users cannot call it.
- We pass `createdByUserId` explicitly rather than resolving from `ctx.auth.getUserIdentity()` because the seed runs in an internal context where no end-user identity is present.
- The normalized-name uniqueness is enforced at the application layer — the index supports `.first()` matches but Convex won't enforce a DB-level uniqueness constraint.
- The function is **idempotent by design.** Running it N times produces one row. This is the contract for deploy orchestration: the script can safely retry on transient network errors.
- Long-term, this helper stays in the codebase as `ensureInitialProgramForTenant` rather than being deleted post-rollout. Any future "spin up a demo tenant" script uses the same function.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/tenantPrograms/seed.ts` | Create | Internal seed helper; idempotent. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/tenantPrograms/mutations.ts` | Create | 1B |
| `convex/tenantPrograms/queries.ts` | Create | 1C |
| `convex/tenantPrograms/sync.ts` | Create | 1D |
| `convex/tenantPrograms/seed.ts` | Create | 1E |
