# Phase A — Activity Feed Parity & Fixes

**Goal:** Close every legibility gap in the `/workspace/reports/activity` surface so that every domain event the system actually emits has a label, every status transition renders from the correct fields, and the summary exposes event-type and outcome slices on top of the existing `bySource`. Read-side only — no schema changes, no new queries, no new writes.

**Prerequisite:** None (this is the smallest, safest phase — the design explicitly calls it out as ship-first to unblock confidence in the domain-event stream). Deploys cleanly on top of current `main` (2026-04-18).

**Runs in PARALLEL with:** Phase B, Phase C, Phase D, Phase E, Phase F, Phase G (backend-only subphases), Phase H. Backend files are fully disjoint. Frontend overlap is limited to `app/workspace/reports/activity/_components/activity-summary-cards.tsx`, which Phase F6 extends **after** A4.

**Skills to invoke:**
- `web-design-guidelines` — new summary cards and filter dropdown items must remain accessible (aria-labels on cards, keyboard-navigable filter dropdowns).
- `vercel-react-best-practices` — summary card grid must stay stable across `useQuery` updates; memoize derived breakdowns.
- `shadcn` — two new cards reuse existing `Card` / `CardHeader` / `CardContent` primitives; any chart primitives come from `components/ui/chart.tsx`.

**Acceptance Criteria:**
1. `rg -n 'eventType: "' convex | grep -oE '"[a-z_.]+"' | sort -u` and every value found exists as a key in `convex/reporting/lib/eventLabels.ts`'s `EVENT_LABELS` map.
2. The activity filter dropdown (`app/workspace/reports/activity/_components/activity-feed-filters.tsx`) lists all newly labelled event types (the dropdown is rebuilt from `Object.entries(EVENT_LABELS)` — no extra wiring needed).
3. A `domainEvents` row with `eventType === "opportunity.status_changed"` and non-null top-level `fromStatus`/`toStatus` renders the transition in the activity row (e.g., `"scheduled → completed"`). Same for `meeting.canceled`, `meeting.started`, `meeting.stopped`, `meeting.status_changed`.
4. Legacy rows that only wrote status into `metadata.fromStatus`/`metadata.toStatus` continue to render correctly (fallback path preserved — no data loss for historical rows).
5. `getActivitySummary` returns two new fields: `byEventType` (object keyed by event type string) and `byOutcome` (object keyed by outcome label). `actorBreakdown` entries are also widened to include `actorRole`.
6. The activity report page renders two new cards — **Top Event Types** (top 5 of `byEventType`) and **Outcome Mix** (all keys of `byOutcome` with non-zero counts).
7. `byOutcome` buckets: `followUp.completed` events with `metadata.outcome === "payment_received"` increment `"reminder_payment_received"`; `meeting.overran_review_resolved` events with `metadata.resolutionAction === "log_payment"` increment `"review_resolved_sale"`; and the remaining `outcome` / `resolutionAction` values each map to their own labelled bucket.
8. Filter dropdown `EVENT_TYPE_OPTIONS` still sorts alphabetically (no ordering regression).
9. Hovering an event icon in the activity row shows the event-type key as a `title` attribute (aids debugging / back-channel support).
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
A1 (event labels — backend)    ─────────────────┐
                                                │
A2 (activity summary extension — backend) ─────┤── A4 (filter & summary UI — frontend; depends on A1+A2)
                                                │
A3 (event row status transition — frontend) ───┘   (A3 is independent; can ship at the same time as A4 once A1/A2 land)
```

**Optimal execution:**
1. **Backend stream:** Start A1 and A2 in parallel (different exports in different files).
2. **Frontend stream:** Start A3 immediately — it only edits `activity-event-row.tsx` and does not depend on A1/A2. A4 waits for A1 (label map) and A2 (byEventType / byOutcome) to merge.
3. Merge: A1+A2 → A4 → ship.

**Estimated time:** 1 day (solo); 0.5 day with backend + frontend parallel.

---

## Subphases

### A1 — Event Label Completion

**Type:** Backend (pure TypeScript constant)
**Parallelizable:** Yes — only edits `convex/reporting/lib/eventLabels.ts`. No other phase modifies this file.

**What:** Add 9 missing entries to `EVENT_LABELS` so every emitted `eventType` resolves to a human-readable verb and icon hint.

**Why:** `getEventLabel()` (called by the activity row and the filter dropdown) falls back to `{ verb: eventType, iconHint: "activity" }` when a key is missing. 9 real event types the pipeline emits (audited via `rg -n 'eventType: "' convex` on 2026-04-18) currently hit that fallback, rendering as raw strings and being omitted from the filter dropdown entirely (the dropdown iterates `EVENT_LABELS`, not emitted events).

**Where:**
- `convex/reporting/lib/eventLabels.ts` (modify)

**How:**

**Step 1: Audit existing map and append new labels.**

Current `EVENT_LABELS` ships 24 entries (verified 2026-04-19 by reading the file). Append 9 new entries preserving the existing grouping comments (if any) and alphabetical order within category.

```typescript
// Path: convex/reporting/lib/eventLabels.ts

