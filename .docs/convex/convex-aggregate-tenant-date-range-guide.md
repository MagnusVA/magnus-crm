# Tenantized Date-Range Aggregates With `@convex-dev/aggregate`

This guide shows how to use the Convex Aggregate component in a generic
multi-tenant Convex project, with efficient queries over bounded date ranges.

It is intentionally project-agnostic. Replace table names, auth helpers, role
checks, and field names with the equivalents from your application.

## Goal

Use `@convex-dev/aggregate` when you need fast count, sum, min, max, rank, or
offset queries over many Convex documents without scanning the underlying table.

For tenantized date-range reporting, the core pattern is:

1. Put the tenant boundary in the aggregate `Namespace`.
2. Put the report dimensions in the aggregate `Key`.
3. Put the timestamp as the final part of the key when querying a dimension over
   a bounded date range.
4. Always pass `namespace: tenantId` when reading or writing tenant-scoped
   aggregate data.
5. Update the aggregate in the same mutation that changes the source table.

Example query shape:

```ts
// Count paid orders for tenant A between startAt and endAt.
await ordersByStatusAndDate.count(ctx, {
  namespace: tenantId,
  bounds: {
    lower: { key: ["paid", startAt], inclusive: true },
    upper: { key: ["paid", endAt], inclusive: false },
  },
});
```

That is equivalent to:

```ts
doc.tenantId === tenantId &&
status === "paid" &&
createdAt >= startAt &&
createdAt < endAt
```

The aggregate query avoids reading all matching `orders` documents.

## Install The Component

Install the package:

```bash
npm install @convex-dev/aggregate
```

Register one named aggregate component instance for every independent aggregate
you want to maintain:

```ts
// convex/convex.config.ts
import aggregate from "@convex-dev/aggregate/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();

app.use(aggregate, { name: "ordersByStatusAndDate" });
app.use(aggregate, { name: "ordersByDate" });
app.use(aggregate, { name: "ordersByStatusPlanAndDate" });

export default app;
```

Use multiple component names when you need multiple sort keys or different query
shapes. Do not try to make one aggregate handle every possible filter.

## Example Schema

This guide uses an `orders` table:

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({
    name: v.string(),
  }),

  customers: defineTable({
    tenantId: v.id("tenants"),
    name: v.string(),
  }).index("by_tenantId", ["tenantId"]),

  orders: defineTable({
    tenantId: v.id("tenants"),
    customerId: v.id("customers"),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("refunded"),
      v.literal("failed"),
    ),
    plan: v.union(
      v.literal("starter"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    amountMinor: v.number(),
    createdAt: v.number(),
  })
    .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"])
    .index("by_tenantId_and_status_and_createdAt", [
      "tenantId",
      "status",
      "createdAt",
    ]),
});
```

The aggregate component does not replace normal indexes. Keep indexes for list
views and drill-down pages. Use aggregates for summary counts and sums.

## Define A Tenantized Aggregate

Create a module that defines the aggregate instances:

```ts
// convex/orderAggregates.ts
import { TableAggregate } from "@convex-dev/aggregate";
import { components } from "./_generated/api";
import type { DataModel, Doc, Id } from "./_generated/dataModel";

type OrderStatus = Doc<"orders">["status"];
type OrderPlan = Doc<"orders">["plan"];

export const ordersByStatusAndDate = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [OrderStatus, number];
  DataModel: DataModel;
  TableName: "orders";
}>(components.ordersByStatusAndDate, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.createdAt],
  sumValue: (doc) => doc.amountMinor,
});

export const ordersByDate = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: number;
  DataModel: DataModel;
  TableName: "orders";
}>(components.ordersByDate, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => doc.createdAt,
  sumValue: (doc) => doc.amountMinor,
});

