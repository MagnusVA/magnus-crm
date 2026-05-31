# Phase 1 — Entity Search Projection and Query Facade

**Goal:** Add the tenant-scoped `leadCustomerSearchRows` projection, backfill it safely, keep it current from existing write paths, and expose one bounded Convex facade for list, search, direct ID resolution, redirect lookup, and entity detail payloads.

**Prerequisite:** Phase 0 complete. `convex/_generated/ai/guidelines.md` has been read before touching Convex code. The existing `@convex-dev/migrations` component in `convex/migrations.ts` is available. Old routes and navigation remain unchanged during this phase.

**Runs in PARALLEL with:** Phase 2 UI scaffolding can begin after 1A and 1E publish stable API names and DTO shapes. Phase 3 detail UI can begin after 1F publishes the entity detail payload contract. No later phase should depend on production search behavior until 1C backfill and assertion pass.

**Skills to invoke:**
- `convex-migration-helper` — required for the projection backfill and assertion migration.
- `convex-performance-audit` — verify search/list/detail reads stay indexed, bounded, and free of `.filter()` database filtering.
- `next-best-practices` — later RSC preloading and redirect shims consume these public Convex functions.

> **Critical path:** This phase is on the critical path. Phase 2 can build against stubs after the query contract is stable, but Phase 5 rollout cannot proceed until schema, backfill, projection maintenance, and assertion all pass in the production test tenant.

**Acceptance Criteria:**
1. `convex/schema.ts` includes `leadCustomerSearchRows` with tenant-first indexes and `search_lead_customer_entities`.
2. `npx convex dev --once` or the team's Convex schema generation command succeeds after the new schema and validators are added.
3. `convex/leadCustomers/projection.ts` can rebuild or upsert exactly one projection row for a tenant lead without accepting `tenantId` from a client argument.
4. The backfill migration creates one projection row per existing lead and the assertion migration verifies tenant, lead, lifecycle, visibility, and customer linkage consistency.
5. Existing lead, customer, opportunity, meeting-reference, payment-summary, identifier, and merge write paths call the projection rebuild helper or intentionally document why a follow-up rebuild is unnecessary.
6. `api.leadCustomers.queries.searchEntities` returns at most 50 tenant-scoped rows, resolves direct lead/customer/opportunity/meeting IDs before full-text search, and does not leak cross-tenant existence.
7. `api.leadCustomers.queries.listEntities` paginates through visible rows with indexed lifecycle filtering and no client-side database filtering.
8. `api.leadCustomers.detail.getEntityDetail` returns a bounded detail payload with permission metadata for related opportunities/meetings and no unbounded `.collect()`.
9. Projection logs use structured counts and IDs only; they do not log names, emails, phone numbers, social handles, raw search terms, or payment references.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (validators + schema) ───────────────┬── 1B (projection builder/upsert) ───────┬── 1C (migration + assertion)
                                        │                                         │
                                        │                                         ├── 1D (write hook integration)
                                        │                                         │
                                        └── 1E (search/list + ID resolver) ───────┤
                                                                                  │
1B + current detail sources ──────────────────────────────────────────────────────┘
                                                                                  │
                                                    1F (entity detail payload) ───┤
                                                                                  │
1C + 1D + 1E + 1F complete ─────────────────────────────────────────────────────── 1G (backend verification)
```

**Optimal execution:**
1. Complete 1A first because generated types and indexes unblock every other backend subphase.
2. Run 1B and 1E in parallel after 1A. 1B owns projection writes; 1E owns query facade and direct lookup.
3. Start 1F as soon as 1B publishes shared lifecycle/permission helpers. It can reuse existing lead/customer/opportunity query logic while migration work continues.
4. Run 1C after 1B exists; run 1D after 1B exposes a stable rebuild API.
5. Finish with 1G after migration assertion and write hooks are in place.

**Estimated time:** 4-7 days

---

## Subphases

### 1A — Validators, DTOs, and Projection Schema

**Type:** Backend / Migration
**Parallelizable:** No — schema and validators must exist before generated Convex types, projection code, migrations, and public queries compile.

**What:** Add lifecycle/status validators, row DTO types, and the `leadCustomerSearchRows` schema with tenant-first indexes and a search index.

**Why:** The unified workspace needs a single bounded person/entity browse surface. Querying leads, customers, and opportunities independently from the client would duplicate permission/filtering logic and make pagination unreliable.

**Where:**
- `convex/leadCustomers/validators.ts` (new)
- `convex/leadCustomers/types.ts` (new)
- `convex/schema.ts` (modify)

**How:**

**Step 1: Create validators shared by schema and functions.**

```typescript
// Path: convex/leadCustomers/validators.ts
import { v } from "convex/values";

export const leadCustomerLifecycleValidator = v.union(
  v.literal("lead"),
  v.literal("customer"),
  v.literal("merged"),
);

export const leadCustomerLifecycleFilterValidator = v.union(
  v.literal("all"),
  v.literal("lead"),
  v.literal("customer"),
);

