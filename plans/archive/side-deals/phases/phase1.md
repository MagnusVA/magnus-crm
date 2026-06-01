# Phase 1 - Schema & Enum Foundations

**Goal:** Widen the Convex data model so the system can distinguish Calendly opportunities from side-deal opportunities, classify side-deal payment origins, and sort the future Opportunities list by a single denormalized activity timestamp. After this phase, existing Calendly flows continue to work while all new opportunity writes populate `source` and `latestActivityAt`.

**Prerequisite:** `plans/side-deals/side-deals-design.md` is accepted. Production contains one real test tenant, so all required-field changes must follow widen-migrate-narrow. `paymentRecords.meetingId` and `customers.winningMeetingId` are already optional.

**Runs in PARALLEL with:** Nothing at the phase level. This is the hard foundation for every later phase. Internally, 1B, 1C, and 1D can run in parallel after 1A schema widening has generated types.

**Skills to invoke:**
- `convex-migration-helper` - required for the widen-migrate-narrow rollout of `opportunities.source` and `opportunities.latestActivityAt`.
- `convex-performance-audit` - verify every new Opportunities list index matches an intended query branch and does not introduce unnecessary scan paths.
- `convex-dev-workos-authkit` - read-only sanity check that no schema or helper change weakens tenant/user identity derivation.

---

## Acceptance Criteria

1. `npx convex dev` accepts the widened schema with optional `opportunities.source`, optional `opportunities.latestActivityAt`, optional `opportunities.manualCreationKey`, the new opportunity indexes, `leadIdentifiers.source = "side_deal"`, and side-deal payment origins.
2. Existing Calendly webhook opportunity creation inserts rows with `source: "calendly"` and `latestActivityAt` set to the created/updated timestamp.
3. Any mutation that changes an opportunity lifecycle field uses `patchOpportunityLifecycle()` or explicitly documents why it does not affect lifecycle/activity ordering.
4. `normalizeOpportunitySource()` treats legacy rows with `source === undefined` as `"calendly"` until the narrow deploy.
5. `isSideDealOrigin("closer_side_deal")` and `isSideDealOrigin("admin_side_deal")` return true; existing origins keep their prior classification.
6. The backfill migration is idempotent: running it twice leaves already-patched opportunities unchanged.
7. Backfill dry run reports the expected number of opportunities that would receive `source` and/or `latestActivityAt`.
8. Backfill verification can prove there are zero opportunity rows where `source === undefined` and zero rows where `latestActivityAt === undefined`.
9. The narrow deploy is documented but not merged in this phase; `source` and `latestActivityAt` remain optional until backfill verification passes in production.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (schema widen + validator unions - BLOCKER) ───────────────┐
                                                              │
                 ┌────────────────────────────────────────────┘
                 │
                 ├── 1B (normalization + lifecycle helper) ─────────┐
                 │                                                   │
                 ├── 1C (existing writer compliance) ────────────────┤
                 │                                                   ├── 1E (backfill run + verification)
                 └── 1D (migration definition + dry-run runner) ─────┘
                                                                     │
                                                                     └── 1F (narrow-deploy runbook)
