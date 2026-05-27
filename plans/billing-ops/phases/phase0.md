# Phase 0 — Data Audit and Product Lock

**Goal:** Establish the disabled Billing Ops foundation before any workspace route is visible. This phase locks the `verified === billing reviewed` product decision, widens schema safely, adds aggregate/readiness infrastructure, and proves the production test tenant can reconstruct billing context.

**Prerequisite:** `plans/billing-ops/billing-ops-design.md` is accepted for MVP semantics. Do not start route/UI work until the schema widen and disabled tenant gate are deployed.

**Runs in PARALLEL with:** Nothing at phase level. After 0B widens schema and generated Convex types exist, Phase 1 backend guards/types can begin against the disabled gate while 0C-0F continue.

**Skills to invoke:**
- `convex-migration-helper` — required for widen-only schema changes, aggregate backfill, readiness verification, and the optional dedicated billing-review-field branch.
- `convex-performance-audit` — use if audit/readiness checks or aggregate verification show read amplification in Convex insights.
- `design-doc-review` — use before implementation if product reverses the `verified` semantics or asks to store external billing IDs in MVP.

**Acceptance Criteria:**
1. Product has explicitly accepted `paymentRecords.status = "verified"` as Billing-reviewed for MVP, or Phase 0 stops and the dedicated billing review field migration branch is selected.
2. `convex/schema.ts` includes disabled-by-default tenant gating, Billing filter indexes, the Slack contributor timeline index, export audit storage, and a persisted Billing readiness check table.
3. Billing aggregate components are registered in `convex/convex.config.ts` and compile into generated component references.
4. A bounded tenant payment audit query returns status, customer, meeting, registrant, attribution, proof, and historical `verified` diagnostics without unbounded `.collect()`.
5. A system-admin readiness verification records pass/fail metadata before any tenant can be enabled.
6. The enable mutation refuses to set `billingOpsEnabled = true` unless the latest readiness check passed after the latest Billing aggregate backfill.
7. `tenants.billingOpsEnabled` is absent or false for every tenant after deploy.
8. No workspace route, sidebar item, command palette item, or public Billing query exposes Billing Ops during Phase 0.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
0A (Product lock + audit matrix) ───────────┐
                                            ├── 0C (Audit query)
0B (Schema widen + components) ─────────────┼── 0D (Aggregate helpers/backfill)
                                            └── 0E (Readiness persistence + enablement)

0C + 0D + 0E complete ───────────────────────── 0F (Runbook + gate evidence)
```

**Optimal execution:**
1. Start 0A and 0B together. 0A is product/data analysis; 0B is a widen-only schema branch.
2. Start 0C, 0D, and 0E after generated Convex types include the new fields/tables/components.
3. Finish with 0F so the implementation team has exact commands, gate evidence, rollback notes, and go/no-go criteria.

**Estimated time:** 2-3 days

---

## Subphases

### 0A — Product Semantics and Audit Matrix

**Type:** Manual / Backend
**Parallelizable:** Yes — can run alongside 0B because it reads current data and product decisions but does not depend on new schema.

**What:** Lock the MVP review semantics and define the exact data-quality checks that must pass for the production test tenant.

**Why:** Billing Ops reuses `paymentRecords.status = "verified"`. If that status already means something else, every downstream queue, correction, export, and aggregate key is wrong.

**Where:**
- `plans/billing-ops/billing-ops-design.md` (reference only)
- `plans/billing-ops/phases/phase0.md` (new)
- `convex/billing/audit.ts` (new in 0C)

**How:**

**Step 1: Record the product lock before coding.**

```typescript
// Path: convex/billing/types.ts
export type BillingPaymentStatus = "recorded" | "verified" | "disputed";

export type BillingReviewSemantics = {
  needsReviewStatus: "recorded";
  reviewedStatus: "verified";
  invalidRevenueStatus: "disputed";
  reviewedByField: "verifiedByUserId";
  reviewedAtField: "verifiedAt";
};

export const BILLING_REVIEW_SEMANTICS: BillingReviewSemantics = {
  needsReviewStatus: "recorded",
  reviewedStatus: "verified",
  invalidRevenueStatus: "disputed",
  reviewedByField: "verifiedByUserId",
  reviewedAtField: "verifiedAt",
};
```

**Step 2: Define the audit matrix before implementation.**

```typescript
// Path: convex/billing/types.ts
export type BillingAuditMetric =
  | "missingCustomerId"
  | "missingMeetingId"
  | "missingAttributedCloserOnCommissionable"
  | "missingRecordedByUser"
  | "missingProgram"
  | "missingAttributionContext"
  | "existingVerifiedRows"
  | "proofFileRows";
