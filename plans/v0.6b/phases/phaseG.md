# Phase G — Origin & Attribution Schema

**Goal:** Add durable row-level origin dimensions to `paymentRecords` and `followUps` so admin-logged payments, reminder-driven payments, customer-flow payments, and admin-created reminders become analytically distinguishable without relying on `domainEvents.metadata`. Widen the schema, backfill historical rows, update every direct-insert site to populate the new fields on new rows, and wire the new fields into the relevant reports (Revenue, Reminders, Team).

**Prerequisite:**
- All other v0.6b phases can ship independently. Phase G unblocks: Revenue page's "Revenue by Origin" chart, Reminders page's "Reminder-Driven Revenue" card (currently a placeholder — see Phase E5), Team page's "Admin-Logged Revenue" secondary attribution column, Pipeline Health's admin-initiated-reminder backlog split (Phase F extension).
- Deployment window: schedule in a low-traffic window because write sites change across the entire payment + follow-up surface.

**Runs in PARALLEL with:** Phase A, Phase B, Phase C, Phase D, Phase E (frontend subphases), Phase F (backend subphases). Phase G's write-site updates do not overlap with Phase A/B/C/D/E/F/H's files. **Schema file (`convex/schema.ts`) is shared with Phase D (index add) and Phase E (index add)** — all three changes are additive and co-deploy cleanly. Phase G should be the last to write to `convex/schema.ts` so its diff includes the new fields (not just indexes).

**Skills to invoke:**
- **`convex-migration-helper`** — Phase G is the canonical widen-migrate-narrow use case. Run this skill first to scaffold the backfill helpers and the migration pattern.
- `convex-performance-audit` — backfill must batch correctly; new origin-aware queries must not regress read budgets.
- `workos` — not applicable (no auth changes).
- `vercel-react-best-practices` — the reporting-consumer step adds new chart renders; keep them memoized.