```

**Optimal execution:**
1. Complete **1A** first and run `npx convex dev` so generated `Doc<"opportunities">` types include the widened fields.
2. Start **1B, 1C, and 1D in parallel**. 1B owns new helper files, 1C owns existing opportunity writers, and 1D owns `convex/migrations.ts`.
3. Run the migration dry run and real backfill in **1E** only after 1B and 1C are merged, so new writes during the migration window already write the new fields.
4. Keep **1F** as a documented follow-up, not an implementation merge, until production verification shows all existing rows are backfilled.

**Estimated time:** 1.5-2 days solo, or 1 day with 3 parallel backend streams after 1A.

---

## Subphases

### 1A - Schema Widen + Origin Validators

**Type:** Backend
**Parallelizable:** No - all other subphases depend on Convex generated types and validators accepting the widened row shapes.

**What:** Modify `convex/schema.ts` and `convex/lib/paymentTypes.ts` with additive schema/validator changes only.

**Why:** Side deals need a source discriminator, idempotency key, side-deal payment origins, and list indexes before any backend or frontend implementation can compile safely. These fields are optional during rollout because existing production opportunity rows do not have them.

**Where:**
- `convex/schema.ts` (modify)
- `convex/lib/paymentTypes.ts` (modify)

**How:**

**Step 1: Extend `leadIdentifiers.source`.**

```typescript
// Path: convex/schema.ts
source: v.union(
  v.literal("calendly_booking"),
  v.literal("manual_entry"),
  v.literal("merge"),
  v.literal("side_deal"),
),
```

**Step 2: Widen `opportunities` with additive optional fields.**

```typescript
// Path: convex/schema.ts
opportunities: defineTable({
  tenantId: v.id("tenants"),
  leadId: v.id("leads"),
  assignedCloserId: v.optional(v.id("users")),
  // ... existing fields ...
  status: v.union(
    v.literal("scheduled"),
    v.literal("in_progress"),
    v.literal("meeting_overran"),
    v.literal("payment_received"),
    v.literal("follow_up_scheduled"),
    v.literal("reschedule_link_sent"),
    v.literal("lost"),
    v.literal("canceled"),
    v.literal("no_show"),
  ),
  source: v.optional(
    v.union(v.literal("calendly"), v.literal("side_deal")),
  ),
  manualCreationKey: v.optional(v.string()),
  latestActivityAt: v.optional(v.number()),
  // ... existing fields ...
  createdAt: v.number(),
  updatedAt: v.number(),
})
```

**Step 3: Add the exact opportunity indexes required by list, create idempotency, and staleness.**

```typescript
// Path: convex/schema.ts
.index("by_tenantId_and_manualCreationKey", [
  "tenantId",
  "manualCreationKey",
])
.index("by_tenantId_and_source_and_createdAt", [
  "tenantId",
  "source",
  "createdAt",
])
.index("by_source_and_status_and_createdAt", [
  "source",
  "status",
  "createdAt",
])
.index("by_tenantId_and_latestActivityAt", [
  "tenantId",
  "latestActivityAt",
])
.index("by_tenantId_and_status_and_latestActivityAt", [
  "tenantId",
  "status",
  "latestActivityAt",
])
.index("by_tenantId_and_source_and_latestActivityAt", [
  "tenantId",
  "source",
  "latestActivityAt",
])
.index("by_tenantId_and_source_and_status_and_latestActivityAt", [
  "tenantId",
  "source",
  "status",
  "latestActivityAt",
])
.index("by_tenantId_and_assignedCloserId_and_latestActivityAt", [
  "tenantId",
  "assignedCloserId",
  "latestActivityAt",
])
.index("by_tenantId_and_assignedCloserId_and_status_and_latestActivityAt", [
  "tenantId",
  "assignedCloserId",
  "status",
  "latestActivityAt",
])
.index("by_tenantId_and_assignedCloserId_and_source_and_latestActivityAt", [
  "tenantId",
  "assignedCloserId",
  "source",
  "latestActivityAt",
])
.index("by_tenantId_and_assignedCloserId_and_source_and_status_and_latestActivityAt", [
  "tenantId",
  "assignedCloserId",
  "source",
  "status",
  "latestActivityAt",
])
```

**Step 4: Extend payment origin unions and types.**

```typescript
// Path: convex/lib/paymentTypes.ts
export const COMMISSIONABLE_ORIGINS = [
  "closer_meeting",
  "closer_reminder",
  "admin_meeting",
  "admin_reminder",
  "admin_review_resolution",
  "closer_side_deal",
  "admin_side_deal",
] as const;

export const commissionableOriginValidator = v.union(
  v.literal("closer_meeting"),
  v.literal("closer_reminder"),
  v.literal("admin_meeting"),
  v.literal("admin_reminder"),
  v.literal("admin_review_resolution"),
  v.literal("closer_side_deal"),
  v.literal("admin_side_deal"),
);

