# Phase H — Cross-Cutting Fixes

**Goal:** Ship the three cross-cutting corrections that every other phase benefits from: (1) fix the date-range off-by-one bug in `ReportDateControls` so custom ranges include the last day of the selection, (2) add the `reports:view` permission and swap the reports layout auth from `requireRole` to `requireWorkspaceUser()` + `hasPermission(...)`, (3) add three new sidebar nav entries for the new report pages (Meeting Time, Review Ops, Reminders). No schema change, no new Convex queries — the smallest, lowest-risk phase of v0.6b.

**Prerequisite:** None to ship the date fix + permission alone. The nav entries depend on Phase C, Phase D, and Phase E existing (their routes must be mounted). Phase H can ship before C/D/E — the nav links would show 404 temporarily — but the recommended sequence is **ship nav last, after C/D/E**.

**Runs in PARALLEL with:** Phase A, Phase B, Phase C, Phase D, Phase E, Phase F, Phase G (backend subphases). Phase H's file set is disjoint from every other phase:
- `app/workspace/reports/_components/report-date-controls.tsx` — only Phase H touches.
- `convex/lib/permissions.ts` — only Phase H adds entries; Phase G modifies `convex/lib/outcomeHelpers.ts` (different file).
- `app/workspace/reports/layout.tsx` — only Phase H modifies.
- `app/workspace/_components/workspace-shell-client.tsx` — only Phase H touches the `reportNavItems` array in v0.6b.

**Skills to invoke:**
- `web-design-guidelines` — nav changes must maintain keyboard order and use semantic icons.
- `next-best-practices` — layout-level auth uses server-side cached helpers (`requireWorkspaceUser` + `hasPermission` from `lib/auth.ts` and `convex/lib/permissions.ts`).

**Acceptance Criteria:**
1. `ReportDateControls` — picking "April 1 → April 30" now sends `endDate = midnight(May 1)`. Every existing report query (`getLeadConversionMetrics`, `getActivityFeed`, `getActivitySummary`, `getFormResponseKpis` where used, etc.) continues to interpret `endDate` as exclusive upper bound — and now includes the last day of the custom range.
2. `convex/lib/permissions.ts` exposes `"reports:view"` mapped to `["tenant_master", "tenant_admin"]`.
3. `app/workspace/reports/layout.tsx` gates via `requireWorkspaceUser()` + `hasPermission(access.crmUser.role, "reports:view")` (instead of `requireRole(["tenant_master","tenant_admin"])`).
4. `workspace-shell-client.tsx` `reportNavItems` array contains three new entries: **Meeting Time** → `/workspace/reports/meeting-time`, **Review Ops** → `/workspace/reports/reviews`, **Reminders** → `/workspace/reports/reminders`.
5. Existing 5 nav entries (Team Performance, Revenue, Pipeline Health, Leads & Conversions, Activity Feed) preserved in original order.
6. Every report page that uses `ReportDateControls` continues to render correctly with the new end-date semantics, including legacy inclusive values already seeded by existing page clients.
7. No permission regression: every page that was accessible to `tenant_master` / `tenant_admin` before Phase H is still accessible.
8. A `closer` user navigating to `/workspace/reports/*` is redirected (same as pre-Phase H — `requireWorkspaceUser` + `hasPermission` enforces the gate).
9. `pnpm tsc --noEmit` passes.

---

## Subphase Dependency Graph

```
H1 (date-range end-boundary fix — frontend) ─────────────────┐
                                                              │── (independent; ship first)
H2 (reports:view permission — backend + layout refactor) ───┤
                                                              │
H3 (sidebar nav additions — frontend) ──────────────────────┘ (ship last, after C/D/E land)
```

**Optimal execution:**
1. **H1 and H2 can ship immediately** (no phase dependencies).
2. **H3 ships after C/D/E** so the new nav links resolve to real pages.

**Estimated time:** 0.5 day total.

---

## Subphases

### H1 — Date-Range End-Boundary Fix

**Type:** Frontend (single-file modification)
**Parallelizable:** Yes — only edits `app/workspace/reports/_components/report-date-controls.tsx`.

