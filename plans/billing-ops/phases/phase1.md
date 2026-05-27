# Phase 1 — Read-Only Billing Queue

**Goal:** Build the tenant-gated read-only Billing Ops workspace: `/workspace/billing` for the paginated queue and `/workspace/billing/[paymentRecordId]` for focused payment context. The phase also wires Billing aggregate hooks so exact counts remain correct after the Phase 0 backfill.

**Prerequisite:** Phase 0 schema widen is deployed, Convex generated types include Billing tables/components, Billing Ops remains disabled for all tenants, and product has accepted the `verified` review semantics.

**Runs in PARALLEL with:** Phase 2 backend review mutation work can begin after 1A, 1B, and 1D contracts are stable. Phase 4 copy/export formatting can begin after 1C defines the row/detail shape.

**Skills to invoke:**
- `convex-performance-audit` — use if queue enrichment reads too many related documents or Convex insights flags read amplification.
- `next-best-practices` — route files stay thin server components; interactive filters/pagination live in client components.
- `frontend-design` — the queue is an operational surface and should be dense, scannable, and not card-heavy.
- `shadcn` — reuse Table, Select, Badge, Skeleton, Empty, Button, ScrollArea, and Tooltip primitives.

**Acceptance Criteria:**
1. `tenant_master` and `tenant_admin` users can access `/workspace/billing` only when their tenant has `billingOpsEnabled === true`.
2. Direct Billing route access while disabled renders a controlled unavailable state, and public Billing Convex functions reject with a stable disabled error.
3. `closer` and `lead_generator` users cannot load Billing routes or public Billing functions.
4. Queue filters are server-side before pagination for status, program, payment type, and date bounds.
5. Queue rows include customer, payment, entered-by, phone closer, DM attribution, Slack contributor summary, meeting, opportunity, and review metadata.
6. Exact counts for the active filter come from Billing aggregate components, not table scans.
7. The focused payment page loads proof metadata/URL only after tenant authorization and includes bounded domain event history.
8. The queue exposes no review, correction, or export mutation buttons in Phase 1.
9. Existing payment insert and status-change paths update Billing aggregate components through shared hooks.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (permissions + guards) ───────────────┬── 1B (queue query + exact counts)
                                         ├── 1C (enrichment + detail query)
1D (aggregate write hooks) ──────────────┘

1B + 1C complete ─────────────────────────── 1E (route wrappers + skeletons)

1E complete ──────────────────────────────── 1F (queue/detail read-only UI)
```

**Optimal execution:**
1. Run 1A and 1D in parallel. They touch different backend files and unblock public query safety plus count correctness.
2. Run 1B and 1C in parallel after guards exist. 1B owns pagination/filtering; 1C owns page/detail enrichment.
3. Start 1E once query references exist so server routes can call availability.
4. Finish with 1F, wiring only read-only UI actions.

**Estimated time:** 4-6 days

---

## Subphases

### 1A — Billing Permissions, Guards, and Availability

**Type:** Backend
**Parallelizable:** Yes — independent of query/enrichment details, but all public Billing functions depend on this contract.

**What:** Add Billing permission literals, central Billing guards, and a small availability query used by RSC route wrappers.

**Why:** Billing data is tenant-scoped financial data. Every public function must derive tenant/user from Convex auth, verify permission, and enforce `billingOpsEnabled`.

**Where:**
- `convex/lib/permissions.ts` (modify)
- `convex/billing/guards.ts` (new)
- `convex/billing/queries.ts` (new)

**How:**

**Step 1: Add permission literals.**

```typescript
// Path: convex/lib/permissions.ts
export const PERMISSIONS = {
  // ... existing permissions ...
  "billing:view": ["tenant_master", "tenant_admin"],
  "billing:review": ["tenant_master", "tenant_admin"],
  "billing:correct": ["tenant_master", "tenant_admin"],
  "billing:export": ["tenant_master", "tenant_admin"],
} as const;
```

**Step 2: Create Billing guards.**

```typescript
// Path: convex/billing/guards.ts
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { Permission } from "../lib/permissions";
import { hasPermission } from "../lib/permissions";
import { requireTenantUser } from "../requireTenantUser";