export const paymentOriginValidator = v.union(
  v.literal("closer_meeting"),
  v.literal("closer_reminder"),
  v.literal("admin_meeting"),
  v.literal("admin_reminder"),
  v.literal("admin_review_resolution"),
  v.literal("closer_side_deal"),
  v.literal("admin_side_deal"),
  v.literal("customer_direct"),
  v.literal("bookkeeper_direct"),
);
```

**Step 5: Push schema and regenerate API types.**

```bash
# Path: repo root
npx convex dev
pnpm tsc --noEmit
```

**Key implementation notes:**
- Do not make `source` or `latestActivityAt` required in this deploy. Convex will reject existing rows that lack the fields.
- Keep `manualCreationKey` optional permanently because Calendly rows never need it.
- The source/status/latestActivity indexes intentionally duplicate closer-scoped and tenant-scoped branches; this avoids filtering after pagination.
- Do not remove existing `createdAt` indexes in this phase. Pipeline views still use them.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Widen `opportunities`, extend `leadIdentifiers.source`, add list/idempotency/staleness indexes. |
| `convex/lib/paymentTypes.ts` | Modify | Add `closer_side_deal` and `admin_side_deal` to commissionable/payment origin validators and derived types. |

---

### 1B - Source Normalization + Lifecycle Activity Helper

**Type:** Backend
**Parallelizable:** Yes - depends on 1A generated types, but touches only new helper files and can run alongside 1C/1D.

**What:** Create `convex/lib/sideDeals.ts` and `convex/lib/opportunityActivity.ts`.

**Why:** Readers need a single compatibility rule for legacy rows (`undefined` means Calendly), and writers need one helper that keeps `updatedAt`, `latestActivityAt`, and opportunity aggregates synchronized.

**Where:**
- `convex/lib/sideDeals.ts` (new)
- `convex/lib/opportunityActivity.ts` (new)

**How:**

**Step 1: Add side-deal normalization utilities.**

```typescript
// Path: convex/lib/sideDeals.ts
import type { Doc } from "../_generated/dataModel";
import type { CommissionableOrigin } from "./paymentTypes";

export type OpportunitySource = "calendly" | "side_deal";

export function normalizeOpportunitySource(
  opportunity: Pick<Doc<"opportunities">, "source">,
): OpportunitySource {
  return opportunity.source ?? "calendly";
}

export function isSideDeal(
  opportunity: Pick<Doc<"opportunities">, "source">,
): boolean {
  return normalizeOpportunitySource(opportunity) === "side_deal";
}

const SIDE_DEAL_ORIGINS: ReadonlySet<CommissionableOrigin> = new Set([
  "closer_side_deal",
  "admin_side_deal",
]);

export function isSideDealOrigin(origin: string | undefined | null): boolean {
  return origin !== undefined && origin !== null
    ? SIDE_DEAL_ORIGINS.has(origin as CommissionableOrigin)
    : false;
}
```

**Step 2: Add the lifecycle patch helper.**

```typescript
// Path: convex/lib/opportunityActivity.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { replaceOpportunityAggregate } from "../reporting/writeHooks";

export function computeLatestActivityAt(
  opportunity: Pick<
    Doc<"opportunities">,
    "paymentReceivedAt" | "lostAt" | "latestMeetingAt" | "updatedAt" | "createdAt"
  >,
): number {
  return Math.max(
    opportunity.paymentReceivedAt ?? 0,
    opportunity.lostAt ?? 0,
    opportunity.latestMeetingAt ?? 0,
    opportunity.updatedAt,
    opportunity.createdAt,
  );
}