```

**Step 3: Decide up front what blocks enablement.**

Use these blocking rules in the readiness check:

| Finding | Blocks Enablement | Notes |
|---|---:|---|
| Existing `verified` rows with accepted semantics | No | Count them and show them in queue as reviewed. |
| Product rejects `verified` reuse | Yes | Switch to design section 10.8 before Phase 1. |
| Missing `recordedByUserId` live row | Yes | Operators cannot audit who entered the payment. |
| Missing `programId` or unresolved active/archived program label | Yes | Billing export needs program dimension. |
| Missing `customerId` with opportunity/customer fallback available | No | Show diagnostics in detail page. |
| Missing customer and no fallback identity | Product gate | Enable only if billing accepts lead/opportunity-only review. |

**Key implementation notes:**
- Do not silently reinterpret historical `verified` rows. Product must decide whether they are already reviewed.
- The optional dedicated billing-review-field branch is a migration, not a UI tweak. It changes indexes, default filter semantics, and aggregate keys.
- Treat `recorded` and `verified` as active revenue states. Only `disputed` is invalid revenue in existing summaries.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/types.ts` | Create | Shared Billing status and audit DTO types |
| `plans/billing-ops/phases/phase0.md` | Create | Product lock and phase execution plan |

---

### 0B — Widen Schema and Register Components

**Type:** Backend
**Parallelizable:** No — generated Convex types from this subphase unblock every later Billing file.

**What:** Add optional tenant gate, missing payment indexes, Slack contributor timeline index, export audit table, readiness check table, and aggregate component registrations.

**Why:** Every later query/mutation depends on these generated table/component types. Keeping the tenant gate optional means existing production data remains valid and Billing stays disabled by default.

**Where:**
- `convex/schema.ts` (modify)
- `convex/convex.config.ts` (modify)
- `convex/billing/aggregates.ts` (new)

**How:**

**Step 1: Widen tenant and payment schema.**

```typescript
// Path: convex/schema.ts
tenants: defineTable({
  // ... existing fields ...
  slackQualificationDailyTeamQuota: v.optional(v.number()),
  billingOpsEnabled: v.optional(v.boolean()),
})
  .index("by_contactEmail", ["contactEmail"])
  .index("by_workosOrgId", ["workosOrgId"]);

paymentRecords: defineTable({
  // ... existing fields ...
})
  .index("by_tenantId_and_status_and_recordedAt", [
    "tenantId",
    "status",
    "recordedAt",
  ])
  .index("by_tenantId_and_status_and_programId_and_recordedAt", [
    "tenantId",
    "status",
    "programId",
    "recordedAt",
  ])
  .index("by_tenantId_and_status_and_paymentType_and_recordedAt", [
    "tenantId",
    "status",
    "paymentType",
    "recordedAt",
  ])
  .index("by_tenantId_and_status_and_programId_and_paymentType_and_recordedAt", [
    "tenantId",
    "status",
    "programId",
    "paymentType",
    "recordedAt",
  ]);
```

**Step 2: Add the Slack timeline index.**

```typescript
// Path: convex/schema.ts
slackQualificationEvents: defineTable({
  // ... existing fields ...
})
  .index("by_tenantId_and_opportunityId", [
    "tenantId",
    "opportunityId",
  ])
  .index("by_tenantId_and_opportunityId_and_submittedAt", [
    "tenantId",
    "opportunityId",
    "submittedAt",
  ]);
```

**Step 3: Add export and readiness audit tables.**

