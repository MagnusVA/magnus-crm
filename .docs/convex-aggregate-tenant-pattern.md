# Convex aggregate component — tenant-scoped pattern

This document walks through one strong example in this repo: **billing payment counts**. It shows tenant isolation end-to-end without scanning `paymentRecords` for every filter.

## The pattern in one sentence

**`tenantId` is the aggregate namespace** (partition key). Writes derive it from the document; reads derive it from auth. Client filter args never choose the tenant.

---

## 1. Register component instances

Each aggregate is a named Convex component instance in `convex/convex.config.ts`:

```ts
app.use(aggregate, { name: "billingPaymentsByStatus" });
app.use(aggregate, { name: "billingPaymentsByStatusProgram" });
app.use(aggregate, { name: "billingPaymentsByStatusType" });
app.use(aggregate, { name: "billingPaymentsByStatusProgramType" });
```

Billing uses four variants so counts can hit the narrowest B-tree for the filter shape (status only vs status+program vs status+type vs all three).

Reporting uses the same pattern for `meetingsByStatus`, `paymentSums`, `opportunityByStatus`, `leadTimeline`, `customerConversions`, and Slack qualification aggregates.

---

## 2. Define aggregates with `Namespace: Id<"tenants">`

The type and `namespace` callback make tenant partitioning explicit (`convex/billing/aggregates.ts`):

```ts
export const billingPaymentsByStatus = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [PaymentStatus, number];
  DataModel: DataModel;
  TableName: "paymentRecords";
}>(components.billingPaymentsByStatus, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.recordedAt],
});
```

Every payment row lands in **that tenant’s** subtree. `sortKey` orders within the namespace so you can count by status and slice by `recordedAt` with bounds (not full table scans).

The same `namespace: (doc) => doc.tenantId` pattern appears on reporting aggregates in `convex/reporting/aggregates.ts` (`meetingsByStatus`, `opportunityByStatus`, etc.).

---

## 3. Keep writes in sync (mutation side)

Payment mutations call centralized hooks; billing aggregates stay in sync via `insertIfDoesNotExist` / `replaceOrInsert` / `deleteIfExists`:

```ts
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
```

Those run from `insertPaymentAggregate` / `replacePaymentAggregate` in `convex/reporting/writeHooks.ts` whenever payments are created or updated (closer flows, side deals, customer conversion, etc.). The document’s `tenantId` drives namespace on insert — no separate tenant argument on the aggregate API.

---

## 4. Read with auth-derived `tenantId` + `namespace`

Queries never trust a client-supplied tenant id for counting (`convex/billing/queries.ts`):

```ts
export const listPayments = query({
  args: listPaymentsArgsValidator,
  handler: async (ctx, args) => {
    const { tenantId } = await requireBillingPermission(ctx, "billing:view");
    await requireBillingOpsEnabled(ctx, tenantId);

    const page = await paginateBillingPaymentQuery(ctx, tenantId, args, args.paginationOpts);

    return {
      ...page,
      page: await enrichBillingPaymentListRows(ctx, tenantId, page.page),
      exactCount: await countBillingPayments(ctx, tenantId, args),
    };
  },
});
```

`countBillingPayments` picks the right aggregate and always passes `namespace: tenantId`, with optional date bounds on the sort key:

```ts
return await billingPaymentsByStatus.count(ctx, {
  namespace: tenantId,
  bounds: hasDateBounds
    ? {
        lower: { key: [args.status, startAt], inclusive: true },
        upper: { key: [args.status, endAt], inclusive: false },
      }
    : { prefix: [args.status] },
});
```

So “how many recorded payments in March for program X?” is **O(log n)** in that tenant’s partition, not a paginated scan of the whole table.

Program filters are also tenant-checked before export:

```ts
async function assertProgramFilterForTenant(ctx, tenantId, programId) {
  if (!programId) return;
  const program = await ctx.db.get(programId);
  if (!program || program.tenantId !== tenantId) {
    throw new Error("Program not found.");
  }
}
```

---

## 5. Tenant-scoped maintenance (backfill / reset)

Backfills paginate **one tenant** via index, optionally clear only that namespace, then re-insert (`convex/billing/backfill.ts`):

```ts
if (reset === true && cursor === undefined) {
  await clearBillingPaymentAggregatesForTenant(ctx, tenantId);
}

const result = await ctx.db
  .query("paymentRecords")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .paginate({ numItems: BACKFILL_BATCH_SIZE, cursor: cursor ?? null });

for (const payment of result.page) {
  await insertBillingPaymentAggregates(ctx, payment);
}
```

`clearBillingPaymentAggregatesForTenant` calls `.clear(ctx, { namespace: tenantId })` on all four billing aggregates — no cross-tenant wipe.

Verification across tenants uses the same namespace API in `convex/reporting/verification.ts` (`aggregate.count(ctx, { namespace: tenant._id })` per tenant).

---

## Simpler read-only cousin: pipeline distribution

Minimal “count by status for my tenant” read in `convex/reporting/pipelineHealth.ts`:

```ts
export const getPipelineDistribution = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, ["tenant_master", "tenant_admin"]);

    const counts = await opportunityByStatus.countBatch(
      ctx,
      OPPORTUNITY_STATUSES.map((status) => ({
        namespace: tenantId,
        bounds: { prefix: [status] },
      })),
    );

    return {
      distribution: OPPORTUNITY_STATUSES.map((status, index) => ({
        status,
        count: counts[index] ?? 0,
      })),
    };
  },
});
```

Same tenant model; billing adds richer keys, multiple aggregate trees, and date-range bounds.

---

## What makes this elegant for multi-tenancy

| Layer | Mechanism |
|--------|-----------|
| **Partition** | `Namespace: Id<"tenants">` + `namespace: (doc) => doc.tenantId` |
| **Auth** | `tenantId` from `requireBillingPermission` / `requireTenantUser`, not from untrusted args |
| **Writes** | Document-driven namespace; shared hooks on payment lifecycle |
| **Reads** | `count(..., { namespace: tenantId, bounds })` — tenant + filter in one call |
| **Ops** | Per-tenant `clear` + indexed backfill |

**Recipe:** namespace = tenant, sort key = report dimensions, hooks on write, auth on read.

---

## Key files

| File | Role |
|------|------|
| `convex/convex.config.ts` | Register aggregate component instances |
| `convex/billing/aggregates.ts` | Billing aggregate definitions + `countBillingPayments` |
| `convex/billing/queries.ts` | Auth-scoped queries using aggregates |
| `convex/billing/backfill.ts` | Per-tenant backfill and reset |
| `convex/reporting/aggregates.ts` | Reporting aggregate definitions |
| `convex/reporting/writeHooks.ts` | Central payment/meeting/opportunity sync |
| `convex/reporting/pipelineHealth.ts` | Example `countBatch` read for opportunities |
| `convex/reporting/verification.ts` | Cross-tenant aggregate vs table parity checks |