export const ordersByStatusPlanAndDate = new TableAggregate<{
  Namespace: Id<"tenants">;
  Key: [OrderStatus, OrderPlan, number];
  DataModel: DataModel;
  TableName: "orders";
}>(components.ordersByStatusPlanAndDate, {
  namespace: (doc) => doc.tenantId,
  sortKey: (doc) => [doc.status, doc.plan, doc.createdAt],
  sumValue: (doc) => doc.amountMinor,
});
```

The important decisions are:

- `Namespace: Id<"tenants">` creates a separate aggregate tree per tenant.
- `namespace: (doc) => doc.tenantId` assigns each row to its tenant tree.
- `Key: [OrderStatus, number]` supports status-specific date-range queries.
- `Key: number` supports all-orders date-range queries.
- `Key: [OrderStatus, OrderPlan, number]` supports status-plus-plan date-range
  queries.
- `sumValue` is optional. Add it when you also need `sum()`.

## Build Date Bounds Helpers

Prefer half-open date ranges: `[startAt, endAt)`.

This means:

- Include rows at exactly `startAt`.
- Exclude rows at exactly `endAt`.
- Adjacent ranges do not double count boundary rows.

```ts
// convex/aggregateBounds.ts
import type { Value } from "convex/values";

export function assertValidDateRange(startAt: number, endAt: number) {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt)) {
    throw new Error("Date bounds must be finite numbers.");
  }

  if (startAt >= endAt) {
    throw new Error("startAt must be earlier than endAt.");
  }
}

export function dateBounds(startAt: number, endAt: number) {
  assertValidDateRange(startAt, endAt);

  return {
    lower: { key: startAt, inclusive: true as const },
    upper: { key: endAt, inclusive: false as const },
  };
}

export function tupleDateBounds<TPrefix extends readonly Value[]>(
  prefix: TPrefix,
  startAt: number,
  endAt: number,
) {
  assertValidDateRange(startAt, endAt);

  return {
    lower: {
      key: [...prefix, startAt] as [...TPrefix, number],
      inclusive: true as const,
    },
    upper: {
      key: [...prefix, endAt] as [...TPrefix, number],
      inclusive: false as const,
    },
  };
}
```

Use `dateBounds()` when the aggregate key is just a timestamp. Use
`tupleDateBounds()` when the key is dimensions followed by a timestamp.

## Query A Tenantized Date Range

This is a generic public query. Replace `getTenantIdFromAuth()` with your auth
implementation.

```ts
// convex/orderReports.ts
import { v } from "convex/values";
import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { dateBounds, tupleDateBounds } from "./aggregateBounds";
import {
  ordersByDate,
  ordersByStatusAndDate,
  ordersByStatusPlanAndDate,
} from "./orderAggregates";

async function getTenantIdFromAuth(ctx: QueryCtx): Promise<Id<"tenants">> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    throw new Error("Unauthenticated.");
  }

  // Replace this with your app's mapping from identity to tenant ID.
  // Examples:
  // - identity.orgId from an auth provider
  // - a users table lookup
  // - a memberships table lookup
  // - an organizations table lookup
  throw new Error("Implement getTenantIdFromAuth for your application.");
}

const orderStatus = v.union(
  v.literal("pending"),
  v.literal("paid"),
  v.literal("refunded"),
  v.literal("failed"),
);

const orderPlan = v.union(
  v.literal("starter"),
  v.literal("pro"),
  v.literal("enterprise"),
);

