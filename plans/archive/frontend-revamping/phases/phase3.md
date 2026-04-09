# Phase 3 — UX Refinement: State Management, Polling Hook, URL Filters, Empty States, Calendar Indicator, Lazy Dialogs

**Goal:** Improve code quality and user experience by extracting shared patterns, making filter state shareable via URL, adding actionable empty states, enhancing the calendar with a current-time indicator, and lazy-loading dialog contents.

**Prerequisite:** Phase 1 complete (status config must be stable). Phase 2 is NOT required — this phase touches page internals, not the layout shell.

**Runs in PARALLEL with:** Phase 2 (with care — both modify `app/workspace/page.tsx` and `app/workspace/closer/page.tsx`, but in different sections: Phase 2 adds `usePageTitle`, Phase 3 modifies data fetching. Coordinate to avoid merge conflicts.)

**Skills to invoke:**
- `vercel-react-best-practices` — `rerender-split-combined-hooks`, `bundle-dynamic-imports`, `rerender-functional-setstate`
- `vercel-composition-patterns` — `patterns-explicit-variants`, `state-lift-state`
- `shadcn` — Empty component CTAs, Alert variant usage

**Acceptance Criteria:**
1. A `usePollingQuery` hook exists in `hooks/` and is used by all 3 pages that currently implement one-shot polling.
2. The Team page uses a single discriminated union `useState<DialogState>` instead of 12 separate state calls.
3. Admin pipeline filters (`status` and `closer`) are synced to URL query params.
4. All empty states have at least one actionable CTA (link or button).
5. Day and week calendar views display a red horizontal "current time" line that updates every minute.
6. All dialog-heavy pages lazy-load their dialog contents via `next/dynamic`.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (usePollingQuery hook) ─────────┐
                                    ├──→ 3A is consumed by 3 pages (no further deps)
3B (Team page dialog refactor) ────┤
                                    │    (independent)
3C (Admin pipeline URL filters) ───┤
                                    │    (independent)
3D (Empty state CTAs) ────────────┤
                                    │    (independent)
3E (Calendar time indicator) ──────┤
                                    │    (independent)
3F (Lazy-load dialogs) ────────────┘
```

**Optimal execution:**
All 6 subphases are independent and can run in PARALLEL.

**Estimated time:** 3–4 days

---

### 3A — Extract `usePollingQuery` Hook

**Type:** Frontend (hook extraction)
**Parallelizable:** Yes — creates a new hook, then updates 3 consumers

**What:** Extract the repeated `useConvex() + useEffect + useState + setInterval` one-shot polling pattern into a reusable `usePollingQuery` hook.

**Why:** This exact pattern is copy-pasted across 3 pages:
- `app/workspace/page.tsx` — admin dashboard stats (60s polling)
- `app/workspace/closer/page.tsx` — next meeting (60s polling)
- `app/workspace/closer/meetings/[meetingId]/page.tsx` — meeting detail (one-shot, no polling)

Extracting it reduces ~40 lines of boilerplate per usage, standardizes error handling, and prevents bugs from inconsistent cancellation patterns.

**Where:**
- `hooks/use-polling-query.ts` (new)
- `app/workspace/page.tsx` (update)
- `app/workspace/closer/page.tsx` (update)
- `app/workspace/closer/meetings/[meetingId]/page.tsx` (update)

**How:**

```typescript
// Path: hooks/use-polling-query.ts
"use client";

import { useEffect, useState, useCallback } from "react";
import { useConvex } from "convex/react";
import type { FunctionReference, FunctionArgs, FunctionReturnType } from "convex/server";

/**
 * One-shot Convex query with optional polling.
 *
 * Unlike `useQuery` which creates a reactive subscription,
 * this hook fetches once and optionally re-fetches on an interval.
 * Use this for queries that depend on `Date.now()` or other
 * non-deterministic inputs that Convex cannot cache.
 *
 * @param queryRef — Convex query function reference
 * @param args — Query arguments, or "skip" to disable
 * @param options.intervalMs — Polling interval in ms (0 = no polling, just one-shot)
 */