// BEFORE — excerpted (full file ~110 lines)
export const EVENT_LABELS: Record<string, EventLabel> = {
  // ... 24 existing entries ...
  "payment.recorded": { verb: "recorded a payment", iconHint: "dollar-sign" },
  "payment.verified": { verb: "verified a payment", iconHint: "badge-check" },
  // ... rest of existing entries ...
};

// AFTER — add (keep existing 24 untouched; append alphabetically within category):
export const EVENT_LABELS: Record<string, EventLabel> = {
  // ... existing 24 entries ...

  // === v0.6b: Admin resolution & overran flow ===
  "meeting.admin_resolved": { verb: "resolved a meeting as admin", iconHint: "shield-check" },
  "meeting.overran_detected": { verb: "flagged a meeting as overran", iconHint: "alert-triangle" },
  "meeting.overran_closer_responded": { verb: "responded to an overran meeting", iconHint: "message-square" },
  "meeting.overran_review_resolved": { verb: "resolved an overran review", iconHint: "gavel" },
  "meeting.status_changed": { verb: "changed a meeting status", iconHint: "arrow-right-left" },
  "meeting.webhook_ignored_overran": { verb: "ignored a late webhook for a flagged meeting", iconHint: "filter" },

  // === v0.6b: Payment dispute & follow-up lifecycle ===
  "payment.disputed": { verb: "disputed a payment", iconHint: "circle-alert" },
  "followUp.expired": { verb: "expired a follow-up", iconHint: "calendar-x-2" },

  // === v0.6b: Customer rollback ===
  "customer.conversion_rolled_back": { verb: "rolled back a customer conversion", iconHint: "undo-2" },
};
```

**Step 2: Extend `ICON_MAP` in the activity row consumer.**

`activity-event-row.tsx` currently imports a fixed map of `iconHint` → lucide component. Every new `iconHint` that is not already in the map needs an entry; otherwise the `ICON_MAP[label.iconHint] ?? Activity` fallback kicks in and every new icon renders as the generic `Activity` icon.

Audit: the new icon hints used are `shield-check`, `alert-triangle`, `message-square`, `gavel`, `arrow-right-left`, `filter`, `circle-alert`, `calendar-x-2`, `undo-2`. All are valid `lucide-react` exports. This update is made in subphase **A3** (it's a frontend-only file) and re-verified there. **Do not touch `activity-event-row.tsx` in A1.**

**Key implementation notes:**
- Keep the existing 24 entries byte-for-byte identical to avoid rebase conflicts.
- Do not add labels for event types that are *not* currently emitted in production — false coverage misleads debugging.
- `meeting.status_changed` is distinct from `opportunity.status_changed` (which already has a label). The `meeting.status_changed` event is emitted only from `convex/reviews/mutations.ts:423` when an admin forces a meeting out of `meeting_overran` during review resolution. Verb reflects that context: "changed a meeting status".

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/eventLabels.ts` | Modify | Append 9 labels; preserve existing 24 |

---

### A2 — Activity Summary `byEventType` + `byOutcome` Slices

**Type:** Backend (query handler extension)
**Parallelizable:** Yes — only edits `convex/reporting/activityFeed.ts` within the existing `getActivitySummary` handler. No other phase touches this handler.

**What:** Extend `getActivitySummary`'s return shape to include two new breakdowns computed from the already-scanned events, and widen `actorBreakdown` entries with `actorRole` so downstream UI can filter actors by role without re-querying users.