const BILLING_ROLES = ["tenant_master", "tenant_admin"] as const;

export class BillingOpsDisabledError extends Error {
  constructor() {
    super("Billing Ops is not enabled for this tenant.");
    this.name = "BillingOpsDisabledError";
  }
}

export async function requireBillingPermission(
  ctx: QueryCtx | MutationCtx,
  permission: Permission,
) {
  const session = await requireTenantUser(ctx, [...BILLING_ROLES]);
  if (!hasPermission(session.role, permission)) {
    throw new Error("Insufficient Billing permissions.");
  }
  return session;
}

export async function requireBillingOpsEnabled(
  ctx: QueryCtx | MutationCtx,
  tenantId: Id<"tenants">,
) {
  const tenant = await ctx.db.get(tenantId);
  if (!tenant || tenant.billingOpsEnabled !== true) {
    throw new BillingOpsDisabledError();
  }
  return tenant;
}
```

**Step 3: Add an availability query for RSC route gates.**

```typescript
// Path: convex/billing/queries.ts
import { query } from "../_generated/server";
import { requireBillingPermission } from "./guards";

export const getAvailability = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    const tenant = await ctx.db.get(tenantId);
    return {
      enabled: tenant?.billingOpsEnabled === true,
      reason:
        tenant?.billingOpsEnabled === true
          ? null
          : "Billing Ops is not enabled for this tenant.",
    };
  },
});
```

**Key implementation notes:**
- The guard does not accept `tenantId`, `userId`, role, or reviewer id from the client.
- `getAvailability` does not bypass role checks; it only avoids throwing for a disabled tenant so the RSC can render `BillingUnavailable`.
- Keep all mutating permissions defined now even though Phase 1 only uses `billing:view`; Phase 2-4 import the same literals.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | Add Billing permission literals |
| `convex/billing/guards.ts` | Create | Permission and enablement guards |
| `convex/billing/queries.ts` | Create | Availability query |

---

### 1B — Queue Query, Filter Branching, and Exact Counts

**Type:** Backend
**Parallelizable:** Yes — depends on 1A guards and Phase 0 aggregate helpers, but not on frontend UI.

**What:** Implement `api.billing.queries.listPayments` with indexed filter selection before pagination and aggregate-backed exact counts.

**Why:** Client-side filtering after pagination produces empty or incomplete pages. Billing operators need correct pages and exact counts for operational work.

**Where:**
- `convex/billing/queries.ts` (modify)
- `convex/billing/queryBuilder.ts` (new)
- `convex/billing/validators.ts` (modify)

**How:**

**Step 1: Export a single filter validator.**

```typescript
// Path: convex/billing/validators.ts
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { paymentTypeValidator } from "../lib/paymentTypes";

export const listPaymentsArgsValidator = {
  status: billingStatusValidator,
  programId: v.optional(v.id("tenantPrograms")),
  paymentType: v.optional(paymentTypeValidator),
  startAt: v.optional(v.number()),
  endAt: v.optional(v.number()),
  paginationOpts: paginationOptsValidator,
};
```

**Step 2: Put filter branching in a dedicated helper.**

```typescript
// Path: convex/billing/queryBuilder.ts
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { PaymentType } from "../lib/paymentTypes";
import type { BillingPaymentStatus } from "./types";

export type BillingPaymentFilters = {
  status: BillingPaymentStatus;
  programId?: Id<"tenantPrograms">;
  paymentType?: PaymentType;
  startAt?: number;
  endAt?: number;
};

function boundedRecordedAt<Q extends { gte: Function; lt: Function }>(
  q: Q,
  startAt?: number,
  endAt?: number,
) {
  let next = q;
  if (startAt !== undefined) next = next.gte("recordedAt", startAt);
  if (endAt !== undefined) next = next.lt("recordedAt", endAt);
  return next;
}

