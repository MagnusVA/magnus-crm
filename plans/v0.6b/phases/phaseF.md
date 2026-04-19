# Phase F — Pipeline Health & Leads Completeness

**Goal:** Close the reporting gaps on three existing report pages — Pipeline Health (stale count accuracy, review/reminder backlog, no-show source split, admin-vs-closer loss attribution), Leads & Conversions (4 Tier 4 KPIs: Avg Meetings per Sale, Avg Time to Conversion, Form Response Rate, Top Answer per Field), Activity (Most Active Closer card + Actions per Closer card, derived locally from the activity summary). Read-side only — no schema change.

**Prerequisite:** None for F1-F5. F6 should merge **after Phase A** because it relies on `getActivitySummary.actorBreakdown` being widened with `actorRole`. Phase B's `teamActions.ts` shipping order is irrelevant to F6's typecheck; an optional post-Phase-B upgrade swap is tracked as a non-blocking follow-up (see F6 Step 3).

**Runs in PARALLEL with:** Phase A, Phase B, Phase C, Phase D, Phase E, Phase G (backend-only subphases), Phase H. Backend file ownership is disjoint. Frontend overlap is limited to `app/workspace/reports/activity/_components/activity-summary-cards.tsx`, which A4 updates first and F6 extends second.

**Skills to invoke:**
- `convex-performance-audit` — 5 backend extensions scan (a) opportunities (stale count), (b) opportunities (loss attribution), (c) meetings (no-show source), (d) meetings (meetings-per-sale), (e) leads/customers (time-to-conversion), (f) meetingFormResponses (response rate + top answer).
- `shadcn` — 2 new chart types (stacked-bar for loss attribution, top-answer list). `Progress`, `Badge` primitives.
- `web-design-guidelines` — no-show source split and loss attribution are new chart types — verify color contrast, keyboard-navigable legends.
- `frontend-design` — Pipeline Health page expands from 4 to 8 panels; rearrange to a consistent 2×4 grid.

**Acceptance Criteria:**
1. `stalePipelineList` UI reads the true `staleCount` returned by the backend — no longer uses `staleOpps.length` as a count proxy.
2. `getPipelineHealth` (new export or existing, TBD in F1) returns an additional `staleCount` integer alongside the existing `staleOpps` array.
3. Pipeline Health page shows **Pending Overran Reviews** card (count of `meetingReviews.status === "pending"` — same source as Phase D backlog; shared query name TBD in F1).
4. Pipeline Health page shows **Unresolved Reminders** card (count of `followUps.type === "manual_reminder" AND status === "pending"`).
5. Pipeline Health page shows **No-Show Source Split** chart (bar chart: `closer` / `calendly_webhook` — uses `meetings.noShowSource` across range).
6. Pipeline Health page shows **Admin-vs-Closer Loss Attribution** chart (stacked bar grouped by `opportunities.lostByUserId` → resolve role).
7. Leads page shows 4 new KPI cards: **Avg Meetings per Sale**, **Avg Time to Conversion**, **Form Response Rate**, **Top Answer per Field** (top answer is a list, not a card; lists the top answer per field key).
8. Activity page shows a **Most Active Closer** card (top `actorBreakdown` entry with `actorRole === "closer"`, derived locally from the Phase-A-extended summary response).
9. Activity page shows an **Actions per Closer (daily avg)** card — derived locally from `summary.actorBreakdown` + `dateRange` (formula: `totalCloserActions / distinctCloserActors / daySpanDays`). **No dependency on Phase B's `teamActions.ts`.** An optional post-Phase-B upgrade that swaps to the richer `getActionsPerCloserPerDay` query is tracked as a non-blocking follow-up.
10. All new **date-filtered** UI sections respect the shared `ReportDateControls` range. The two Pipeline backlog cards (`Pending Overran Reviews`, `Unresolved Reminders`) remain intentionally **real-time / as-of-now** metrics and are labeled as such.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
F1 (pipelineHealth.ts — backend: staleCount, review/reminder backlog, noShowSource, lossAttribution) ──┐
                                                                                                        │
                                                                                                        ├── F4 (pipeline UI — 4 new panels; depends on F1)
                                                                                                        │
F2 (leadConversion.ts — backend: 3 Tier 4 KPIs) ─────────────────┐                                     │
                                                                  │                                     │
F3 (formResponseAnalytics.ts — backend: formResponseRate + topAnswer) ── F5 (leads UI — 4 new KPI panels; depends on F2+F3)
                                                                  │