export function usePollingQuery<Query extends FunctionReference<"query">>(
  queryRef: Query,
  args: FunctionArgs<Query> | "skip",
  options?: { intervalMs?: number },
): FunctionReturnType<Query> | undefined {
  const convex = useConvex();
  const [data, setData] = useState<FunctionReturnType<Query> | undefined>(undefined);
  const intervalMs = options?.intervalMs ?? 0;

  // Stable serialized args for dependency tracking
  const argsKey = args === "skip" ? "skip" : JSON.stringify(args);

  const fetchData = useCallback(async () => {
    if (args === "skip") return;
    try {
      const result = await convex.query(queryRef, args);
      setData(result);
    } catch (err) {
      console.error(`[usePollingQuery] Failed to fetch`, err);
    }
  }, [convex, queryRef, argsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (args === "skip") {
      setData(undefined);
      return;
    }

    let cancelled = false;

    const fetch = async () => {
      try {
        const result = await convex.query(queryRef, args);
        if (!cancelled) setData(result);
      } catch (err) {
        console.error(`[usePollingQuery] Failed to fetch`, err);
      }
    };

    void fetch();

    let interval: ReturnType<typeof setInterval> | undefined;
    if (intervalMs > 0) {
      interval = setInterval(() => void fetch(), intervalMs);
    }

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  }, [convex, queryRef, argsKey, intervalMs]); // eslint-disable-line react-hooks/exhaustive-deps

  return data;
}
```

**Update consumers:**

```tsx
// app/workspace/page.tsx — BEFORE (40 lines of boilerplate):
const convex = useConvex();
const [stats, setStats] = useState<AdminDashboardStats | undefined>(undefined);
useEffect(() => { /* 25 lines */ }, [convex, user]);

// AFTER (1 line):
const stats = usePollingQuery(
  api.dashboard.adminStats.getAdminDashboardStats,
  user && user.role !== "closer" ? {} : "skip",
  { intervalMs: 60_000 },
);
```

```tsx
// app/workspace/closer/page.tsx — BEFORE:
const convex = useConvex();
const [nextMeeting, setNextMeeting] = useState<NextMeetingData | undefined>(undefined);
useEffect(() => { /* 20 lines */ }, [convex]);

// AFTER:
const nextMeeting = usePollingQuery(
  api.closer.dashboard.getNextMeeting,
  {},
  { intervalMs: 60_000 },
);
```

```tsx
// app/workspace/closer/meetings/[meetingId]/page.tsx — BEFORE:
const convex = useConvex();
const [detailState, setDetailState] = useState<...>(/* complex state */);
useEffect(() => { /* 20 lines */ }, [meetingId, convex]);

// AFTER:
const detail = usePollingQuery(
  api.closer.meetingDetail.getMeetingDetail,
  { meetingId },
);
```

> **Note for meeting detail:** This page also uses a `refreshDetail` callback for `OutcomeActionBar`. The hook should also expose a `refetch` method. Add this to the hook by returning `{ data, refetch: fetchData }` instead of just `data`, or keep the `useConvex().query()` one-off call for refresh alongside the hook for initial load.

**Key implementation notes:**
- The `argsKey` serialization is needed because Convex query args are objects — we need a stable dependency for `useEffect`
- The `"skip"` sentinel matches the Convex `useQuery` pattern for conditional execution
- Error handling logs but doesn't throw — the consumer sees `undefined` and shows a skeleton
- The `EMPTY_ADMIN_STATS` fallback in workspace/page.tsx can be removed since the hook returns `undefined` on error (consistent with Convex `useQuery` behavior)

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `hooks/use-polling-query.ts` | Created | Reusable one-shot + polling hook |
| `app/workspace/page.tsx` | Modified | Replace 40-line useEffect with hook |
| `app/workspace/closer/page.tsx` | Modified | Replace 20-line useEffect with hook |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Modified | Replace fetch pattern with hook |

---

### 3B — Team Page Dialog State Refactor

**Type:** Frontend (composition pattern)
**Parallelizable:** Yes — touches only `app/workspace/team/page.tsx`

**What:** Replace the 12 individual `useState` calls with a single discriminated union state.

**Why:** The current pattern creates 12 state variables for 3 dialogs. Every `set*` call triggers a re-render, and the parallel state (e.g., `removeDialogOpen` + `removeUserId` + `removeUserName`) can drift out of sync. A discriminated union is a textbook application of `patterns-explicit-variants`.

**Where:**
- `app/workspace/team/page.tsx`

**How:**

```tsx
// Path: app/workspace/team/page.tsx