export function selectBillingPaymentQuery(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  filters: BillingPaymentFilters,
) {
  if (filters.programId && filters.paymentType) {
    return ctx.db
      .query("paymentRecords")
      .withIndex(
        "by_tenantId_and_status_and_programId_and_paymentType_and_recordedAt",
        (q) =>
          boundedRecordedAt(
            q
              .eq("tenantId", tenantId)
              .eq("status", filters.status)
              .eq("programId", filters.programId!)
              .eq("paymentType", filters.paymentType!),
            filters.startAt,
            filters.endAt,
          ),
      );
  }

  if (filters.programId) {
    return ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_programId_and_recordedAt", (q) =>
        boundedRecordedAt(
          q
            .eq("tenantId", tenantId)
            .eq("status", filters.status)
            .eq("programId", filters.programId!),
          filters.startAt,
          filters.endAt,
        ),
      );
  }

  if (filters.paymentType) {
    return ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_status_and_paymentType_and_recordedAt", (q) =>
        boundedRecordedAt(
          q
            .eq("tenantId", tenantId)
            .eq("status", filters.status)
            .eq("paymentType", filters.paymentType!),
          filters.startAt,
          filters.endAt,
        ),
      );
  }

  return ctx.db
    .query("paymentRecords")
    .withIndex("by_tenantId_and_status_and_recordedAt", (q) =>
      boundedRecordedAt(
        q.eq("tenantId", tenantId).eq("status", filters.status),
        filters.startAt,
        filters.endAt,
      ),
    );
}
```

**Step 3: Implement the paginated query.**

```typescript
// Path: convex/billing/queries.ts
import { query } from "../_generated/server";
import { countBillingPayments } from "./aggregates";
import { enrichBillingPaymentRows } from "./enrichment";
import { requireBillingOpsEnabled, requireBillingPermission } from "./guards";
import { selectBillingPaymentQuery } from "./queryBuilder";
import { listPaymentsArgsValidator } from "./validators";

export const listPayments = query({
  args: listPaymentsArgsValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const page = await selectBillingPaymentQuery(ctx, tenantId, args)
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...page,
      page: await enrichBillingPaymentRows(ctx, tenantId, page.page),
    };
  },
});

export const getPaymentCount = query({
  args: billingQueueFiltersValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);
    return await countBillingPayments(ctx, tenantId, args);
  },
});
```

**Key implementation notes:**
- Status is required and single-select. Do not add an `all` status branch in MVP.
- Date filters are optional bounds on `recordedAt`; default queue must not hide older unreviewed payments.
- Keep exact count as a separate `getPaymentCount` query for the client. `usePaginatedQuery` exposes flattened page rows, so do not rely on extra fields attached to the pagination result in UI code.
- Keep search out of Phase 1. Text search needs a projection/search index later.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/validators.ts` | Modify | Shared queue args |
| `convex/billing/queryBuilder.ts` | Create | Indexed filter branch helper |
| `convex/billing/queries.ts` | Modify | `listPayments` query |

---

### 1C — Billing Enrichment and Focused Detail Query

**Type:** Backend
**Parallelizable:** Yes — depends on 1A guards but can run alongside 1B and 1D.

**What:** Build queue row enrichment, focused payment detail enrichment, Slack contributor summary/timeline, proof metadata, and bounded payment event history.

**Why:** Billing operators need context, not just payment rows. Enrichment must happen after pagination and must never leak cross-tenant records.

**Where:**
- `convex/billing/enrichment.ts` (new)
- `convex/billing/queries.ts` (modify)
- `convex/billing/types.ts` (modify)

**How:**

**Step 1: Enrich only the current page.**

