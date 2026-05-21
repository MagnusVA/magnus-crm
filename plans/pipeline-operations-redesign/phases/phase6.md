# Phase 6 — Reporting & Analytics Alignment

**Goal:** Align `/workspace/reports/*`, Slack metrics, and PostHog instrumentation with the Operations model. Reports must say exactly whether they count qualification events, unique opportunities, booked program, sold program, or payment program.

**Prerequisite:** Phases 2-5 are complete: attribution fields are widened/backfilled, `slackQualificationEvents` and `operationsQualificationRows` exist, meeting stats rollups exist, and detail pages expose the same attribution vocabulary.

**Runs in PARALLEL with:** Nothing. This phase depends on the Phase 2 attribution contract, the Phase 3 qualification ledger, the Phase 4 scheduling rollup, and the Phase 5 detail links.

**Skills to invoke:**
- `convex-performance-audit` — review reporting queries, aggregate usage, bounded scans, and read amplification.
- `convex-migration-helper` — use if reporting parity requires a new aggregate, rollup table, or backfill.
- `vercel-react-best-practices` — keep report client state localized and avoid avoidable rerenders across chart/table sections.
- `web-design-guidelines` — keep dense report tables, filters, and empty states scannable.
- `.docs/posthog/nextjs-setup.md` and `.docs/posthog/posthog-convex.md` — verify analytics event hygiene and existing PostHog patterns.

**Acceptance Criteria:**
1. `/workspace/reports/slack-qualifications` clearly distinguishes qualification events from unique Slack-sourced opportunities.
2. Slack qualification totals reconcile against `slackQualificationEvents`, including duplicate/already-booked attempts that did not create a new opportunity.
3. Pipeline Health reports can group or filter scheduling/show-rate metrics by `bookingProgramId`, `attributionTeamId`, and `dmCloserId`.
4. Team Performance reports distinguish phone closer performance from DM closer/setter attribution.
5. Revenue reports continue to use `paymentRecords.programId` and `customers.programId` as sold-program/payment-program source of truth.
6. A Booked → Sold Program matrix is available to admins and includes explicit unknown buckets for historical or side-deal rows.
7. Report UI copy labels every program filter as `Booked program`, `Sold program`, or `Payment program`; no generic `Program` label remains where the dimension is ambiguous.
8. PostHog events use normalized enum/boolean properties only and do not send raw UTM strings, social handles, customer names, emails, phone numbers, Slack IDs, Calendly URIs, or document IDs.
9. All new report links route to `/workspace/operations` or existing entity detail pages without breaking the workspace shell.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (dimension vocabulary) ──────────────┬── 6C (pipeline/team report filters)
                                        ├── 6D (booked-to-sold matrix)
                                        └── 6E (analytics event hygiene)

6B (Slack ledger reconciliation) ───────┬── 6C (team setter dimensions)
                                        └── 6F (parity checklist)

6C + 6D + 6E complete ───────────────────── 6F (rollout parity checks)
```

**Optimal execution:**
1. Start 6A first so backend and frontend code share the same report dimension names.
2. Run 6B after 6A because Slack report copy and metrics need the event/opportunity vocabulary.
3. Run 6C, 6D, and 6E in parallel after 6A; they touch separate report areas.
4. Finish with 6F after all report numbers are available for parity comparison.

**Estimated time:** 3-5 days

---

## Subphases

### 6A — Reporting Dimension Vocabulary

**Type:** Full-Stack
**Parallelizable:** No — report queries and UI filters should use the same labels before any report is modified.

**What:** Create shared dimension helpers for booked program, sold program, payment program, qualification events, and opportunity entities; then update common report filter copy.

**Why:** The design intentionally separates booking intent from payment outcome. Without shared labels, reports can accidentally make `bookingProgramId` look like revenue attribution.

**Where:**
- `convex/reporting/lib/programDimensions.ts` (new)
- `app/workspace/reports/_components/report-program-filter.tsx` (modify)
- `app/workspace/reports/_components/report-program-dimension-filter.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx` (modify)
- `app/workspace/reports/team/_components/team-report-types.ts` (modify)

**How:**

**Step 1: Add backend-safe report dimension helpers.**

```typescript
// Path: convex/reporting/lib/programDimensions.ts
import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";