export async function patchOpportunityLifecycle(
  ctx: MutationCtx,
  opportunityId: Id<"opportunities">,
  patch: Partial<Doc<"opportunities">>,
): Promise<Doc<"opportunities">> {
  const before = await ctx.db.get(opportunityId);
  if (!before) {
    throw new Error("Opportunity not found");
  }

  const updatedAt = patch.updatedAt ?? Date.now();
  const nextShape = { ...before, ...patch, updatedAt };
  await ctx.db.patch(opportunityId, {
    ...patch,
    updatedAt,
    latestActivityAt: computeLatestActivityAt(nextShape),
  });

  if (
    patch.status !== undefined ||
    patch.latestMeetingId !== undefined ||
    patch.nextMeetingId !== undefined ||
    patch.paymentReceivedAt !== undefined ||
    patch.lostAt !== undefined
  ) {
    return await replaceOpportunityAggregate(ctx, before, opportunityId);
  }

  const after = await ctx.db.get(opportunityId);
  if (!after) {
    throw new Error("Opportunity not found after patch");
  }
  return after;
}
```

**Key implementation notes:**
- `computeLatestActivityAt` uses `Math.max`, not nullish coalescing order, so a late lost/payment timestamp beats an older meeting timestamp.
- The helper calls `replaceOpportunityAggregate` only for lifecycle-affecting patches. Pure assignment changes can still use direct `ctx.db.patch` if they do not affect list ordering, but reviewers should require an explicit rationale.
- Keep the helper in `convex/lib/` because Phase 2 side-deal mutations and existing Calendly writers both need it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/sideDeals.ts` | Create | Source/origin normalization used by list/detail/reporting logic. |
| `convex/lib/opportunityActivity.ts` | Create | Central opportunity lifecycle patch helper. |

---

### 1C - Existing Opportunity Writer Compliance

**Type:** Backend
**Parallelizable:** Yes - depends on 1A and 1B, but can be split by module directory across multiple backend owners.

**What:** Update every existing Calendly/meeting/reminder/payment writer that inserts or patches opportunity lifecycle fields so it writes `source` and keeps `latestActivityAt` current.

**Why:** The Opportunities list sorts by `latestActivityAt`. If existing flows keep patching only `status` or meeting refs, Calendly opportunities will drift and list ordering becomes wrong immediately after the backfill.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify)
- `convex/lib/opportunityMeetingRefs.ts` (modify)
- `convex/pipeline/inviteeCanceled.ts` (modify)
- `convex/pipeline/inviteeNoShow.ts` (modify)
- `convex/closer/payments.ts` (modify)
- `convex/closer/meetingActions.ts` (modify)
- `convex/admin/meetingActions.ts` (modify)
- `convex/closer/followUpMutations.ts` (modify)
- `convex/closer/noShowActions.ts` (modify)
- `convex/closer/meetingOverrun.ts` (modify)
- `convex/closer/reminderOutcomes.ts` (modify)
- `convex/customers/mutations.ts` (review/modify)
- `convex/lib/outcomeHelpers.ts` (review/modify)
- `convex/opportunities/maintenance.ts` (review/modify)
- `convex/leads/merge.ts` (review/modify)
- `convex/reviews/mutations.ts` (modify)
- `convex/unavailability/redistribution.ts` (review/modify only where lifecycle fields change)

**How:**

**Step 1: Set source/activity on Calendly-created opportunities.**

```typescript
// Path: convex/pipeline/inviteeCreated.ts
opportunityId = await ctx.db.insert("opportunities", {
  tenantId,
  leadId,
  assignedCloserId,
  hostCalendlyUserUri,
  hostCalendlyEmail,
  hostCalendlyName,
  eventTypeConfigId,
  status: "scheduled",
  source: "calendly",
  calendlyEventUri,
  latestActivityAt: now,
  createdAt: now,
  updatedAt: now,
  utmParams,
});
```

**Step 2: Update denormalized meeting ref helper to preserve activity ordering.**

```typescript
// Path: convex/lib/opportunityMeetingRefs.ts
import { computeLatestActivityAt } from "./opportunityActivity";

// Inside the existing patch block, after computing latest/next meeting refs:
const nextOpportunity = {
  ...opportunity,
  latestMeetingId: latestMeeting?._id,
  latestMeetingAt: latestMeeting?.scheduledAt,
  nextMeetingId: nextMeeting?._id,
  nextMeetingAt: nextMeeting?.scheduledAt,
  updatedAt: now,
};

await ctx.db.patch(opportunityId, {
  latestMeetingId: latestMeeting?._id,
  latestMeetingAt: latestMeeting?.scheduledAt,
  nextMeetingId: nextMeeting?._id,
  nextMeetingAt: nextMeeting?.scheduledAt,
  updatedAt: now,
  latestActivityAt: computeLatestActivityAt(nextOpportunity),
});
```