**Why:** Today the summary returns `{ totalEvents, isTruncated, bySource, byEntity, byActor, actorBreakdown }`. Admin review work, reminder completions, disputed payments, and overran detections all collapse into coarse `bySource` buckets (all are `"admin"` or `"closer"`), so the summary view is not diagnostically useful. `byEventType` surfaces the raw event frequency (used for "Top Event Types" card). `byOutcome` rolls structured outcomes out of `metadata` for the two event types that carry them (`followUp.completed` and `meeting.overran_review_resolved`). `actorRole` on `actorBreakdown` keeps Phase F6 independent of Phase B's `teamActions.ts`.

**Where:**
- `convex/reporting/activityFeed.ts` (modify — extend `getActivitySummary` handler only; `getActivityFeed` unchanged)

**How:**

**Step 1: Add the two new accumulators in the existing scan loop.**

The handler already iterates the in-range event set once. Add two `Record<string, number>` accumulators and update them inside the same loop — no second scan.

```typescript
// Path: convex/reporting/activityFeed.ts

// Inside getActivitySummary handler, alongside existing accumulators:

// BEFORE:
const bySource: Record<string, number> = {};
const byEntity: Record<string, number> = {};
const byActor = new Map<string, number>();

// AFTER (add):
const bySource: Record<string, number> = {};
const byEntity: Record<string, number> = {};
const byActor = new Map<string, number>();

// NEW — v0.6b
const byEventType: Record<string, number> = {};
const byOutcome: Record<string, number> = {};

// ... inside the scan loop ...
for (const event of events) {
  bySource[event.source] = (bySource[event.source] ?? 0) + 1;
  byEntity[event.entityType] = (byEntity[event.entityType] ?? 0) + 1;
  if (event.actorUserId) byActor.set(event.actorUserId, (byActor.get(event.actorUserId) ?? 0) + 1);

  // NEW — v0.6b
  byEventType[event.eventType] = (byEventType[event.eventType] ?? 0) + 1;

  // byOutcome: pull structured outcome fields out of metadata.
  // metadata is stored as a string (JSON) in convex/schema.ts:805 — parse defensively.
  if (event.eventType === "followUp.completed" || event.eventType === "meeting.overran_review_resolved") {
    const parsed = parseEventMetadata(event.metadata);
    if (event.eventType === "followUp.completed" && parsed?.outcome) {
      const bucket = `reminder_${parsed.outcome}`;
      byOutcome[bucket] = (byOutcome[bucket] ?? 0) + 1;
    } else if (event.eventType === "meeting.overran_review_resolved" && parsed?.resolutionAction) {
      const bucket = `review_resolved_${parsed.resolutionAction}`;
      byOutcome[bucket] = (byOutcome[bucket] ?? 0) + 1;
    }
  }
}
```

**Step 2: Add the `parseEventMetadata` helper at module scope.**

`domainEvents.metadata` is `v.optional(v.string())` (JSON-encoded). Parse defensively — never throw on malformed JSON; that would blow up the whole summary query.

```typescript
// Path: convex/reporting/activityFeed.ts (top of file, near imports)

/**
 * Parses domainEvents.metadata (JSON string) into a plain object.
 * Returns null for missing, empty, or malformed metadata — never throws.
 * v0.6b: used by getActivitySummary to extract outcome fields without
 * coupling the summary shape to the write-side metadata contract.
 */
function parseEventMetadata(
  metadata: string | undefined | null,
): Record<string, unknown> | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
```

**Step 3: Extend `actorBreakdown` with `actorRole` while hydrating users.**

`getActivitySummary` already hydrates `users` docs to produce `actorName`. Include each actor's CRM role in the same pass so downstream UI can distinguish closer activity from admin activity without a second user lookup.

```typescript
// Path: convex/reporting/activityFeed.ts

const actorDocs = await Promise.all(
  actorIds.map(async (actorId) => [actorId, await ctx.db.get(actorId)] as const),
);
const actorById = new Map(actorDocs);

const actorBreakdown = [...actorCounts.entries()]
  .map(([actorUserId, count]) => {
    const actor = actorById.get(actorUserId) ?? null;
    return {
      actorUserId,
      actorName: getUserDisplayName(actor),
      actorRole: actor?.role ?? "unknown",
      count,
    };
  })
  .sort((left, right) => right.count - left.count);
```

**Step 4: Return the new fields.**

```typescript
// Path: convex/reporting/activityFeed.ts

return {
  totalEvents,
  isTruncated,
  bySource,
  byEntity,
  byActor: Object.fromEntries(byActor),
  actorBreakdown, // existing field, widened with actorRole
  // NEW — v0.6b
  byEventType,
  byOutcome,
};
```