```typescript
// Path: convex/billing/enrichment.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { buildOpportunityAttributionPayload } from "../lib/attribution/detailPayload";
import {
  resolveLegacyCompatibleAttributedCloserId,
  resolveLegacyCompatibleRecordedByUserId,
} from "../lib/paymentTypes";

function userName(user: Doc<"users"> | null | undefined) {
  return user?.fullName ?? user?.email ?? "Unknown user";
}

export async function enrichBillingPaymentRows(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payments: Array<Doc<"paymentRecords">>,
) {
  return await Promise.all(
    payments.map(async (payment) => {
      if (payment.tenantId !== tenantId) {
        throw new Error("Cross-tenant payment read blocked.");
      }

      const [customer, opportunity, meeting, enteredBy, reviewer] =
        await Promise.all([
          resolveBillingCustomer(ctx, tenantId, payment),
          resolveBillingOpportunity(ctx, tenantId, payment),
          payment.meetingId ? ctx.db.get(payment.meetingId) : null,
          ctx.db.get(resolveLegacyCompatibleRecordedByUserId(payment)!),
          payment.verifiedByUserId ? ctx.db.get(payment.verifiedByUserId) : null,
        ]);

      const attribution = await resolveBillingAttribution(
        ctx,
        tenantId,
        opportunity,
        meeting,
        payment,
      );

      return {
        payment: {
          id: payment._id,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          recordedAt: payment.recordedAt,
          status: payment.status,
          paymentType: payment.paymentType,
          programId: payment.programId,
          programName: payment.programName,
          origin: payment.origin,
          contextType: payment.contextType,
          referenceCode: payment.referenceCode ?? null,
          note: payment.note ?? null,
          hasProofFile: Boolean(payment.proofFileId),
          commissionable: payment.commissionable,
        },
        customer: customer
          ? {
              id: customer._id,
              fullName: customer.fullName ?? null,
              email: customer.email ?? null,
              phone: customer.phone ?? null,
            }
          : { id: null, fullName: null, email: null, phone: null },
        opportunity: opportunity
          ? {
              id: opportunity._id,
              status: opportunity.status,
              source: opportunity.source ?? null,
            }
          : { id: null, status: null, source: null },
        meeting: meeting
          ? { id: meeting._id, scheduledAt: meeting.scheduledAt }
          : { id: null, scheduledAt: null },
        enteredBy: { id: enteredBy!._id, name: userName(enteredBy) },
        phoneCloser: attribution.phoneCloser,
        dmAttribution: attribution.dmAttribution,
        slackContributorSummary: attribution.slackContributorSummary,
        review: {
          reviewedAt: payment.verifiedAt ?? null,
          reviewerName: reviewer ? userName(reviewer) : null,
        },
      };
    }),
  );
}
```

**Step 2: Resolve Slack contribution separately from attribution payload.**

```typescript
// Path: convex/billing/enrichment.ts
async function resolveSlackContributorSummary(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  opportunity: Doc<"opportunities"> | null,
) {
  if (!opportunity) {
    return { firstLabel: null, latestLabel: null, count: 0 };
  }

  const events = await ctx.db
    .query("slackQualificationEvents")
    .withIndex("by_tenantId_and_opportunityId_and_submittedAt", (q) =>
      q.eq("tenantId", tenantId).eq("opportunityId", opportunity._id),
    )
    .order("asc")
    .take(25);

  if (events.length === 0 && opportunity.qualifiedBy) {
    const fallback = opportunity.qualifiedBy.slackUserId;
    return { firstLabel: fallback, latestLabel: fallback, count: 1 };
  }

  const labels = events.map((event) =>
    event.fullNameSnapshot || event.slackUserId,
  );
  return {
    firstLabel: labels[0] ?? null,
    latestLabel: labels.at(-1) ?? null,
    count: labels.length,
  };
}
```

**Step 3: Add focused payment detail.**

```typescript
// Path: convex/billing/queries.ts
import { v } from "convex/values";
import { enrichBillingPaymentDetail } from "./enrichment";

export const getPaymentDetail = query({
  args: { paymentRecordId: v.id("paymentRecords") },
  handler: async (ctx, { paymentRecordId }) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const payment = await ctx.db.get(paymentRecordId);
    if (!payment || payment.tenantId !== tenantId) {
      return null;
    }

    return await enrichBillingPaymentDetail(ctx, tenantId, payment);
  },
});
```

**Step 4: Include proof metadata and event history in detail only.**