export const orderSummary = query({
  args: {
    startAt: v.number(),
    endAt: v.number(),
    status: v.optional(orderStatus),
    plan: v.optional(orderPlan),
  },
  handler: async (ctx, args) => {
    const tenantId = await getTenantIdFromAuth(ctx);

    if (args.status && args.plan) {
      const bounds = tupleDateBounds(
        [args.status, args.plan] as const,
        args.startAt,
        args.endAt,
      );

      const [count, amountMinor] = await Promise.all([
        ordersByStatusPlanAndDate.count(ctx, { namespace: tenantId, bounds }),
        ordersByStatusPlanAndDate.sum(ctx, { namespace: tenantId, bounds }),
      ]);

      return { count, amountMinor };
    }

    if (args.status) {
      const bounds = tupleDateBounds(
        [args.status] as const,
        args.startAt,
        args.endAt,
      );

      const [count, amountMinor] = await Promise.all([
        ordersByStatusAndDate.count(ctx, { namespace: tenantId, bounds }),
        ordersByStatusAndDate.sum(ctx, { namespace: tenantId, bounds }),
      ]);

      return { count, amountMinor };
    }

    if (args.plan) {
      throw new Error(
        "Plan-only reporting needs its own aggregate: ordersByPlanAndDate.",
      );
    }

    const bounds = dateBounds(args.startAt, args.endAt);
    const [count, amountMinor] = await Promise.all([
      ordersByDate.count(ctx, { namespace: tenantId, bounds }),
      ordersByDate.sum(ctx, { namespace: tenantId, bounds }),
    ]);

    return { count, amountMinor };
  },
});
```

Notice the explicit failure for `plan` without `status`. The key
`[status, plan, createdAt]` cannot efficiently answer a plan-only date-range
query because `plan` is in the middle of the tuple. Add a separate aggregate
with key `[plan, createdAt]` if that query matters.

## Keep Writes In Sync

The aggregate is a derived data structure. Every mutation that inserts, updates,
or deletes an `orders` document must update every aggregate that tracks orders.

Wrap writes in helper functions so the update contract is hard to forget:

```ts
// convex/orderWrites.ts
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  ordersByDate,
  ordersByStatusAndDate,
  ordersByStatusPlanAndDate,
} from "./orderAggregates";

async function syncOrderInsert(ctx: MutationCtx, order: Doc<"orders">) {
  await Promise.all([
    ordersByDate.insert(ctx, order),
    ordersByStatusAndDate.insert(ctx, order),
    ordersByStatusPlanAndDate.insert(ctx, order),
  ]);
}

async function syncOrderReplace(
  ctx: MutationCtx,
  before: Doc<"orders">,
  after: Doc<"orders">,
) {
  await Promise.all([
    ordersByDate.replace(ctx, before, after),
    ordersByStatusAndDate.replace(ctx, before, after),
    ordersByStatusPlanAndDate.replace(ctx, before, after),
  ]);
}

async function syncOrderDelete(ctx: MutationCtx, order: Doc<"orders">) {
  await Promise.all([
    ordersByDate.delete(ctx, order),
    ordersByStatusAndDate.delete(ctx, order),
    ordersByStatusPlanAndDate.delete(ctx, order),
  ]);
}

export async function insertOrder(
  ctx: MutationCtx,
  fields: Omit<Doc<"orders">, "_id" | "_creationTime">,
) {
  const orderId = await ctx.db.insert("orders", fields);
  const order = await ctx.db.get(orderId);
  if (!order) {
    throw new Error("Inserted order not found.");
  }

  await syncOrderInsert(ctx, order);
  return orderId;
}

export async function patchOrder(
  ctx: MutationCtx,
  orderId: Id<"orders">,
  patch: Partial<Pick<Doc<"orders">, "status" | "plan" | "amountMinor">>,
) {
  const before = await ctx.db.get(orderId);
  if (!before) {
    throw new Error("Order not found.");
  }

  await ctx.db.patch(orderId, patch);

  const after = await ctx.db.get(orderId);
  if (!after) {
    throw new Error("Patched order not found.");
  }

  await syncOrderReplace(ctx, before, after);
}

export async function deleteOrder(ctx: MutationCtx, orderId: Id<"orders">) {
  const before = await ctx.db.get(orderId);
  if (!before) {
    return;
  }

  await ctx.db.delete(orderId);
  await syncOrderDelete(ctx, before);
}
```

Convex mutations are transactional, so the source document and aggregate update
commit together. Queries will not observe the source table updated but the
aggregate stale, as long as both writes happen in the same mutation.

## Public Mutation Example

```ts
// convex/orders.ts
import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { insertOrder, patchOrder } from "./orderWrites";