export const leadCustomerLeadStatusValidator = v.union(
  v.literal("active"),
  v.literal("converted"),
  v.literal("merged"),
);

export const leadCustomerCustomerStatusValidator = v.union(
  v.literal("active"),
  v.literal("churned"),
  v.literal("paused"),
);
```

**Step 2: Define DTO types for public query return shapes.**

```typescript
// Path: convex/leadCustomers/types.ts
import type { Id } from "../_generated/dataModel";

export type LeadCustomerLifecycle = "lead" | "customer" | "merged";
export type LeadCustomerLifecycleFilter = "all" | "lead" | "customer";

export type LeadCustomerSearchRowDto = {
  _id: Id<"leadCustomerSearchRows">;
  leadId: Id<"leads">;
  customerId?: Id<"customers">;
  lifecycle: LeadCustomerLifecycle;
  displayName: string;
  email?: string;
  phone?: string;
  primaryIdentifier?: string;
  leadStatus: "active" | "converted" | "merged";
  customerStatus?: "active" | "churned" | "paused";
  opportunityCount: number;
  wonOpportunityCount: number;
  meetingCount: number;
  latestMeetingAt?: number;
  latestActivityAt: number;
  firstSeenAt: number;
  convertedAt?: number;
  totalPaidMinor?: number;
  paymentCurrency?: string;
  selectedOpportunityId?: Id<"opportunities">;
  selectedMeetingId?: Id<"meetings">;
};
```

**Step 3: Add the projection table.**

```typescript
// Path: convex/schema.ts
import {
  leadCustomerCustomerStatusValidator,
  leadCustomerLeadStatusValidator,
  leadCustomerLifecycleValidator,
} from "./leadCustomers/validators";