export const reportProgramDimensionValidator = v.union(
  v.literal("booking_program"),
  v.literal("sold_program"),
  v.literal("payment_program"),
);

export type ReportProgramDimension =
  | "booking_program"
  | "sold_program"
  | "payment_program";

export function getProgramDimensionLabel(
  dimension: ReportProgramDimension,
): string {
  switch (dimension) {
    case "booking_program":
      return "Booked program";
    case "sold_program":
      return "Sold program";
    case "payment_program":
      return "Payment program";
  }
}

export function getBookingProgramId(
  row:
    | Pick<Doc<"meetings">, "bookingProgramId">
    | Pick<Doc<"opportunities">, "firstBookingProgramId">
    | null
    | undefined,
): Id<"tenantPrograms"> | undefined {
  if (!row) return undefined;
  if ("bookingProgramId" in row) return row.bookingProgramId;
  return row.firstBookingProgramId;
}

export function getSoldProgramId(
  row:
    | Pick<Doc<"customers">, "programId">
    | Pick<Doc<"paymentRecords">, "programId">
    | Pick<Doc<"opportunities">, "soldProgramId">
    | null
    | undefined,
): Id<"tenantPrograms"> | undefined {
  if (!row) return undefined;
  if ("soldProgramId" in row) return row.soldProgramId;
  return row.programId;
}
```

**Step 2: Add a dimension-aware report filter wrapper.**

```tsx
// Path: app/workspace/reports/_components/report-program-dimension-filter.tsx
"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { ReportProgramFilter } from "./report-program-filter";

type ProgramDimension = "booking_program" | "sold_program" | "payment_program";

const LABELS: Record<ProgramDimension, string> = {
  booking_program: "Booked program",
  sold_program: "Sold program",
  payment_program: "Payment program",
};

export function ReportProgramDimensionFilter({
  dimension,
  value,
  onChange,
}: {
  dimension: ProgramDimension;
  value?: Id<"tenantPrograms">;
  onChange: (value: Id<"tenantPrograms"> | undefined) => void;
}) {
  return (
    <ReportProgramFilter
      value={value}
      onChange={onChange}
      label={LABELS[dimension]}
    />
  );
}
```

**Step 3: Update the existing program filter to accept explicit labels.**

```tsx
// Path: app/workspace/reports/_components/report-program-filter.tsx
interface ReportProgramFilterProps {
  value?: Id<"tenantPrograms">;
  onChange: (next: Id<"tenantPrograms"> | undefined) => void;
  label?: string;
}