**Step 3: Replace direct status patches with `patchOpportunityLifecycle`.**

```typescript
// Path: convex/closer/payments.ts
import { patchOpportunityLifecycle } from "../lib/opportunityActivity";

// Replace:
await ctx.db.patch(args.opportunityId, {
  status: "payment_received",
  paymentReceivedAt: now,
  updatedAt: now,
});
await replaceOpportunityAggregate(ctx, opportunity, args.opportunityId);

// With:
await patchOpportunityLifecycle(ctx, args.opportunityId, {
  status: "payment_received",
  paymentReceivedAt: now,
  updatedAt: now,
});
```

**Step 4: Inventory and review every direct lifecycle patch.**

```bash
# Path: repo root
rg -n "ctx\\.db\\.patch\\([^\\n]*(opportunity|args\\.opportunityId|opportunityId)|status: \\\"" convex
```

Each result must land in one of these buckets:
- converted to `patchOpportunityLifecycle`;
- proven not to patch an opportunity document;
- assignment-only patch that leaves lifecycle/activity fields untouched;
- lead merge / maintenance patch that intentionally changes only foreign keys or archival metadata;
- migration/admin script outside runtime path, documented in the phase PR.

**Key implementation notes:**
- Do not blanket-replace `ctx.db.patch` in admin migration scripts. Runtime correctness matters here; migration utilities can be documented separately.
- `patchOpportunityLifecycle` already replaces the opportunity aggregate, so remove duplicate `replaceOpportunityAggregate` calls at each converted site.
- `unavailability/redistribution.ts` reassigns closers. If it only patches `assignedCloserId`, preserve existing semantics and do not bump `latestActivityAt` unless the business action should surface as recent activity.
- `opportunities/maintenance.ts` and `leads/merge.ts` may contain operational cleanup or merge-only patches. They still need explicit review because accidental status/lifecycle writes there will bypass `latestActivityAt` and aggregate replacement.
- `customers/mutations.ts` and `lib/outcomeHelpers.ts` are payment/conversion-adjacent. Convert opportunity lifecycle writes if present; otherwise document that their status patches target non-opportunity tables.
- Existing tests are sparse, so the reviewer checklist and `rg` inventory are part of the acceptance gate.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | New Calendly opportunities write `source` and `latestActivityAt`. |
| `convex/lib/opportunityMeetingRefs.ts` | Modify | Meeting ref updates keep `latestActivityAt` current. |
| `convex/pipeline/inviteeCanceled.ts` | Modify | Use lifecycle helper for cancel status patches. |
| `convex/pipeline/inviteeNoShow.ts` | Modify | Use lifecycle helper for no-show status patches. |
| `convex/closer/payments.ts` | Modify | Use lifecycle helper for payment-received transition. |
| `convex/closer/meetingActions.ts` | Modify | Use lifecycle helper for meeting outcome transitions. |
| `convex/admin/meetingActions.ts` | Modify | Same as closer, admin path. |
| `convex/closer/followUpMutations.ts` | Modify | Use lifecycle helper for follow-up scheduling state. |
| `convex/closer/noShowActions.ts` | Modify | Use lifecycle helper for no-show outcomes. |
| `convex/closer/meetingOverrun.ts` | Modify | Use lifecycle helper for overrun transitions. |
| `convex/closer/reminderOutcomes.ts` | Modify | Use lifecycle helper for reminder payment/lost/no-response outcomes. |
| `convex/customers/mutations.ts` | Review / Modify | Payment/conversion-adjacent; convert opportunity lifecycle writes if present. |
| `convex/lib/outcomeHelpers.ts` | Review / Modify | Shared outcome helpers; verify status patches do not bypass opportunity lifecycle helper. |
| `convex/opportunities/maintenance.ts` | Review / Modify | Maintenance patches must preserve lifecycle/activity invariants. |
| `convex/leads/merge.ts` | Review / Modify | Merge rewrites must not leave opportunity aggregate/activity stale. |
| `convex/reviews/mutations.ts` | Modify | Use lifecycle helper for review resolution status patches. |
| `convex/unavailability/redistribution.ts` | Modify / Review | Preserve activity timestamp for assignment-only patches unless explicitly changing lifecycle. |