F6 (activity UI — 2 new cards; depends on Phase A's actorRole extension, but zero Phase B dependency) ───
```

**Optimal execution:**
1. **Backend stream (parallel):** F1, F2, F3 all touch different backend files. Start all three simultaneously.
2. **Frontend stream (after their respective backend):**
   - F4 depends on F1 (Pipeline page extensions).
   - F5 depends on F2 + F3 (Leads page extensions).
   - F6 depends on Phase A widening `actorBreakdown` with `actorRole`, but has **zero** dependency on Phase B. Post-Phase-B upgrade swap is a follow-up.

**Estimated time:** 3 days (solo); 1.5 days with backend + frontend parallel; 1 day with 3 agents (backend split across F1/F2/F3 + frontend split across F4/F5/F6).

---

## Subphases

### F1 — `pipelineHealth.ts`: True Stale Count + Backlog Metrics + Loss Attribution

**Type:** Backend (modification + new exports)
**Parallelizable:** Yes — only edits `convex/reporting/pipelineHealth.ts`.

**What:** Extend the existing pipeline health queries to:
- Return a true `staleCount` alongside the (still-bounded) `staleOpps` list.
- Add a `getPipelineBacklogAndLoss` query returning `pendingReviewsCount`, `unresolvedRemindersCount`, `noShowSourceSplit`, and `lossAttribution` (grouped by `lostByUserId` → role).

**Why:** The audit confirms `staleCount` is currently derived from `staleOpps.length` (capped at 20) — misleading when the real backlog is larger. Pipeline Health is the admin's early-warning dashboard; the 4 new cards surface operational risks that today are scattered across the codebase.

**Where:**
- `convex/reporting/pipelineHealth.ts` (modify)

**How:**

**Step 1: Add `staleCount` to the stale-pipeline query.**

The audit shows pipelineHealth.ts has `getPipelineDistribution` and `getPipelineAging`. The stale list appears to be part of one of those queries (confirm via `rg -n 'staleOpps' convex`). Assume the stale list is inside `getPipelineAging` (or rename to `getPipelineHealthSummary` if needed; verify with a targeted read during implementation).

```typescript
// Path: convex/reporting/pipelineHealth.ts

// BEFORE (excerpt — the existing stale-list-building loop returns up to 20 sorted by age):
const staleOpps: StaleOpp[] = [];
for await (const opp of ctx.db.query("opportunities").withIndex(...)) {
  if (isStale(opp) && staleOpps.length < MAX_STALE_OPPORTUNITIES) {
    staleOpps.push(opp);
  }
}

// AFTER:
let staleCount = 0;
const staleOpps: StaleOpp[] = [];
for await (const opp of ctx.db.query("opportunities").withIndex(...)) {
  if (isStale(opp)) {
    staleCount++;
    if (staleOpps.length < MAX_STALE_OPPORTUNITIES) {
      staleOpps.push(opp);
    }
  }
}

return {
  // ... existing fields ...
  staleOpps,     // still capped at 20
  staleCount,    // NEW — true count
};
```

**Step 2: Add a new export `getPipelineBacklogAndLoss`.**

```typescript
// Path: convex/reporting/pipelineHealth.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange, getUserDisplayName } from "./lib/helpers";

const MAX_PENDING_REVIEWS = 2001;
const MAX_UNRESOLVED_REMINDERS = 2001;
const MAX_LOSS_OPPS_SCAN = 2000;
const MAX_MEETINGS_NOSHOW_SCAN = 2000;

type NoShowSource = "closer" | "calendly_webhook" | "none";

export const getPipelineBacklogAndLoss = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // === 1. Pending overran reviews (as-of-now; not date-filtered) ===
    const pendingReviews = await ctx.db
      .query("meetingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_PENDING_REVIEWS);
    const pendingReviewsCount = Math.min(pendingReviews.length, MAX_PENDING_REVIEWS - 1);
    const isPendingReviewsTruncated = pendingReviews.length >= MAX_PENDING_REVIEWS;

    // === 2. Unresolved manual reminders (as-of-now) ===
    // Uses existing by_tenantId_and_status_and_createdAt. Filter by type post-scan.
    const pendingFollowUps = await ctx.db
      .query("followUps")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "pending"),
      )
      .take(MAX_UNRESOLVED_REMINDERS);
    const manualReminders = pendingFollowUps.filter((r) => r.type === "manual_reminder");
    const unresolvedRemindersCount = Math.min(manualReminders.length, MAX_UNRESOLVED_REMINDERS - 1);
    const isUnresolvedRemindersTruncated = pendingFollowUps.length >= MAX_UNRESOLVED_REMINDERS;

    // === 3. No-show source split (date-range-filtered on scheduledAt) ===
    const noShowMeetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_status_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("status", "no_show")
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )
      .take(MAX_MEETINGS_NOSHOW_SCAN);
    const noShowSourceSplit: Record<NoShowSource, number> = { closer: 0, calendly_webhook: 0, none: 0 };
    for (const m of noShowMeetings) {
      const key: NoShowSource = m.noShowSource ?? "none";
      noShowSourceSplit[key]++;
    }
    const isNoShowSourceTruncated = noShowMeetings.length >= MAX_MEETINGS_NOSHOW_SCAN;

    // === 4. Admin-vs-closer loss attribution (filtered by lostAt in range) ===
    // Scan opportunities with status="lost" AND lostAt in range.
    // lostAt was confirmed (2026-04-19) to be the canonical timestamp; opportunities.lostByUserId holds the actor.
    // Index choice: `by_tenantId_and_status` exists and is a prefix of
    // `by_tenantId_and_status_and_createdAt` — both work here. We use the shorter
    // name because we don't need the createdAt ordering (we filter lostAt post-scan).
    // At current volume (~200 lost opps/year), scanning all lost opps and filtering
    // post-scan is cheap — the alternative would be adding a composite
    // `by_tenantId_and_status_and_lostAt` index, which is out of scope for v0.6b.
    const lostOppsRaw = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", "lost"),
      )
      .take(MAX_LOSS_OPPS_SCAN);
    const isLossOppsTruncated = lostOppsRaw.length >= MAX_LOSS_OPPS_SCAN;
    const lostOpps = lostOppsRaw.filter(
      (opp) => opp.lostAt !== undefined && opp.lostAt >= startDate && opp.lostAt < endDate,
    );

    // Resolve actor role per lostByUserId via ctx.db.get (bounded to distinct user count).
    const lossByActor = new Map<Id<"users">, number>();
    for (const opp of lostOpps) {
      if (opp.lostByUserId) {
        lossByActor.set(opp.lostByUserId, (lossByActor.get(opp.lostByUserId) ?? 0) + 1);
      }
    }
    const actorUserIds = Array.from(lossByActor.keys());
    const actors = await Promise.all(
      actorUserIds.map(async (id) => {
        const user = await ctx.db.get(id);
        return {
          userId: id,
          role: user?.role ?? "unknown",
          name: user ? getUserDisplayName(user) : "Removed user",
        };
      }),
    );
    // Aggregate into admin / closer / unknown buckets.
    const lossAttribution = {
      admin: 0, // tenant_master OR tenant_admin
      closer: 0,
      unknown: 0,
      byActor: actors.map((a) => ({
        ...a,
        count: lossByActor.get(a.userId) ?? 0,
      })).sort((a, b) => b.count - a.count),
    };
    for (const actor of actors) {
      const count = lossByActor.get(actor.userId) ?? 0;
      if (actor.role === "tenant_master" || actor.role === "tenant_admin") lossAttribution.admin += count;
      else if (actor.role === "closer") lossAttribution.closer += count;
      else lossAttribution.unknown += count;
    }
    // Lost opps without lostByUserId also count toward unknown.
    const lostWithoutActor = lostOpps.filter((opp) => !opp.lostByUserId).length;
    lossAttribution.unknown += lostWithoutActor;

    return {
      pendingReviewsCount,
      isPendingReviewsTruncated,
      unresolvedRemindersCount,
      isUnresolvedRemindersTruncated,
      noShowSourceSplit,
      isNoShowSourceTruncated,
      lossAttribution,
      isLossOppsTruncated,
    };
  },
});
```

**Key implementation notes:**
- `staleCount` is the **only** change to the existing stale query — every other addition is a new export so we don't disturb the existing page contract.
- **`no_show` status filter:** we use `by_tenantId_and_status_and_scheduledAt` (existing index) for an efficient status-filtered range scan. Confirmed by schema audit — `meetings` has this index.
- **Loss attribution pre-filter:** `opportunities` schema has `by_tenantId_and_status` — scan lost opps first, then filter by `lostAt` post-scan. At current lost-opp volume this is cheap. If volume grows, the alternative is adding a dedicated `by_tenantId_and_status_and_lostAt` index — out of scope for v0.6b.
- **Role fallback:** Convex user `role` is already known; we cache actor role per user ID to avoid duplicate `ctx.db.get` calls.
- **`lostByUserId` is optional** (schema line 239). Lost opps without an actor get counted under `unknown` — common for legacy data.
- `byActor` in `lossAttribution` gives the frontend a drill-down list in addition to the 3-bucket summary.
- **Don't** add per-role scans (e.g., one query per role) — one scan is cheaper and keeps the query shape monolithic.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/pipelineHealth.ts` | Modify | Add `staleCount` to existing query; add `getPipelineBacklogAndLoss` new export |