export default defineSchema({
  // ... existing tables ...

  leadCustomerSearchRows: defineTable({
    tenantId: v.id("tenants"),
    leadId: v.id("leads"),
    customerId: v.optional(v.id("customers")),
    lifecycle: leadCustomerLifecycleValidator,
    isSearchVisible: v.boolean(),
    leadStatus: leadCustomerLeadStatusValidator,
    customerStatus: v.optional(leadCustomerCustomerStatusValidator),
    displayName: v.string(),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    primaryIdentifier: v.optional(v.string()),
    searchText: v.string(),
    opportunityCount: v.number(),
    wonOpportunityCount: v.number(),
    meetingCount: v.number(),
    latestMeetingAt: v.optional(v.number()),
    latestActivityAt: v.number(),
    firstSeenAt: v.number(),
    convertedAt: v.optional(v.number()),
    totalPaidMinor: v.optional(v.number()),
    paymentCurrency: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_tenantId_and_leadId", ["tenantId", "leadId"])
    .index("by_tenantId_and_customerId", ["tenantId", "customerId"])
    .index("by_tenantId_and_isSearchVisible_and_latestActivityAt", [
      "tenantId",
      "isSearchVisible",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_isSearchVisible_and_lifecycle_and_latestActivityAt", [
      "tenantId",
      "isSearchVisible",
      "lifecycle",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_leadStatus_and_latestActivityAt", [
      "tenantId",
      "leadStatus",
      "latestActivityAt",
    ])
    .index("by_tenantId_and_customerStatus_and_latestActivityAt", [
      "tenantId",
      "customerStatus",
      "latestActivityAt",
    ])
    .searchIndex("search_lead_customer_entities", {
      searchField: "searchText",
      filterFields: [
        "tenantId",
        "isSearchVisible",
        "lifecycle",
        "leadStatus",
        "customerStatus",
      ],
    }),
});
```

**Step 4: Generate and verify schema types.**

```bash
# Path: terminal
npx convex dev --once
pnpm tsc --noEmit
```

**Key implementation notes:**
- This is a safe schema addition because it creates a new derived table. It still requires a migration/backfill because the UI depends on projection completeness.
- Keep `tenantId` first in every read index and search filter.
- Do not make source-of-truth table changes in this phase unless implementation discovers a hard blocker; any such change must go through a new migration plan.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadCustomers/validators.ts` | Create | Lifecycle/status validators |
| `convex/leadCustomers/types.ts` | Create | Public DTO types |
| `convex/schema.ts` | Modify | Add projection table, indexes, search index |

---

### 1B — Projection Builder and Upsert Helper

**Type:** Backend
**Parallelizable:** Yes — depends on 1A generated types, but independent from public search/list queries.

**What:** Implement a projection builder that derives one row from `leads`, optional `customers`, bounded opportunities, identifiers, meetings, and payment summaries; expose `rebuildLeadCustomerSearchRow`.

**Why:** Every write path and migration needs one canonical place to compute lifecycle, search text, counts, latest activity, and visibility.

**Where:**
- `convex/leadCustomers/projection.ts` (new)
- `convex/leadCustomers/searchText.ts` (new)

**How:**

**Step 1: Build normalized search text without logging PII.**

```typescript
// Path: convex/leadCustomers/searchText.ts
import type { Doc, Id } from "../_generated/dataModel";

function pushValue(parts: string[], value: string | undefined) {
  const trimmed = value?.trim();
  if (trimmed) parts.push(trimmed.toLowerCase());
}

export function buildLeadCustomerSearchText(input: {
  lead: Doc<"leads">;
  customer: Doc<"customers"> | null;
  identifiers: Array<Doc<"leadIdentifiers">>;
  opportunities: Array<Pick<Doc<"opportunities">, "_id" | "manualCreationKey" | "status" | "source" | "firstBookingProgramName" | "soldProgramName">>;
  meetingIds: Array<Id<"meetings">>;
}) {
  const parts: string[] = [];
  pushValue(parts, input.lead._id);
  pushValue(parts, input.lead.fullName);
  pushValue(parts, input.lead.email);
  pushValue(parts, input.lead.phone);
  pushValue(parts, input.customer?._id);
  pushValue(parts, input.customer?.fullName);
  pushValue(parts, input.customer?.email);
  pushValue(parts, input.customer?.phone);

  for (const handle of input.lead.socialHandles ?? []) {
    pushValue(parts, handle.handle);
  }
  for (const identifier of input.identifiers) {
    pushValue(parts, identifier.value);
    pushValue(parts, identifier.rawValue);
  }
  for (const opportunity of input.opportunities) {
    pushValue(parts, opportunity._id);
    pushValue(parts, opportunity.manualCreationKey);
    pushValue(parts, opportunity.status);
    pushValue(parts, opportunity.source);
    pushValue(parts, opportunity.firstBookingProgramName);
    pushValue(parts, opportunity.soldProgramName);
  }
  for (const meetingId of input.meetingIds) {
    pushValue(parts, meetingId);
  }

  return [...new Set(parts)].join(" ");
}
```

**Step 2: Implement the rebuild helper with bounded reads.**

```typescript
// Path: convex/leadCustomers/projection.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { buildLeadCustomerSearchText } from "./searchText";

type ProjectionPatch = Omit<
  Doc<"leadCustomerSearchRows">,
  "_id" | "_creationTime"
>;

function displayNameForLead(lead: Doc<"leads">) {
  return lead.fullName ?? lead.email ?? lead.phone ?? "Unknown lead";
}

function latestActivityFor(lead: Doc<"leads">, opportunities: Doc<"opportunities">[]) {
  return Math.max(
    lead.updatedAt,
    lead.firstSeenAt,
    ...opportunities.map((opportunity) =>
      opportunity.latestActivityAt ??
      opportunity.paymentReceivedAt ??
      opportunity.latestMeetingAt ??
      opportunity.updatedAt ??
      opportunity.createdAt,
    ),
  );
}

export async function rebuildLeadCustomerSearchRow(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const lead = await ctx.db.get(leadId);
  if (!lead || lead.tenantId !== tenantId) return;

  const [customer, identifiers, opportunities] = await Promise.all([
    ctx.db
      .query("customers")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .first(),
    ctx.db
      .query("leadIdentifiers")
      .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
      .take(100),
    ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", leadId),
      )
      .order("desc")
      .take(100),
  ]);

  const meetingIds = opportunities.flatMap((opportunity) =>
    [opportunity.latestMeetingId, opportunity.nextMeetingId, opportunity.firstMeetingId]
      .filter((id): id is Id<"meetings"> => id !== undefined),
  );
  const lifecycle = lead.status === "merged" ? "merged" : customer ? "customer" : "lead";
  const row: ProjectionPatch = {
    tenantId,
    leadId,
    customerId: customer?._id,
    lifecycle,
    isSearchVisible: lifecycle !== "merged",
    leadStatus: lead.status,
    customerStatus: customer?.status,
    displayName: customer?.fullName ?? displayNameForLead(lead),
    email: customer?.email ?? lead.email,
    phone: customer?.phone ?? lead.phone,
    primaryIdentifier: identifiers[0]?.rawValue ?? lead.socialHandles?.[0]?.handle,
    searchText: buildLeadCustomerSearchText({
      lead,
      customer,
      identifiers,
      opportunities,
      meetingIds,
    }),
    opportunityCount: opportunities.length,
    wonOpportunityCount: opportunities.filter(
      (opportunity) => opportunity.status === "payment_received",
    ).length,
    meetingCount: meetingIds.length,
    latestMeetingAt: Math.max(
      0,
      ...opportunities.flatMap((opportunity) =>
        [opportunity.latestMeetingAt, opportunity.nextMeetingAt, opportunity.firstMeetingAt]
          .filter((value): value is number => value !== undefined),
      ),
    ) || undefined,
    latestActivityAt: latestActivityFor(lead, opportunities),
    firstSeenAt: lead.firstSeenAt,
    convertedAt: customer?.convertedAt,
    totalPaidMinor: customer?.totalPaidMinor,
    paymentCurrency: customer?.paymentCurrency,
    updatedAt: Date.now(),
  };

  const existing = await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, row);
  } else {
    await ctx.db.insert("leadCustomerSearchRows", row);
  }

  console.log("[LeadCustomers:Projection] rebuilt row", {
    tenantId,
    leadId,
    lifecycle,
    opportunityCount: row.opportunityCount,
    meetingCount: row.meetingCount,
  });
}
```

**Step 3: Add repair helpers for merged or missing leads if needed.**

```typescript
// Path: convex/leadCustomers/projection.ts
export async function hideProjectionRowForMissingLead(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  const existing = await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();

  if (existing) {
    await ctx.db.patch(existing._id, {
      lifecycle: "merged",
      isSearchVisible: false,
      updatedAt: Date.now(),
    });
  }
}
```

**Key implementation notes:**
- `rebuildLeadCustomerSearchRow` is a plain helper, not a public mutation; callers already have tenant context.
- Keep opportunity and identifier reads capped. The projection is for browse/search summaries, not full history.
- `meetingCount` derived from denormalized refs may be approximate for high-history entities; detail payload carries capped section metadata later.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadCustomers/projection.ts` | Create | Projection builder/upsert helper |
| `convex/leadCustomers/searchText.ts` | Create | Search text construction |

---

### 1C — Backfill and Assertion Migrations

**Type:** Backend / Migration
**Parallelizable:** Yes — depends on 1B, but can run while 1D and 1F continue in separate files.

**What:** Add `@convex-dev/migrations` definitions to backfill projection rows for every existing lead and assert consistency afterward.

**Why:** New writes will keep projections current, but existing test-tenant data must be populated before the unified search route can be trusted.

**Where:**
- `convex/migrations.ts` (modify)
- `plans/leads-customers-unified-view/projection-migration-runbook.md` (new)

**How:**

**Step 1: Add migration definitions.**

```typescript
// Path: convex/migrations.ts
import { rebuildLeadCustomerSearchRow } from "./leadCustomers/projection";

export const backfillLeadCustomerSearchRows = migrations.define({
  table: "leads",
  batchSize: 100,
  migrateOne: async (ctx, lead) => {
    await rebuildLeadCustomerSearchRow(ctx, lead.tenantId, lead._id);
  },
});

export const assertLeadCustomerSearchRowsBackfilled = migrations.define({
  table: "leads",
  batchSize: 100,
  migrateOne: async (ctx, lead) => {
    const row = await ctx.db
      .query("leadCustomerSearchRows")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", lead.tenantId).eq("leadId", lead._id),
      )
      .unique();

    if (!row) {
      throw new Error(`Lead ${lead._id} is missing leadCustomerSearchRows row`);
    }
    if (row.tenantId !== lead.tenantId || row.leadId !== lead._id) {
      throw new Error(`Lead ${lead._id} has mismatched projection identity`);
    }
    if (row.leadStatus !== lead.status) {
      throw new Error(`Lead ${lead._id} has stale leadStatus projection`);
    }
    if (row.isSearchVisible !== (row.lifecycle !== "merged")) {
      throw new Error(`Lead ${lead._id} has invalid visibility projection`);
    }
  },
});
```

**Step 2: Create the runbook.**

```markdown
<!-- Path: plans/leads-customers-unified-view/projection-migration-runbook.md -->

# Lead Customer Search Projection Migration Runbook

## Deploy 1 — Widen

1. Deploy schema and projection code.
2. Confirm `npx convex dev --once` succeeds.
3. Confirm no UI route depends on `leadCustomerSearchRows` yet.

## Dry Run

- `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows","dryRun":true}'`

## Run

- `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows"}'`
- `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'`
- `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled"}'`

## Verify

- Projection count matches lead count for the production test tenant.
- Sample rows from `artifacts/sample-data-matrix.md` match source lead/customer/opportunity state.
- Convex logs contain `[LeadCustomers:Projection]` counts but no PII.
```

**Step 3: Run in dev first, then production test tenant.**

```bash
# Path: terminal
npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows","dryRun":true}'
npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows"}'
npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'
```

**Key implementation notes:**
- The migration is online. Code must tolerate missing projection rows until the assertion passes.
- Do not use `.collect()` to backfill all leads. The migrations component handles batching and resume.
- If assertion fails, fix the projection builder and rerun the backfill before any UI relies on it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/migrations.ts` | Modify | Backfill and assertion definitions |
| `plans/leads-customers-unified-view/projection-migration-runbook.md` | Create | Operational migration steps |

---

### 1D — Projection Maintenance Write Hooks

**Type:** Backend
**Parallelizable:** Yes — depends on 1B helper; independent from public query facade implementation.

**What:** Call `rebuildLeadCustomerSearchRow` from existing write paths that can change identity, lifecycle, opportunity, meeting, payment, or merge state.

**Why:** A projection is only useful if it stays current after the backfill. Missing hooks produce stale search results and incorrect lifecycle badges.

**Where:**
- `convex/leads/mutations.ts` (modify)
- `convex/leads/merge.ts` (modify)
- `convex/leads/identityResolution.ts` (modify)
- `convex/customers/conversion.ts` (modify)
- `convex/customers/mutations.ts` (modify)
- `convex/opportunities/createManual.ts` (modify)
- `convex/lib/opportunityActivity.ts` (modify)
- `convex/lib/opportunityMeetingRefs.ts` (modify)
- `convex/lib/paymentHelpers.ts` (modify)
- `convex/reporting/writeHooks.ts` (modify only if the local write path proves it is the central payment/opportunity side-effect point)

**How:**

**Step 1: Add helper calls after lead identity edits.**

```typescript
// Path: convex/leads/mutations.ts
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";

// Inside the existing mutation after patching lead identity fields:
await ctx.db.patch(leadId, {
  fullName: args.fullName,
  email: args.email,
  phone: args.phone,
  updatedAt: Date.now(),
});
await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
```

**Step 2: Rebuild both source and target after a merge.**

```typescript
// Path: convex/leads/merge.ts
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";

// After source lead is marked merged and target receives identifiers/opportunities:
await rebuildLeadCustomerSearchRow(ctx, tenantId, targetLeadId);
await rebuildLeadCustomerSearchRow(ctx, tenantId, sourceLeadId);
```

**Step 3: Rebuild after customer conversion and payment summary sync.**

```typescript
// Path: convex/customers/conversion.ts
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";

// After customer insert and lead status patch:
await rebuildLeadCustomerSearchRow(ctx, tenantId, leadId);
```

```typescript
// Path: convex/lib/paymentHelpers.ts
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";

// After customer totalPaidMinor / totalPaymentCount / paymentCurrency is patched:
if (customer) {
  await rebuildLeadCustomerSearchRow(ctx, customer.tenantId, customer.leadId);
}
```

**Step 4: Rebuild after opportunity lifecycle and meeting ref updates.**

```typescript
// Path: convex/lib/opportunityActivity.ts
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";

// After patchOpportunityLifecycle writes status/latestActivityAt:
const nextOpportunity = await ctx.db.get(opportunityId);
if (nextOpportunity) {
  await rebuildLeadCustomerSearchRow(ctx, nextOpportunity.tenantId, nextOpportunity.leadId);
}
```

```typescript
// Path: convex/lib/opportunityMeetingRefs.ts
import { rebuildLeadCustomerSearchRow } from "../leadCustomers/projection";

// After denormalized meeting refs are updated:
const opportunity = await ctx.db.get(opportunityId);
if (opportunity) {
  await rebuildLeadCustomerSearchRow(ctx, opportunity.tenantId, opportunity.leadId);
}
```

**Key implementation notes:**
- Put rebuilds after successful source writes, not before.
- Do not create public "rebuild arbitrary lead" mutations for the client. Admin repair can be an internal mutation if needed later.
- If a helper is used in many transactions, watch write cost and OCC conflicts; projection rebuilds should be tied to meaningful state changes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leads/mutations.ts` | Modify | Rebuild after identity edits |
| `convex/leads/merge.ts` | Modify | Rebuild source and target rows |
| `convex/leads/identityResolution.ts` | Modify | Rebuild after identifier changes |
| `convex/customers/conversion.ts` | Modify | Rebuild after conversion |
| `convex/customers/mutations.ts` | Modify | Rebuild after customer status changes |
| `convex/opportunities/createManual.ts` | Modify | Rebuild after side-deal creation |
| `convex/lib/opportunityActivity.ts` | Modify | Rebuild after opportunity lifecycle/activity change |
| `convex/lib/opportunityMeetingRefs.ts` | Modify | Rebuild after meeting refs change |
| `convex/lib/paymentHelpers.ts` | Modify | Rebuild after customer payment summary sync |
| `convex/reporting/writeHooks.ts` | Modify | Add only if this is the local central write hook |

---

### 1E — Search, List, and Direct Identifier Resolution

**Type:** Backend
**Parallelizable:** Yes — depends on 1A; direct lookup can proceed while 1B projection writes are refined.

**What:** Create public query facade functions for paginated browse, full-text search, and operational direct ID resolution.

**Why:** Phase 2 should call one tenant-scoped API instead of stitching together leads, customers, and opportunity search rows in the client.

**Where:**
- `convex/leadCustomers/identifierResolution.ts` (new)
- `convex/leadCustomers/queries.ts` (new)

**How:**

**Step 1: Implement direct ID resolution.**

```typescript
// Path: convex/leadCustomers/identifierResolution.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function getProjectedRowForLead(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  leadId: Id<"leads">,
) {
  return await ctx.db
    .query("leadCustomerSearchRows")
    .withIndex("by_tenantId_and_leadId", (q) =>
      q.eq("tenantId", tenantId).eq("leadId", leadId),
    )
    .unique();
}