import type { Id } from "@/convex/_generated/dataModel";

// ─── Discriminated union for dialog state ────────────────────────────

type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string };

export default function TeamPage() {
  // ... existing queries ...

  // Single state replaces 12 useState calls
  const [dialog, setDialog] = useState<DialogState>({ type: null });

  const closeDialog = () => setDialog({ type: null });

  const handleEditRole = (memberId: Id<"users">, currentRole: string) => {
    const member = members?.find((m) => m._id === memberId);
    if (member && currentUser && currentUser._id !== memberId && member.role !== "tenant_master") {
      setDialog({
        type: "role",
        userId: memberId,
        userName: member.fullName || member.email,
        currentRole,
      });
    }
  };

  const handleRemoveUser = (memberId: Id<"users">) => {
    const member = members?.find((m) => m._id === memberId);
    if (member && currentUser && currentUser._id !== memberId && member.role !== "tenant_master") {
      setDialog({
        type: "remove",
        userId: memberId,
        userName: member.fullName || member.email,
      });
    }
  };

  const handleRelinkCalendly = (memberId: Id<"users">) => {
    const member = members?.find((m) => m._id === memberId);
    if (member) {
      setDialog({
        type: "calendly",
        userId: memberId,
        userName: member.fullName || member.email,
      });
    }
  };

  // ... render ...

  return (
    <div className="flex flex-col gap-6">
      {/* ... header, table ... */}

      {/* Dialogs — render based on discriminated union */}
      {dialog.type === "remove" && (
        <RemoveUserDialog
          open
          onOpenChange={(open) => { if (!open) closeDialog(); }}
          userId={dialog.userId}
          userName={dialog.userName}
        />
      )}

      {dialog.type === "calendly" && (
        <CalendlyLinkDialog
          open
          onOpenChange={(open) => { if (!open) closeDialog(); }}
          userId={dialog.userId}
          userName={dialog.userName}
        />
      )}

      {dialog.type === "role" && (
        <RoleEditDialog
          open
          onOpenChange={(open) => { if (!open) closeDialog(); }}
          userId={dialog.userId}
          userName={dialog.userName}
          currentRole={dialog.currentRole}
        />
      )}
    </div>
  );
}
```

**Key implementation notes:**
- The `open` prop is always `true` when the dialog is rendered (the discriminated union controls rendering, not an `open` boolean)
- `onOpenChange` calls `closeDialog()` when the dialog requests close (escape, backdrop click)
- This reduces from 12 state variables to 1, and from ~10 handler functions to 4
- Re-render count drops because `setDialog({ type: null })` is a single state update, not 3–4 separate `set*` calls

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/team/page.tsx` | Modified | Discriminated union dialog state |

---

### 3C — Admin Pipeline URL-Synced Filters

**Type:** Frontend
**Parallelizable:** Yes — touches only admin pipeline page

**What:** Sync the admin pipeline's status and closer filters to URL query params (`?status=...&closer=...`) so links are shareable and the back button works.

**Why:** The closer pipeline already does this correctly. The admin pipeline stores filters in component state only, making links unshareable and breaking the back button on filter changes. Inconsistency between the two pipeline views confuses users.

**Where:**
- `app/workspace/pipeline/page.tsx`

**How:**

Replace component state with `useSearchParams` + `useRouter`:

```tsx
// Path: app/workspace/pipeline/page.tsx
"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { Suspense } from "react";

// Wrap page in Suspense for useSearchParams (Next.js requirement)
export default function PipelinePage() {
  return (
    <Suspense>
      <PipelineContent />
    </Suspense>
  );
}

function PipelineContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const status = searchParams.get("status") ?? undefined;
  const closerId = searchParams.get("closer") ?? undefined;

  const setFilters = (newStatus?: string, newCloser?: string) => {
    const params = new URLSearchParams();
    if (newStatus) params.set("status", newStatus);
    if (newCloser) params.set("closer", newCloser);
    const qs = params.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  // Pass status and closerId to query args:
  const queryArgs = useMemo(() => ({
    ...(status && isValidOpportunityStatus(status) ? { status } : {}),
    ...(closerId ? { closerId: closerId as Id<"users"> } : {}),
  }), [status, closerId]);

  // ... rest of page
}
```

**Key implementation notes:**
- `useSearchParams` requires a `<Suspense>` boundary in Next.js App Router
- `{ scroll: false }` prevents scroll-to-top on filter change (matches closer pipeline behavior)
- The `useMemo` on query args prevents unnecessary Convex re-fetches
- This is a direct port of the pattern already used in `app/workspace/closer/pipeline/page.tsx`

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/pipeline/page.tsx` | Modified | URL-synced filter state |

---

### 3D — Empty State CTAs

**Type:** Frontend
**Parallelizable:** Yes — touches individual component empty states

**What:** Add actionable CTAs (buttons or links) to all empty states in the application.

**Why:** Current empty states inform the user ("No upcoming meetings", "No opportunities") but provide no actionable next step. Users are left wondering what to do. Contextual CTAs guide them to the right action.

**Where:**
- `app/workspace/closer/_components/closer-empty-state.tsx`
- `app/workspace/closer/pipeline/page.tsx` (empty state in the table)
- `app/workspace/pipeline/_components/opportunities-table.tsx` (empty state)
- `app/workspace/team/_components/team-members-table.tsx` (empty state)
- `app/workspace/settings/_components/event-type-config-list.tsx` (empty state)

**How:**

For each empty state, add context-appropriate CTAs:

**Closer Dashboard — "No upcoming meetings":**
```tsx
<CloserEmptyState
  title="No upcoming meetings"
  description="New meetings appear automatically when leads book through Calendly."
>
  <p className="text-xs text-muted-foreground">
    Ask your admin to verify your Calendly link is active.
  </p>
</CloserEmptyState>
```

> Modify `CloserEmptyState` to accept `children` for optional extra content.

**Closer Pipeline — empty filtered table:**
```tsx
// When filtered and no results:
<Empty>
  <EmptyHeader>
    <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
    <EmptyTitle>No {statusLabel} opportunities</EmptyTitle>
    <EmptyDescription>
      Try selecting a different status filter, or check back later.
    </EmptyDescription>
  </EmptyHeader>
  <Button variant="outline" size="sm" onClick={() => setStatus(undefined)}>
    Show all opportunities
  </Button>
</Empty>

// When unfiltered and no results:
<Empty>
  <EmptyHeader>
    <EmptyMedia variant="icon"><InboxIcon /></EmptyMedia>
    <EmptyTitle>No opportunities yet</EmptyTitle>
    <EmptyDescription>
      Opportunities are created automatically when leads book meetings through Calendly.
    </EmptyDescription>
  </EmptyHeader>
</Empty>
```

**Admin Pipeline — empty table:**
```tsx
<Button variant="outline" size="sm" asChild>
  <Link href="/workspace/settings">Configure event types</Link>
</Button>
```

**Team Members Table — empty:**
```tsx
<Button variant="outline" size="sm" onClick={() => /* open invite dialog */}>
  <UsersIcon data-icon="inline-start" />
  Invite your first team member
</Button>
```

**Event Type Config — empty:**
```tsx
<EmptyDescription>
  Connect Calendly and your event types will appear here automatically.