---

### F2 — `leadConversion.ts`: Tier 4 Conversion KPIs

**Type:** Backend (modification)
**Parallelizable:** Yes — only edits `convex/reporting/leadConversion.ts`.

**What:** Extend `getLeadConversionMetrics` to return three additional KPIs: `avgMeetingsPerSale`, `avgTimeToConversionMs`, and — kept separate for response size control — a new sibling query `getFormResponseKpis` in `formResponseAnalytics.ts` (see F3) for Form Response Rate + Top Answer per Field.

**Why:** v0.6 Tier 4 promised four lead/conversion KPIs; today only the first (`conversionRate`) is exposed. All three backing scans are cheap at current volume.

**Where:**
- `convex/reporting/leadConversion.ts` (modify)

**How:**

**Step 1: Extend `getLeadConversionMetrics`.**

```typescript
// Path: convex/reporting/leadConversion.ts

// Inside the existing getLeadConversionMetrics handler — after the existing conversion computation:

// === 1. Avg Meetings per Sale ===
// For each customer converted in the range, count meetings on their winning opportunity.
// customers table exposes winningOpportunityId. Meetings count via by_opportunityId index.

const convertedCustomers = await ctx.db
  .query("customers")
  .withIndex("by_tenantId_and_convertedAt", (q) =>
    q
      .eq("tenantId", tenantId)
      .gte("convertedAt", startDate)
      .lt("convertedAt", endDate),
  )
  .take(MAX_CUSTOMERS_SCAN);      // e.g. 2000

const isCustomersTruncated = convertedCustomers.length >= MAX_CUSTOMERS_SCAN;

let totalMeetingsOnWinners = 0;
let totalWinnersWithMeetings = 0;
for (const c of convertedCustomers) {
  const meetings = await ctx.db
    .query("meetings")
    .withIndex("by_opportunityId", (q) => q.eq("opportunityId", c.winningOpportunityId))
    .take(20); // 20 is plenty for a single opportunity
  if (meetings.length > 0) {
    totalMeetingsOnWinners += meetings.length;
    totalWinnersWithMeetings++;
  }
}
const avgMeetingsPerSale =
  totalWinnersWithMeetings > 0 ? totalMeetingsOnWinners / totalWinnersWithMeetings : null;

// === 2. Avg Time to Conversion ===
// For each converted customer in range, compute (convertedAt - lead.firstSeenAt).
// leads table has firstSeenAt.
let totalTimeToConversionMs = 0;
let timeToConversionSampleCount = 0;
for (const c of convertedCustomers) {
  const lead = await ctx.db.get(c.leadId);
  if (lead && lead.firstSeenAt !== undefined) {
    const deltaMs = c.convertedAt - lead.firstSeenAt;
    // Defensive: skip negative (should not happen; data quality signal)
    if (deltaMs > 0) {
      totalTimeToConversionMs += deltaMs;
      timeToConversionSampleCount++;
    }
  }
}
const avgTimeToConversionMs =
  timeToConversionSampleCount > 0 ? totalTimeToConversionMs / timeToConversionSampleCount : null;

// Append to the existing return shape:
return {
  // ... existing fields (newLeads, totalConversions, conversionRate, byCloser, excludedConversions, isConversionDataTruncated) ...

  // NEW v0.6b
  avgMeetingsPerSale,
  meetingsPerSaleNumerator: totalMeetingsOnWinners,
  meetingsPerSaleDenominator: totalWinnersWithMeetings,
  avgTimeToConversionMs,
  timeToConversionSampleCount,
  isCustomersTruncated,
};
```

**Key implementation notes:**
- **Per-customer meeting count:** `.take(20)` on `by_opportunityId` is sufficient — an opportunity rarely has >5 meetings. If it does (an extreme chain), the top-20 is a fine cap.
- `avgTimeToConversionMs` may be null if no in-range conversions had a retrievable `firstSeenAt` — rare, but handled.
- Skip negative `deltaMs` (`convertedAt < firstSeenAt`) — should be impossible but protects the average from pathological data.
- `winningOpportunityId` is `v.id("opportunities")` (non-optional per schema) — no null check needed.
- Do **not** include DQ Rate — explicitly deferred to v0.7.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/leadConversion.ts` | Modify | Extend `getLeadConversionMetrics` with 2 new KPI fields |

---

### F3 — `formResponseAnalytics.ts`: Form Response Rate + Top Answer per Field

**Type:** Backend (modification — new export, same file)
**Parallelizable:** Yes — only edits `convex/reporting/formResponseAnalytics.ts`.

**What:** Add `getFormResponseKpis` exporting `formResponseRate` (distinct-meeting-response-ratio) and `topAnswerPerField` (mode of answer per fieldKey).

**Why:** Both KPIs are promised Tier 4. `meetingFormResponses` table already exists with an index supporting both rollups. No schema change.

**Where:**
- `convex/reporting/formResponseAnalytics.ts` (modify — add export)

**How:**

**Step 1: Add `getFormResponseKpis`.**

```typescript
// Path: convex/reporting/formResponseAnalytics.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { requireTenantUser } from "../requireTenantUser";
import { assertValidDateRange } from "./lib/helpers";