```typescript
// Path: convex/billing/enrichment.ts
export async function enrichBillingPaymentDetail(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
  payment: Doc<"paymentRecords">,
) {
  const [row] = await enrichBillingPaymentRows(ctx, tenantId, [payment]);
  const [proofUrl, proofMeta, events] = await Promise.all([
    payment.proofFileId ? ctx.storage.getUrl(payment.proofFileId) : null,
    payment.proofFileId
      ? ctx.db.system.get("_storage", payment.proofFileId)
      : null,
    ctx.db
      .query("domainEvents")
      .withIndex("by_tenantId_and_entityType_and_entityId_and_occurredAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("entityType", "payment")
          .eq("entityId", payment._id),
      )
      .order("desc")
      .take(50),
  ]);

  return {
    ...row,
    proof: {
      url: proofUrl,
      contentType: proofMeta?.contentType ?? null,
      size: proofMeta?.size ?? null,
    },
    events,
    slackContributorTimeline: await resolveSlackContributorTimeline(
      ctx,
      tenantId,
      row.opportunity.id,
    ),
  };
}
```

**Key implementation notes:**
- Validate `tenantId` on every loaded document before returning it. `ctx.db.get()` by id is not enough.
- Queue rows get `hasProofFile`; signed proof URL belongs only on focused detail.
- Keep Slack contributor timeline bounded to 25 and event history bounded to 50.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/billing/enrichment.ts` | Create | Row/detail enrichment helpers |
| `convex/billing/queries.ts` | Modify | `getPaymentDetail` query |
| `convex/billing/types.ts` | Modify | Detail and row DTOs |

---

### 1D — Billing Aggregate Write Hooks

**Type:** Backend
**Parallelizable:** Yes — can run while query/enrichment work proceeds.

**What:** Wire Billing aggregate helpers into existing shared payment aggregate hooks and audit all payment write/status paths.

**Why:** Exact counts become stale immediately after Phase 0 backfill unless new payment inserts, review/dispute/void status changes, and correction changes update Billing aggregates transactionally.

**Where:**
- `convex/reporting/writeHooks.ts` (modify)
- `convex/closer/payments.ts` (inspect, modify only if missing shared hook)
- `convex/closer/reminderOutcomes.ts` (inspect)
- `convex/lib/outcomeHelpers.ts` (inspect)
- `convex/customers/mutations.ts` (inspect)
- `convex/sideDeals/logPayment.ts` (inspect)
- `convex/sideDeals/voidPayment.ts` (inspect)
- `convex/reviews/mutations.ts` (inspect)
- `convex/admin/tenantsMutations.ts` (modify cleanup list)

**How:**

**Step 1: Update shared insert/replace hooks.**

```typescript
// Path: convex/reporting/writeHooks.ts
import {
  insertBillingPaymentAggregates,
  replaceBillingPaymentAggregates,
} from "../billing/aggregates";

export async function insertPaymentAggregate(
  ctx: MutationCtx,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  await insertBillingPaymentAggregates(ctx, payment);
  if (isPaymentAggregateEligible(payment)) {
    await paymentSums.insert(ctx, payment);
  }
  return payment;
}

export async function replacePaymentAggregate(
  ctx: MutationCtx,
  oldPayment: Doc<"paymentRecords">,
  paymentId: Id<"paymentRecords">,
): Promise<Doc<"paymentRecords">> {
  const payment = await getPaymentOrThrow(ctx, paymentId);
  await replaceBillingPaymentAggregates(ctx, oldPayment, payment);

  const oldEligible = isPaymentAggregateEligible(oldPayment);
  const nextEligible = isPaymentAggregateEligible(payment);
  // Existing paymentSums logic remains unchanged below.
  return payment;
}
```

**Step 2: Verify every payment insert path already calls `insertPaymentAggregate`.**

| Payment Path | Expected Hook |
|---|---|
| `convex/closer/payments.ts` | `insertPaymentAggregate(ctx, paymentId)` |
| `convex/closer/reminderOutcomes.ts` | `insertPaymentAggregate(ctx, paymentId)` |
| `convex/lib/outcomeHelpers.ts` | `insertPaymentAggregate(ctx, paymentId)` |
| `convex/customers/mutations.ts` | `insertPaymentAggregate(ctx, paymentId)` |
| `convex/sideDeals/logPayment.ts` | `insertPaymentAggregate(ctx, paymentId)` then replace after customer link |

**Step 3: Verify every dispute/void path calls `replacePaymentAggregate`.**

| Status Path | Expected Hook |
|---|---|
| `convex/reviews/mutations.ts` | After patching target payment to `disputed` |
| `convex/sideDeals/voidPayment.ts` | After patching side-deal payment to `disputed` |
| Phase 2 `markReviewed` | After patching `recorded -> verified` |
| Phase 3 `correctPayment` | After patching status/program/type |

**Step 4: Include new tenant-scoped tables in reset cleanup.**

```typescript
// Path: convex/admin/tenantsMutations.ts
const TENANT_SCOPED_BY_TENANT_ID_TABLES = [
  // ... existing tables ...
  "billingExportEvents",
  "billingOpsReadinessChecks",
] as const;
```

**Key implementation notes:**
- Centralizing in `reporting/writeHooks.ts` reduces merge conflicts and avoids editing every payment mutation.
- Do not make Billing counts depend on `paymentSums` eligibility. Billing counts include non-commissionable and disputed payment records.
- Tenant reset/replay tooling must clear or rebuild Billing aggregate namespaces alongside payment data.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/writeHooks.ts` | Modify | Billing aggregate insert/replace inside shared hooks |
| `convex/admin/tenantsMutations.ts` | Modify | Cleanup new tenant-scoped Billing tables |
| Payment write/status files listed above | Inspect / Modify | Add shared hook only if missing |