export function ReportProgramFilter({
  value,
  onChange,
  label = "Payment program",
}: ReportProgramFilterProps) {
  return (
    <Select value={value ?? ALL_SENTINEL} onValueChange={handleChange}>
      <SelectTrigger className="w-[12rem]" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectLabel>{label}</SelectLabel>
        <SelectItem value={ALL_SENTINEL}>All {label.toLowerCase()}s</SelectItem>
        {programs.map((program) => (
          <SelectItem key={program._id} value={program._id}>
            {program.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
```

**Key implementation notes:**
- Use `bookingProgram*` for schema/code fields and `Booked program` for user-facing copy.
- Revenue pages should pass `dimension="payment_program"` or `dimension="sold_program"`, never the default generic label.
- Do not import client components into Convex modules; keep label helpers duplicated only if the import boundary demands it.
- Search all report UI files for `Program` after implementation and verify ambiguous copy was replaced.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/programDimensions.ts` | Create | Backend report dimension helpers |
| `app/workspace/reports/_components/report-program-filter.tsx` | Modify | Add explicit label prop |
| `app/workspace/reports/_components/report-program-dimension-filter.tsx` | Create | Dimension-aware UI wrapper |
| `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx` | Modify | Rename copy to payment/sold program |
| `app/workspace/reports/team/_components/team-report-types.ts` | Modify | Add typed dimension names |

---

### 6B — Slack Qualification Ledger Reconciliation

**Type:** Backend
**Parallelizable:** Yes — depends on 6A vocabulary and Phase 3 ledger tables.

**What:** Update Slack qualification reporting and Slack metric helpers to count `slackQualificationEvents` as operational activity while still exposing unique opportunity conversion separately.

**Why:** The existing reporting path counts Slack-sourced opportunities through aggregates. Phase 3 adds duplicate/already-booked qualification events that do not always create opportunities, so opportunity counts alone understate setter work.

**Where:**
- `convex/reporting/slackQualifications.ts` (modify)
- `convex/slack/metrics.ts` (modify)
- `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` (modify)
- `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx` (modify)
- `app/workspace/reports/slack-qualifications/_components/setter-contribution-table.tsx` (modify)
- `app/workspace/operations/_components/qualification-tab.tsx` (modify after Phase 3 creates it)

**How:**

**Step 1: Add a bounded ledger range helper.**

```typescript
// Path: convex/reporting/slackQualifications.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

const MAX_QUALIFICATION_EVENTS = 1000;

async function listQualificationEventsForRange(
  ctx: QueryCtx,
  args: {
    tenantId: Id<"tenants">;
    start: number;
    end: number;
    slackUserId?: string;
  },
): Promise<{ rows: Doc<"slackQualificationEvents">[]; truncated: boolean }> {
  const query = args.slackUserId
    ? ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_slackUserId_and_submittedAt", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("slackUserId", args.slackUserId!)
            .gte("submittedAt", args.start)
            .lt("submittedAt", args.end),
        )
    : ctx.db
        .query("slackQualificationEvents")
        .withIndex("by_tenantId_and_submittedAt", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .gte("submittedAt", args.start)
            .lt("submittedAt", args.end),
        );

  const rows = await query.take(MAX_QUALIFICATION_EVENTS + 1);
  return {
    rows: rows.slice(0, MAX_QUALIFICATION_EVENTS),
    truncated: rows.length > MAX_QUALIFICATION_EVENTS,
  };
}
```

**Step 2: Return both event counts and unique opportunity counts.**

```typescript
// Path: convex/reporting/slackQualifications.ts
function summarizeQualificationEvents(rows: Doc<"slackQualificationEvents">[]) {
  const uniqueOpportunityIds = new Set<string>();
  let createdOpportunityEvents = 0;
  let duplicatePendingEvents = 0;
  let alreadyBookedEvents = 0;
  let unlinkedEvents = 0;

  for (const row of rows) {
    if (row.opportunityId) uniqueOpportunityIds.add(row.opportunityId);

    switch (row.resultKind) {
      case "created_opportunity":
        createdOpportunityEvents += 1;
        break;
      case "duplicate_pending":
        duplicatePendingEvents += 1;
        break;
      case "already_booked":
        alreadyBookedEvents += 1;
        break;
      case "unlinked":
        unlinkedEvents += 1;
        break;
    }
  }

  return {
    qualificationEventCount: rows.length,
    uniqueOpportunityCount: uniqueOpportunityIds.size,
    createdOpportunityEvents,
    duplicatePendingEvents,
    alreadyBookedEvents,
    unlinkedEvents,
  };
}
```

**Step 3: Link the report to Operations.**

```tsx
// Path: app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx
import Link from "next/link";
import { Button } from "@/components/ui/button";

<Button asChild variant="outline" size="sm">
  <Link href={`/workspace/operations?tab=qualifications&qualifiedAfter=${range.start}&qualifiedBefore=${range.end}`}>
    View all in Operations
  </Link>
</Button>
```

**Key implementation notes:**
- Do not remove the existing aggregate-backed opportunity metrics until parity is checked.
- Use ledger terminology for activity: `qualification events`.
- Use opportunity terminology for entity conversion: `unique opportunities`.
- Keep the report range capped. If the production test tenant hits `truncated`, add a ledger aggregate through `convex-migration-helper` instead of raising the cap.
- Preserve Honduras business-day period logic already in `convex/reporting/slackQualifications.ts`.
- Do not add unsupported `source` query params to Operations; the Qualification tab is already Slack-ledger scoped.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/slackQualifications.ts` | Modify | Count ledger activity and unique opportunities |
| `convex/slack/metrics.ts` | Modify | Reconcile Slack helper metrics with ledger rows |
| `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` | Modify | Add Operations cross-link and updated copy |
| `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx` | Modify | Show event/opportunity totals |
| `app/workspace/reports/slack-qualifications/_components/setter-contribution-table.tsx` | Modify | Label setter counts as qualification events |
| `app/workspace/operations/_components/qualification-tab.tsx` | Modify | Accept report deep-link filters |

---

### 6C — Pipeline and Team Operations Dimensions

**Type:** Full-Stack
**Parallelizable:** Yes — depends on 6A and Phase 4 `operationsMeetingDailyStats`.

**What:** Add booked-program, DM team, and DM closer filters to pipeline/team report queries and UI controls without changing revenue definitions.

**Why:** Phase 4 made scheduling and phone-sales operationally filterable. Reports need the same dimensions to answer show-rate and phone-closer performance questions.

**Where:**
- `convex/reporting/pipelineHealth.ts` (modify)
- `convex/reporting/teamPerformance.ts` (modify)
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` (modify)
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (modify)
- `app/workspace/reports/team/_components/closer-performance-table.tsx` (modify)
- `app/workspace/reports/_components/report-attribution-filters.tsx` (new)

**How:**

**Step 1: Add a stats query that reads the Phase 4 rollup.**

```typescript
// Path: convex/reporting/pipelineHealth.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getSchedulingShowRateByOperationsDimensions = query({
  args: {
    startDayKey: v.string(),
    endDayKeyExclusive: v.string(),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    attributionTeamId: v.optional(v.id("attributionTeams")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("operationsMeetingDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", args.startDayKey)
          .lt("dayKey", args.endDayKeyExclusive),
      )
      .take(1000);

    const filtered = rows.filter((row) => {
      if (args.bookingProgramId && row.bookingProgramId !== args.bookingProgramId) {
        return false;
      }
      if (args.attributionTeamId && row.attributionTeamId !== args.attributionTeamId) {
        return false;
      }
      if (args.dmCloserId && row.dmCloserId !== args.dmCloserId) {
        return false;
      }
      return true;
    });

    const scheduled = filtered.reduce((sum, row) => sum + row.count, 0);
    const shown = filtered
      .filter((row) => row.meetingStatus === "completed")
      .reduce((sum, row) => sum + row.count, 0);
    const noShows = filtered
      .filter((row) => row.meetingStatus === "no_show")
      .reduce((sum, row) => sum + row.count, 0);

    return {
      scheduled,
      shown,
      noShows,
      showRate: scheduled === 0 ? null : shown / scheduled,
      noShowRate: scheduled === 0 ? null : noShows / scheduled,
      truncated: rows.length === 1000,
    };
  },
});
```

**Step 2: Add shared attribution filters for report pages.**

```tsx
// Path: app/workspace/reports/_components/report-attribution-filters.tsx
"use client";

import type { Id } from "@/convex/_generated/dataModel";
import { ReportProgramDimensionFilter } from "./report-program-dimension-filter";

export type ReportAttributionFilterValue = {
  bookingProgramId?: Id<"tenantPrograms">;
  attributionTeamId?: Id<"attributionTeams">;
  dmCloserId?: Id<"dmClosers">;
};

export function ReportAttributionFilters({
  value,
  onChange,
}: {
  value: ReportAttributionFilterValue;
  onChange: (value: ReportAttributionFilterValue) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <ReportProgramDimensionFilter
        dimension="booking_program"
        value={value.bookingProgramId}
        onChange={(bookingProgramId) => onChange({ ...value, bookingProgramId })}
      />
      {/* Add DM team and DM closer selects from Phase 2 attribution queries. */}
    </div>
  );
}
```

**Step 3: Add a Team Performance companion query for Operations dimensions.**

```typescript
// Path: convex/reporting/teamPerformance.ts
export const getTeamOperationsDimensions = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
    bookingProgramId: v.optional(v.id("tenantPrograms")),
    dmCloserId: v.optional(v.id("dmClosers")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const startDayKey = new Date(args.startDate).toISOString().slice(0, 10);
    const endExclusive = new Date(args.endDate);
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    const endDayKeyExclusive = endExclusive.toISOString().slice(0, 10);

    const rows = await ctx.db
      .query("operationsMeetingDailyStats")
      .withIndex("by_tenantId_and_dayKey", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("dayKey", startDayKey)
          .lt("dayKey", endDayKeyExclusive),
      )
      .take(1000);

    const filtered = rows.filter((row) => {
      if (args.bookingProgramId && row.bookingProgramId !== args.bookingProgramId) {
        return false;
      }
      if (args.dmCloserId && row.dmCloserId !== args.dmCloserId) {
        return false;
      }
      return true;
    });

    const byCloser = new Map<Id<"users">, { scheduled: number; completed: number }>();
    for (const row of filtered) {
      const current = byCloser.get(row.assignedCloserId) ?? {
        scheduled: 0,
        completed: 0,
      };
      current.scheduled += row.count;
      if (row.meetingStatus === "completed") {
        current.completed += row.count;
      }
      byCloser.set(row.assignedCloserId, current);
    }

    return {
      rows: [...byCloser.entries()].map(([closerId, totals]) => ({
        closerId,
        ...totals,
        showRate:
          totals.scheduled === 0 ? null : totals.completed / totals.scheduled,
      })),
      truncated: rows.length === 1000,
    };
  },
});
```

**Key implementation notes:**
- Filtering the bounded rollup rows in memory is acceptable for the MVP because the query reads day-level rows, not raw meetings.
- If the rollup reaches `truncated`, add indexes or a second rollup keyed by program/team/closer before raising limits.
- Do not let client-provided closer IDs bypass `requireTenantUser`.
- `bookingProgramId` is for booked-call metrics; `soldProgramId` is for customer/payment outcome metrics.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/pipelineHealth.ts` | Modify | Add Operations-dimension show-rate query |
| `convex/reporting/teamPerformance.ts` | Modify | Separate phone closer and revenue dimensions |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | Add filters and cards |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | Add filters |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | Label phone vs revenue columns |
| `app/workspace/reports/_components/report-attribution-filters.tsx` | Create | Shared booked-program/DM filters |

---

### 6D — Booked to Sold Program Matrix

**Type:** Full-Stack
**Parallelizable:** Yes — depends on 6A and Phase 2 sold-program caches.

**What:** Add an admin report that compares booked program from the original booking to sold program from payment/customer data.

**Why:** The design calls booked/sold mismatches a legitimate cross-sell/down-sell/up-sell outcome, not an error. Admins need a report that shows those movements explicitly.

**Where:**
- `convex/reporting/bookedVsSold.ts` (new)
- `app/workspace/reports/revenue/_components/booked-vs-sold-matrix.tsx` (new)
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` (modify)
- `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx` (modify)

**How:**

**Step 1: Query bounded payment rows and derive booked program from the originating opportunity.**

```typescript
// Path: convex/reporting/bookedVsSold.ts
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

const MAX_MATRIX_PAYMENTS = 500;
type ProgramBucket = Id<"tenantPrograms"> | "unknown";
type MatrixKey = string;

export const getBookedVsSoldMatrix = query({
  args: {
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_tenantId_and_recordedAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("recordedAt", args.startDate)
          .lt("recordedAt", args.endDate),
      )
      .take(MAX_MATRIX_PAYMENTS + 1);

    const buckets = new Map<
      MatrixKey,
      {
        bookingProgramId: ProgramBucket;
        soldProgramId: ProgramBucket;
        paymentCount: number;
        totalAmountMinor: number;
      }
    >();

    for (const payment of payments.slice(0, MAX_MATRIX_PAYMENTS)) {
      const opportunityId = payment.originatingOpportunityId ?? payment.opportunityId;
      const opportunity = opportunityId ? await ctx.db.get(opportunityId) : null;
      const bookingProgramId = opportunity?.firstBookingProgramId ?? "unknown";
      const soldProgramId = payment.programId ?? "unknown";
      const key: MatrixKey = `${bookingProgramId}:${soldProgramId}`;
      const current =
        buckets.get(key) ??
        { bookingProgramId, soldProgramId, paymentCount: 0, totalAmountMinor: 0 };

      current.paymentCount += 1;
      current.totalAmountMinor += payment.amountMinor;
      buckets.set(key, current);
    }

    const programIds = new Set<Id<"tenantPrograms">>();
    for (const bucket of buckets.values()) {
      if (bucket.bookingProgramId !== "unknown") programIds.add(bucket.bookingProgramId);
      if (bucket.soldProgramId !== "unknown") programIds.add(bucket.soldProgramId);
    }
    const programs = await Promise.all([...programIds].map((programId) => ctx.db.get(programId)));
    const programNameById = new Map<Id<"tenantPrograms">, string>();
    for (const program of programs) {
      if (program) programNameById.set(program._id, program.name);
    }

    return {
      rows: [...buckets.values()]
        .map((bucket) => ({
          ...bucket,
          bookingProgramName:
            bucket.bookingProgramId === "unknown"
              ? "Unknown booked program"
              : programNameById.get(bucket.bookingProgramId) ?? "Unknown booked program",
          soldProgramName:
            bucket.soldProgramId === "unknown"
              ? "Unknown sold program"
              : programNameById.get(bucket.soldProgramId) ?? "Unknown sold program",
        }))
        .sort((left, right) => right.totalAmountMinor - left.totalAmountMinor),
      truncated: payments.length > MAX_MATRIX_PAYMENTS,
    };
  },
});
```

**Step 2: Render the matrix inside the Revenue report.**

```tsx
// Path: app/workspace/reports/revenue/_components/booked-vs-sold-matrix.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function BookedVsSoldMatrix({
  rows,
}: {
  rows: Array<{
    bookingProgramName: string;
    soldProgramName: string;
    paymentCount: number;
    totalAmount: string;
  }>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Booked to Sold Program</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Booked program</TableHead>
              <TableHead>Sold program</TableHead>
              <TableHead className="text-right">Payments</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.bookingProgramName}:${row.soldProgramName}`}>
                <TableCell>{row.bookingProgramName}</TableCell>
                <TableCell>{row.soldProgramName}</TableCell>
                <TableCell className="text-right">{row.paymentCount}</TableCell>
                <TableCell className="text-right">{row.totalAmount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- The MVP can live on the Revenue report because the source of truth is payment rows.
- Historical payments with no linked opportunity must show `Unknown booked program`, not disappear.
- The backend query should return display names with explicit unknown buckets; the client should not perform row-by-row program lookups.
- This query intentionally does not redefine revenue totals; it explains program movement within already-counted payments.
- If row-by-row opportunity lookups become expensive, add `bookingProgramId` as an optional cache on `paymentRecords` using widen-migrate-narrow.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/bookedVsSold.ts` | Create | Matrix backend query |
| `app/workspace/reports/revenue/_components/booked-vs-sold-matrix.tsx` | Create | Revenue report matrix |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Modify | Fetch and render matrix |
| `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx` | Modify | Add matching skeleton block |

---

### 6E — PostHog Event Hygiene

**Type:** Frontend
**Parallelizable:** Yes — depends on 6A names but not on report query implementation.

**What:** Add client-side report analytics helpers for Operations/report usage while preventing raw attribution and PII leakage.

**Why:** The design permits analytics events, but specifically disallows raw UTM values and social handles. Existing report filters will now hold sensitive attribution context, so capture must be normalized.

**Where:**
- `app/workspace/reports/_components/use-report-analytics.ts` (new)
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` (modify)
- `app/workspace/reports/team/_components/team-report-page-client.tsx` (modify)
- `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` (modify)
- `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` (modify)
- `lib/posthog-config.ts` (read only unless existing config must change)

**How:**

**Step 1: Add a normalized report analytics hook.**

```typescript
// Path: app/workspace/reports/_components/use-report-analytics.ts
"use client";

import { useCallback, useRef } from "react";
import posthog from "posthog-js";
import { isPostHogEnabled } from "@/lib/posthog-config";

type ReportName =
  | "pipeline_health"
  | "team_performance"
  | "revenue"
  | "slack_qualifications"
  | "booked_vs_sold";

type ReportFilterProperties = {
  report: ReportName;
  date_range_preset: "7d" | "30d" | "month" | "custom";
  has_booking_program_filter?: boolean;
  has_sold_program_filter?: boolean;
  has_attribution_team_filter?: boolean;
  has_dm_closer_filter?: boolean;
};

export function useReportAnalytics(report: ReportName) {
  const viewedRef = useRef(false);

  const captureViewed = useCallback(() => {
    if (!isPostHogEnabled() || viewedRef.current) return;
    posthog.capture("report_viewed", { report });
    viewedRef.current = true;
  }, [report]);

  const captureFiltersChanged = useCallback(
    (properties: Omit<ReportFilterProperties, "report">) => {
      if (!isPostHogEnabled()) return;
      posthog.capture("report_filters_changed", {
        report,
        ...properties,
      });
    },
    [report],
  );

  return { captureViewed, captureFiltersChanged };
}
```

**Step 2: Wire report-view events once per page mount.**

```tsx
// Path: app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx
import { useEffect } from "react";
import { useReportAnalytics } from "../../_components/use-report-analytics";

export function PipelineReportPageClient() {
  const { captureViewed } = useReportAnalytics("pipeline_health");

  useEffect(() => {
    captureViewed();
  }, [captureViewed]);

  // Existing report implementation remains below.
}
```

**Key implementation notes:**
- Never pass raw `utm_source`, `utm_medium`, `utm_campaign`, social handles, customer names, emails, phone numbers, Slack IDs, Calendly URIs, Convex IDs, or WorkOS IDs as event properties.
- Prefer `has_*_filter` booleans over filter values.
- Avoid capturing on every render; use one view event per report mount and filter events only on committed filter changes.
- If server-side events are needed later, use `lib/posthog-capture.ts` and apply the same property restrictions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/_components/use-report-analytics.ts` | Create | Normalized report analytics hook |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | Capture report view/filter changes |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | Capture report view/filter changes |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Modify | Capture report view/filter changes |
| `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` | Modify | Capture report view/filter changes |
| `lib/posthog-config.ts` | Read | Confirm existing enablement rules |

---

### 6F — Reporting Parity and Rollout Checklist

**Type:** Manual
**Parallelizable:** No — runs after the reporting changes are implemented.

**What:** Create and execute a parity checklist comparing old and new report numbers for the production test tenant before enabling the redesigned reports as the default.

**Why:** Some differences will be intentional because event-ledger counts are not the same as opportunity counts. The project owner needs those differences documented before old assumptions are replaced.

**Where:**
- `plans/pipeline-operations-redesign/reporting-parity-checklist.md` (new)
- `plans/pipeline-operations-redesign/pipeline-operations-redesign-design.md` (modify if definitions changed)
- `convex/reporting/backfill.ts` (modify only if parity reveals missing aggregate/backfill data)
- `convex/admin/migrations.ts` (modify only if parity requires admin-only readiness checks)

**How:**

**Step 1: Create the checklist document.**

```markdown
<!-- Path: plans/pipeline-operations-redesign/reporting-parity-checklist.md -->
# Reporting Parity Checklist

## Slack Qualifications

- [ ] Ledger qualification event count:
- [ ] Unique linked opportunity count:
- [ ] Existing opportunity aggregate count:
- [ ] Duplicate/already-booked event count:
- [ ] Difference explained:

## Pipeline Health

- [ ] Raw meeting count for selected range:
- [ ] Operations rollup count for selected range:
- [ ] Show-rate difference explained:

## Team Performance

- [ ] Phone closer scheduled-call count:
- [ ] DM closer attribution count:
- [ ] Revenue total for same date range:
- [ ] Difference explained:

## Revenue

- [ ] Existing revenue total:
- [ ] Redesigned revenue total:
- [ ] Booked-to-sold matrix total:
- [ ] Unknown booked-program bucket reviewed:
- [ ] Difference explained:

## Cutoffs

- [ ] Attribution backfill cutoff:
- [ ] Slack ledger backfill cutoff:
- [ ] Meeting stats rollup cutoff:
```

**Step 2: Run typecheck and targeted reporting smoke tests.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
pnpm tsc --noEmit
```

**Step 3: Verify UI behavior in the browser.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
pnpm dev
```

Then inspect:
- `/workspace/reports/slack-qualifications`
- `/workspace/reports/pipeline`
- `/workspace/reports/team`
- `/workspace/reports/revenue`
- `/workspace/operations?tab=qualifications`

**Key implementation notes:**
- Keep old report sections visible until parity is reviewed.
- If a number differs because the definition changed, document it in the checklist instead of hiding the difference in UI copy.
- If parity requires a new backfill, use `convex-migration-helper` and keep it dry-run capable.
- Record historical cutoff dates explicitly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/pipeline-operations-redesign/reporting-parity-checklist.md` | Create | Manual rollout checklist |
| `plans/pipeline-operations-redesign/pipeline-operations-redesign-design.md` | Modify | Only if definitions change |
| `convex/reporting/backfill.ts` | Modify | Only if reporting backfill is needed |
| `convex/admin/migrations.ts` | Modify | Only if readiness checks are needed |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/lib/programDimensions.ts` | Create | 6A |
| `app/workspace/reports/_components/report-program-filter.tsx` | Modify | 6A |
| `app/workspace/reports/_components/report-program-dimension-filter.tsx` | Create | 6A |
| `app/workspace/reports/revenue/_components/revenue-by-program-section.tsx` | Modify | 6A |
| `app/workspace/reports/team/_components/team-report-types.ts` | Modify | 6A |
| `convex/reporting/slackQualifications.ts` | Modify | 6B |
| `convex/slack/metrics.ts` | Modify | 6B |
| `app/workspace/reports/slack-qualifications/_components/slack-qualification-report-page-client.tsx` | Modify | 6B, 6E |
| `app/workspace/reports/slack-qualifications/_components/setter-qualification-summary-cards.tsx` | Modify | 6B |
| `app/workspace/reports/slack-qualifications/_components/setter-contribution-table.tsx` | Modify | 6B |
| `app/workspace/operations/_components/qualification-tab.tsx` | Modify | 6B |
| `convex/reporting/pipelineHealth.ts` | Modify | 6C |
| `convex/reporting/teamPerformance.ts` | Modify | 6C |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | 6C, 6E |
| `app/workspace/reports/team/_components/team-report-page-client.tsx` | Modify | 6C, 6E |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Modify | 6C |
| `app/workspace/reports/_components/report-attribution-filters.tsx` | Create | 6C |
| `convex/reporting/bookedVsSold.ts` | Create | 6D |
| `app/workspace/reports/revenue/_components/booked-vs-sold-matrix.tsx` | Create | 6D |
| `app/workspace/reports/revenue/_components/revenue-report-page-client.tsx` | Modify | 6D, 6E |
| `app/workspace/reports/revenue/_components/revenue-report-skeleton.tsx` | Modify | 6D |
| `app/workspace/reports/_components/use-report-analytics.ts` | Create | 6E |
| `lib/posthog-config.ts` | Read | 6E |
| `plans/pipeline-operations-redesign/reporting-parity-checklist.md` | Create | 6F |
| `plans/pipeline-operations-redesign/pipeline-operations-redesign-design.md` | Modify | 6F if definitions change |
| `convex/reporting/backfill.ts` | Modify | 6F if reporting backfill is needed |
| `convex/admin/migrations.ts` | Modify | 6F if readiness checks are needed |