**What:** When the user picks a custom date range, convert the end date from "midnight of the chosen day" to "midnight of the next day" before sending as `endDate`. Every report query treats `endDate` as exclusive upper — this fix makes "April 1 → April 30" include all of April 30. The component must also render stored exclusive-upper values back to the user as the prior calendar day so the picker remains legible.

**Why:** Audit evidence — `convex/reporting/leadConversion.ts:32-37`, `convex/reporting/activityFeed.ts:99-125,183-187`, and `convex/reporting/formResponseAnalytics.ts:91-99` all use `.lt("scheduledAt", endDate)` / `.lt("occurredAt", endDate)` / `.lt("recordedAt", endDate)` semantics. The control currently sends `range.to.getTime()` (midnight at the **start** of the selected end date) → any meeting on the end date is excluded. Fixing this at the control level is the single point of change; fixing it in each query would spread date-boundary policy across the backend.

**Where:**
- `app/workspace/reports/_components/report-date-controls.tsx` (modify)

**How:**

**Step 1: Identify the current conversion.**

The audit shows lines 123-130 set `range.to.getTime()` directly:

```tsx
// BEFORE (lines ~115–135 — simplified):
onSelect={(range) => {
  if (range?.from && range?.to) {
    onChange({
      startDate: range.from.getTime(),
      endDate: range.to.getTime(),  // BUG: midnight of last selected day — excludes that day
    });
  }
}}
```

**Step 2: Convert `to` to end-of-range exclusive upper.**

```tsx
// Path: app/workspace/reports/_components/report-date-controls.tsx

// AFTER:
onSelect={(range) => {
  if (range?.from && range?.to) {
    // v0.6b Phase H: every report query treats endDate as exclusive upper bound.
    // Convert the user's end day to the next day at 00:00 so the chosen day is included.
    const startOfEndDay = new Date(range.to);
    startOfEndDay.setHours(0, 0, 0, 0);
    startOfEndDay.setDate(startOfEndDay.getDate() + 1);

    const startOfFromDay = new Date(range.from);
    startOfFromDay.setHours(0, 0, 0, 0);

    onChange({
      startDate: startOfFromDay.getTime(),
      endDate: startOfEndDay.getTime(),
    });
  }
}}
```

**Step 3: Also normalize the "from" side.**

If the current implementation sends `range.from.getTime()` without zeroing the time portion, we normalize that too. The `Calendar` component (shadcn/ui date-range picker) typically returns midnight already, but explicit `setHours(0,0,0,0)` guarantees it against timezone flukes. Covered in the AFTER snippet above.

**Step 4: Update the quick-pick presets to emit exclusive uppers.**

The current file ships these presets: `Today`, `This Week`, `This Month`, `Last Month`, `Last 90 Days`. Update each preset so the emitted `endDate` is an exclusive upper bound:

```tsx
function startOfTomorrow(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1); // tomorrow midnight → exclusive upper for "today"
  return d.getTime();
}
```

Examples:
```tsx
Today      => { startDate: startOfDay(now), endDate: startOfTomorrow() }
This Week  => { startDate: startOfWeek(now), endDate: startOfTomorrow() }
This Month => { startDate: startOfMonth(now), endDate: startOfTomorrow() }
Last Month => { startDate: startOfMonth(lastMonth), endDate: startOfMonth(now) }
Last 90d   => { startDate: subDays(startOfDay(now), 89), endDate: startOfTomorrow() }
```

For in-progress periods such as `This Week` / `This Month`, the exclusive upper should be **tomorrow midnight**, not the end of the entire week/month.

**Step 5: Normalize the render path for exclusive-upper values.**

Once the control starts emitting `endDate = next-day-midnight`, the raw `value.endDate` can no longer be used directly in the button label or the `Calendar` selection. Otherwise a range selected as `Apr 1 → Apr 30` will immediately re-render as `Apr 1 → May 1`.

Use a small helper:

```tsx
function getDisplayEnd(endDate: number): Date {
  const end = new Date(endDate);
  const isExactMidnight =
    end.getHours() === 0 &&
    end.getMinutes() === 0 &&
    end.getSeconds() === 0 &&
    end.getMilliseconds() === 0;

  // New contract: midnight means exclusive upper bound, so render the prior day.
  // Legacy contract: endOfDay/endOfMonth values are still inclusive and should render as-is.
  if (isExactMidnight) {
    end.setDate(end.getDate() - 1);
  }
  return end;
}
```

Use `getDisplayEnd(value.endDate)` for:
- the button label text
- `Calendar.selected.to`

This keeps the component backward-compatible with existing page clients that still seed inclusive `endOfMonth(...)` defaults while correctly displaying the new exclusive values emitted after interaction.

**Step 6: Verify by eyeball QA.**

Pick "April 1 → April 30" on the Activity page. A meeting with `scheduledAt` on April 30 at 3pm should appear in the feed. Before the fix, it was silently dropped.

**Key implementation notes:**
- **Local vs UTC:** The conversion uses local-time `setHours(0,0,0,0)`. For an admin in the same timezone as the app's UTC reporting, this is identical. For cross-timezone admins, there's a ≤24h boundary skew on the two edges — acceptable per design §16.7 ("proper timezone support deferred to v0.7").
- **Don't move this logic into backend queries.** The design is explicit (§11.1): every query treats `endDate` as exclusive upper. Changing that contract leaks date policy into backend logic and invalidates existing queries during the deploy window.
- **Display normalization is required.** Changing only the emitted `endDate` without changing how the control renders `value.endDate` causes an immediate one-day UI regression (`Apr 30` re-renders as `May 1`).
- **Tests:** ad-hoc QA per `TESTING.MD`. Create a meeting on the last day of the range and verify it shows up; remove and verify it's gone.
- **Backward compatibility:** existing page clients currently seed a mix of inclusive `endOf...()` values. The render-time normalization above keeps those pages legible while the control itself migrates new writes to the exclusive-upper contract.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reports/_components/report-date-controls.tsx` | Modify | Normalize `from` to midnight; bump `to` to next-day midnight; fix preset calculations |

---

### H2 — `reports:view` Permission + Layout Auth Swap

**Type:** Backend (permission add) + Frontend (layout auth call swap)
**Parallelizable:** Yes — edits `convex/lib/permissions.ts` (pure addition) and `app/workspace/reports/layout.tsx` (swap `requireRole` → `requireWorkspaceUser + hasPermission`).

**What:**
- Add `"reports:view": ["tenant_master", "tenant_admin"]` to the `PERMISSIONS` table.
- Change `app/workspace/reports/layout.tsx` from `await requireRole([...])` to `await requireWorkspaceUser()` + explicit `hasPermission(access.crmUser.role, "reports:view")` check.

**Why:** Today the reports area gates on `pipeline:view-all` (or `requireRole(["tenant_master","tenant_admin"])` as the audit shows). Both couple reports-access decisions to unrelated gates. Introducing a dedicated `reports:view` permission lets future phases expand/restrict reports without touching unrelated permission gates (e.g., v0.7 closer-facing reporting without widening `pipeline:view-all`).

**Where:**
- `convex/lib/permissions.ts` (modify — add permission entry)
- `app/workspace/reports/layout.tsx` (modify — swap auth guard)

**How:**

**Step 1: Add the permission entry.**

```typescript
// Path: convex/lib/permissions.ts

// BEFORE (existing PERMISSIONS table — excerpt):
export const PERMISSIONS = {
  "team:invite": ["tenant_master", "tenant_admin"],
  "team:remove": ["tenant_master", "tenant_admin"],
  "team:update-role": ["tenant_master"],
  "pipeline:view-all": ["tenant_master", "tenant_admin"],
  "pipeline:view-own": ["tenant_master", "tenant_admin", "closer"],
  "settings:manage": ["tenant_master", "tenant_admin"],
  "meeting:view-own": ["tenant_master", "tenant_admin", "closer"],
  "meeting:manage-own": ["closer"],
  "payment:record": ["closer"],
  "payment:view-all": ["tenant_master", "tenant_admin"],
  "payment:view-own": ["tenant_master", "tenant_admin", "closer"],
  "review:view": ["tenant_master", "tenant_admin"],
  "review:resolve": ["tenant_master", "tenant_admin"],
} as const;