---

### 1E — Route Wrappers, Loading States, and Disabled State

**Type:** Frontend
**Parallelizable:** No — depends on 1A availability query and 1B/1C API references.

**What:** Create `/workspace/billing` and `/workspace/billing/[paymentRecordId]` thin RSC wrappers, loading files, skeletons, and disabled state.

**Why:** The route should be protected at the server boundary before any client component mounts. Disabled tenants need a controlled state rather than a redirect loop.

**Where:**
- `app/workspace/billing/page.tsx` (new)
- `app/workspace/billing/loading.tsx` (new)
- `app/workspace/billing/[paymentRecordId]/page.tsx` (new)
- `app/workspace/billing/[paymentRecordId]/loading.tsx` (new)
- `app/workspace/billing/_components/billing-unavailable.tsx` (new)
- `app/workspace/billing/_components/billing-page-skeleton.tsx` (new)

**How:**

**Step 1: Add the queue RSC wrapper.**

```tsx
// Path: app/workspace/billing/page.tsx
import { Suspense } from "react";
import { fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { requirePermission } from "@/lib/auth";
import { BillingPageClient } from "./_components/billing-page-client";
import { BillingPageSkeleton } from "./_components/billing-page-skeleton";
import { BillingUnavailable } from "./_components/billing-unavailable";

export const unstable_instant = false;

export default async function BillingPage() {
  const access = await requirePermission("billing:view");
  const availability = await fetchQuery(
    api.billing.queries.getAvailability,
    {},
    { token: access.session.accessToken },
  );

  if (!availability.enabled) {
    return <BillingUnavailable reason={availability.reason} />;
  }

  return (
    <Suspense fallback={<BillingPageSkeleton />}>
      <BillingPageClient />
    </Suspense>
  );
}
```

**Step 2: Add the focused page wrapper.**

```tsx
// Path: app/workspace/billing/[paymentRecordId]/page.tsx
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { requirePermission } from "@/lib/auth";
import { BillingReviewPageClient } from "../_components/billing-review-page-client";
import { BillingUnavailable } from "../_components/billing-unavailable";

export const unstable_instant = false;

export default async function BillingPaymentPage({
  params,
}: {
  params: Promise<{ paymentRecordId: string }>;
}) {
  const access = await requirePermission("billing:view");
  const availability = await fetchQuery(
    api.billing.queries.getAvailability,
    {},
    { token: access.session.accessToken },
  );
  if (!availability.enabled) {
    return <BillingUnavailable reason={availability.reason} />;
  }

  const { paymentRecordId } = await params;
  const preloadedPayment = await preloadQuery(
    api.billing.queries.getPaymentDetail,
    { paymentRecordId: paymentRecordId as Id<"paymentRecords"> },
    { token: access.session.accessToken },
  );

  return <BillingReviewPageClient preloadedPayment={preloadedPayment} />;
}
```

