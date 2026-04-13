# v0.6 Diversions

## Phase 3

### 1. Aggregate bounds API, not `prefix + bounds`

**Plan:** Query examples in the design/phase docs show aggregate calls like:

```ts
meetingsByStatus.count(ctx, {
  namespace: tenantId,
  prefix: [closerId, classification, status],
  bounds: dateBounds,
});
```

**Implemented:** The installed `@convex-dev/aggregate` API only accepts a single `bounds` object, and tuple-prefix filtering must be expressed as tuple lower/upper bounds or `{ bounds: { prefix: [...] } }`.

**Why:** The shipped package does not support separate `prefix` and `bounds` parameters on the same query shape.

**Impact:** Team Performance uses `countBatch()` with tuple date bounds over `[closerId, classification, status, scheduledAt]` instead of issuing the exact example calls from the plan.

### 2. Team Performance returns `null` rates for zero-denominator cases

**Plan:** Example code returns `0` for `showUpRate` / `closeRate` when the denominator is zero.

**Implemented:** These rates return `null`.

**Why:** The design later explicitly says zero-meeting closers should display `"—"` instead of `0%` or `NaN`. Returning `null` preserves that distinction at the data layer.

**Impact:** Phase 5 UI should render `null` rates as `"—"`.

### 3. Revenue queries use bounded payment scans, not `paymentSums`

**Plan:** `getRevenueMetrics()` and `getRevenueTrend()` were designed around the `paymentSums` aggregate keyed by `[closerId, recordedAt]`.

**Implemented:** Revenue metrics, details, and trend all use bounded indexed scans of `paymentRecords`, then attribute payments to an effective closer.

**Why:** In the current schema, `paymentRecords.closerId` is the user who recorded the payment, not always the closer who owns the opportunity/customer.

- `logPayment()` records the acting user as `closerId`
- `recordCustomerPayment()` can be executed by an admin
- post-conversion customer payments may belong to the converting closer, not the admin who recorded them

Using the aggregate directly would misattribute closer revenue whenever an admin records a payment.

**Attribution rule used:**

- `contextType === "opportunity"` → attribute to `opportunities.assignedCloserId`
- `contextType === "customer"` → attribute to `customers.convertedByUserId`
- fallback → `paymentRecords.closerId`

**Impact:** Revenue numbers now match closer ownership semantics instead of recorder semantics. This is more correct for reporting, but it means the `paymentSums` aggregate is currently not the source of truth for per-closer revenue queries.

### 4. Lead conversion breakdown uses winning opportunity ownership

**Plan:** `getLeadConversionMetrics()` was designed around the `customerConversions` aggregate keyed by `[convertedByUserId, convertedAt]`.

**Implemented:** The query scans converted customers in-range and attributes each conversion to:

- `opportunities.assignedCloserId` from `winningOpportunityId`, falling back to
- `customers.convertedByUserId`

**Why:** `convertedByUserId` is the actor who performed conversion, which may be an admin. For per-closer reporting, the winning opportunity owner is the better business attribution.

**Impact:** Per-closer conversions reflect closer ownership, not admin/manual conversion activity.

### 5. Extra truncation guards were added on bounded scan queries

**Plan:** Several Phase 3 examples used bounded `.take()` calls but did not consistently surface truncation state.

**Implemented:** Additional safety caps and flags were added on scan-based queries:

- payment-backed queries cap at 2,500 rows
- conversion scans cap at 2,500 rows
- form response distribution caps at 2,500 rows
- pipeline aging caps by status and velocity window
- activity summary caps at 10,000 events, per the design

**Why:** These queries are acceptable at current scale, but the caps make the behavior explicit and safer as data grows.

**Impact:** Several responses now include truncation metadata that the Phase 5 UI can surface if needed.

### 6. Activity feed labels were expanded to match actual emitted events

**Plan:** `eventLabels.ts` included a small illustrative event map.

**Implemented:** The event label map was expanded to cover the event types actually emitted in the current codebase, including:

- `followUp.created`
- `followUp.booked`
- `followUp.completed`
- `meeting.no_show_reverted`
- `opportunity.marked_lost`
- `customer.status_changed`
- `user.created`
- `user.reactivated`

**Why:** The plan’s list was incomplete relative to real event emission sites.

**Impact:** Frontend activity rendering can use the shared map without falling back to raw event type strings for common events.

### 7. Activity feed uses post-filtering for `entityType` in some paths

**Plan:** The feed examples imply index selection by actor/eventType/date and optional entity filters.

**Implemented:** The query picks the most selective existing index:

- actor + date
- else eventType + date
- else tenant + date

Then applies `entityType` filtering in memory when needed.

**Why:** The schema does not currently have an index that covers all filter combinations needed by the report feed.

**Impact:** This is acceptable at current feed volume, but if the activity feed grows materially, a more targeted composite index or event-count aggregate may be needed.

### 8. `getFieldCatalog()` returns a bare array

**Plan:** One example showed a wrapper object with `{ fields, isTruncated }`.

**Implemented:** `getFieldCatalog()` returns the field array directly.

**Why:** The acceptance criteria call for “returns all form fields for the tenant,” and the planned frontend usage also expects a direct array result.

**Impact:** This keeps the API simpler and aligned with the intended consumer.

### 9. Team/revenue responses include exclusion diagnostics

**Plan:** The docs did not call out how to handle payments/conversions that cannot be attributed to an active closer.

**Implemented:** Queries surface exclusion diagnostics such as:

- `excludedRevenueMinor`
- `excludedSales`
- `excludedDealCount`
- `excludedConversions`

**Why:** Because attribution is derived from current ownership fields, some rows can legitimately fall outside the active closer set.

**Impact:** This gives the Phase 5 UI and QA work a way to detect when totals do not fully reconcile to raw table totals.