export const createOrder = mutation({
  args: {
    tenantId: v.id("tenants"),
    customerId: v.id("customers"),
    status: v.union(
      v.literal("pending"),
      v.literal("paid"),
      v.literal("refunded"),
      v.literal("failed"),
    ),
    plan: v.union(
      v.literal("starter"),
      v.literal("pro"),
      v.literal("enterprise"),
    ),
    amountMinor: v.number(),
  },
  handler: async (ctx, args) => {
    // In a real multi-tenant app, do not trust tenantId from client args.
    // Derive it from auth, then verify that customerId belongs to that tenant.
    return await insertOrder(ctx, {
      tenantId: args.tenantId,
      customerId: args.customerId,
      status: args.status,
      plan: args.plan,
      amountMinor: args.amountMinor,
      createdAt: Date.now(),
    });
  },
});

export const markOrderPaid = mutation({
  args: {
    orderId: v.id("orders"),
  },
  handler: async (ctx, args) => {
    await patchOrder(ctx, args.orderId, {
      status: "paid",
    });
  },
});
```

For production tenant isolation, derive `tenantId` from auth or membership data.
Client-provided tenant IDs are easy to spoof.

## Optional Filters Need Their Own Key Shapes

Aggregate keys behave like sorted index keys. Prefixes work from left to right.

Good key for status-specific date range:

```ts
Key: [OrderStatus, number];
sortKey: (doc) => [doc.status, doc.createdAt];
```

Efficient queries:

```ts
// All paid orders in date range.
tupleDateBounds(["paid"], startAt, endAt);

// All orders with status paid, no date range.
{ prefix: ["paid"] }
```

Not efficient with this key:

```ts
// All statuses in date range.
// You cannot skip status and bound only createdAt.
```

Add this aggregate for all-status date ranges:

```ts
Key: number;
sortKey: (doc) => doc.createdAt;
```

For optional filters, model the common query shapes:

| Desired query | Suggested key |
| --- | --- |
| All rows in date range | `[createdAt]` or `createdAt` |
| Status in date range | `[status, createdAt]` |
| Plan in date range | `[plan, createdAt]` |
| Status plus plan in date range | `[status, plan, createdAt]` |
| Customer in date range | `[customerId, createdAt]` |
| Status plus customer in date range | `[status, customerId, createdAt]` |

Do not create aggregates for filters nobody uses. Each aggregate adds write work
and backfill work.

## Batch Counts For Dashboards

Dashboards often need many related counts, such as totals for every status.
Use batch APIs when possible:

```ts
const statuses = ["pending", "paid", "refunded", "failed"] as const;

const boundsForStatuses = statuses.map((status) => ({
  namespace: tenantId,
  bounds: tupleDateBounds([status] as const, startAt, endAt),
}));

const [counts, sums] = await Promise.all([
  ordersByStatusAndDate.countBatch(ctx, boundsForStatuses),
  ordersByStatusAndDate.sumBatch(ctx, boundsForStatuses),
]);