```typescript
// Path: convex/schema.ts
billingExportEvents: defineTable({
  tenantId: v.id("tenants"),
  actorUserId: v.id("users"),
  filtersJson: v.string(),
  exactCount: v.number(),
  exportedCount: v.number(),
  truncated: v.boolean(),
  createdAt: v.number(),
})
  .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
  .index("by_tenantId_and_actorUserId_and_createdAt", [
    "tenantId",
    "actorUserId",
    "createdAt",
  ]),

billingOpsReadinessChecks: defineTable({
  tenantId: v.id("tenants"),
  actorSubject: v.string(),
  status: v.union(v.literal("passed"), v.literal("failed")),
  checkedAt: v.number(),
  aggregateBackfilledAt: v.optional(v.number()),
  filtersJson: v.string(),
  summaryJson: v.string(),
})
  .index("by_tenantId_and_checkedAt", ["tenantId", "checkedAt"])
  .index("by_tenantId_and_status_and_checkedAt", [
    "tenantId",
    "status",
    "checkedAt",
  ]),
```

**Step 4: Register aggregate components.**

```typescript
// Path: convex/convex.config.ts
app.use(aggregate, { name: "billingPaymentsByStatus" });
app.use(aggregate, { name: "billingPaymentsByStatusProgram" });
app.use(aggregate, { name: "billingPaymentsByStatusType" });
app.use(aggregate, { name: "billingPaymentsByStatusProgramType" });
```

**Step 5: Define aggregate instances.**

```typescript
// Path: convex/billing/aggregates.ts
import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "../_generated/api";
import type { DataModel, Doc, Id } from "../_generated/dataModel";

type PaymentStatus = Doc<"paymentRecords">["status"];
type PaymentType = Doc<"paymentRecords">["paymentType"];

export const billingPaymentsByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.recordedAt],
});

export const billingPaymentsByStatusProgram = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, Id<"tenantPrograms">, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatusProgram, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.programId, doc.recordedAt],
});

export const billingPaymentsByStatusType = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, PaymentType, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatusType, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.paymentType, doc.recordedAt],
});

export const billingPaymentsByStatusProgramType = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, Id<"tenantPrograms">, PaymentType, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatusProgramType, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [
    doc.status,
    doc.programId,
    doc.paymentType,
    doc.recordedAt,
  ],
});
```

**Key implementation notes:**
- This is a widen-only deploy. All new document fields are optional or new tables.
- `billingOpsReadinessChecks` is added because the design requires persisted readiness evidence before enablement.
- Do not add a `billingPaymentQueue` projection table in MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Tenant flag, indexes, export events, readiness checks |
| `convex/convex.config.ts` | Modify | Add four Billing aggregate components |
| `convex/billing/aggregates.ts` | Create | Aggregate instances used by counts and write hooks |

---

### 0C — Bounded Payment Audit Query

**Type:** Backend
**Parallelizable:** Yes — depends on 0B generated types but not on aggregate backfill or route work.

**What:** Create an admin/owner Billing audit query that samples recent tenant payments and verifies linked context without unbounded reads.

**Why:** Operators need confidence that Billing rows can be reconstructed before UI work starts. The audit also surfaces whether historical `verified` rows exist.

**Where:**
- `convex/billing/audit.ts` (new)
- `convex/billing/validators.ts` (new)

**How:**

**Step 1: Add Billing validators shared by audit and queue work.**

```typescript
// Path: convex/billing/validators.ts
import { v } from "convex/values";
import { paymentTypeValidator } from "../lib/paymentTypes";

export const billingStatusValidator = v.union(
  v.literal("recorded"),
  v.literal("verified"),
  v.literal("disputed"),
);

export const billingQueueFiltersValidator = {
  status: billingStatusValidator,
  programId: v.optional(v.id("tenantPrograms")),
  paymentType: v.optional(paymentTypeValidator),
  startAt: v.optional(v.number()),
  endAt: v.optional(v.number()),
};
```

**Step 2: Implement the bounded smoke audit.**

```typescript
// Path: convex/billing/audit.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatiblePaymentCommissionable,
} from "../lib/paymentTypes";

export const getPaymentAuditSnapshot = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit = 200 }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q.eq("tenantId", tenantId),
      )
      .order("desc")
      .take(boundedLimit);

    let missingRecordedByUser = 0;
    let missingProgram = 0;

    await Promise.all(
      payments.map(async (payment) => {
        const [recordedBy, program] = await Promise.all([
          ctx.db.get(payment.recordedByUserId),
          ctx.db.get(payment.programId),
        ]);
        if (!recordedBy || recordedBy.tenantId !== tenantId) {
          missingRecordedByUser += 1;
        }
        if (!program || program.tenantId !== tenantId) {
          missingProgram += 1;
        }
      }),
    );

    return {
      totalSampled: payments.length,
      missingCustomerId: payments.filter((p) => !p.customerId).length,
      missingMeetingId: payments.filter((p) => !p.meetingId).length,
      missingAttributedCloserOnCommissionable: payments.filter((p) => {
        return (
          resolveLegacyCompatiblePaymentCommissionable(p) &&
          !resolveLegacyCompatibleAttributedCloserId(p)
        );
      }).length,
      missingRecordedByUser,
      missingProgram,
      proofFileRows: payments.filter((p) => p.proofFileId).length,
      byStatus: {
        recorded: payments.filter((p) => p.status === "recorded").length,
        verified: payments.filter((p) => p.status === "verified").length,
        disputed: payments.filter((p) => p.status === "disputed").length,
      },
    };
  },
});
```