**Step 3: Add stable loading fallbacks.**

```tsx
// Path: app/workspace/billing/loading.tsx
import { BillingPageSkeleton } from "./_components/billing-page-skeleton";

export default function BillingLoading() {
  return <BillingPageSkeleton />;
}
```

**Key implementation notes:**
- `params` is a Promise in this Next.js version; await it inside the RSC.
- Keep `requirePermission("billing:view")` on both route files even though layout auth already exists.
- Do not add sidebar navigation yet unless it is hidden by `billingOpsEnabled`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/page.tsx` | Create | Queue server wrapper |
| `app/workspace/billing/loading.tsx` | Create | Queue route fallback |
| `app/workspace/billing/[paymentRecordId]/page.tsx` | Create | Detail server wrapper |
| `app/workspace/billing/[paymentRecordId]/loading.tsx` | Create | Detail route fallback |
| `app/workspace/billing/_components/billing-unavailable.tsx` | Create | Disabled state |
| `app/workspace/billing/_components/billing-page-skeleton.tsx` | Create | Shared skeleton |

---

### 1F — Read-Only Queue and Detail UI

**Type:** Frontend
**Parallelizable:** No — depends on 1E route wrappers and the 1B/1C query contracts.

**What:** Build the queue table, filters, pagination controls, and focused payment detail sections without review/correction/export actions.

**Why:** Phase 1 gives operators a trustworthy read-only view before any write risk is introduced.

**Where:**
- `app/workspace/billing/_components/billing-page-client.tsx` (new)
- `app/workspace/billing/_components/billing-queue-table.tsx` (new)
- `app/workspace/billing/_components/billing-review-page-client.tsx` (new)
- `app/workspace/billing/_components/billing-payment-summary.tsx` (new)
- `app/workspace/billing/_components/billing-event-history.tsx` (new)
- `app/workspace/billing/_components/slack-contributor-timeline.tsx` (new)

**How:**

**Step 1: Implement the paginated queue client.**

```tsx
// Path: app/workspace/billing/_components/billing-page-client.tsx
"use client";

import { useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePageTitle } from "@/hooks/use-page-title";
import { BillingQueueTable } from "./billing-queue-table";

type BillingStatus = "recorded" | "verified" | "disputed";
type PaymentType = "monthly" | "split" | "pif" | "deposit";

export function BillingPageClient() {
  usePageTitle("Billing");
  const [status, setStatus] = useState<BillingStatus>("recorded");
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | undefined>();
  const [paymentType, setPaymentType] = useState<PaymentType | undefined>();
  const filters = { status, programId, paymentType };

  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {
    includeArchived: true,
  });
  const exactCount = useQuery(api.billing.queries.getPaymentCount, filters);
  const queue = usePaginatedQuery(
    api.billing.queries.listPayments,
    filters,
    { initialNumItems: 25 },
  );

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
          <p className="text-sm text-muted-foreground">
            Review recorded payments before external billing handoff.
          </p>
        </div>
      </header>
      <BillingQueueTable
        rows={queue.results}
        status={queue.status}
        exactCount={exactCount}
        programs={programs ?? []}
        onStatusChange={setStatus}
        onProgramChange={setProgramId}
        onPaymentTypeChange={setPaymentType}
        onLoadMore={() => queue.loadMore(25)}
      />
    </div>
  );
}
```

**Step 2: Keep row actions read-only.**

```tsx
// Path: app/workspace/billing/_components/billing-queue-table.tsx
import Link from "next/link";
import { ExternalLinkIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatAmountMinor } from "@/lib/format-currency";