return statuses.map((status, index) => ({
  status,
  count: counts[index],
  amountMinor: sums[index],
}));
```

Batch APIs reduce repeated component calls and are a good fit for summary cards,
breakdowns, and charts.

## Prefix Bounds Vs Date Bounds

Use `prefix` when you want the entire group:

```ts
await ordersByStatusAndDate.count(ctx, {
  namespace: tenantId,
  bounds: { prefix: ["paid"] },
});
```

Use lower and upper bounds when the final part of the key is a range:

```ts
await ordersByStatusAndDate.count(ctx, {
  namespace: tenantId,
  bounds: {
    lower: { key: ["paid", startAt], inclusive: true },
    upper: { key: ["paid", endAt], inclusive: false },
  },
});
```

Use `eq` for an exact key:

```ts
await ordersByDate.count(ctx, {
  namespace: tenantId,
  bounds: { eq: createdAt },
});
```

Exact timestamp queries are uncommon because multiple rows may share the same
timestamp. Date ranges are usually more useful.

## Using `sumValue`

If you define:

```ts
sumValue: (doc) => doc.amountMinor
```

Then:

```ts
await aggregate.sum(ctx, { namespace, bounds });
```

returns the sum of `amountMinor` for all rows in the bound.

You can encode business rules in `sumValue`:

```ts
sumValue: (doc) => {
  if (doc.status === "refunded" || doc.status === "failed") {
    return 0;
  }
  return doc.amountMinor;
}
```

The count still counts rows in the bound. The sum only reflects your `sumValue`
function. If you need separate count semantics, use a different aggregate or
exclude rows at write time with conditional insert/delete logic.

## Conditional Eligibility

Sometimes only some documents should be included in an aggregate. For example,
you may only want paid orders in a revenue aggregate.

Define an eligibility helper:

```ts
function isRevenueEligible(order: Doc<"orders">) {
  return order.status === "paid";
}
```

Use idempotent methods during updates where eligibility may change:

```ts
async function syncRevenueReplace(
  ctx: MutationCtx,
  before: Doc<"orders">,
  after: Doc<"orders">,
) {
  const beforeEligible = isRevenueEligible(before);
  const afterEligible = isRevenueEligible(after);

  if (beforeEligible && afterEligible) {
    await revenueByDate.replace(ctx, before, after);
  } else if (beforeEligible) {
    await revenueByDate.delete(ctx, before);
  } else if (afterEligible) {
    await revenueByDate.insert(ctx, after);
  }
}
```

When you are backfilling an existing table or repairing drift, use the
idempotent variants:

```ts
await revenueByDate.insertIfDoesNotExist(ctx, after);
await revenueByDate.deleteIfExists(ctx, before);
await revenueByDate.replaceOrInsert(ctx, before, after);
```

## Existing Data Requires A Backfill

If you add an aggregate to a table that already has data, new writes will not
magically populate historical aggregate entries. You need a migration/backfill.

Safe rollout:

1. Register the aggregate in `convex.config.ts`.
2. Add aggregate definitions.
3. Update live write paths to use idempotent methods such as
   `insertIfDoesNotExist`, `replaceOrInsert`, and `deleteIfExists`.
4. Deploy.
5. Run a paginated backfill over existing source documents.
6. Verify aggregate counts against bounded source-table counts for sampled
   ranges.
7. Switch live write paths to strict methods: `insert`, `replace`, and `delete`.

Sketch:

```ts
// convex/backfillOrderAggregates.ts
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  ordersByDate,
  ordersByStatusAndDate,
  ordersByStatusPlanAndDate,
} from "./orderAggregates";

const PAGE_SIZE = 100;