</EmptyDescription>
<Button variant="outline" size="sm" asChild>
  <Link href="/workspace/settings">Check Calendly connection</Link>
</Button>
```

**Key implementation notes:**
- The `Empty` compound component from shadcn already supports children after `EmptyHeader` — CTAs go there
- CTAs should be `variant="outline" size="sm"` for visual subtlety — they're suggestions, not primary actions
- For filtered views, always offer a "clear filters" CTA alongside the "no results" message
- Avoid CTAs that link to external services (Calendly) — keep users in the CRM

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/closer/_components/closer-empty-state.tsx` | Modified | Accept children, add guidance |
| `app/workspace/closer/pipeline/page.tsx` | Modified | Add "clear filter" CTA to empty |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | Add CTA to empty state |
| `app/workspace/team/_components/team-members-table.tsx` | Modified | Add "invite" CTA to empty state |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modified | Add connection CTA to empty state |

---

### 3E — Calendar Current-Time Indicator

**Type:** Frontend
**Parallelizable:** Yes — touches only calendar view components

**What:** Add a red horizontal line to the day and week calendar views that indicates the current time. The line updates its position every minute.

**Why:** Day and week calendar views show the time grid (7 AM – 9 PM) but don't indicate where "now" is. This is a standard calendar UX affordance — Google Calendar, Outlook, and Apple Calendar all show this. Without it, users must mentally map the current time to the grid.

**Where:**
- `app/workspace/closer/_components/day-view.tsx`
- `app/workspace/closer/_components/week-view.tsx`
- `app/workspace/closer/_components/calendar-utils.ts`

**How:**

**Step 1: Add a `useCurrentTime` hook to calendar-utils:**

```typescript
// Path: app/workspace/closer/_components/calendar-utils.ts

// Add to existing file:

/**
 * Returns current time and re-renders every `intervalMs`.
 * Used for the "now" indicator line in day/week views.
 */
export function useCurrentTime(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
```

**Step 2: Create the indicator component:**

```tsx
// Inline in day-view.tsx and week-view.tsx, or extracted:

function NowIndicator({ now }: { now: Date }) {
  const hour = now.getHours();
  const minutes = now.getMinutes();

  // Only show if within the visible grid range
  if (hour < START_HOUR || hour >= END_HOUR) return null;

  const topPx = (hour - START_HOUR) * HOUR_HEIGHT + (minutes / 60) * HOUR_HEIGHT;

  return (
    <div
      className="pointer-events-none absolute left-0 right-0 z-10 flex items-center"
      style={{ top: `${topPx}px` }}
      aria-hidden="true"
    >
      <div className="size-2 rounded-full bg-red-500" />
      <div className="h-px flex-1 bg-red-500" />
    </div>
  );
}
```

**Step 3: Integrate into day-view.tsx:**

```tsx
// Inside the scrollable time grid container, add alongside the hour lines and meeting blocks:
<NowIndicator now={now} />
```

**Step 4: Integrate into week-view.tsx:**

For the week view, the indicator spans across all 7 columns. Place it in the time grid container at the same level as the grid lines, but spanning the full width:

```tsx
// Inside the scrollable container, AFTER the column grid:
{isToday(currentDate) && <NowIndicator now={now} />}
```

> Only show the indicator if the current view includes today's date.

**Key implementation notes:**
- `z-10` ensures the line appears above meeting blocks but below interactive elements
- `pointer-events-none` prevents the line from intercepting clicks on meeting blocks
- `aria-hidden="true"` because this is a purely visual indicator
- The red dot + line pattern matches Google Calendar's design language
- `useCurrentTime(60_000)` updates once per minute — no need for more precision
- In the week view, only show the indicator on today's column. Use `isToday()` from date-fns on each column header to determine visibility

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/closer/_components/calendar-utils.ts` | Modified | Add useCurrentTime hook |
| `app/workspace/closer/_components/day-view.tsx` | Modified | Add NowIndicator component |
| `app/workspace/closer/_components/week-view.tsx` | Modified | Add NowIndicator with column scope |

---

### 3F — Lazy-Load Dialogs

**Type:** Frontend (performance)
**Parallelizable:** Yes — touches dialog imports across multiple pages

**What:** Convert static dialog imports to `next/dynamic` for all dialogs that are only shown on user interaction.

**Why:** Dialogs like `PaymentFormDialog` (361 lines), `FollowUpDialog` (224 lines), and `InviteUserDialog` (225 lines) are imported at page load but only rendered when a user clicks a button. Lazy-loading them reduces the initial JavaScript bundle for each page.

**Where:**
- `app/workspace/team/page.tsx`
- `app/workspace/closer/meetings/[meetingId]/page.tsx` (via OutcomeActionBar)
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx`
- `app/workspace/settings/_components/event-type-config-list.tsx`
- `app/admin/page.tsx`