**Acceptance Criteria:**
1. `convex/schema.ts` adds four fields: `paymentRecords.origin` (optional union), `paymentRecords.loggedByAdminUserId` (optional id), `followUps.createdByUserId` (optional id), `followUps.createdSource` (optional union). `followUps.reason` expands from 3 to 5 values.
2. `convex/schema.ts` adds two indexes: `paymentRecords.by_tenantId_and_origin_and_recordedAt` and `followUps.by_tenantId_and_createdSource_and_createdAt`.
3. `npx convex dev` accepts the schema (all new fields are `v.optional`).
4. All pre-existing production rows continue to satisfy the schema (optional fields → undefined is acceptable).
5. Backfill `backfillPaymentOrigin` runs to completion on the test tenant without error; every paymentRecord has `origin` set to exactly one of `closer_meeting`, `closer_reminder`, `admin_meeting`, `customer_flow` (audit query counts the unset rows — must be 0 after completion).
6. Backfill `backfillFollowUpOrigin` runs to completion; every followUp has `createdSource` and `createdByUserId` set (or explicitly marked as "system" if not derivable from events).
7. Every direct insert into `paymentRecords` (4 sites) now passes `origin` and (where applicable) `loggedByAdminUserId`.
8. Every direct insert into `followUps` (10 sites) now passes `createdByUserId` and `createdSource`. The new `reason` values (`admin_initiated`, `overran_review_resolution`) are used at the appropriate call sites.
9. Revenue page renders a new **Revenue by Origin** chart (post-backfill).
10. Reminders page's `ReminderDrivenRevenueCard` switches from placeholder to live data.
11. Team page renders a new **Admin-Logged Revenue** secondary column on `CloserPerformanceTable`.
12. Pipeline Health shows admin-initiated reminder backlog distinct from closer-initiated (extends Phase F's `UnresolvedRemindersCard`).
13. `pnpm tsc --noEmit` passes at every subphase commit.

---

## Subphase Dependency Graph

```
G1 (schema widen — backend, BLOCKS EVERYTHING BELOW)
   │
   ├── G2 (backfillPaymentOrigin — backend; depends on G1)
   │
   ├── G3 (backfillFollowUpOrigin — backend; depends on G1)
   │
   ├── G4 (write-site rollout — backend; depends on G1, parallel with G2/G3)
   │
   └── G5 (reporting consumers — backend + frontend; depends on G4 + backfills complete)
        │
        ├── G5a (revenue origin chart — backend + frontend)
        │
        ├── G5b (reminder-driven revenue — frontend, upgrade Phase E placeholder)
        │
        ├── G5c (team page admin-logged column — backend + frontend)
        │
        └── G5d (pipeline admin-initiated reminder backlog split — backend + frontend)
```

**Optimal execution:**
1. **Serial step 1 (G1):** Deploy schema widen. Blocks everything else in Phase G.
2. **Parallel (G2, G3, G4):** Backfills and write-site updates can proceed in parallel. Each is idempotent.
3. **Wait for backfill completion** — `auditPaymentOriginBackfill` and `auditFollowUpOriginBackfill` both return `{ unset: 0 }` before enabling reporting consumers.
4. **Parallel (G5a–G5d):** Report consumers each live in different files and can ship in parallel.

**Estimated time:** 5 days (solo); 3 days with backend + frontend parallel; 2 days with migration helper + 3 agents.

---

## Subphases

### G1 — Schema Widen (Fields + Indexes)

**Type:** Backend (schema modification)
**Parallelizable:** No — blocks G2, G3, G4, G5.

**What:** Add 4 new optional fields + expand one enum + add 2 new indexes. All changes are additive (no renames, no removed fields).

**Why:** The widen step is the canonical first step of a widen-migrate-narrow workflow (`convex-migration-helper`). Until new fields exist as `v.optional`, the backfill can't write them and the updated write sites can't type-check.

**Where:**
- `convex/schema.ts` (modify — `paymentRecords` table lines 667-709; `followUps` table lines 711-778)

**How:**

**Step 1: Run the `convex-migration-helper` skill.**

This skill scaffolds the migration pattern. It'll produce a `migrations.ts` file and a `backfill.ts` file (or extend existing) with idempotent batch handlers.

**Step 2: Modify `paymentRecords`.**

```typescript
// Path: convex/schema.ts

// BEFORE (lines 667-709):
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  closerId: v.id("users"),
  amountMinor: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),
  status: v.union(v.literal("recorded"), v.literal("verified"), v.literal("disputed")),
  verifiedAt: v.optional(v.number()),
  verifiedByUserId: v.optional(v.id("users")),
  statusChangedAt: v.optional(v.number()),
  recordedAt: v.number(),
  customerId: v.optional(v.id("customers")),
  contextType: v.union(v.literal("opportunity"), v.literal("customer")),
})
  .index(...) // existing 8 indexes unchanged

// AFTER (v0.6b Phase G):
paymentRecords: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.optional(v.id("opportunities")),
  meetingId: v.optional(v.id("meetings")),
  closerId: v.id("users"),
  amountMinor: v.number(),
  currency: v.string(),
  provider: v.string(),
  referenceCode: v.optional(v.string()),
  proofFileId: v.optional(v.id("_storage")),
  status: v.union(v.literal("recorded"), v.literal("verified"), v.literal("disputed")),
  verifiedAt: v.optional(v.number()),
  verifiedByUserId: v.optional(v.id("users")),
  statusChangedAt: v.optional(v.number()),
  recordedAt: v.number(),
  customerId: v.optional(v.id("customers")),
  contextType: v.union(v.literal("opportunity"), v.literal("customer")),

  // === v0.6b Phase G: Origin & Attribution ===
  // Which flow produced this payment:
  //   "closer_meeting"   — closer logged from the post-meeting flow (convex/closer/payments.ts)
  //   "closer_reminder"  — closer logged from the reminder outcome flow (convex/closer/reminderOutcomes.ts)
  //   "admin_meeting"    — admin logged during review resolution or ad-hoc (convex/admin/meetingActions.ts + convex/reviews/mutations.ts)
  //   "customer_flow"    — logged from the customer payment flow (convex/customers/mutations.ts)
  // Optional during the widen phase; narrowed-to-required is explicitly deferred.
  origin: v.optional(
    v.union(
      v.literal("closer_meeting"),
      v.literal("closer_reminder"),
      v.literal("admin_meeting"),
      v.literal("customer_flow"),
    ),
  ),
  // Non-null when an admin (tenant_master / tenant_admin) recorded the payment,
  // regardless of origin. Separates "which flow" from "who recorded."
  loggedByAdminUserId: v.optional(v.id("users")),
})
  // ... existing 8 indexes unchanged ...
  // New index: query revenue grouped by origin over a date range.
  .index("by_tenantId_and_origin_and_recordedAt", [
    "tenantId",
    "origin",
    "recordedAt",
  ]),
```

**Step 3: Modify `followUps`.**

```typescript
// Path: convex/schema.ts

// BEFORE (lines 711-778) — reason enum has 3 values:
followUps: defineTable({
  // ... tenantId, opportunityId, leadId, closerId, type, schedulingLinkUrl, ... (existing) ...
  reason: v.union(
    v.literal("closer_initiated"),
    v.literal("cancellation_follow_up"),
    v.literal("no_show_follow_up"),
  ),
  // ... existing status, bookedAt, createdAt ...
})
  .index(...) // 8 existing indexes

// AFTER (v0.6b Phase G):
followUps: defineTable({
  // ... tenantId, opportunityId, leadId, closerId, type, schedulingLinkUrl, ... (existing) ...
  reason: v.union(
    v.literal("closer_initiated"),
    v.literal("cancellation_follow_up"),
    v.literal("no_show_follow_up"),
    // === v0.6b Phase G ===
    v.literal("admin_initiated"),          // admin created the reminder directly
    v.literal("overran_review_resolution"),// admin created as part of resolveReview
  ),
  // ... existing status, bookedAt, createdAt unchanged ...

  // === v0.6b Phase G: Origin & Attribution ===
  // User who pressed the button that created this followUp.
  // Optional during widen; distinct from `closerId` (which is the *owner*/assignee).
  createdByUserId: v.optional(v.id("users")),
  createdSource: v.optional(
    v.union(
      v.literal("closer"),
      v.literal("admin"),
      v.literal("system"),           // reserved; unused today
    ),
  ),
})
  // ... existing 8 indexes unchanged (including Phase E's by_tenantId_and_createdAt) ...
  // New index: query reminder backlog split by createdSource.
  .index("by_tenantId_and_createdSource_and_createdAt", [
    "tenantId",
    "createdSource",
    "createdAt",
  ]),
```

**Step 4: Deploy and verify.**

```bash
npx convex dev
```

Verify:
- Both tables have the new fields.
- All existing production rows are still valid (optional fields tolerate undefined).
- The two new indexes appear.
- `npx convex data paymentRecords --limit 1` shows one row (origin is undefined) — proves the optional field is compatible.

**Step 5: Cross-check existing production queries.**

The widen must not break any active query. Run:
```bash
rg -n "reason: \"" convex | grep -v test
rg -n "origin: \"" convex | grep -v test
```
Expected: pre-existing references only use the 3 original `reason` values. The 2 new values only appear after G4 write-site rollout.

**Key implementation notes:**
- **Why widen alone, not widen+narrow in the same deploy:** if we widen and narrow together, the narrow-phase validator will reject existing rows without the new fields and the deploy fails. Widen alone gets the schema live without write breakage.
- **Narrowing is deferred — explicitly.** The design (§10.4) is clear: narrowing blocks any future new origin values. Not worth the rigidity for a CRM in flux.
- **Indexes on optional fields** — Convex tolerates undefined. Rows with undefined `origin` / `createdSource` simply don't appear in the range queries that filter by those. Intentional: rows under backfill flight simply don't participate in origin-grouped reports until backfilled.
- **Don't co-deploy Phase D / Phase E indexes with Phase G fields** in the same PR unless QA is prepared to test 3 independent schema diffs in one go. Deploy Phase D + Phase E indexes first (small, safe), then Phase G fields.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 4 fields, expand 1 enum, add 2 indexes |

---

### G2 — Backfill: `paymentRecords.origin` + `loggedByAdminUserId`

**Type:** Backend (new internal mutation, new file or extend `backfill.ts`)
**Parallelizable:** Yes — depends on G1. Independent of G3/G4.

**What:** Create `backfillPaymentOrigin` in `convex/reporting/backfill.ts` (already exists for aggregates). This mutation processes `paymentRecords` in batches. For each row:
1. If `contextType === "customer"` → `origin = "customer_flow"` **but still inspect the matching event for admin attribution**.
2. Look up the matching `payment.recorded` event (via `domainEvents.entityType === "payment"` and `entityId === payment._id`); use its `metadata.origin`, `source`, and `actorUserId` to refine `origin` and populate `loggedByAdminUserId`.
3. Default for non-customer rows: `origin = "closer_meeting"` + no admin.
4. Log any row that falls back to default so data-quality follow-ups are possible.

**Why:** Historical rows can't be ignored — reports can't show `origin = "unknown"` on historical revenue. Deriving origin from `domainEvents.metadata` is one-shot work that makes all future origin-aware queries cleanly filterable.

**Where:**
- `convex/reporting/backfill.ts` (modify — add internal mutation)

**How:**

**Step 1: Define the batch handler.**

```typescript
// Path: convex/reporting/backfill.ts

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";

const BATCH_SIZE = 100;

type PaymentOrigin = "closer_meeting" | "closer_reminder" | "admin_meeting" | "customer_flow";

/**
 * v0.6b Phase G: backfill paymentRecords.origin and loggedByAdminUserId.
 * Idempotent: rows with origin already set are skipped. Schedules itself
 * with ctx.scheduler.runAfter(0, ...) on each batch to continue.
 */
export const backfillPaymentOrigin = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("paymentRecords")
      .paginate({ cursor: cursor ?? null, numItems: BATCH_SIZE });

    let processed = 0;
    let skipped = 0;
    let fellBackToDefault = 0;

    for (const row of page.page) {
      if (row.origin !== undefined) {
        skipped++;
        continue;
      }
      let origin: PaymentOrigin = "closer_meeting"; // default
      let loggedByAdminUserId: Id<"users"> | undefined;
      let usedDefault = false;

      // Rule 1: row-level primary signal. Customer-flow rows stay customer_flow.
      if (row.contextType === "customer") {
        origin = "customer_flow";
      }

      // Rule 2: match payment.recorded event via entityId; inspect metadata + source.
      // This runs for both customer and opportunity rows because admin attribution is
      // independent of origin (design §16.9).
      const events = await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q
            .eq("tenantId", row.tenantId)
            .eq("entityType", "payment")
            .eq("entityId", row._id),
        )
        .take(5); // bounded
      const recordedEvent = events.find((e) => e.eventType === "payment.recorded");

      if (recordedEvent) {
        const metadata = parseMetadata(recordedEvent.metadata);

        // Non-customer rows can refine origin from the event stream.
        if (row.contextType !== "customer") {
          // Reminder-driven: metadata.origin === "reminder" (historical encoding used by reminderOutcomes.ts)
          if (metadata?.origin === "reminder") {
            origin = "closer_reminder";
          }
          // Admin-recorded meeting flow.
          else if (recordedEvent.source === "admin") {
            origin = "admin_meeting";
          }
          // Otherwise remains closer_meeting.
          else {
            usedDefault = true;
          }
        }

        // Admin attribution is independent of origin. Capture it for both
        // customer_flow and meeting-driven rows.
        if (recordedEvent.source === "admin" && recordedEvent.actorUserId) {
          loggedByAdminUserId = recordedEvent.actorUserId;
        } else if (metadata?.loggedByAdminUserId) {
          loggedByAdminUserId = metadata.loggedByAdminUserId as Id<"users">;
        }
      } else if (row.contextType !== "customer") {
        // No event found on a meeting/opportunity row — fallback to closer_meeting.
        usedDefault = true;
      }

      if (usedDefault) fellBackToDefault++;
      await ctx.db.patch(row._id, { origin, loggedByAdminUserId });
      processed++;
    }

    if (fellBackToDefault > 0) {
      console.log(
        "[Backfill:PaymentOrigin] batch complete | processed=%d, defaulted=%d, skipped=%d",
        processed, fellBackToDefault, skipped,
      );
    }

    // Schedule the next batch.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.reporting.backfill.backfillPaymentOrigin, {
        cursor: page.continueCursor,
      });
    }
    return { processed, skipped, fellBackToDefault, isDone: page.isDone };
  },
});

function parseMetadata(m: string | undefined | null): Record<string, unknown> | null {
  if (!m) return null;
  try {
    const parsed = JSON.parse(m);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
```

**Step 2: Add an audit helper for verification.**

`internalQuery` is imported alongside `internalMutation` at the top of the file (see Step 1).

```typescript
// Path: convex/reporting/backfill.ts (continued — uses the same imports from Step 1)

/**
 * Returns counts of paymentRecords by origin status.
 * Used to verify backfill completeness before turning on origin-aware reports.
 *
 * Paginates to avoid blowing transaction limits on large tenants. Runs as a
 * single query (not a mutation) so Convex caches results until data changes.
 */
export const auditPaymentOriginBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    let total = 0;
    let withOrigin = 0;
    const byOrigin: Record<string, number> = {
      closer_meeting: 0, closer_reminder: 0, admin_meeting: 0, customer_flow: 0,
    };
    while (true) {
      const page = await ctx.db.query("paymentRecords").paginate({ cursor, numItems: 500 });
      for (const row of page.page) {
        total++;
        if (row.origin !== undefined) {
          withOrigin++;
          byOrigin[row.origin] = (byOrigin[row.origin] ?? 0) + 1;
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return { total, withOrigin, unset: total - withOrigin, byOrigin };
  },
});
```

**Step 3: Trigger the backfill manually (CLI).**

```bash
# From CLI / devtools:
npx convex run reporting/backfill:backfillPaymentOrigin '{}'
# After some time:
npx convex run reporting/backfill:auditPaymentOriginBackfill '{}'
# Verify { unset: 0 } before proceeding.
```

**Key implementation notes:**
- **Idempotency:** rows with `origin` already set are skipped. Safe to re-run.
- **Event lookup bound:** `.take(5)` on the payment's events — more than enough; usually 1-3 events per payment.
- **Metadata parsing:** domain events store metadata as a JSON string. Parser is defensive (returns null on malformed).
- **Fall-back logging:** only log rows that fall back to default — not every row. Keeps logs readable for the common case.
- **Customer-flow + admin:** if a customer-flow payment was logged by an admin, `origin = "customer_flow"` **and** `loggedByAdminUserId` is set. Both are independent dimensions (design §16.9). The code path above must preserve both.
- **`recordedEvent.actorUserId`:** typed as `Id<"users">` in the schema; safe to cast.
- **Do not scan domainEvents outside the per-payment lookup** — at 50k+ events that would explode cost. The per-payment lookup uses an index that's already optimized for this.
- **Reminder-driven encoding:** the historical encoding in `convex/closer/reminderOutcomes.ts` puts `metadata.origin === "reminder"`. Preserve that exact string check until the backfill completes; after G4 the new rows use `origin = "closer_reminder"` directly at the row level.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/backfill.ts` | Modify | Add `backfillPaymentOrigin` + `auditPaymentOriginBackfill` |

---

### G3 — Backfill: `followUps.createdByUserId` + `createdSource`

**Type:** Backend (new internal mutation)
**Parallelizable:** Depends on G1. Independent of G2/G4.

**What:** Create `backfillFollowUpOrigin` in `convex/reporting/backfill.ts`. For each followUp without a `createdSource`:
1. Find the earliest `followUp.created` domain event (by `entityId === followUp._id`).
2. If found: `createdSource = event.source`, `createdByUserId = event.actorUserId`.
3. If not found: `createdSource = "system"`, `createdByUserId` = undefined (no trace).

**Why:** Phase F and Phase G reports want to distinguish admin-initiated from closer-initiated reminders and follow-ups. Historical rows can't be ignored for the same reason as G2.

**Where:**
- `convex/reporting/backfill.ts` (modify — add internal mutation)

**How:**

**Step 1: Define the batch handler.**

```typescript
// Path: convex/reporting/backfill.ts

export const backfillFollowUpOrigin = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("followUps")
      .paginate({ cursor: cursor ?? null, numItems: BATCH_SIZE });

    let processed = 0;
    let skipped = 0;
    let defaultedToSystem = 0;

    for (const row of page.page) {
      if (row.createdSource !== undefined) {
        skipped++;
        continue;
      }
      // Find the earliest followUp.created event for this row.
      const events = await ctx.db
        .query("domainEvents")
        .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
          q
            .eq("tenantId", row.tenantId)
            .eq("entityType", "followUp")
            .eq("entityId", row._id),
        )
        .take(5);
      const createdEvent = events.find((e) => e.eventType === "followUp.created");

      let createdSource: "closer" | "admin" | "system";
      let createdByUserId: Id<"users"> | undefined;

      if (createdEvent) {
        if (createdEvent.source === "closer" || createdEvent.source === "admin") {
          createdSource = createdEvent.source;
          createdByUserId = createdEvent.actorUserId;
        } else {
          createdSource = "system";
        }
      } else {
        createdSource = "system";
        defaultedToSystem++;
      }

      await ctx.db.patch(row._id, { createdSource, createdByUserId });
      processed++;
    }

    if (defaultedToSystem > 0) {
      console.log(
        "[Backfill:FollowUpOrigin] batch complete | processed=%d, defaulted=%d, skipped=%d",
        processed, defaultedToSystem, skipped,
      );
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.reporting.backfill.backfillFollowUpOrigin, {
        cursor: page.continueCursor,
      });
    }
    return { processed, skipped, defaultedToSystem, isDone: page.isDone };
  },
});