export async function resolveDirectEntityIdentifier(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  rawTerm: string,
) {
  const term = rawTerm.trim();

  const leadId = ctx.db.normalizeId("leads", term);
  if (leadId) return await getProjectedRowForLead(ctx, tenantId, leadId);

  const customerId = ctx.db.normalizeId("customers", term);
  if (customerId) {
    const customer = await ctx.db.get(customerId);
    if (customer?.tenantId !== tenantId) return null;
    return await getProjectedRowForLead(ctx, tenantId, customer.leadId);
  }

  const opportunityId = ctx.db.normalizeId("opportunities", term);
  if (opportunityId) {
    const opportunity = await ctx.db.get(opportunityId);
    if (opportunity?.tenantId !== tenantId) return null;
    const row = await getProjectedRowForLead(ctx, tenantId, opportunity.leadId);
    return row ? { ...row, selectedOpportunityId: opportunity._id } : null;
  }

  const meetingId = ctx.db.normalizeId("meetings", term);
  if (meetingId) {
    const meeting = await ctx.db.get(meetingId);
    if (meeting?.tenantId !== tenantId) return null;
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) return null;
    const row = await getProjectedRowForLead(ctx, tenantId, opportunity.leadId);
    return row
      ? { ...row, selectedOpportunityId: opportunity._id, selectedMeetingId: meeting._id }
      : null;
  }

  return null;
}
```

**Step 2: Implement paginated browse.**

```typescript
// Path: convex/leadCustomers/queries.ts
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  leadCustomerLifecycleFilterValidator,
  leadCustomerLifecycleValidator,
} from "./validators";
import { resolveDirectEntityIdentifier } from "./identifierResolution";