**Key implementation notes:**
- **Do not modify `getActivityFeed`** — only the summary query. The feed is row-level and already returns top-level `fromStatus`/`toStatus`.
- `metadata` is JSON-encoded on write (see `convex/lib/domainEvents.ts:emitDomainEvent`). The parser handles both `undefined` and malformed input — log nothing (hot path). If alert-level visibility into malformed metadata is ever wanted, route it via `verification.ts`, not the summary.
- `byEventType` is an object (not a Map) because `Object.fromEntries(Map)` is fine but redundant when we already build as an object. Consistent with `bySource`/`byEntity`.
- `byOutcome` bucket names are deliberately prefixed (`reminder_*`, `review_resolved_*`) so the frontend can show them under labelled groups without re-parsing the key.
- `actorRole` is derived from the live `users.role` field at read time. Use `"unknown"` when the user doc is missing so the summary stays resilient to deleted users.
- Summary truncation (`isTruncated`) still applies — the outcome slice scans only the in-range, capped event set. Document this in the returned shape; no change to semantics.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/activityFeed.ts` | Modify | Extend `getActivitySummary` only; leave `getActivityFeed` unchanged |

---

### A3 — Activity Row `fromStatus` / `toStatus` Rendering Fix

**Type:** Frontend (single component modification)
**Parallelizable:** Yes — only edits `activity-event-row.tsx`. Independent of A1/A2. Can ship immediately.

**What:** Read top-level `event.fromStatus` / `event.toStatus` first; fall back to `event.metadata.fromStatus` / `event.metadata.toStatus` only for legacy rows. Also extend the `ICON_MAP` to cover the new icon hints added in A1.

**Why:** `convex/lib/domainEvents.ts:12-32` writes `fromStatus` and `toStatus` as **top-level** `domainEvents` fields. `convex/reporting/activityFeed.ts` correctly returns both top-level fields. But `activity-event-row.tsx` lines 73-74 read `metadata.fromStatus` / `metadata.toStatus` — which is always `undefined` for events written after the domainEvents schema was added. Every status transition for `opportunity.status_changed`, `meeting.canceled`, `meeting.status_changed`, etc. silently drops the transition text from the row.

**Where:**
- `app/workspace/reports/activity/_components/activity-event-row.tsx` (modify — status extraction + icon map)

**How:**

**Step 1: Fix the status extraction.**

```tsx
// Path: app/workspace/reports/activity/_components/activity-event-row.tsx

// BEFORE (lines ~71–95):
interface ActivityEventRowProps {
  event: {
    eventType: string;
    entityType: string;
    actorName: string | null;
    occurredAt: number;
    source: string;
    metadata: Record<string, unknown> | null;
  };
}