**Key implementation notes:**
- This query is intentionally a smoke sample, not the final readiness gate.
- Use `by_tenantId_and_recordedAt` and `.take()`. Do not scan every payment in an interactive query.
- Missing customer/meeting is diagnostic. Missing registrant/program is a stronger enablement blocker.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/audit.ts` | Create | Bounded tenant payment audit |
| `convex/billing/validators.ts` | Create | Shared status/filter validators |

---

### 0D — Billing Aggregate Backfill and Verification

**Type:** Backend
**Parallelizable:** Yes — depends on 0B aggregate component registration but can run independently of the UI and audit query.

**What:** Add insert/replace helper contracts plus internal backfill and verification functions for Billing count aggregates.

**Why:** Billing queue counts must be exact. A one-time backfill is not enough; later phases must wire these helpers into all payment write/status paths.

**Where:**
- `convex/billing/aggregates.ts` (modify)
- `convex/billing/backfill.ts` (new)
- `convex/admin/billingOps.ts` (new, readiness verification in 0E)

**How:**

**Step 1: Add aggregate write helper contracts.**

```typescript
// Path: convex/billing/aggregates.ts
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export async function insertBillingPaymentAggregates(
  ctx: MutationCtx,
  payment: Doc<"paymentRecords">,
) {
  await Promise.all([
    billingPaymentsByStatus.insertIfDoesNotExist(ctx, payment),
    billingPaymentsByStatusProgram.insertIfDoesNotExist(ctx, payment),
    billingPaymentsByStatusType.insertIfDoesNotExist(ctx, payment),
    billingPaymentsByStatusProgramType.insertIfDoesNotExist(ctx, payment),
  ]);
}

export async function replaceBillingPaymentAggregates(
  ctx: MutationCtx,
  before: Doc<"paymentRecords">,
  after: Doc<"paymentRecords">,
) {
  await Promise.all([
    billingPaymentsByStatus.replaceOrInsert(ctx, before, after),
    billingPaymentsByStatusProgram.replaceOrInsert(ctx, before, after),
    billingPaymentsByStatusType.replaceOrInsert(ctx, before, after),
    billingPaymentsByStatusProgramType.replaceOrInsert(ctx, before, after),
  ]);
}
```

**Step 2: Backfill in bounded scheduled batches.**

```typescript
// Path: convex/billing/backfill.ts
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { insertBillingPaymentAggregates } from "./aggregates";

const BACKFILL_BATCH_SIZE = 200;

export const backfillBillingPaymentAggregates = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { tenantId, cursor }) => {
    const result = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .paginate({
        numItems: BACKFILL_BATCH_SIZE,
        cursor: cursor ?? null,
      });

    for (const payment of result.page) {
      await insertBillingPaymentAggregates(ctx, payment);
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.billing.backfill.backfillBillingPaymentAggregates,
        { tenantId, cursor: result.continueCursor },
      );
    }

    return {
      processed: result.page.length,
      hasMore: !result.isDone,
      completedAt: result.isDone ? Date.now() : null,
    };
  },
});
```

**Step 3: Verify aggregates against indexed bounded checks.**

```typescript
// Path: convex/billing/aggregates.ts
import type { MutationCtx, QueryCtx } from "../_generated/server";

type BillingCountArgs = {
  status: Doc<"paymentRecords">["status"];
  programId?: Id<"tenantPrograms">;
  paymentType?: Doc<"paymentRecords">["paymentType"];
  startAt?: number;
  endAt?: number;
};