---

### 1D - Backfill Migration Definition

**Type:** Backend
**Parallelizable:** Yes - depends on 1A but only touches `convex/migrations.ts`.

**What:** Add an idempotent `@convex-dev/migrations` migration to backfill legacy opportunities.

**Why:** The eventual narrow deploy requires all rows to have `source` and `latestActivityAt`. The list page also needs those fields before it can rely on the new indexes.

**Where:**
- `convex/migrations.ts` (modify)

**How:**

**Step 1: Append the migration definition.**

```typescript
// Path: convex/migrations.ts
export const backfillOpportunitySourceAndActivity = migrations.define({
  table: "opportunities",
  batchSize: 200,
  migrateOne: async (ctx, opportunity) => {
    const patch: Partial<typeof opportunity> = {};

    if (opportunity.source === undefined) {
      patch.source = "calendly";
    }

    if (opportunity.latestActivityAt === undefined) {
      patch.latestActivityAt = Math.max(
        opportunity.paymentReceivedAt ?? 0,
        opportunity.lostAt ?? 0,
        opportunity.latestMeetingAt ?? 0,
        opportunity.updatedAt,
        opportunity.createdAt,
      );
    }

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(opportunity._id, patch);
    }
  },
});
```

**Step 2: Add run commands to the phase PR description or ops notes.**

```bash
# Path: repo root
npx convex run migrations:run '{"name":"backfillOpportunitySourceAndActivity","dryRun":true}'
npx convex run migrations:run '{"name":"backfillOpportunitySourceAndActivity"}'
```

**Key implementation notes:**
- The exact CLI argument shape can vary by migrations component version. Confirm with the current `@convex-dev/migrations` docs before execution; do not guess in production.
- The migration must be safe while webhooks continue writing. 1C ensures new rows already write both fields.
- Use `batchSize: 200` to keep the migration small for the one-tenant production dataset while remaining safe if dev data grows.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations.ts` | Modify | Append idempotent opportunity source/activity backfill. |

---

### 1E - Migration Execution + Verification

**Type:** Manual / Backend
**Parallelizable:** No - run after 1B/1C/1D are merged and deployed so no new legacy-shaped rows are created during backfill.

**What:** Run dry run, execute the migration, and verify no rows remain with missing source/activity fields.

**Why:** Later phases will query by `source` and `latestActivityAt`. Missing values produce invisible rows or incorrect order in indexed pagination.

**Where:**
- Convex dashboard / CLI (manual)
- `plans/side-deals/phases/phase1.md` (modify if execution notes discover command differences)

**How:**

**Step 1: Dry run and capture output.**

```bash
# Path: repo root
npx convex run migrations:run '{"name":"backfillOpportunitySourceAndActivity","dryRun":true}'
```

**Step 2: Execute against dev, then production once dev looks correct.**

```bash
# Path: repo root
npx convex run migrations:run '{"name":"backfillOpportunitySourceAndActivity"}'
npx convex run --prod migrations:run '{"name":"backfillOpportunitySourceAndActivity"}'
```

**Step 3: Add a temporary admin verification query or use dashboard filters.**

```typescript
// Path: convex/admin/migrations.ts
export const verifyOpportunitySourceAndActivityBackfill = query({
  args: {},
  handler: async (ctx) => {
    await requireSystemAdminSession(await ctx.auth.getUserIdentity());
    let missingSource = 0;
    let missingLatestActivityAt = 0;
    for await (const opportunity of ctx.db.query("opportunities")) {
      if (opportunity.source === undefined) missingSource += 1;
      if (opportunity.latestActivityAt === undefined) missingLatestActivityAt += 1;
    }
    return { missingSource, missingLatestActivityAt };
  },
});
```

**Key implementation notes:**
- If a temporary verification query is added, remove it before the narrow deploy unless it becomes part of the permanent admin migration toolkit.
- Do not narrow on the same deploy as the backfill. Observe at least one successful production deploy cycle first.
- Keep screenshots/logs of dry run and production execution in the PR or release notes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/admin/migrations.ts` | Modify / Optional | Temporary verification query if dashboard filtering is insufficient. |
| `plans/side-deals/phases/phase1.md` | Modify / Optional | Record the exact migration command syntax used if it differs from this plan. |