export const listEntities = query({
  args: {
    paginationOpts: paginationOptsValidator,
    lifecycle: v.optional(leadCustomerLifecycleFilterValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    if (args.lifecycle && args.lifecycle !== "all") {
      return await ctx.db
        .query("leadCustomerSearchRows")
        .withIndex(
          "by_tenantId_and_isSearchVisible_and_lifecycle_and_latestActivityAt",
          (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("isSearchVisible", true)
              .eq("lifecycle", args.lifecycle),
        )
        .order("desc")
        .paginate(args.paginationOpts);
    }

    return await ctx.db
      .query("leadCustomerSearchRows")
      .withIndex("by_tenantId_and_isSearchVisible_and_latestActivityAt", (q) =>
        q.eq("tenantId", tenantId).eq("isSearchVisible", true),
      )
      .order("desc")
      .paginate(args.paginationOpts);
  },
});
```

**Step 3: Implement full-text search with direct lookup first.**

```typescript
// Path: convex/leadCustomers/queries.ts
export const searchEntities = query({
  args: {
    searchTerm: v.string(),
    lifecycle: v.optional(leadCustomerLifecycleValidator),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const term = args.searchTerm.trim();
    if (term.length === 0) return [];

    const direct = await resolveDirectEntityIdentifier(ctx, tenantId, term);
    if (direct) return [direct];
    if (term.length < 2) return [];

    return await ctx.db
      .query("leadCustomerSearchRows")
      .withSearchIndex("search_lead_customer_entities", (q) => {
        const scoped = q
          .search("searchText", term)
          .eq("tenantId", tenantId)
          .eq("isSearchVisible", true);
        return args.lifecycle ? scoped.eq("lifecycle", args.lifecycle) : scoped;
      })
      .take(50);
  },
});
```

**Key implementation notes:**
- Do not log `searchTerm`.
- Direct lookup returns `null` for cross-tenant IDs; the UI should show "No results" without revealing existence.
- Keep lifecycle filter values aligned with Phase 2 URL params.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadCustomers/identifierResolution.ts` | Create | Direct lead/customer/opportunity/meeting ID lookup |
| `convex/leadCustomers/queries.ts` | Create | `listEntities`, `searchEntities` |

---

### 1F — Entity Detail Payload Contract

**Type:** Backend
**Parallelizable:** Yes — can begin after 1A and current detail source functions are understood; it does not depend on migration completion.

**What:** Add `api.leadCustomers.detail.getEntityDetail` and helper builders for a bounded, lead-centric detail payload.

**Why:** Phase 3 needs one preloaded page payload that includes the high-value sections directly on the page while preserving role-specific resource guards.

**Where:**
- `convex/leadCustomers/detail.ts` (new)
- `convex/leadCustomers/detailPayload.ts` (new)
- `convex/leadCustomers/permissions.ts` (new)
- `convex/leadCustomers/activity.ts` (new)

**How:**

**Step 1: Add related-record permission helpers.**

```typescript
// Path: convex/leadCustomers/permissions.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { CrmRole } from "../lib/roleMapping";

export function canOpenOpportunityDetail(input: {
  viewerUserId: Id<"users">;
  viewerRole: CrmRole;
  opportunity: Doc<"opportunities">;
}) {
  if (input.viewerRole === "tenant_master" || input.viewerRole === "tenant_admin") {
    return true;
  }
  return input.opportunity.assignedCloserId === input.viewerUserId;
}
```

**Step 2: Implement the public detail query.**

```typescript
// Path: convex/leadCustomers/detail.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { buildEntityDetailPayload } from "./detailPayload";
import { canOpenOpportunityDetail } from "./permissions";

export const getEntityDetail = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }) => {
    const { tenantId, userId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
      "closer",
    ]);

    const lead = await ctx.db.get(leadId);
    if (!lead || lead.tenantId !== tenantId) return null;

    if (lead.status === "merged" && lead.mergedIntoLeadId) {
      return { kind: "redirect", leadId: lead.mergedIntoLeadId } as const;
    }

    const [customer, opportunities, identifiers] = await Promise.all([
      ctx.db
        .query("customers")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .first(),
      ctx.db
        .query("opportunities")
        .withIndex("by_tenantId_and_leadId", (q) =>
          q.eq("tenantId", tenantId).eq("leadId", leadId),
        )
        .order("desc")
        .take(50),
      ctx.db
        .query("leadIdentifiers")
        .withIndex("by_leadId", (q) => q.eq("leadId", leadId))
        .order("desc")
        .take(100),
    ]);

    return await buildEntityDetailPayload(ctx, {
      tenantId,
      viewerUserId: userId,
      viewerRole: role,
      lead,
      customer,
      identifiers,
      opportunities: opportunities.map((opportunity) => ({
        opportunity,
        permissions: {
          canOpenDetail: canOpenOpportunityDetail({
            viewerUserId: userId,
            viewerRole: role,
            opportunity,
          }),
        },
      })),
    });
  },
});
```

**Step 3: Build bounded section payloads.**

```typescript
// Path: convex/leadCustomers/detailPayload.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { CrmRole } from "../lib/roleMapping";

const MAX_MEETINGS = 50;
const MAX_COMMENTS_PER_MEETING = 5;
const MAX_TOTAL_COMMENTS = 250;
const MAX_PAYMENTS = 50;
const MAX_ACTIVITY = 75;

export async function buildEntityDetailPayload(
  ctx: QueryCtx,
  input: {
    tenantId: Id<"tenants">;
    viewerUserId: Id<"users">;
    viewerRole: CrmRole;
    lead: Doc<"leads">;
    customer: Doc<"customers"> | null;
    identifiers: Doc<"leadIdentifiers">[];
    opportunities: Array<{
      opportunity: Doc<"opportunities">;
      permissions: { canOpenDetail: boolean };
    }>;
  },
) {
  const opportunityIds = input.opportunities.map(({ opportunity }) => opportunity._id);
  const meetingBatches = await Promise.all(
    opportunityIds.map((opportunityId) =>
      ctx.db
        .query("meetings")
        .withIndex("by_opportunityId_and_scheduledAt", (q) =>
          q.eq("opportunityId", opportunityId),
        )
        .order("desc")
        .take(MAX_MEETINGS),
    ),
  );
  const meetings = meetingBatches.flat().slice(0, MAX_MEETINGS);
  const allowedMeetingIds = new Set(
    meetings
      .filter((meeting) =>
        input.viewerRole === "tenant_master" ||
        input.viewerRole === "tenant_admin" ||
        meeting.assignedCloserId === input.viewerUserId,
      )
      .map((meeting) => meeting._id),
  );

  const commentsNested = await Promise.all(
    meetings.slice(0, MAX_MEETINGS).map(async (meeting) => {
      if (!allowedMeetingIds.has(meeting._id)) return [];
      return await ctx.db
        .query("meetingComments")
        .withIndex("by_meetingId_and_createdAt", (q) => q.eq("meetingId", meeting._id))
        .order("desc")
        .take(MAX_COMMENTS_PER_MEETING);
    }),
  );
  const activeComments = commentsNested
    .flat()
    .filter((comment) => comment.deletedAt === undefined)
    .slice(0, MAX_TOTAL_COMMENTS);

  const payments = input.customer
    ? await ctx.db
        .query("paymentRecords")
        .withIndex("by_customerId_and_recordedAt", (q) =>
          q.eq("customerId", input.customer!._id),
        )
        .order("desc")
        .take(MAX_PAYMENTS)
    : [];

  return {
    kind: "detail" as const,
    lead: input.lead,
    customer: input.customer,
    identifiers: input.identifiers,
    opportunities: input.opportunities,
    meetings,
    comments: activeComments,
    payments,
    activity: [], // Filled by `convex/leadCustomers/activity.ts` in the same subphase.
    caps: {
      opportunities: input.opportunities.length >= 50,
      meetings: meetings.length >= MAX_MEETINGS,
      comments: activeComments.length >= MAX_TOTAL_COMMENTS,
      payments: payments.length >= MAX_PAYMENTS,
      activity: false,
      maxActivity: MAX_ACTIVITY,
    },
  };
}
```

**Step 4: Add activity event composition.**

```typescript
// Path: convex/leadCustomers/activity.ts
import type { Doc } from "../_generated/dataModel";

export function buildEntityActivity(input: {
  lead: Doc<"leads">;
  customer: Doc<"customers"> | null;
  opportunities: Doc<"opportunities">[];
  meetings: Doc<"meetings">[];
  payments: Doc<"paymentRecords">[];
}) {
  return [
    ...input.opportunities.map((opportunity) => ({
      kind: "opportunity_status" as const,
      at: opportunity.latestActivityAt ?? opportunity.updatedAt,
      opportunityId: opportunity._id,
      status: opportunity.status,
    })),
    ...input.meetings.map((meeting) => ({
      kind: "meeting" as const,
      at: meeting.scheduledAt,
      meetingId: meeting._id,
      status: meeting.status,
    })),
    ...input.payments.map((payment) => ({
      kind: "payment" as const,
      at: payment.recordedAt,
      paymentId: payment._id,
      amountMinor: payment.amountMinor,
      currency: payment.currency,
    })),
  ].sort((left, right) => right.at - left.at).slice(0, 75);
}
```

**Key implementation notes:**
- Return `null` for not found/cross-tenant, and a redirect variant for merged leads. Phase 3 route can decide whether to `notFound()` or `redirect()`.
- Do not expose unassigned closer comments/payments through the entity payload.
- Avoid calling public Convex queries from this query; extract reusable logic into helpers instead.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadCustomers/detail.ts` | Create | Public entity detail query |
| `convex/leadCustomers/detailPayload.ts` | Create | Bounded payload builder |
| `convex/leadCustomers/permissions.ts` | Create | Per-related-record permission metadata |
| `convex/leadCustomers/activity.ts` | Create | Activity timeline builder |

---

### 1G — Backend Verification and Performance Review

**Type:** Backend / Manual QA
**Parallelizable:** No — depends on 1C, 1D, 1E, and 1F.

**What:** Verify generated types, migration status, projection completeness, query bounds, and no-PII logging before frontend phases depend on the backend.

**Why:** Projection bugs are expensive to discover from UI QA. This gate confirms the derived table and facade are trustworthy.

**Where:**
- `plans/leads-customers-unified-view/phase1-verification.md` (new)
- Convex logs/dashboard (read)
- Production test tenant data (read)

**How:**

**Step 1: Record automated checks.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase1-verification.md -->

# Phase 1 Verification — Entity Projection and Query Facade

| Check | Command | Result |
|---|---|---|
| TypeScript | `pnpm tsc --noEmit` | TBD |
| Convex schema/codegen | `npx convex dev --once` | TBD |
| Backfill dry run | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows","dryRun":true}'` | TBD |
| Assertion dry run | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'` | TBD |
```

**Step 2: Verify sample rows.**

```bash
# Path: terminal
npx convex run leadCustomers/queries:searchEntities '{"searchTerm":"<redacted-id-or-test-term>"}'
npx convex run leadCustomers/queries:listEntities '{"paginationOpts":{"numItems":25,"cursor":null},"lifecycle":"all"}'
```

**Step 3: Run a read-cost review.**

```markdown
<!-- Path: plans/leads-customers-unified-view/phase1-verification.md -->

## Performance Review

- [ ] `searchEntities` uses `withSearchIndex` after direct ID lookup.
- [ ] `listEntities` uses tenant-first indexes before pagination.
- [ ] `getEntityDetail` caps identifiers, opportunities, meetings, comments, payments, and activity.
- [ ] No new public query uses `.filter()` for database filtering.
- [ ] No new query uses `.collect()` without a hard proof of small table size.
```

**Key implementation notes:**
- If Convex insights flags read amplification in detail payload construction, split the payload or reduce inline comment bounds before frontend work proceeds.
- Keep verification evidence redacted.
- This subphase does not flip navigation or redirects.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/phase1-verification.md` | Create | Backend gate evidence |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/leadCustomers/validators.ts` | Create | 1A |
| `convex/leadCustomers/types.ts` | Create | 1A |
| `convex/schema.ts` | Modify | 1A |
| `convex/leadCustomers/projection.ts` | Create | 1B |
| `convex/leadCustomers/searchText.ts` | Create | 1B |
| `convex/migrations.ts` | Modify | 1C |
| `plans/leads-customers-unified-view/projection-migration-runbook.md` | Create | 1C |
| `convex/leads/mutations.ts` | Modify | 1D |
| `convex/leads/merge.ts` | Modify | 1D |
| `convex/leads/identityResolution.ts` | Modify | 1D |
| `convex/customers/conversion.ts` | Modify | 1D |
| `convex/customers/mutations.ts` | Modify | 1D |
| `convex/opportunities/createManual.ts` | Modify | 1D |
| `convex/lib/opportunityActivity.ts` | Modify | 1D |
| `convex/lib/opportunityMeetingRefs.ts` | Modify | 1D |
| `convex/lib/paymentHelpers.ts` | Modify | 1D |
| `convex/reporting/writeHooks.ts` | Modify | 1D |
| `convex/leadCustomers/identifierResolution.ts` | Create | 1E |
| `convex/leadCustomers/queries.ts` | Create | 1E |
| `convex/leadCustomers/detail.ts` | Create | 1F |
| `convex/leadCustomers/detailPayload.ts` | Create | 1F |
| `convex/leadCustomers/permissions.ts` | Create | 1F |
| `convex/leadCustomers/activity.ts` | Create | 1F |
| `plans/leads-customers-unified-view/phase1-verification.md` | Create | 1G |