function dateBounds(startAt?: number, endAt?: number) {
  return startAt === undefined && endAt === undefined
    ? undefined
    : {
        lower: {
          key: startAt ?? Number.NEGATIVE_INFINITY,
          inclusive: true,
        },
        upper: {
          key: endAt ?? Number.POSITIVE_INFINITY,
          inclusive: false,
        },
      };
}

export async function countBillingPayments(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
  args: BillingCountArgs,
) {
  if (args.programId && args.paymentType) {
    return await billingPaymentsByStatusProgramType.count(ctx, {
      namespace: tenantId,
      bounds: {
        lower: {
          key: [
            args.status,
            args.programId,
            args.paymentType,
            args.startAt ?? Number.NEGATIVE_INFINITY,
          ],
          inclusive: true,
        },
        upper: {
          key: [
            args.status,
            args.programId,
            args.paymentType,
            args.endAt ?? Number.POSITIVE_INFINITY,
          ],
          inclusive: false,
        },
      },
    });
  }

  if (args.programId) {
    return await billingPaymentsByStatusProgram.count(ctx, {
      namespace: tenantId,
      bounds: {
        lower: {
          key: [args.status, args.programId, args.startAt ?? Number.NEGATIVE_INFINITY],
          inclusive: true,
        },
        upper: {
          key: [args.status, args.programId, args.endAt ?? Number.POSITIVE_INFINITY],
          inclusive: false,
        },
      },
    });
  }

  if (args.paymentType) {
    return await billingPaymentsByStatusType.count(ctx, {
      namespace: tenantId,
      bounds: {
        lower: {
          key: [args.status, args.paymentType, args.startAt ?? Number.NEGATIVE_INFINITY],
          inclusive: true,
        },
        upper: {
          key: [args.status, args.paymentType, args.endAt ?? Number.POSITIVE_INFINITY],
          inclusive: false,
        },
      },
    });
  }

  return await billingPaymentsByStatus.count(ctx, {
    namespace: tenantId,
    bounds: dateBounds(args.startAt, args.endAt)
      ? {
          lower: {
            key: [args.status, args.startAt ?? Number.NEGATIVE_INFINITY],
            inclusive: true,
          },
          upper: {
            key: [args.status, args.endAt ?? Number.POSITIVE_INFINITY],
            inclusive: false,
          },
        }
      : undefined,
  });
}
```

**Key implementation notes:**
- `Number.NEGATIVE_INFINITY` and `Number.POSITIVE_INFINITY` are valid Convex numbers and useful for open-ended aggregate bounds.
- Phase 1 must wire `insertBillingPaymentAggregates` into all payment insert paths before enablement.
- Phase 2 must call `replaceBillingPaymentAggregates` for review status changes. Phase 3 corrections must ensure the same replacement happens through the shared `replacePaymentAggregate` hook from Phase 1D.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/aggregates.ts` | Modify | Insert, replace, and count helpers |
| `convex/billing/backfill.ts` | Create | Internal tenant-scoped backfill |

---

### 0E — System Admin Readiness and Enablement Gate

**Type:** Backend / Config
**Parallelizable:** Yes — depends on 0B schema and 0D count helper; independent of workspace UI.

**What:** Add system-admin functions that persist readiness checks and refuse enablement unless the latest check passed.

**Why:** Billing must not appear just because code exists. Enablement is a tenant-scoped operational decision after backfill and verification.

**Where:**
- `convex/admin/billingOps.ts` (new)
- `app/admin/_components/admin-page-client.tsx` (modify later, optional Phase 0 admin affordance)

**How:**

**Step 1: Add verification result storage.**

```typescript
// Path: convex/admin/billingOps.ts
import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requireSystemAdminSession } from "../requireSystemAdmin";

export const getBillingOpsReadiness = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const latest = await ctx.db
      .query("billingOpsReadinessChecks")
      .withIndex("by_tenantId_and_checkedAt", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .first();

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("Tenant not found");

    return {
      enabled: tenant.billingOpsEnabled === true,
      latest,
    };
  },
});

export const recordBillingOpsReadinessCheck = mutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(v.literal("passed"), v.literal("failed")),
    aggregateBackfilledAt: v.optional(v.number()),
    filtersJson: v.string(),
    summaryJson: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    return await ctx.db.insert("billingOpsReadinessChecks", {
      tenantId: args.tenantId,
      actorSubject: identity.subject,
      status: args.status,
      checkedAt: Date.now(),
      aggregateBackfilledAt: args.aggregateBackfilledAt,
      filtersJson: args.filtersJson,
      summaryJson: args.summaryJson,
    });
  },
});
```