const MAX_FORM_RESPONSES_SCAN = 5000;
const MAX_MEETINGS_SCAN = 2000;

export const getFormResponseKpis = query({
  args: { startDate: v.number(), endDate: v.number() },
  handler: async (ctx, { startDate, endDate }) => {
    assertValidDateRange(startDate, endDate);

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // === Denominator: distinct meetings in range ===
    const meetings = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q
          .eq("tenantId", tenantId)
          .gte("scheduledAt", startDate)
          .lt("scheduledAt", endDate),
      )
      .take(MAX_MEETINGS_SCAN);
    const isMeetingsTruncated = meetings.length >= MAX_MEETINGS_SCAN;
    const totalMeetings = meetings.length;
    const meetingIdSet = new Set(meetings.map((m) => m._id));

    // === Numerator: distinct meetings with at least one form response in range ===
    // Schema check (2026-04-19): meetingFormResponses exposes only `by_meetingId`,
    // `by_tenantId_and_eventTypeConfigId`, `by_tenantId_and_fieldKey`, and `by_leadId`
    // — there is no `by_tenantId` index and no `by_tenantId_and_submittedAt` index.
    // We iterate the in-range meeting set and fetch responses per meeting via
    // `by_meetingId`. This is N × avg(responsesPerMeeting) reads; bounded because
    // `meetings.length <= MAX_MEETINGS_SCAN (2000)` and responses per meeting cap at
    // the form's field count (typically 3–8). Safe at current volume.
    let totalFormResponsesRead = 0;
    let isFormResponsesTruncated = false;
    const respondedMeetingIds = new Set<string>();
    const answersByField = new Map<string, Map<string, number>>(); // fieldKey -> answer -> count

    for (const meeting of meetings) {
      if (totalFormResponsesRead >= MAX_FORM_RESPONSES_SCAN) {
        isFormResponsesTruncated = true;
        break;
      }
      const responses = await ctx.db
        .query("meetingFormResponses")
        .withIndex("by_meetingId", (q) => q.eq("meetingId", meeting._id))
        .take(32); // per-meeting safety cap — well above any realistic field count
      totalFormResponsesRead += responses.length;

      for (const resp of responses) {
        respondedMeetingIds.add(resp.meetingId);
        // fieldKey + answerText are the actual schema names (verified 2026-04-19).
        const fieldKey = resp.fieldKey;
        const answer = resp.answerText ?? "";
        if (!answer) continue;
        if (!answersByField.has(fieldKey)) answersByField.set(fieldKey, new Map());
        const fieldMap = answersByField.get(fieldKey)!;
        fieldMap.set(answer, (fieldMap.get(answer) ?? 0) + 1);
      }
    }

    const respondedMeetingsCount = respondedMeetingIds.size;
    const formResponseRate =
      totalMeetings > 0 ? respondedMeetingsCount / totalMeetings : null;

    // === Top Answer per Field ===
    const topAnswerPerField = Array.from(answersByField.entries()).map(([fieldKey, answerCounts]) => {
      const top = Array.from(answerCounts.entries()).sort((a, b) => b[1] - a[1])[0];
      const totalResponses = Array.from(answerCounts.values()).reduce((s, n) => s + n, 0);
      return {
        fieldKey,
        topAnswer: top[0],
        topAnswerCount: top[1],
        totalResponses,
        topAnswerShare: totalResponses > 0 ? top[1] / totalResponses : 0,
      };
    });
    // Sort alphabetically by field key for stable render.
    topAnswerPerField.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));

    return {
      totalMeetings,
      respondedMeetingsCount,
      formResponseRate,
      topAnswerPerField,
      isMeetingsTruncated,
      isFormResponsesTruncated,
    };
  },
});
```

**Key implementation notes:**
- **Schema field names confirmed (2026-04-19):** `meetingFormResponses` uses `fieldKey` and `answerText`. Do not use `fieldName`/`answerValue`.
- **Index strategy:** `meetingFormResponses` has `by_meetingId`, `by_tenantId_and_eventTypeConfigId`, `by_tenantId_and_fieldKey`, and `by_leadId` — **no** `by_tenantId` or `by_tenantId_and_submittedAt` index. The per-meeting fetch pattern (iterate meetings in range, fetch responses via `by_meetingId`) avoids any unindexed scan. No schema change required in Phase F.
- **Bounding strategy:** total form-response reads are capped by `MAX_FORM_RESPONSES_SCAN = 5000`. Per-meeting cap is 32 responses (well above any realistic form). At current volume (~5 fields per meeting × 200 meetings/month), a 30-day range reads ~1,000 responses — far under budget.
- **Empty answer text:** filter out (`!answer`). Don't surface blank top answers.
- **Top answer share:** the percentage of the field's in-range responses that selected this answer. Helps interpret "is this the dominant answer or just the plurality of a spread?"
- **If volume grows past the 5,000 bound regularly,** consider adding a `by_tenantId_and_meetingId` composite index or a `by_tenantId_and_submittedAt` index as a v0.7 follow-up — explicitly out of scope for v0.6b.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/formResponseAnalytics.ts` | Modify | Add `getFormResponseKpis` export |

---

### F4 — Pipeline Health Page: 4 New Panels

**Type:** Frontend (modifications + new components)
**Parallelizable:** Depends on F1. Independent of F2/F3/F5/F6.

**What:**
- Modify `stale-pipeline-list.tsx` to read `staleCount` (not `staleOpps.length`).
- Add `pending-overran-reviews-card.tsx` (count from `pendingReviewsCount`).
- Add `unresolved-reminders-card.tsx`.
- Add `no-show-source-split-chart.tsx`.
- Add `loss-attribution-chart.tsx` (stacked-bar: admin / closer / unknown, with drill-down list).
- Modify `pipeline-report-page-client.tsx` to add `ReportDateControls`, subscribe to `getPipelineBacklogAndLoss`, and render the 4 new panels. The backlog cards are explicitly labeled as current/as-of-now; the no-show and loss charts respect the selected range.