export function BillingQueueTable({ rows }: { rows: BillingPaymentRow[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Paid at</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Amount</TableHead>
            <TableHead>Program</TableHead>
            <TableHead>Entered by</TableHead>
            <TableHead>Attribution</TableHead>
            <TableHead className="text-right">Open</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.payment.id}>
              <TableCell>{new Date(row.payment.recordedAt).toLocaleString()}</TableCell>
              <TableCell>{row.customer.fullName ?? row.customer.email ?? "Missing customer"}</TableCell>
              <TableCell>{formatAmountMinor(row.payment.amountMinor, row.payment.currency)}</TableCell>
              <TableCell>{row.payment.programName}</TableCell>
              <TableCell>{row.enteredBy.name}</TableCell>
              <TableCell>{row.dmAttribution.teamName ?? row.dmAttribution.rawSource ?? "None"}</TableCell>
              <TableCell className="text-right">
                <Button variant="ghost" size="icon" asChild aria-label="Open payment">
                  <Link href={`/workspace/billing/${row.payment.id}`}>
                    <ExternalLinkIcon />
                  </Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

**Step 3: Implement the focused read-only client from preloaded data.**

```tsx
// Path: app/workspace/billing/_components/billing-review-page-client.tsx
"use client";

import Link from "next/link";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { ArrowLeftIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/hooks/use-page-title";
import { BillingPaymentSummary } from "./billing-payment-summary";
import { BillingEventHistory } from "./billing-event-history";
import { SlackContributorTimeline } from "./slack-contributor-timeline";

export function BillingReviewPageClient({
  preloadedPayment,
}: {
  preloadedPayment: Preloaded<typeof api.billing.queries.getPaymentDetail>;
}) {
  const detail = usePreloadedQuery(preloadedPayment);
  usePageTitle(detail ? `Billing payment ${detail.payment.id}` : "Billing payment");

  if (!detail) {
    return <div className="text-sm text-muted-foreground">Payment not found.</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" asChild className="self-start">
        <Link href="/workspace/billing">
          <ArrowLeftIcon data-icon="inline-start" />
          Billing
        </Link>
      </Button>
      <BillingPaymentSummary detail={detail} />
      <SlackContributorTimeline events={detail.slackContributorTimeline} />
      <BillingEventHistory events={detail.events} />
    </div>
  );
}
```

**Key implementation notes:**
- `usePaginatedQuery` returns flattened `results`; render exact counts from `api.billing.queries.getPaymentCount`.
- Do not mount `useMutation(api.billing.mutations.markReviewed)` or correction/export actions in Phase 1.
- Table cells must remain readable on smaller widths; use horizontal overflow rather than shrinking text into unreadable columns.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/billing/_components/billing-page-client.tsx` | Create | Queue filters and pagination |
| `app/workspace/billing/_components/billing-queue-table.tsx` | Create | Read-only queue table |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Create | Focused detail client |
| `app/workspace/billing/_components/billing-payment-summary.tsx` | Create | Payment/customer/context sections |
| `app/workspace/billing/_components/billing-event-history.tsx` | Create | Bounded payment events |
| `app/workspace/billing/_components/slack-contributor-timeline.tsx` | Create | Contributor timeline |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | 1A |
| `convex/billing/guards.ts` | Create | 1A |
| `convex/billing/queries.ts` | Create / Modify | 1A, 1B, 1C |
| `convex/billing/validators.ts` | Modify | 1B |
| `convex/billing/queryBuilder.ts` | Create | 1B |
| `convex/billing/enrichment.ts` | Create | 1C |
| `convex/billing/types.ts` | Modify | 1C |
| `convex/reporting/writeHooks.ts` | Modify | 1D |
| `convex/admin/tenantsMutations.ts` | Modify | 1D |
| `app/workspace/billing/page.tsx` | Create | 1E |
| `app/workspace/billing/loading.tsx` | Create | 1E |
| `app/workspace/billing/[paymentRecordId]/page.tsx` | Create | 1E |
| `app/workspace/billing/[paymentRecordId]/loading.tsx` | Create | 1E |
| `app/workspace/billing/_components/billing-unavailable.tsx` | Create | 1E |
| `app/workspace/billing/_components/billing-page-skeleton.tsx` | Create | 1E |
| `app/workspace/billing/_components/billing-page-client.tsx` | Create | 1F |
| `app/workspace/billing/_components/billing-queue-table.tsx` | Create | 1F |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Create | 1F |
| `app/workspace/billing/_components/billing-payment-summary.tsx` | Create | 1F |
| `app/workspace/billing/_components/billing-event-history.tsx` | Create | 1F |
| `app/workspace/billing/_components/slack-contributor-timeline.tsx` | Create | 1F |