**Step 2: Gate enablement on latest passing evidence.**

```typescript
// Path: convex/admin/billingOps.ts
export const setBillingOpsEnabled = mutation({
  args: {
    tenantId: v.id("tenants"),
    enabled: v.boolean(),
  },
  handler: async (ctx, { tenantId, enabled }) => {
    const identity = await ctx.auth.getUserIdentity();
    requireSystemAdminSession(identity);

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("Tenant not found");

    if (enabled) {
      const latestPassed = await ctx.db
        .query("billingOpsReadinessChecks")
        .withIndex("by_tenantId_and_status_and_checkedAt", (q) =>
          q.eq("tenantId", tenantId).eq("status", "passed"),
        )
        .order("desc")
        .first();

      if (!latestPassed) {
        throw new Error("Billing Ops cannot be enabled without a passing readiness check.");
      }
      if (latestPassed.aggregateBackfilledAt === undefined) {
        throw new Error("Billing aggregate backfill timestamp is missing.");
      }
    }

    await ctx.db.patch(tenantId, { billingOpsEnabled: enabled });
    return { tenantId, enabled };
  },
});
```

**Key implementation notes:**
- System admin functions live under `convex/admin/`, not workspace Billing functions.
- Direct workspace users never call enablement mutations.
- If readiness verification is later automated, keep the persisted check as the source of truth for enablement.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/admin/billingOps.ts` | Create | Readiness and enablement mutations |
| `app/admin/_components/admin-page-client.tsx` | Modify | Optional Phase 0 button/status display, can defer to release runbook |

---

### 0F — Rollout Runbook and Gate Evidence

**Type:** Manual / QA
**Parallelizable:** No — final Phase 0 checkpoint consumes evidence from all earlier subphases.

**What:** Document exact rollout order, commands, checks, rollback, and the test-tenant readiness result.

**Why:** The app has one production test tenant. Schema and aggregate changes are safe only if the team can prove what has run and keep Billing disabled until the full MVP is ready.

**Where:**
- `plans/billing-ops/phases/phase0-rollout-runbook.md` (new)
- `plans/billing-ops/phases/parallelization-strategy.md` (new in parallelization task)

**How:**

**Step 1: Create the runbook skeleton.**

```typescript
// Path: plans/billing-ops/phases/phase0-rollout-runbook.md
export const rolloutSections = [
  "Pre-deploy product signoff",
  "Widen-only schema deploy",
  "Generated Convex type verification",
  "Billing aggregate backfill",
  "Readiness verification matrix",
  "Enablement refusal checks",
  "Rollback plan",
] as const;
```

**Step 2: Record the verification matrix.**

Use the matrix from design section 4.1 plus these filter count checks:

| Status | Program | Type | Date Bounds | Expected Check |
|---|---|---|---|---|
| `recorded` | none | none | none | Aggregate count equals indexed count. |
| `verified` | each active program | none | none | Aggregate count equals indexed count. |
| `disputed` | none | each type | last 90 days | Aggregate count equals indexed count. |
| `recorded` | each active program | each type | last 90 days | Aggregate count equals indexed count. |

**Key implementation notes:**
- Do not auto-enable the tenant as part of any backfill or verification function.
- Keep rollback simple: set `billingOpsEnabled` false, hide nav, and leave widened schema in place.
- Only remove migration/backfill helpers after the MVP has shipped and the team no longer needs replay tooling.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/billing-ops/phases/phase0-rollout-runbook.md` | Create | Operational rollout evidence and commands |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/billing/types.ts` | Create | 0A |
| `convex/schema.ts` | Modify | 0B |
| `convex/convex.config.ts` | Modify | 0B |
| `convex/billing/aggregates.ts` | Create | 0B, 0D |
| `convex/billing/validators.ts` | Create | 0C |
| `convex/billing/audit.ts` | Create | 0C |
| `convex/billing/backfill.ts` | Create | 0D |
| `convex/admin/billingOps.ts` | Create | 0E |
| `app/admin/_components/admin-page-client.tsx` | Modify | 0E |
| `plans/billing-ops/phases/phase0-rollout-runbook.md` | Create | 0F |