**Where:**
- `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx` (modify)
- `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx` (new)
- `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` (new)
- `app/workspace/reports/pipeline/_components/no-show-source-split-chart.tsx` (new)
- `app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx` (new)
- `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` (modify)

**How:**

**Step 1: Fix the stale-pipeline count.**

```tsx
// Path: app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx

// BEFORE:
interface StalePipelineListProps {
  staleOpps: Array<{ /* ... */ }>;
}
// ...
<CardTitle>Stale Opportunities ({staleOpps.length})</CardTitle>

// AFTER:
interface StalePipelineListProps {
  staleOpps: Array<{ /* ... */ }>;
  staleCount: number; // NEW — true count
}

// ...
<CardTitle>
  Stale Opportunities ({staleCount.toLocaleString()}
  {staleOpps.length < staleCount && ` — showing first ${staleOpps.length}`})
</CardTitle>
```

Update the caller in `pipeline-report-page-client.tsx` to pass `staleCount` from the new backend field.

**Step 2: Two small count cards.**

```tsx
// Path: app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { GavelIcon } from "lucide-react";
import Link from "next/link";

interface Props {
  count: number;
  isTruncated: boolean;
}

export function PendingOverranReviewsCard({ count, isTruncated }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <GavelIcon className="h-3.5 w-3.5" />
          Pending Overran Reviews
          {isTruncated && (
            <Badge variant="secondary" className="ml-auto text-[10px]">
              2000+
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{count.toLocaleString()}</div>
        <p className="text-xs text-muted-foreground">
          <Link href="/workspace/reviews" className="underline hover:no-underline">
            Open inbox →
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { BellRingIcon } from "lucide-react";

interface Props {
  count: number;
  isTruncated: boolean;
}

export function UnresolvedRemindersCard({ count, isTruncated }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <BellRingIcon className="h-3.5 w-3.5" />
          Unresolved Reminders
          {isTruncated && (
            <Badge variant="secondary" className="ml-auto text-[10px]">
              2000+
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums">{count.toLocaleString()}</div>
        <p className="text-xs text-muted-foreground">Manual reminders still pending</p>
      </CardContent>
    </Card>
  );
}
```

**Step 3: No-show source split chart.**

Reuse the `SourceSplitChart` from Phase C (`app/workspace/reports/meeting-time/_components/source-split-chart.tsx`). Because Phase C owns that file and we should not cross-import between report trees, extract it to a shared location **only if** both phases are landing in the same sprint. For Phase F shipping independently, inline a tiny equivalent:

```tsx
// Path: app/workspace/reports/pipeline/_components/no-show-source-split-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

interface Props {
  split: { closer: number; calendly_webhook: number; none: number };
}

export function NoShowSourceSplitChart({ split }: Props) {
  const data = [
    { label: "Closer", count: split.closer, fill: "var(--chart-1)" },
    { label: "Calendly Webhook", count: split.calendly_webhook, fill: "var(--chart-3)" },
    { label: "Unset", count: split.none, fill: "var(--muted-foreground)" },
  ];
  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>No-Show Source</CardTitle>
        <CardDescription>Who recorded each no-show? Closer action vs auto-detected via Calendly.</CardDescription>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No no-shows in range.</p>
        ) : (
          <ChartContainer
            config={Object.fromEntries(data.map((d) => [d.label, { label: d.label, color: d.fill }]))}
            className="h-48"
          >
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical">
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="label" width={130} tickLine={false} axisLine={false} />
                <Tooltip content={<ChartTooltipContent />} />
                <Bar dataKey="count" />
              </BarChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 4: Loss attribution chart (stacked bar + drill-down list).**

```tsx
// Path: app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx
"use client";

import { Bar, BarChart, ResponsiveContainer, XAxis, YAxis, Tooltip, Legend } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltipContent } from "@/components/ui/chart";

interface Props {
  lossAttribution: {
    admin: number;
    closer: number;
    unknown: number;
    byActor: Array<{
      userId: string;
      name: string;
      role: string;
      count: number;
    }>;
  };
}