// AFTER (v0.6b):
export const PERMISSIONS = {
  // ... existing entries unchanged ...
  "review:view": ["tenant_master", "tenant_admin"],
  "review:resolve": ["tenant_master", "tenant_admin"],
  // v0.6b Phase H — admin-only reporting area.
  "reports:view": ["tenant_master", "tenant_admin"],
} as const;
```

`Permission` type is derived from `keyof typeof PERMISSIONS` — automatically picks up the new entry.

**Step 2: Update the reports layout to use the new permission.**

```tsx
// Path: app/workspace/reports/layout.tsx

// BEFORE (13 lines — the whole file):
import { requireRole } from "@/lib/auth";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <>{children}</>;
}

// AFTER (v0.6b):
import { requireWorkspaceUser } from "@/lib/auth";
import { hasPermission } from "@/convex/lib/permissions";
import { redirect } from "next/navigation";

export default async function ReportsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await requireWorkspaceUser();
  // Redirect closers (and any future roles that lack reports:view) to their home.
  if (!hasPermission(access.crmUser.role, "reports:view")) {
    redirect("/workspace/closer");
  }
  return <>{children}</>;
}
```

**Step 3: Verify behavior.**

- As `tenant_master`: navigate to `/workspace/reports/team` — page loads (same as before).
- As `closer`: navigate to `/workspace/reports/team` — redirected to `/workspace/closer` (same as before because `requireRole` already blocked; now blocked via permission).
- As unauthenticated: redirected to `/sign-in` (handled inside `requireWorkspaceUser`).

**Key implementation notes:**
- **`hasPermission` is a synchronous helper** in `convex/lib/permissions.ts`. We import it directly into the RSC layout — there's no Convex function call. This keeps the layout fast.
- **Cross-module import:** Next.js + Convex supports importing TypeScript constants from `convex/` into `app/` via the repo's tsconfig path mapping. If this import fails (edge case — check the path mapping), extract the pure helper into `lib/reporting/permissions.ts` with a re-export.
- **`requireWorkspaceUser`** already redirects unauthenticated users, pending-onboarding users, system-admin users (to `/admin`), and non-provisioned users. Phase H only adds one additional redirect: permission-denied users to `/workspace/closer`.
- **Don't modify `requireRole`.** It's used by other gates — keep intact. Phase H prefers the dedicated `hasPermission` call for the narrower `reports:view` check.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/permissions.ts` | Modify | Add `"reports:view"` entry |
| `app/workspace/reports/layout.tsx` | Modify | Swap `requireRole` for `requireWorkspaceUser` + `hasPermission` |

---

### H3 — Sidebar Nav Additions (Meeting Time / Review Ops / Reminders)

**Type:** Frontend (single-file modification)
**Parallelizable:** Ship **after** Phase C, D, and E land. Independent of H1/H2.

**What:** Add three entries to `reportNavItems` in `workspace-shell-client.tsx`:
- **Meeting Time** → `/workspace/reports/meeting-time` (icon: `ClockIcon`)
- **Review Ops** → `/workspace/reports/reviews` (icon: `GavelIcon`)
- **Reminders** → `/workspace/reports/reminders` (icon: `BellRingIcon`)

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)

**How:**

**Step 1: Extend the `reportNavItems` array.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx

// BEFORE (lines ~91–97 — 5 entries):
const reportNavItems: NavItem[] = [
  { href: "/workspace/reports/team", label: "Team Performance", icon: BarChart3Icon },
  { href: "/workspace/reports/revenue", label: "Revenue", icon: DollarSignIcon },
  { href: "/workspace/reports/pipeline", label: "Pipeline Health", icon: ActivityIcon },
  { href: "/workspace/reports/leads", label: "Leads & Conversions", icon: TrendingUpIcon },
  { href: "/workspace/reports/activity", label: "Activity Feed", icon: ClockIcon },
];