---

### 1F - Narrow-Deploy Runbook

**Type:** Manual / Backend
**Parallelizable:** No - only starts after 1E proves all environments have zero missing fields.

**What:** Document the follow-up deploy that changes `source` and `latestActivityAt` from optional to required.

**Why:** The feature should not permanently carry legacy compatibility once the backfill is proven. Narrowing tightens the data contract and removes a class of list-page edge cases.

**Where:**
- `convex/schema.ts` (future modify, not in this phase)
- `convex/lib/sideDeals.ts` (future simplify, optional)

**How:**

**Step 1: Prepare a follow-up PR after production verification.**

```typescript
// Path: convex/schema.ts
source: v.union(v.literal("calendly"), v.literal("side_deal")),
latestActivityAt: v.number(),
manualCreationKey: v.optional(v.string()),
```

**Step 2: Keep `normalizeOpportunitySource()` until every query has been audited.**

```typescript
// Path: convex/lib/sideDeals.ts
export function normalizeOpportunitySource(
  opportunity: Pick<Doc<"opportunities">, "source">,
): OpportunitySource {
  return opportunity.source;
}
```

**Step 3: Run final verification.**

```bash
# Path: repo root
npx convex dev
pnpm tsc --noEmit
pnpm lint
```

**Key implementation notes:**
- The narrow deploy is intentionally deferred. Do not merge it with the widen/backfill PR.
- `manualCreationKey` stays optional forever.
- If any environment still has missing values, abort narrowing and rerun 1E.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Future Modify | Narrow `source` and `latestActivityAt` only after verified backfill. |
| `convex/lib/sideDeals.ts` | Future Modify | Optional simplification once legacy rows are impossible. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/paymentTypes.ts` | Modify | 1A |
| `convex/lib/sideDeals.ts` | Create | 1B |
| `convex/lib/opportunityActivity.ts` | Create | 1B |
| `convex/pipeline/inviteeCreated.ts` | Modify | 1C |
| `convex/lib/opportunityMeetingRefs.ts` | Modify | 1C |
| `convex/pipeline/inviteeCanceled.ts` | Modify | 1C |
| `convex/pipeline/inviteeNoShow.ts` | Modify | 1C |
| `convex/closer/payments.ts` | Modify | 1C |
| `convex/closer/meetingActions.ts` | Modify | 1C |
| `convex/admin/meetingActions.ts` | Modify | 1C |
| `convex/closer/followUpMutations.ts` | Modify | 1C |
| `convex/closer/noShowActions.ts` | Modify | 1C |
| `convex/closer/meetingOverrun.ts` | Modify | 1C |
| `convex/closer/reminderOutcomes.ts` | Modify | 1C |
| `convex/customers/mutations.ts` | Review / Modify | 1C |
| `convex/lib/outcomeHelpers.ts` | Review / Modify | 1C |
| `convex/opportunities/maintenance.ts` | Review / Modify | 1C |
| `convex/leads/merge.ts` | Review / Modify | 1C |
| `convex/reviews/mutations.ts` | Modify | 1C |
| `convex/unavailability/redistribution.ts` | Modify / Review | 1C |
| `convex/migrations.ts` | Modify | 1D |
| `convex/admin/migrations.ts` | Modify / Optional | 1E |