/**
 * Audit helper mirroring the paymentRecords audit.
 * Uses the same `internalQuery` import added in G2 (top of `backfill.ts`).
 */
export const auditFollowUpOriginBackfill = internalQuery({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    let total = 0;
    let withSource = 0;
    const bySource: Record<string, number> = { closer: 0, admin: 0, system: 0 };
    while (true) {
      const page = await ctx.db.query("followUps").paginate({ cursor, numItems: 500 });
      for (const row of page.page) {
        total++;
        if (row.createdSource !== undefined) {
          withSource++;
          bySource[row.createdSource] = (bySource[row.createdSource] ?? 0) + 1;
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return { total, withSource, unset: total - withSource, bySource };
  },
});
```

**Step 2: Trigger and verify.**

```bash
npx convex run reporting/backfill:backfillFollowUpOrigin '{}'
npx convex run reporting/backfill:auditFollowUpOriginBackfill '{}'
# Expect { unset: 0 }
```

**Key implementation notes:**
- Same batching, same scheduler self-continuation pattern as G2.
- `system` is a legitimate value — not an error — for rows with no traceable creator.
- `createdByUserId` remains undefined for `system`-sourced rows (no actor in the event).
- The backfill does **not** populate the new `reason` values (`admin_initiated`, `overran_review_resolution`). The `reason` field is already required; historical rows already have one of the three original values. The new values are set on new rows in G4.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/backfill.ts` | Modify | Add `backfillFollowUpOrigin` + `auditFollowUpOriginBackfill` |

---

### G4 — Write-Site Rollout

**Type:** Backend (modify 10+ mutation files)
**Parallelizable:** Yes — depends on G1. Independent of G2/G3. **Multiple files; can be split across agents per file.**

**What:** Update every direct insert into `paymentRecords` or `followUps` to populate the new fields. Also route some admin flows through the correct `reason` value.

**Why:** Without this rollout, new production rows after G1 still lack origin/creator fields — the backfill becomes stale. This is the widen-migrate-narrow's "migrate" phase for the write side.

**Where (per the audit — 4 payment sites, 10 follow-up sites):**
- `convex/lib/outcomeHelpers.ts` — modify both `createPaymentRecord` and `createManualReminder` to accept `origin`, `loggedByAdminUserId`, `reason`, `createdByUserId`, `createdSource` args.
- `convex/closer/payments.ts:146` — pass `origin` dynamically (closer role → `closer_meeting`; admin role → `admin_meeting` + set `loggedByAdminUserId`).
- `convex/closer/reminderOutcomes.ts:100` — pass `origin: "closer_reminder"`.
- `convex/customers/mutations.ts:170` — pass `origin: "customer_flow"`; if actor role is admin, set `loggedByAdminUserId`.
- `convex/closer/followUpMutations.ts:48,208,355` — pass `createdByUserId`, `createdSource` on 3 inserts.
- `convex/closer/noShowActions.ts:230` — pass `createdByUserId`, `createdSource`.
- `convex/closer/meetingOverrun.ts:287` — pass `createdByUserId`, `createdSource`.
- `convex/closer/reminderOutcomes.ts:412` — pass `createdByUserId`, `createdSource`.
- `convex/admin/meetingActions.ts:117,258,377` — pass `createdByUserId: actorUserId`, `createdSource: "admin"`, and set `reason: "admin_initiated"` or `reason: "overran_review_resolution"` depending on the site.
- `convex/reviews/mutations.ts` — review-resolution payment inserts pass `origin: "admin_meeting"`; review-resolution follow-up inserts pass `reason: "overran_review_resolution"` + `createdSource: "admin"`.

**How (representative patch for each file):**

**Step 1: Extend `outcomeHelpers.ts` signatures.**

```typescript
// Path: convex/lib/outcomeHelpers.ts

// BEFORE:
export async function createPaymentRecord(ctx, args: {
  tenantId: Id<"tenants">;
  opportunityId?: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  closerId: Id<"users">;
  amountMinor: number;
  // ... existing fields ...
}) { /* ... */ }

// AFTER:
type PaymentOrigin = "closer_meeting" | "closer_reminder" | "admin_meeting" | "customer_flow";

export async function createPaymentRecord(ctx, args: {
  tenantId: Id<"tenants">;
  opportunityId?: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  closerId: Id<"users">;
  amountMinor: number;
  // ... existing fields ...
  origin: PaymentOrigin;                          // NEW — required on new rows
  loggedByAdminUserId?: Id<"users">;              // NEW — optional
}) {
  // ... existing body ...
  return await ctx.db.insert("paymentRecords", {
    // ... existing fields ...
    origin: args.origin,
    loggedByAdminUserId: args.loggedByAdminUserId,
  });
}

// Similarly for createManualReminder:
type FollowUpReason =
  | "closer_initiated"
  | "cancellation_follow_up"
  | "no_show_follow_up"
  | "admin_initiated"
  | "overran_review_resolution";
type FollowUpCreatedSource = "closer" | "admin" | "system";

export async function createManualReminder(ctx, args: {
  tenantId: Id<"tenants">;
  opportunityId: Id<"opportunities">;
  leadId: Id<"leads">;
  closerId: Id<"users">;
  // ... existing fields ...
  reason: FollowUpReason;                         // widened enum
  createdByUserId: Id<"users">;                   // NEW — required on new rows
  createdSource: FollowUpCreatedSource;           // NEW — required
}) {
  // ...
  return await ctx.db.insert("followUps", {
    // ... existing fields ...
    reason: args.reason,
    createdByUserId: args.createdByUserId,
    createdSource: args.createdSource,
  });
}
```

**Step 2: Rewrite each direct insert site.**

Example: `convex/closer/payments.ts:146`. Prior pattern:
```typescript
await ctx.db.insert("paymentRecords", {
  tenantId, opportunityId, meetingId, closerId: attributedCloserId,
  amountMinor, currency, provider, /* ... */
  recordedAt: Date.now(),
});
```

New pattern:
```typescript
// Path: convex/closer/payments.ts

// role is already in scope from requireTenantUser:
const { userId, role } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin", "closer"]);

const origin: PaymentOrigin = role === "closer" ? "closer_meeting" : "admin_meeting";
const loggedByAdminUserId =
  role === "tenant_master" || role === "tenant_admin" ? userId : undefined;

await ctx.db.insert("paymentRecords", {
  tenantId, opportunityId, meetingId, closerId: attributedCloserId,
  amountMinor, currency, provider, /* ... */
  recordedAt: Date.now(),
  origin,
  loggedByAdminUserId,
});
```

Example: `convex/closer/reminderOutcomes.ts:100`. Prior pattern inserts a payment; update:
```typescript
// Path: convex/closer/reminderOutcomes.ts

await ctx.db.insert("paymentRecords", {
  // ... existing fields ...
  origin: "closer_reminder",  // reminder-driven attribution
});
```

Example: `convex/admin/meetingActions.ts:117` (adminCreateFollowUp). The follow-up reason here should be `"admin_initiated"`:
```typescript
// Path: convex/admin/meetingActions.ts

await ctx.db.insert("followUps", {
  // ... existing fields ...
  reason: "admin_initiated",
  createdByUserId: actorUserId,
  createdSource: "admin",
});
```

Example: `convex/reviews/mutations.ts` — the review-resolution follow-up (resolutionAction === "schedule_follow_up") should use `reason: "overran_review_resolution"`:
```typescript
// Path: convex/reviews/mutations.ts

await createManualReminder(ctx, {
  // ... existing ...
  reason: "overran_review_resolution",
  createdByUserId: actorUserId,
  createdSource: "admin",
});
```

**Step 3: Update `customers/mutations.ts:170` — customer payment.**

```typescript
// Path: convex/customers/mutations.ts

const { userId, role } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin", "closer"]);
const loggedByAdminUserId =
  role === "tenant_master" || role === "tenant_admin" ? userId : undefined;

await ctx.db.insert("paymentRecords", {
  // ... existing ...
  origin: "customer_flow",
  loggedByAdminUserId,
});
```

**Step 4: Run the full typecheck.**

```bash
pnpm tsc --noEmit
```

Every direct insert must type-check with the new fields. `createPaymentRecord` / `createManualReminder` helpers make origin a required TS parameter — if any consumer forgets to pass it, tsc fails loudly.

**Step 5: Re-run the insert-site audit before closing G4.**

```bash
rg -n 'insert\\("paymentRecords"|insert\\("followUps"' convex
```

Compare the results against the site list in this phase. If a new direct insert appeared during implementation, update it before declaring G4 complete.

**Key implementation notes:**
- **Centralization:** Making `origin` / `createdSource` required in the helper signatures is how we force every consumer to think about it. The audit shows helpers are under-consumed; that's fine — the direct inserts now require the fields too via TS.
- **No data migration at this step** — only new rows get the field populated. Historical rows rely on G2/G3.
- **Review-resolution path:** `convex/reviews/mutations.ts` handles 6 resolution actions. Trace each:
  - `log_payment` → payment insert with `origin: "admin_meeting"` + `loggedByAdminUserId: actorUserId`.
  - `schedule_follow_up` → follow-up insert with `reason: "overran_review_resolution"` + `createdSource: "admin"`.
  - `mark_no_show`, `mark_lost`, `acknowledged`, `disputed` → no insert; no change.
- **Check for duplicate insert sites** — `convex/admin/meetingActions.ts` has three follow-up inserts (at :117, :258, :377). Each needs its own reason (`admin_initiated` or the site-appropriate one).
- **Exhaustive audit is required.** The helper updates are not sufficient on their own because the repo still contains direct `ctx.db.insert("paymentRecords")` and `ctx.db.insert("followUps")` call sites outside the helpers. Re-run the `rg` audit in Step 5 before merging.
- **Testing:** follow `TESTING.MD` — after merging, manually book a test invitee, log a payment as closer (verify `origin === "closer_meeting"`), log another as admin (verify `origin === "admin_meeting"` + `loggedByAdminUserId !== undefined`), complete a reminder payment (verify `origin === "closer_reminder"`).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/outcomeHelpers.ts` | Modify | Extend helper signatures to require new fields |
| `convex/closer/payments.ts` | Modify | 1 insert — role-based origin + loggedByAdminUserId |
| `convex/closer/reminderOutcomes.ts` | Modify | 1 payment insert (origin="closer_reminder") + 1 followUp insert (createdBy/createdSource) |
| `convex/customers/mutations.ts` | Modify | 1 payment insert (origin="customer_flow") |
| `convex/closer/followUpMutations.ts` | Modify | 3 followUp inserts |
| `convex/closer/noShowActions.ts` | Modify | 1 followUp insert |
| `convex/closer/meetingOverrun.ts` | Modify | 1 followUp insert |
| `convex/admin/meetingActions.ts` | Modify | 3 followUp inserts with reason="admin_initiated" or "overran_review_resolution" |
| `convex/reviews/mutations.ts` | Modify | payment insert (origin="admin_meeting") + followUp insert (reason="overran_review_resolution") |

---

### G5 — Reporting Consumers (Revenue / Reminder / Team / Pipeline)

**Type:** Full-stack (backend + frontend)
**Parallelizable:** Depends on G4 + both backfills complete (`auditPaymentOriginBackfill` returns `{ unset: 0 }`). G5a/b/c/d are independent subphases.

**What:**
- **G5a — Revenue by Origin chart.** Extend `convex/reporting/revenue.ts:getRevenueMetrics` to return origin-grouped breakdown; add chart to revenue page.
- **G5b — Reminder-Driven Revenue card upgrade.** Extend `convex/reporting/remindersReporting.ts:getReminderOutcomeFunnel` to include `reminderDrivenRevenueMinor`; upgrade Phase E's placeholder.
- **G5c — Admin-logged revenue column on Team.** Extend `convex/reporting/teamPerformance.ts:getTeamPerformanceMetrics` with `adminLoggedRevenueMinor` per closer; add secondary column.
- **G5d — Admin-initiated reminder backlog split.** Extend Phase F's `getPipelineBacklogAndLoss` (`convex/reporting/pipelineHealth.ts`) to split unresolved reminders into `admin` / `closer` buckets using `createdSource`; update `UnresolvedRemindersCard` prop.

**Where:**
- `convex/reporting/revenue.ts` (modify — G5a)
- `convex/reporting/remindersReporting.ts` (modify — G5b)
- `convex/reporting/teamPerformance.ts` (modify — G5c)
- `convex/reporting/pipelineHealth.ts` (modify — G5d)
- `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` (new — G5a)
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` (modify — G5a)
- `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` (modify — G5b, replace placeholder)
- `app/workspace/reports/team/_components/closer-performance-table.tsx` (modify — G5c, add column)
- `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` (modify — G5d, add breakdown)

**How:**

**G5a — Revenue by Origin (backend + frontend).**

Backend:
```typescript
// Path: convex/reporting/revenue.ts

// Inside getRevenueMetrics — after the existing per-closer rollup, add origin rollup:

const byOrigin: Record<string, number> = {
  closer_meeting: 0, closer_reminder: 0, admin_meeting: 0, customer_flow: 0,
  unknown: 0, // legacy rows; should be 0 post-backfill
};
for (const p of payments) {
  const key = p.origin ?? "unknown";
  byOrigin[key] = (byOrigin[key] ?? 0) + p.amountMinor;
}

return {
  // ... existing fields ...
  byOrigin, // NEW — amount in minor units per origin
};
```

Frontend (new chart):
```tsx
// Path: app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

const ORIGIN_LABELS = {
  closer_meeting: "Closer · Meeting",
  closer_reminder: "Closer · Reminder",
  admin_meeting: "Admin · Meeting",
  customer_flow: "Customer Flow",
  unknown: "Legacy (Unbackfilled)",
} as const;

const ORIGIN_COLORS: Record<keyof typeof ORIGIN_LABELS, string> = {
  closer_meeting: "var(--chart-1)",
  closer_reminder: "var(--chart-2)",
  admin_meeting: "var(--chart-3)",
  customer_flow: "var(--chart-4)",
  unknown: "var(--muted-foreground)",
};

interface Props {
  byOrigin: Record<string, number>;
}

export function RevenueByOriginChart({ byOrigin }: Props) {
  const data = (Object.keys(ORIGIN_LABELS) as (keyof typeof ORIGIN_LABELS)[])
    .filter((k) => (byOrigin[k] ?? 0) > 0)
    .map((k) => ({
      label: ORIGIN_LABELS[k],
      value: (byOrigin[k] ?? 0) / 100, // minor → major
      fill: ORIGIN_COLORS[k],
    }));
  const total = data.reduce((s, d) => s + d.value, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Revenue by Origin</CardTitle>
        <CardDescription>Which flow produced each payment — durable attribution across meetings, reminders, admin entries, and customer flow.</CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No revenue in range.</p>
        ) : (
          <ChartContainer
            config={Object.fromEntries(
              (Object.keys(ORIGIN_LABELS) as (keyof typeof ORIGIN_LABELS)[]).map((k) => [
                k, { label: ORIGIN_LABELS[k], color: ORIGIN_COLORS[k] },
              ]),
            )}
            className="h-56"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical">
                <XAxis type="number" tickFormatter={(v) => `$${v.toLocaleString()}`} />
                <YAxis type="category" dataKey="label" width={160} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltipContent />} />
                <Bar dataKey="value" />
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

Wire into `revenue-report-page-client.tsx` in the place reserved for it. `unknown` bucket appears only if backfill incomplete — useful data-quality indicator during rollout.

**G5b — Reminder-Driven Revenue card upgrade.**

Backend:
```typescript
// Path: convex/reporting/remindersReporting.ts

// Inside getReminderOutcomeFunnel handler — scan paymentRecords with origin="closer_reminder" in range:

const reminderPayments = await ctx.db
  .query("paymentRecords")
  .withIndex("by_tenantId_and_origin_and_recordedAt", (q) =>
    q
      .eq("tenantId", tenantId)
      .eq("origin", "closer_reminder")
      .gte("recordedAt", startDate)
      .lt("recordedAt", endDate),
  )
  .take(2000);

const reminderDrivenRevenueMinor = reminderPayments.reduce((s, p) => s + p.amountMinor, 0);
const reminderDrivenPaymentCount = reminderPayments.length;

return {
  // ... existing fields ...
  reminderDrivenRevenueMinor,
  reminderDrivenPaymentCount,
  isReminderRevenueTruncated: reminderPayments.length >= 2000,
};
```

Frontend — **replace** Phase E's placeholder:
```tsx
// Path: app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DollarSignIcon } from "lucide-react";

interface Props {
  amountMinor: number;
  count: number;
  isTruncated?: boolean;
}

function formatCurrency(minor: number): string {
  return `$${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ReminderDrivenRevenueCard({ amountMinor, count, isTruncated }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSignIcon className="h-4 w-4" />
          Reminder-Driven Revenue
        </CardTitle>
        <CardDescription>
          Sum of payments with `origin = "closer_reminder"` in the selected range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold tabular-nums">{formatCurrency(amountMinor)}</div>
        <p className="mt-1 text-xs text-muted-foreground">
          Across {count} payment(s){isTruncated && ` — first 2,000 shown`}
        </p>
      </CardContent>
    </Card>
  );
}
```

Update `reminders-report-page-client.tsx` to pass the now-available props:
```tsx
<ReminderDrivenRevenueCard
  amountMinor={data.reminderDrivenRevenueMinor}
  count={data.reminderDrivenPaymentCount}
  isTruncated={data.isReminderRevenueTruncated}
/>
```

**G5c — Admin-Logged Revenue column on Team.**

Backend:
```typescript
// Path: convex/reporting/teamPerformance.ts

// Inside per-closer payment summary loop — alongside dealCount, revenueMinor, compute:
const adminLoggedMinor = payments
  .filter((p) => p.loggedByAdminUserId !== undefined)
  .reduce((s, p) => s + p.amountMinor, 0);

// Add to per-closer response:
return {
  // ... existing ...
  adminLoggedRevenueMinor: adminLoggedMinor,
};
```

Frontend: add a column to `CloserPerformanceTable`:
```tsx
// Path: app/workspace/reports/team/_components/closer-performance-table.tsx

<TableHead className="text-right">Admin-Logged</TableHead>
// body:
<TableCell className="text-right">{formatCurrency(closer.adminLoggedRevenueMinor)}</TableCell>
```

**G5d — Admin-initiated reminder backlog split.**

Backend:
```typescript
// Path: convex/reporting/pipelineHealth.ts

// Inside getPipelineBacklogAndLoss — replace the single unresolvedRemindersCount with a breakdown:

const unresolvedReminderSplit = { admin: 0, closer: 0, system: 0, none: 0 };
for (const r of manualReminders) {
  const key = r.createdSource ?? "none";
  unresolvedReminderSplit[key]++;
}
return {
  // ...
  unresolvedRemindersCount,
  unresolvedReminderSplit, // NEW
  // ...
};
```

Frontend:
```tsx
// Path: app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx

interface Props {
  count: number;
  split?: { admin: number; closer: number; system: number; none: number };
  isTruncated: boolean;
}

// Inside the card body, below the primary count:
{split && (
  <p className="mt-1 text-xs text-muted-foreground">
    {split.closer} closer · {split.admin} admin{split.system + split.none > 0 && ` · ${split.system + split.none} other`}
  </p>
)}
```

**Key implementation notes:**
- **Unknown bucket is a feature, not a bug:** during backfill progress it shows data-quality progress. After backfill completes, it should be 0.
- **Team page G5c:** the new column is compact ("Admin-Logged") — don't rename the existing "Cash Collected" column (which still shows the full closer revenue including admin-logged).
- **Order of operations:** enable G5 consumers **only after** backfills verify `{ unset: 0 }`. Otherwise reports show misleading "unknown" buckets.
- **Chart of origin:** admin-logged + closer-logged + customer-flow + reminder should equal total revenue, modulo unknown. Rendering these as a stacked bar instead of a side-by-side would make the "equals total" relationship clear — stylistic call; side-by-side chosen for readability.
- **Phase F dependency for G5d:** G5d extends the `UnresolvedRemindersCard` added in Phase F4. If Phase F hasn't landed, G5d extends a card-placeholder in `pipeline-report-page-client.tsx` directly.

**Files touched:**

| File | Action | Subphase | Notes |
|---|---|---|---|
| `convex/reporting/revenue.ts` | Modify | G5a | |
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | Create | G5a | |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Modify | G5a | |
| `convex/reporting/remindersReporting.ts` | Modify | G5b | |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | Modify | G5b | Replace placeholder |
| `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` | Modify | G5b | Pass new props |
| `convex/reporting/teamPerformance.ts` | Modify | G5c | |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | G5c | Add column |
| `convex/reporting/pipelineHealth.ts` | Modify | G5d | |
| `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` | Modify | G5d | |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | G1 |
| `convex/reporting/backfill.ts` | Modify | G2, G3 |
| `convex/lib/outcomeHelpers.ts` | Modify | G4 |
| `convex/closer/payments.ts` | Modify | G4 |
| `convex/closer/reminderOutcomes.ts` | Modify | G4 |
| `convex/customers/mutations.ts` | Modify | G4 |
| `convex/closer/followUpMutations.ts` | Modify | G4 |
| `convex/closer/noShowActions.ts` | Modify | G4 |
| `convex/closer/meetingOverrun.ts` | Modify | G4 |
| `convex/admin/meetingActions.ts` | Modify | G4 |
| `convex/reviews/mutations.ts` | Modify | G4 |
| `convex/reporting/revenue.ts` | Modify | G5a |
| `convex/reporting/remindersReporting.ts` | Modify | G5b |
| `convex/reporting/teamPerformance.ts` | Modify | G5c |
| `convex/reporting/pipelineHealth.ts` | Modify | G5d |
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | Create | G5a |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Modify | G5a |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | Modify | G5b |
| `app/workspace/reports/reminders/_components/reminders-report-page-client.tsx` | Modify | G5b |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | G5c |
| `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` | Modify | G5d |

**Blast radius:**
- **Highest risk phase.** 11 backend files modified, 2 new frontend components, 5 frontend modifications.
- **Schema impact:** `paymentRecords` and `followUps` are production-critical tables. Widen is safe; narrow is deferred.
- **Backfill runtime:** ~seconds at current volume (~1,000 rows); if tenant grows to 100k rows, ~5 minutes via batched scheduler.
- **Write-site rollout is the biggest surface:** pre-change, every insert works without new fields; post-change, every new insert populates them. **Verify `pnpm tsc --noEmit` passes** after each file before moving to the next.
- **Phase G and Phase F on `pipelineHealth.ts`:** Phase F adds `getPipelineBacklogAndLoss`; Phase G extends that same query with `unresolvedReminderSplit`. Merge order: Phase F first, then Phase G's G5d extension.
- **Phase G and Phase B on `teamPerformance.ts`:** Phase B extends `getTeamPerformanceMetrics` with `reviewRequiredCalls` + `meetingTime` block; Phase G adds `adminLoggedRevenueMinor` per closer. Separate concerns; no conflict.
- **Phase G and Phase E on `remindersReporting.ts`:** Phase E creates the file; Phase G extends it with `reminderDrivenRevenueMinor`. Merge Phase E first.
- **Phase G and Phase A on `activityFeed.ts`:** no overlap.
- **Cold path preserved:** existing `getRevenueMetrics` response stays — only appends `byOrigin`.

**Rollback plan:**
- **G5a/b/c/d:** revert independently — consumers are isolated.
- **G4 rollback:** revert write sites; future new rows once again lack new fields but the schema still accepts them (optional).
- **G3 rollback:** keep the field populated — rollback isn't really needed; idempotent rerun.
- **G2 rollback:** same as G3.
- **G1 rollback:** extremely painful — requires removing fields that write sites now use. Do **not** ship G1 without committing to keep the fields. If schema narrowing is later desired, do it as a separate dedicated phase with a fresh widen-migrate-narrow cycle.

**Deployment runbook:**
1. Ship G1 (schema widen) in a PR. Deploy. Verify `npx convex dev` accepts.
2. Ship G2 + G3 + G4 in parallel PRs (can be 3 separate agents). Merge in any order.
3. Trigger backfills via CLI. Verify audit returns `{ unset: 0 }` for both.
4. Ship G5a/b/c/d in parallel PRs. Each unlocks one reporting consumer.
5. **Do not skip the audit step** — consumers that see "unknown" origin rows will confuse admins.