export function ActivityEventRow({ event }: ActivityEventRowProps) {
  const label = getEventLabel(event.eventType);
  const Icon = ICON_MAP[label.iconHint] ?? Activity;

  const fromStatus = event.metadata?.fromStatus as string | undefined;
  const toStatus = event.metadata?.toStatus as string | undefined;

// AFTER:
interface ActivityEventRowProps {
  event: {
    eventType: string;
    entityType: string;
    actorName: string | null;
    occurredAt: number;
    source: string;
    // v0.6b: top-level status fields take precedence; metadata is legacy-only.
    fromStatus: string | null;
    toStatus: string | null;
    metadata: Record<string, unknown> | null;
  };
}

export function ActivityEventRow({ event }: ActivityEventRowProps) {
  const label = getEventLabel(event.eventType);
  const Icon = ICON_MAP[label.iconHint] ?? Activity;

  // Read top-level first; fall back to metadata only for pre-schema-v2 events.
  const fromStatus =
    event.fromStatus ??
    (event.metadata?.fromStatus as string | undefined) ??
    null;
  const toStatus =
    event.toStatus ??
    (event.metadata?.toStatus as string | undefined) ??
    null;
```

Also update the `activity-feed-list.tsx` (or wherever the event prop is assembled) so it passes `fromStatus` / `toStatus` through from the Convex response. Verify with `rg -n '<ActivityEventRow' app` that every call site spreads the full event object (existing pattern).

**Step 2: Extend `ICON_MAP` for new iconHints from A1.**

Every `iconHint` added in A1 must be mapped to a concrete lucide component, or it falls through to `Activity` and every new event type renders with the generic icon.

```tsx
// Path: app/workspace/reports/activity/_components/activity-event-row.tsx

import {
  // ... existing imports ...
  ShieldCheck,
  AlertTriangle,
  MessageSquare,
  Gavel,
  ArrowRightLeft,
  Filter as FilterIcon, // `filter` conflicts with the Array method lint; alias
  CircleAlert,
  CalendarX2,
  Undo2,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  // ... existing entries ...
  // v0.6b — new iconHints
  "shield-check": ShieldCheck,
  "alert-triangle": AlertTriangle,
  "message-square": MessageSquare,
  gavel: Gavel,
  "arrow-right-left": ArrowRightLeft,
  filter: FilterIcon,
  "circle-alert": CircleAlert,
  "calendar-x-2": CalendarX2,
  "undo-2": Undo2,
};
```

**Step 3: Add debugging `title` attribute.**

Small quality-of-life addition: put the raw event type on the icon's container so support can hover to see the underlying event key without opening devtools.

```tsx
// Path: app/workspace/reports/activity/_components/activity-event-row.tsx

<div
  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted"
  title={event.eventType}
>
  <Icon className="h-4 w-4 text-muted-foreground" />
</div>
```

**Key implementation notes:**
- The legacy fallback is load-bearing — **do not remove** the `metadata.fromStatus` read. Some historical `lead.status_changed` / `customer.status_changed` events from before the top-level fields existed (pre-2026-02) wrote status only into metadata.
- `ICON_MAP` additions must be the exact lucide component names — typos fall through silently to `Activity`. Verify import paths against `node_modules/lucide-react/dist/esm/icons/`.
- Do not change the outer row layout — Phase A is scoped to parity, not a redesign.
- If the `event` prop type is generated via Convex codegen (e.g., pulled from `api.reporting.activityFeed.getActivityFeed._returnType`), no manual type-widening is required — the top-level `fromStatus` / `toStatus` flow through automatically.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/activity/_components/activity-event-row.tsx` | Modify | Status extraction + ICON_MAP extension + hover title |

---

### A4 — Activity Summary Cards — Top Event Types + Outcome Mix

**Type:** Frontend (component extension)
**Parallelizable:** Depends on A1 (label map drives dropdown + card titles) and A2 (`byEventType` / `byOutcome` in the response). A3 is independent.

**What:** Extend `activity-summary-cards.tsx` to render two new cards below the existing 4-source grid: **Top Event Types** (top 5 from `byEventType`) and **Outcome Mix** (non-zero entries from `byOutcome`).

**Why:** Admins today can see "Closer: 123 / Admin: 45 / Pipeline: 67 / System: 12" but cannot see which event types drove those numbers. With A2 shipping `byEventType` + `byOutcome`, we surface the most common event types and the structured outcomes (reminder-driven payments, review resolutions) without adding another query subscription.

**Where:**
- `app/workspace/reports/activity/_components/activity-summary-cards.tsx` (modify — type extension + two new card renders)
- `app/workspace/reports/activity/_components/activity-feed-page-client.tsx` (no change expected — already spreads the summary prop; verify with grep)

**How:**

**Step 1: Extend the prop type and destructure the new fields.**

```tsx
// Path: app/workspace/reports/activity/_components/activity-summary-cards.tsx

// BEFORE:
interface ActivitySummaryCardsProps {
  summary: {
    totalEvents: number;
    isTruncated: boolean;
    bySource: Record<string, number>;
  };
}

// AFTER (v0.6b):
interface ActivitySummaryCardsProps {
  summary: {
    totalEvents: number;
    isTruncated: boolean;
    bySource: Record<string, number>;
    byEventType: Record<string, number>;
    byOutcome: Record<string, number>;
  };
}
```

**Step 2: Derive top-N event types with a stable sort.**

```tsx
// Path: app/workspace/reports/activity/_components/activity-summary-cards.tsx

import { useMemo } from "react";
import { getEventLabel } from "@/convex/reporting/lib/eventLabels";
// ^ only if the client can import TS-only exports from convex/. If restricted by your tsconfig,
//   copy the getEventLabel function into the component or centralize it under lib/reporting/.
//   AGENTS.md pattern: shared client/server constants live in lib/ — preferred path is to
//   move EVENT_LABELS + getEventLabel to `lib/reporting/eventLabels.ts` and re-export from
//   both Convex and the frontend.

export function ActivitySummaryCards({ summary }: ActivitySummaryCardsProps) {
  const topEventTypes = useMemo(() => {
    return Object.entries(summary.byEventType)
      .sort(([aKey, aCount], [bKey, bCount]) => {
        if (bCount !== aCount) return bCount - aCount; // descending by count
        return aKey.localeCompare(bKey); // tie-break alphabetically
      })
      .slice(0, 5)
      .map(([eventType, count]) => ({
        eventType,
        verb: getEventLabel(eventType).verb,
        count,
      }));
  }, [summary.byEventType]);

  const outcomeRows = useMemo(() => {
    return Object.entries(summary.byOutcome)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([bucket, count]) => ({ bucket, label: humanizeOutcomeBucket(bucket), count }));
  }, [summary.byOutcome]);

  // ... existing 4-source card render unchanged ...

  return (
    <div className="space-y-4">
      {/* EXISTING 4-source grid unchanged */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {/* ... existing SOURCE_CARDS render ... */}
      </div>

      {/* NEW v0.6b — Top Event Types + Outcome Mix */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Top Event Types
            </CardTitle>
          </CardHeader>
          <CardContent>
            {topEventTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No events in range.</p>
            ) : (
              <ul className="space-y-1">
                {topEventTypes.map(({ eventType, verb, count }) => (
                  <li key={eventType} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{verb}</span>
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Outcome Mix
            </CardTitle>
          </CardHeader>
          <CardContent>
            {outcomeRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No outcomes tracked in range.</p>
            ) : (
              <ul className="space-y-1">
                {outcomeRows.map(({ bucket, label, count }) => (
                  <li key={bucket} className="flex items-center justify-between text-sm">
                    <span>{label}</span>
                    <span className="tabular-nums text-muted-foreground">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

**Step 3: Add the `humanizeOutcomeBucket` helper.**

```tsx
// Path: app/workspace/reports/activity/_components/activity-summary-cards.tsx (module scope)

/**
 * Converts an outcome bucket key (e.g. "reminder_payment_received") into a
 * human label ("Reminder: Payment received"). Symmetric with byOutcome
 * keys built by convex/reporting/activityFeed.ts getActivitySummary.
 */
function humanizeOutcomeBucket(bucket: string): string {
  const [namespace, ...rest] = bucket.split("_");
  const phrase = rest.join(" ");
  const capitalized = phrase.charAt(0).toUpperCase() + phrase.slice(1);
  if (namespace === "reminder") return `Reminder: ${capitalized}`;
  if (namespace === "review") return `Review: ${capitalized.replace(/^resolved /, "Resolved → ")}`;
  return `${namespace}: ${capitalized}`;
}
```

**Key implementation notes:**
- **Do not** add a `useQuery` — the summary prop is already passed by the parent page client. Adding a query would duplicate the subscription.
- Wrap derivation in `useMemo` so chart-like re-renders do not repeatedly sort the entries.
- Accessibility: cards use `<CardTitle>` (already `<h3>` under the hood); list items are semantic `<ul>` / `<li>`.
- Keep the summary prop shape additive — older clients of `ActivitySummaryCards` (none expected, but be defensive) must still render the 4 source cards with zero regressions.
- `getEventLabel` is currently exported from `convex/reporting/lib/eventLabels.ts`. If importing from Convex into `app/` is blocked by tsconfig path restrictions, the implementation move to `lib/reporting/eventLabels.ts` is a **minor refactor** (pure constant + pure function — no Convex imports). Track that as a same-PR addition if required by the repo tsconfig.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Modify | Add `byEventType` + `byOutcome` props; render 2 new cards |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/reporting/lib/eventLabels.ts` | Modify | A1 |
| `convex/reporting/activityFeed.ts` | Modify | A2 |
| `app/workspace/reports/activity/_components/activity-event-row.tsx` | Modify | A3 |
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Modify | A4 |

**Blast radius:** 4 files. All existing consumers remain untouched. `EVENT_LABELS` additions are pure additions; `activityFeed.getActivitySummary` extends its return shape additively; the row fix is a strict-superset (legacy metadata path preserved); summary cards add two new cards below the existing grid.

**Rollback plan:** Revert each subphase independently. All changes are backward-compatible — no schema, no migrations, no write paths touched.