// AFTER (v0.6b — 8 entries):
import {
  BarChart3Icon,
  DollarSignIcon,
  ActivityIcon,
  TrendingUpIcon,
  ClockIcon,            // existing — used for "Activity Feed"
  TimerIcon,            // NEW — Meeting Time
  GavelIcon,            // NEW — Review Ops
  BellRingIcon,         // NEW — Reminders
} from "lucide-react";

const reportNavItems: NavItem[] = [
  { href: "/workspace/reports/team", label: "Team Performance", icon: BarChart3Icon },
  { href: "/workspace/reports/revenue", label: "Revenue", icon: DollarSignIcon },
  { href: "/workspace/reports/pipeline", label: "Pipeline Health", icon: ActivityIcon },
  { href: "/workspace/reports/leads", label: "Leads & Conversions", icon: TrendingUpIcon },
  { href: "/workspace/reports/activity", label: "Activity Feed", icon: ClockIcon },
  // v0.6b Phase H — new reports
  { href: "/workspace/reports/meeting-time", label: "Meeting Time", icon: TimerIcon },
  { href: "/workspace/reports/reviews", label: "Review Ops", icon: GavelIcon },
  { href: "/workspace/reports/reminders", label: "Reminders", icon: BellRingIcon },
];
```

**Step 2: Verify visual order + keyboard navigation.**

Open the workspace in the browser. The Reports subsection should list 8 entries in order. Tab through them — each link should receive focus in the declared order. Active route highlighting should work on each new page.

**Step 3: Verify the "Review Ops" label.**

Design §17 (Open Q5): the report entry is labelled **"Review Ops"** specifically to disambiguate from the top-level "Reviews" operational inbox nav entry. Do **not** label it "Reviews" — that collides. Verify by checking the final sidebar: both "Reviews" (operational, under adminNavItems) and "Review Ops" (analytics, under reportNavItems) coexist.

**Key implementation notes:**
- **Icon choices:**
  - `TimerIcon` for Meeting Time — hourglass/timer imagery matches audit theme.
  - `GavelIcon` for Review Ops — matches the "review resolution" verb pattern from Phase A.
  - `BellRingIcon` for Reminders — clear reminder semantics.
- **Do not collide icons** — `ClockIcon` is used for Activity Feed and cannot double up. `TimerIcon` is distinct from `ClockIcon` in the lucide set.
- **Preserve the existing 5 entries untouched.** Append the 3 new ones at the end.
- **lucide-react is already in `optimizePackageImports`** per `next.config.ts` — new imports don't blow the bundle.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Extend `reportNavItems` with 3 new entries |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/reports/_components/report-date-controls.tsx` | Modify | H1 |
| `convex/lib/permissions.ts` | Modify | H2 |
| `app/workspace/reports/layout.tsx` | Modify | H2 |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | H3 |

**Blast radius:**
- **4 files total modified — the smallest phase in v0.6b.**
- **Zero new files.**
- **Zero schema changes.**
- **Zero new Convex queries.**
- Every modification is reversible in a single commit.
- **H3 ordering:** sidebar entries must point to real pages. Do not ship H3 before Phase C, D, and E are deployed. If an HTTPS-hosted demo requires shipping H1+H2 (date fix is broadly useful) while C/D/E are still in flight, hold H3 back in a follow-up PR.

**Rollback plan:**
- **H1 rollback:** revert one file — the fix is additive (pre-fix the last day was dropped silently; post-fix it's included).
- **H2 rollback:** revert `convex/lib/permissions.ts` + `app/workspace/reports/layout.tsx`. The old `requireRole` call continues to work.
- **H3 rollback:** remove the three new nav entries. Pages remain accessible via direct URL.

**Interaction with other phases:**
- **H1** benefits every other phase's reports — all use `ReportDateControls`.
- **H2**: no other phase currently consumes `hasPermission(access.crmUser.role, "reports:view")`. Phase D's new page layout inherits the fix via `app/workspace/reports/layout.tsx`.
- **H3**: requires Phase C (`/meeting-time`), Phase D (`/reviews`), Phase E (`/reminders`) to be shipped.