export function LossAttributionChart({ lossAttribution }: Props) {
  const data = [
    {
      category: "Losses",
      Admin: lossAttribution.admin,
      Closer: lossAttribution.closer,
      Unknown: lossAttribution.unknown,
    },
  ];
  const total = lossAttribution.admin + lossAttribution.closer + lossAttribution.unknown;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Admin-vs-Closer Loss Attribution</CardTitle>
        <CardDescription>
          Who marked opportunities as Lost. "Unknown" = no `lostByUserId` (legacy data or automation).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {total === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No lost opportunities in range.</p>
        ) : (
          <>
            <ChartContainer
              config={{
                Admin: { label: "Admin", color: "var(--chart-1)" },
                Closer: { label: "Closer", color: "var(--chart-2)" },
                Unknown: { label: "Unknown", color: "var(--muted-foreground)" },
              }}
              className="h-24"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" stackOffset="expand">
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="category" hide />
                  <Tooltip content={<ChartTooltipContent />} />
                  <Legend />
                  <Bar dataKey="Admin" stackId="loss" fill="var(--chart-1)" />
                  <Bar dataKey="Closer" stackId="loss" fill="var(--chart-2)" />
                  <Bar dataKey="Unknown" stackId="loss" fill="var(--muted-foreground)" />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>

            <div className="text-xs">
              <p className="mb-1 font-medium text-muted-foreground">By actor</p>
              <ul className="space-y-0.5">
                {lossAttribution.byActor.slice(0, 8).map((actor) => (
                  <li key={actor.userId} className="flex items-center justify-between">
                    <span>{actor.name} <span className="text-muted-foreground">({actor.role})</span></span>
                    <span className="tabular-nums">{actor.count}</span>
                  </li>
                ))}
                {lossAttribution.byActor.length > 8 && (
                  <li className="text-muted-foreground">…and {lossAttribution.byActor.length - 8} more</li>
                )}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 5: Wire into `pipeline-report-page-client.tsx` and add the shared date control.**

```tsx
// Path: app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx

// BEFORE: two no-arg queries, 3-4 panels, no date control.
// AFTER: add dateRange state + ReportDateControls + second useQuery + 4 new panels.

const now = new Date();
const [dateRange, setDateRange] = useState<DateRange>({
  startDate: startOfMonth(now).getTime(),
  endDate: endOfMonth(now).getTime(), // legacy inclusive seed is acceptable; H1 normalizes user changes
});

const backlogAndLoss = useQuery(
  api.reporting.pipelineHealth.getPipelineBacklogAndLoss,
  dateRange,
);

if (!pipelineHealth || !backlogAndLoss) return <PipelineReportSkeleton />;

// Render:
<ReportDateControls value={dateRange} onChange={setDateRange} />

<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
  <StaleOppCountCard count={pipelineHealth.staleCount} />
  <PendingOverranReviewsCard count={backlogAndLoss.pendingReviewsCount} isTruncated={backlogAndLoss.isPendingReviewsTruncated} />
  <UnresolvedRemindersCard count={backlogAndLoss.unresolvedRemindersCount} isTruncated={backlogAndLoss.isUnresolvedRemindersTruncated} />
  {/* possibly other pipeline counts */}
</div>

<div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
  <NoShowSourceSplitChart split={backlogAndLoss.noShowSourceSplit} />
  <LossAttributionChart lossAttribution={backlogAndLoss.lossAttribution} />
</div>

<StalePipelineList
  staleOpps={pipelineHealth.staleOpps}
  staleCount={pipelineHealth.staleCount}
/>
```

**Key implementation notes:**
- `PendingOverranReviewsCard` links to the operational `/workspace/reviews` inbox — admins can one-click from the dashboard count to the triage surface.
- The two backlog cards are **not** date-filtered. They represent the current operational queue and should be labeled accordingly (`Current`, `Open now`, or equivalent).
- Loss attribution chart uses `stackOffset="expand"` to render 100% bar — clearer at a glance than raw counts. The drill-down list shows raw per-user counts.
- **Do not duplicate the Phase D pending-reviews count** if both backend queries live in the same page. The Pipeline page reads `backlogAndLoss.pendingReviewsCount`; the Reviews page reads `getReviewReportingMetrics.backlog.pendingCount`. Same underlying value; different consumer queries to keep page loads independent.
- Reserve a 5th column slot in the summary grid for future additions (consistent with Phase B's style).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx` | Modify | Read staleCount prop |
| `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx` | Create | |
| `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` | Create | |
| `app/workspace/reports/pipeline/_components/no-show-source-split-chart.tsx` | Create | |
| `app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx` | Create | |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | Add 2nd useQuery + render 4 new panels |

---

### F5 — Leads Page: 4 New Tier 4 KPIs

**Type:** Frontend (modifications + new components)
**Parallelizable:** Depends on F2 + F3. Independent of F1/F4/F6.

**What:**
- Add `avg-meetings-per-sale-card.tsx`.
- Add `avg-time-to-conversion-card.tsx`.
- Add `form-response-rate-card.tsx`.
- Add `top-answer-per-field-list.tsx`.
- Modify `leads-report-page-client.tsx` to subscribe to `getFormResponseKpis` and render the 4 new components.

**Where:**
- `app/workspace/reports/leads/_components/avg-meetings-per-sale-card.tsx` (new)
- `app/workspace/reports/leads/_components/avg-time-to-conversion-card.tsx` (new)
- `app/workspace/reports/leads/_components/form-response-rate-card.tsx` (new)
- `app/workspace/reports/leads/_components/top-answer-per-field-list.tsx` (new)
- `app/workspace/reports/leads/_components/leads-report-page-client.tsx` (modify)

**How:**

**Step 1: Four new components.**

```tsx
// Path: app/workspace/reports/leads/_components/avg-meetings-per-sale-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UsersIcon } from "lucide-react";

interface Props {
  avg: number | null;
  numerator: number;
  denominator: number;
}

export function AvgMeetingsPerSaleCard({ avg, numerator, denominator }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <UsersIcon className="h-3.5 w-3.5" />
          Avg Meetings / Sale
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">{avg === null ? "—" : avg.toFixed(2)}</div>
        <p className="text-xs text-muted-foreground">
          {numerator} meeting(s) across {denominator} winning opportunity/ies
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/leads/_components/avg-time-to-conversion-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TimerIcon } from "lucide-react";

interface Props {
  avgMs: number | null;
  sampleCount: number;
}

function formatDurationMs(ms: number): string {
  const totalHours = ms / 3_600_000;
  if (totalHours < 24) return `${totalHours.toFixed(1)}h`;
  const days = Math.floor(totalHours / 24);
  const hours = Math.round(totalHours - days * 24);
  return `${days}d ${hours}h`;
}

export function AvgTimeToConversionCard({ avgMs, sampleCount }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <TimerIcon className="h-3.5 w-3.5" />
          Avg Time to Conversion
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">
          {avgMs === null ? "—" : formatDurationMs(avgMs)}
        </div>
        <p className="text-xs text-muted-foreground">
          Across {sampleCount} conversion(s) in range
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/leads/_components/form-response-rate-card.tsx
"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClipboardEditIcon } from "lucide-react";

interface Props {
  rate: number | null;
  numerator: number;
  denominator: number;
}

export function FormResponseRateCard({ rate, numerator, denominator }: Props) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <ClipboardEditIcon className="h-3.5 w-3.5" />
          Form Response Rate
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-bold tabular-nums">
          {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
        </div>
        <p className="text-xs text-muted-foreground">
          {numerator} of {denominator} meetings answered at least one field
        </p>
      </CardContent>
    </Card>
  );
}
```

```tsx
// Path: app/workspace/reports/leads/_components/top-answer-per-field-list.tsx
"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface FieldRow {
  fieldKey: string;
  topAnswer: string;
  topAnswerCount: number;
  totalResponses: number;
  topAnswerShare: number;
}

export function TopAnswerPerFieldList({ rows }: { rows: FieldRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Answer per Field</CardTitle>
        <CardDescription>
          Most-common answer per form field within the date range.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No form responses in range.</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <li key={row.fieldKey} className="flex items-start justify-between gap-4 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{row.fieldKey}</p>
                  <p className="truncate text-muted-foreground" title={row.topAnswer}>
                    {row.topAnswer}
                  </p>
                </div>
                <div className="text-right text-xs tabular-nums text-muted-foreground">
                  <div>{row.topAnswerCount} / {row.totalResponses}</div>
                  <div>{(row.topAnswerShare * 100).toFixed(0)}% share</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

**Step 2: Wire into `leads-report-page-client.tsx`.**

```tsx
// Path: app/workspace/reports/leads/_components/leads-report-page-client.tsx

const conversion = useQuery(api.reporting.leadConversion.getLeadConversionMetrics, dateRange);
const formKpis = useQuery(api.reporting.formResponseAnalytics.getFormResponseKpis, dateRange);

if (!conversion || !formKpis) return <LeadsReportSkeleton />;

// Render 4 new cards in a row; top-answer list below as full-width card.
<div className="grid grid-cols-2 gap-4 md:grid-cols-4">
  <ConversionRateCard ... />
  <AvgMeetingsPerSaleCard
    avg={conversion.avgMeetingsPerSale}
    numerator={conversion.meetingsPerSaleNumerator}
    denominator={conversion.meetingsPerSaleDenominator}
  />
  <AvgTimeToConversionCard
    avgMs={conversion.avgTimeToConversionMs}
    sampleCount={conversion.timeToConversionSampleCount}
  />
  <FormResponseRateCard
    rate={formKpis.formResponseRate}
    numerator={formKpis.respondedMeetingsCount}
    denominator={formKpis.totalMeetings}
  />
</div>

<TopAnswerPerFieldList rows={formKpis.topAnswerPerField} />

{/* existing ConversionByCloserTable, FieldAnswerDistribution, FormResponseAnalyticsSection remain */}
```

**Key implementation notes:**
- `formatDurationMs` rounds hours to 1 decimal for under-24h spans; days + hours above. Matches the latency formatter pattern from Phase D but with different breakpoints (leads often convert in hours, not minutes).
- Top answer list truncates the answer text at 1 line with a `title` tooltip for the full text — some fields have long answers.
- Keep the existing `FieldAnswerDistribution` and `FormResponseAnalyticsSection` components — the new `TopAnswerPerFieldList` is a complementary summary, not a replacement.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/leads/_components/avg-meetings-per-sale-card.tsx` | Create | |
| `app/workspace/reports/leads/_components/avg-time-to-conversion-card.tsx` | Create | |
| `app/workspace/reports/leads/_components/form-response-rate-card.tsx` | Create | |
| `app/workspace/reports/leads/_components/top-answer-per-field-list.tsx` | Create | |
| `app/workspace/reports/leads/_components/leads-report-page-client.tsx` | Modify | 2nd useQuery + 4 new cards + 1 new list |

---

### F6 — Activity Page: Most Active Closer + Actions/Closer/Day

**Type:** Frontend (modification)
**Parallelizable:** Yes — depends on Phase A widening `getActivitySummary.actorBreakdown` with `actorRole`. Phase B's `teamActions.ts` is an **optional upgrade path**, not a compile-time prerequisite. Independent of F1/F2/F3/F4/F5.

**What:** Modify `activity-summary-cards.tsx` to render **Most Active Closer** and **Actions per Closer (daily avg)**. Both derive from the Phase-A-extended `summary.actorBreakdown` + `dateRange`. A later Phase-B-dependent upgrade is handled as a follow-up (see Step 3).

**Why:** After Phase A, `actorBreakdown` carries `{ actorUserId, actorName, actorRole, count }` per actor — all data needed for both cards. No new `useQuery` subscription needed; no dependency on Phase B's `teamActions.ts` shipping order.

**Where:**
- `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` (modify — pass `dateRange` to summary cards)
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx` (modify — add 2 cards)

**How:**

**Step 1: Pass `dateRange` to the summary cards.**

```tsx
// Path: app/workspace/reports/activity/_components/activity-feed-page-client.tsx

  // No new useQuery. Phase A already widened the existing summary response with actorRole.
<ActivitySummaryCards
  summary={summary}
  dateRange={dateRange}  // NEW — needed to compute daySpanDays
/>
```

**Step 2: Extend `activity-summary-cards.tsx` (primary path — works independently of Phase B).**

```tsx
// Path: app/workspace/reports/activity/_components/activity-summary-cards.tsx

import { useMemo } from "react";
import { ActivityIcon, TrophyIcon } from "lucide-react";

const DAY_MS = 86_400_000;

interface ActivitySummaryCardsProps {
  summary: {
    totalEvents: number;
    isTruncated: boolean;
    bySource: Record<string, number>;
    byEventType: Record<string, number>;          // from Phase A
    byOutcome: Record<string, number>;            // from Phase A
    actorBreakdown: Array<{
      actorUserId: string;
      actorName: string;
      actorRole: string;
      count: number;
    }>;
  };
  dateRange: { startDate: number; endDate: number };
}

export function ActivitySummaryCards({ summary, dateRange }: ActivitySummaryCardsProps) {
  // Derive both KPIs locally from actorBreakdown.
  // Critically — no dependency on a Phase B query reference. Phase A already
  // supplied actorRole on actorBreakdown. If Phase B's
  // teamActions.ts ships later, the richer data (topCloserActors with full
  // counts, isTruncated flag for event scan limits) can be swapped in as a
  // follow-up; see Step 3.
  const { mostActiveCloser, actionsPerCloserPerDay, distinctCloserActors, daySpanDays } =
    useMemo(() => {
      const closerActors = summary.actorBreakdown.filter((a) => a.actorRole === "closer");
      const top = closerActors.slice().sort((a, b) => b.count - a.count)[0] ?? null;
      const totalCloserActions = closerActors.reduce((sum, a) => sum + a.count, 0);
      const distinct = closerActors.length;
      const days = Math.max(1, Math.ceil((dateRange.endDate - dateRange.startDate) / DAY_MS));
      const apcpd = distinct > 0 ? totalCloserActions / distinct / days : null;
      return {
        mostActiveCloser: top,
        actionsPerCloserPerDay: apcpd,
        distinctCloserActors: distinct,
        daySpanDays: days,
      };
    }, [summary.actorBreakdown, dateRange.startDate, dateRange.endDate]);

  // ... existing Phase A cards (byEventType / byOutcome) render above ...

  // Add two cards in a new grid row below the existing 4-source grid + Phase A cards:
  return (
    <>
      {/* ... existing 4-source grid + Phase A Top Event Types + Outcome Mix ... */}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <TrophyIcon className="h-4 w-4" />
              Most Active Closer
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold">
              {mostActiveCloser ? mostActiveCloser.actorName : "—"}
            </div>
            <p className="text-xs text-muted-foreground">
              {mostActiveCloser
                ? `${mostActiveCloser.count} action(s) in range`
                : "No closer activity"}
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <ActivityIcon className="h-4 w-4" />
              Actions / Closer / Day
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-lg font-bold tabular-nums">
              {actionsPerCloserPerDay === null ? "—" : actionsPerCloserPerDay.toFixed(1)}
            </div>
            <p className="text-xs text-muted-foreground">
              {distinctCloserActors} active closer(s) over {daySpanDays}d
              {summary.isTruncated && " • event scan truncated"}
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
```

**Step 3 (optional, non-blocking): Upgrade to Phase B's richer query once available.**

If Phase B's `teamActions.getActionsPerCloserPerDay` has merged, a follow-up PR can swap the local derivation for the richer query. Phase B's query returns the same `actionsPerCloserPerDay` plus `topCloserActors` (top-3) and its own `isTruncated` flag specific to the event scan. The swap is a 10-line diff and does not block shipping F6:

```tsx
// Optional follow-up after Phase B ships — NOT part of F6's initial scope.
// Requires api.reporting.teamActions.getActionsPerCloserPerDay to exist.
const teamActionsData = useQuery(
  api.reporting.teamActions.getActionsPerCloserPerDay,
  dateRange,
);
// ...then prefer teamActionsData.topCloserActors[0] + teamActionsData.actionsPerCloserPerDay
// when non-undefined; fall back to the actorBreakdown derivation above if still loading.
```

This upgrade step lives in Phase B's wake — not F6. Track it as a 1-point follow-up ticket.

**Key implementation notes:**
- **Zero Phase B dependency at compile time.** F6 consumes only data that ships with Phase A's extended `getActivitySummary`.
- `actorBreakdown` existed before v0.6b, but `actorRole` is added in Phase A. F6 should not merge ahead of that change.
- The local `actionsPerCloserPerDay` formula matches Phase B's query formula exactly, so swapping to Phase B later produces identical numbers (up to the event-scan truncation boundary, where Phase B's dedicated scan may be more accurate at high event volumes).
- Position the new grid row **below** the existing 4-source grid and Phase A's byEventType + byOutcome cards. Goal: keep the most-scanned cards at the top.
- Activity page still subscribes to **one** `useQuery` (`getActivitySummary`) — no subscription growth. `dateRange` is already in scope in the page client.
- The `summary.isTruncated` caveat in the caption honestly signals when the activity-summary scan cap was hit — admins can narrow the range for precision.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` | Modify | Pass `dateRange` prop to summary cards — no new `useQuery` |
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Modify | Add 2 cards deriving from `actorBreakdown` + `dateRange` |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/pipelineHealth.ts` | Modify | F1 |
| `convex/reporting/leadConversion.ts` | Modify | F2 |
| `convex/reporting/formResponseAnalytics.ts` | Modify | F3 |
| `app/workspace/reports/pipeline/_components/stale-pipeline-list.tsx` | Modify | F4 |
| `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx` | Create | F4 |
| `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` | Create | F4 |
| `app/workspace/reports/pipeline/_components/no-show-source-split-chart.tsx` | Create | F4 |
| `app/workspace/reports/pipeline/_components/loss-attribution-chart.tsx` | Create | F4 |
| `app/workspace/reports/pipeline/_components/pipeline-report-page-client.tsx` | Modify | F4 |
| `app/workspace/reports/leads/_components/avg-meetings-per-sale-card.tsx` | Create | F5 |
| `app/workspace/reports/leads/_components/avg-time-to-conversion-card.tsx` | Create | F5 |
| `app/workspace/reports/leads/_components/form-response-rate-card.tsx` | Create | F5 |
| `app/workspace/reports/leads/_components/top-answer-per-field-list.tsx` | Create | F5 |
| `app/workspace/reports/leads/_components/leads-report-page-client.tsx` | Modify | F5 |
| `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` | Modify | F6 |
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Modify | F6 |

**Blast radius:**
- **Backend:** 3 existing files modified (pipelineHealth, leadConversion, formResponseAnalytics). Existing exports preserved; new fields and new export added.
- **Frontend:** 8 new files, 5 modifications across pipeline / leads / activity. No overlap with other phases except Phase A's `activity-summary-cards.tsx` which Phase F extends further (sequence: Phase A first, then Phase F; or merge together with care).
- **No schema change.**
- **Phase A / Phase F overlap:** Both modify `activity-summary-cards.tsx`. Merge order: Phase A ships `byEventType`/`byOutcome` sub-cards first; Phase F adds `actionsPerCloser` + `mostActiveCloser` cards in a separate grid row. No textual conflict if merged sequentially.
- **Phase B / Phase F overlap:** None at compile time. F6 derives both new cards locally from `summary.actorBreakdown` (pre-existing field) and the in-scope `dateRange`. An optional post-Phase-B upgrade that swaps to `api.reporting.teamActions.getActionsPerCloserPerDay` for richer numbers is tracked as a non-blocking follow-up; if Phase B has merged at F6 ship time, the follow-up can be rolled into the same PR.

**Rollback plan:**
- **F1 rollback:** Revert `pipelineHealth.ts`. Frontend `getPipelineBacklogAndLoss` call fails gracefully (skeleton forever) until frontend is also reverted.
- **F2/F3 rollback:** Revert respective backend files. Leads page falls back to existing KPIs.
- **F4/F5/F6 rollback:** Revert frontend modifications.