export const backfillOrderAggregates = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("orders")
      .paginate({ cursor: args.cursor ?? null, numItems: PAGE_SIZE });

    for (const order of page.page) {
      await Promise.all([
        ordersByDate.insertIfDoesNotExist(ctx, order),
        ordersByStatusAndDate.insertIfDoesNotExist(ctx, order),
        ordersByStatusPlanAndDate.insertIfDoesNotExist(ctx, order),
      ]);
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.backfillOrderAggregates.backfillOrderAggregates,
        { cursor: page.continueCursor },
      );
    }
  },
});
```

Adjust the file path in the `internal` reference for your actual file name.

## Verification Query

During rollout, compare aggregate results to a bounded source-table scan for
small ranges:

```ts
export const verifyPaidOrdersForRange = query({
  args: {
    tenantId: v.id("tenants"),
    startAt: v.number(),
    endAt: v.number(),
  },
  handler: async (ctx, args) => {
    const aggregateCount = await ordersByStatusAndDate.count(ctx, {
      namespace: args.tenantId,
      bounds: tupleDateBounds(["paid"] as const, args.startAt, args.endAt),
    });

    const sourceRows = await ctx.db
      .query("orders")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("status", "paid")
          .gte("createdAt", args.startAt)
          .lt("createdAt", args.endAt),
      )
      .take(501);

    const sourceTruncated = sourceRows.length > 500;

    return {
      aggregateCount,
      sourceCount: sourceTruncated ? null : sourceRows.length,
      sourceTruncated,
      match: !sourceTruncated && aggregateCount === sourceRows.length,
    };
  },
});
```

This verification intentionally caps source reads. Do not introduce unbounded
table scans in production queries.

## Repairing Drift

Aggregate drift happens when a source-table write bypasses the aggregate update.

Repair options:

1. Clear the aggregate namespace and backfill it again.
2. Rename the component instance and backfill the new one.
3. Diff source documents against aggregate pages and repair incrementally.

For tenantized aggregates, prefer tenant-bounded repairs:

```ts
await ordersByStatusAndDate.clear(ctx, { namespace: tenantId });
```

Then backfill only documents for that tenant. If your table is large, schedule
the work in small batches.

## Performance Notes

Namespaces are important for multi-tenant systems. Each namespace has its own
aggregate data structure, so writes for one tenant do not contend with another
tenant's aggregate tree.

Bounds are also important. A query like:

```ts
await ordersByDate.count(ctx, { namespace: tenantId });
```

depends on the whole tenant aggregate. A bounded query like:

```ts
await ordersByDate.count(ctx, {
  namespace: tenantId,
  bounds: dateBounds(startAt, endAt),
});
```

has a narrower read footprint and is better for reactive dashboards.

Avoid using a monotonically increasing timestamp as the only key for extremely
high write volume across a single namespace if the workload can be partitioned
more naturally. If you need both all-date and dimension-specific reporting,
define both aggregates and query the narrowest one that answers the question.

## Common Mistakes

Do not put `tenantId` only in the key if this is hard multi-tenancy:

```ts
// Works functionally, but poorer tenant isolation and more shared contention.
Key: [Id<"tenants">, OrderStatus, number];
sortKey: (doc) => [doc.tenantId, doc.status, doc.createdAt];
```

Prefer:

```ts
Namespace: Id<"tenants">;
Key: [OrderStatus, number];
namespace: (doc) => doc.tenantId;
sortKey: (doc) => [doc.status, doc.createdAt];
```

Do not query a middle tuple field without a prefix:

```ts
// Key is [status, plan, createdAt].
// This cannot efficiently answer plan-only date ranges.
```

Do not forget updates:

```ts
await ctx.db.patch(orderId, { status: "paid" });
// Missing aggregate.replace(ctx, before, after)
```

Do not use closed date ranges for adjacent reporting windows:

```ts
// Risk of double-counting boundary timestamps across adjacent windows.
upper: { key: ["paid", endAt], inclusive: true }
```

Prefer:

```ts
upper: { key: ["paid", endAt], inclusive: false }
```

Do not trust tenant IDs from client args. Derive tenant identity from auth or a
server-side membership lookup.

## Checklist

Before using a tenantized date-range aggregate in production:

- The source table has a tenant field.
- The aggregate uses `Namespace` for tenant partitioning.
- The timestamp is the final key element for date-bounded queries.
- Every required optional-filter combination has its own aggregate key shape.
- The query derives `tenantId` server-side.
- The query uses `[startAt, endAt)` bounds.
- The mutation write path updates the aggregate transactionally.
- Existing data has a backfill plan.
- Rollout uses idempotent aggregate methods until backfill is complete.
- Verification compares aggregate results to bounded source-table reads.
- Repair tooling can clear or rebuild at least one tenant namespace.

## References

- [Convex Aggregate component README](https://github.com/get-convex/aggregate)
- [Convex database types](https://docs.convex.dev/database/types)
- [Convex data CLI reference](https://docs.convex.dev/cli/reference/data)