**How:**

Replace static imports with `next/dynamic`:

```tsx
// BEFORE:
import { PaymentFormDialog } from "./payment-form-dialog";
import { FollowUpDialog } from "./follow-up-dialog";
import { MarkLostDialog } from "./mark-lost-dialog";

// AFTER:
import dynamic from "next/dynamic";

const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);
const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
```

**Dialogs to lazy-load:**

| Dialog | Parent Component | Est. Size |
|--------|-----------------|-----------|
| `PaymentFormDialog` | `outcome-action-bar.tsx` | ~360 lines |
| `FollowUpDialog` | `outcome-action-bar.tsx` | ~225 lines |
| `MarkLostDialog` | `outcome-action-bar.tsx` | ~125 lines |
| `InviteUserDialog` | `team/page.tsx` | ~225 lines |
| `RemoveUserDialog` | `team/page.tsx` | ~80 lines |
| `CalendlyLinkDialog` | `team/page.tsx` | ~135 lines |
| `RoleEditDialog` | `team/page.tsx` | ~130 lines |
| `CreateTenantDialog` | `admin/page.tsx` | ~230 lines |
| `ResetTenantDialog` | `admin/page.tsx` | ~225 lines |
| `EventTypeConfigDialog` | `event-type-config-list.tsx` | ~150 lines |

**Key implementation notes:**
- No `loading` fallback is needed for dialogs — the dialog opens instantly because the trigger button shows a loading state while the chunk loads
- `ssr: false` is NOT needed because these components are already inside `"use client"` pages
- The named export pattern (`.then(m => ({ default: m.X }))`) is required because these files use named exports, not default exports
- Total estimated bundle reduction: ~1,900 lines of JS moved from critical path to on-demand chunks
- Test that dialogs still open correctly — the first open may have a brief delay while the chunk loads

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modified | Dynamic import 3 dialogs |
| `app/workspace/team/page.tsx` | Modified | Dynamic import 4 dialogs |
| `app/admin/page.tsx` | Modified | Dynamic import 2 dialogs |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modified | Dynamic import 1 dialog |

---

## Phase 3 Summary

| File | Action | Subphase |
|------|--------|----------|
| `hooks/use-polling-query.ts` | Created | 3A |
| `app/workspace/page.tsx` | Modified | 3A |
| `app/workspace/closer/page.tsx` | Modified | 3A |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Modified | 3A |
| `app/workspace/team/page.tsx` | Modified | 3B, 3F |
| `app/workspace/pipeline/page.tsx` | Modified | 3C |
| `app/workspace/closer/_components/closer-empty-state.tsx` | Modified | 3D |
| `app/workspace/closer/pipeline/page.tsx` | Modified | 3D |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Modified | 3D |
| `app/workspace/team/_components/team-members-table.tsx` | Modified | 3D |
| `app/workspace/settings/_components/event-type-config-list.tsx` | Modified | 3D, 3F |
| `app/workspace/closer/_components/calendar-utils.ts` | Modified | 3E |
| `app/workspace/closer/_components/day-view.tsx` | Modified | 3E |
| `app/workspace/closer/_components/week-view.tsx` | Modified | 3E |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modified | 3F |
| `app/admin/page.tsx` | Modified | 3F |
