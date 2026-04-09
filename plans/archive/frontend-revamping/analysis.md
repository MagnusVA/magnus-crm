# Frontend Audit & Redesign Analysis

**Date:** 2026-04-03
**Scope:** UI/UX design, best practices, composition, accessibility, performance
**Approach:** Redesign with refinement — not a complete overhaul
**Skills applied:** frontend-design, shadcn, vercel-react-best-practices, vercel-composition-patterns, web-design-guidelines, workos

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Typography & Font Stack](#2-typography--font-stack)
3. [Design System Drift](#3-design-system-drift)
4. [Status Color Fragmentation](#4-status-color-fragmentation)
5. [Styling Violations](#5-styling-violations)
6. [Component Composition Issues](#6-component-composition-issues)
7. [Layout & Navigation UX](#7-layout--navigation-ux)
8. [Page-by-Page UI/UX Review](#8-page-by-page-uiux-review)
9. [Accessibility Gaps](#9-accessibility-gaps)
10. [Performance Opportunities](#10-performance-opportunities)
11. [React & Next.js Best Practices](#11-react--nextjs-best-practices)
12. [shadcn/ui Compliance](#12-shadcnui-compliance)
13. [Web Interface Guidelines Compliance](#13-web-interface-guidelines-compliance)
14. [WorkOS AuthKit Integration Review](#14-workos-authkit-integration-review)
15. [Missing UX Patterns](#15-missing-ux-patterns)
16. [Prioritised Improvement Plan](#16-prioritised-improvement-plan)

---

## 1. Executive Summary

Magnus CRM's frontend is a well-architected Next.js 16 + Convex + shadcn/ui application with solid bones: role-based routing works, data subscriptions are thoughtful, and loading states prevent layout shift. The codebase is production-grade.

However, a deep audit reveals **several systemic issues** that collectively erode the UX and violate established best practices:

| Severity | Count | Summary |
|----------|-------|---------|
| **Critical** | 4 | Global monospace font, status config fragmentation, design system drift, raw color classes |
| **High** | 9 | Sparse workspace header, no breadcrumbs, verbose state management, missing keyboard nav, inconsistent heading hierarchy, sidebar branding, landing page copy, admin page status config duplication, calendar fixed height |
| **Medium** | 12 | Missing search/command palette, no page transitions, inconsistent filter patterns, no bulk table actions, chart color parity, missing empty state CTAs, dialog lazy loading, admin stats redirect ordering, pipeline sort, notification center, Calendly guard UX, settings discoverability |
| **Low** | 6 | OG meta, footer polish, skeleton animation variety, tooltip coverage, loading text variety, environment indicator |

The redesign should address these in waves — critical fixes first, then high-impact UX improvements, then progressive enhancements.

---

## 2. Typography & Font Stack

### Critical: Global Monospace Body Text

**Files:** `app/layout.tsx` (line 44), `app/globals.css` (lines 11-12, 128)

The entire application renders body text in JetBrains Mono:

```tsx
// layout.tsx — line 44
className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-mono", jetbrainsMono.variable)}
```

```css
/* globals.css — line 12 */
--font-heading: var(--font-mono);

/* globals.css — line 128 */
html { @apply font-mono; }
```

**Problems:**
- Monospace fonts have wider character widths, reducing content density by ~20-30%
- Reduced readability for long-form text (meeting notes, descriptions, error messages)
- Headings in monospace lose the typographic authority that a display or sans-serif font provides
- Tables waste horizontal space with fixed-width characters
- Contradicts the DESIGN_SYSTEM.md which states "No custom fonts (preserves Next.js defaults for performance)" — yet three custom fonts are imported

**Recommendation:**
- Set `font-sans` (Geist Sans) as the default body font
- Reserve `font-mono` (JetBrains Mono) for code-like elements: IDs, timestamps, tabular numbers, the invite URL display
- Consider a distinctive heading font (not the same as body) for pages that need visual weight — or use Geist Sans with heavier weights and tighter tracking
- Remove Geist Mono import if JetBrains Mono covers all monospace needs

### Font Loading Strategy

Three Google fonts are imported but only two are actively needed. Each font adds a network request:
- `Geist` — used as `--font-geist-sans` but overridden by `font-mono` globally
- `Geist_Mono` — used as `--font-geist-mono` but unused in any component
- `JetBrains_Mono` — used as `--font-mono` and applied globally

**Recommendation:** Remove `Geist_Mono`, use `Geist` as primary sans, `JetBrains_Mono` as mono utility.

---

## 3. Design System Drift

### DESIGN_SYSTEM.md vs Actual Implementation

The documented design system (`DESIGN_SYSTEM.md`) no longer reflects the implemented reality. This creates confusion for any developer extending the UI.

| Aspect | DESIGN_SYSTEM.md says | Actual implementation |
|--------|----------------------|----------------------|
| **Fonts** | "No custom fonts (preserves Next.js defaults)" | Three Google Fonts imported |
| **Colors** | Slate-950, Slate-900, Amber-500 (named Tailwind colors) | OKLch color space variables in globals.css |
| **Loading states** | "No skeleton screens — just purposeful loading" | Skeleton screens used everywhere (good!) |
| **Heading font** | "Sans-serif with tight tracking" | Monospace (JetBrains Mono) |
| **Accent color** | "Amber-500 for all primary CTAs" | Primary is green-hued in OKLch (`oklch(0.448 0.119 151.328)`) |
| **Geometric accents** | "Diagonal gradient stripe in top-right" | Not present in current pages |
| **Toast** | Listed under "Future Enhancements" | Already implemented via Sonner |

**Recommendation:** Rewrite DESIGN_SYSTEM.md to match the actual state, then use it as the source of truth going forward. The current OKLch + shadcn system is better than what the doc describes.

---

## 4. Status Color Fragmentation

### Critical: Two Competing Status Config Systems

There are **two independent, conflicting status badge implementations**:

**1. Closer status config** — `app/workspace/closer/_components/status-config.ts`
- Used by: closer dashboard, calendar, meeting detail, closer pipeline
- Colors: blue/amber/violet/emerald/red/muted/orange with opacity patterns
- Well-structured with `badgeClass`, `dotClass`, `stripBg`

**2. Admin pipeline status badge** — `app/workspace/pipeline/_components/status-badge.tsx`
- Used by: admin pipeline page
- Colors: blue-100/yellow-100/purple-100/emerald-100/red-100/gray-100/orange-100
- Different color treatment (solid bg-100 vs bg-500/10 opacity)
- Re-declares `OpportunityStatus` type locally instead of importing

**Visual inconsistency:** The same "In Progress" status appears as `bg-amber-500/10 text-amber-700` in the closer view and `bg-yellow-100 text-yellow-800` in the admin view — different hues entirely (amber vs yellow).

**Additional instance:** `app/admin/page.tsx` has yet another inline status color mapping for tenant statuses.

**Recommendation:**
- Create a single shared `lib/status-config.ts` (or `lib/status.ts`) that exports all status types, configs, and a `<StatusBadge>` component
- Admin and closer views should use the same visual language
- Tenant status config should also live in this shared location
- Delete `pipeline/_components/status-badge.tsx` entirely; use the shared one

---

## 5. Styling Violations

### Raw Tailwind Colors Instead of Semantic Tokens

The shadcn critical rules state: "Never override component colors or typography" and "Use semantic colors — `bg-primary`, `text-muted-foreground` — never raw values like `bg-blue-500`."

**Violations found across the codebase:**

| File | Violation | Raw class used |
|------|-----------|---------------|
| `status-config.ts` | Status badge colors | `bg-blue-500/10`, `text-blue-700`, `dark:text-blue-400`, etc. |
| `status-badge.tsx` | Status badge colors | `bg-blue-100`, `text-blue-800`, `dark:bg-blue-900`, etc. |
| `pipeline-summary.tsx` | Stat badges | `bg-blue-100 text-blue-800`, `bg-emerald-100 text-emerald-800` |
| `stats-card.tsx` | Card variant borders | `border-emerald-500/30 bg-emerald-500/5`, etc. |
| `system-health.tsx` | Token status | `text-red-400`, `text-amber-400`, `bg-red-500/10` |
| `calendly-connection.tsx` | Connection status | `text-emerald-500`, `text-red-500`, `bg-amber-500/10` |
| `featured-meeting-card.tsx` | Urgency colors | `border-l-amber-500`, `border-l-emerald-500` |
| `lead-info-panel.tsx` | Contact icon badges | `bg-primary/10`, `bg-blue-500/10`, `bg-emerald-500/10` |
| `unmatched-banner.tsx` | Warning colors | `bg-amber-950`, `text-amber-200`, `border-amber-700/50` |

**Nuance:** Status colors are a legitimate case where you need specific hues beyond the semantic palette. The issue is that the same status color is defined differently in multiple places, and many of these should be CSS custom properties or a centralized config.

**Recommendation:**
- Define status colors as CSS custom properties in `globals.css` (e.g., `--status-scheduled`, `--status-in-progress`)
- Or maintain the centralized config object approach but ensure there's exactly ONE source
- For non-status uses (system health, connection indicators), use the existing semantic `destructive`, `primary` tokens where possible

---

## 6. Component Composition Issues

### 6.1 Team Page: Verbose Dialog State Management

**File:** `app/workspace/team/page.tsx`

12 individual `useState` calls manage 3 dialogs:

```tsx
const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
const [removeUserId, setRemoveUserId] = useState<Id<"users"> | null>(null);
const [removeUserName, setRemoveUserName] = useState("");
const [calendlyDialogOpen, setCalendlyDialogOpen] = useState(false);
const [calendlyUserId, setCalendlyUserId] = useState<Id<"users"> | null>(null);
const [calendlyUserName, setCalendlyUserName] = useState("");
const [roleDialogOpen, setRoleDialogOpen] = useState(false);
const [roleUserId, setRoleUserId] = useState<Id<"users"> | null>(null);
const [roleUserName, setRoleUserName] = useState("");
const [roleCurrentRole, setRoleCurrentRole] = useState<string>("");
```

**Recommendation — Composition pattern (`architecture-compound-components`, `state-lift-state`):**

```tsx
type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string };

const [dialog, setDialog] = useState<DialogState>({ type: null });
```

This is a textbook case of `patterns-explicit-variants` — use a discriminated union instead of parallel boolean + data states.

### 6.2 Admin Dashboard: Redirect Ordering

**File:** `app/workspace/page.tsx` (lines 137-148)

```tsx
if (user === undefined) return <DashboardSkeleton />;
if (user === null) return null;
if (user.role === "closer") redirect("/workspace/closer");  // line 143
if (stats === undefined) return <DashboardSkeleton />;       // stats may not need to load
```

The `redirect()` for closers happens after the `user === null` check but **after** the stats `useEffect` has already started firing (it runs on mount regardless). The stats effect does check for closer role, but the closer briefly sees the dashboard skeleton before redirect.

**Recommendation:** Move the redirect check earlier, or gate the stats fetch behind a role check more aggressively.

### 6.3 Pipeline Filters: Inconsistent URL Sync

- **Closer pipeline** (`app/workspace/closer/pipeline/page.tsx`): Status filter synced to URL via `?status=` query param — excellent, enables shareable links and back button
- **Admin pipeline** (`app/workspace/pipeline/page.tsx`): Filters stored in component state only — not URL synced

**Recommendation:** Sync admin pipeline filters to URL too, for consistency and shareability.

### 6.4 One-Shot Fetch Pattern Repeated

The pattern of `useConvex() + useEffect + useState + setInterval` for one-shot polling is repeated in 3 places:
- `app/workspace/page.tsx` (admin stats)
- `app/workspace/closer/page.tsx` (next meeting)
- `app/workspace/closer/meetings/[meetingId]/page.tsx` (meeting detail)

**Recommendation:** Extract a custom hook:

```tsx
function usePollingQuery<T>(queryRef, args, intervalMs = 60_000) { ... }
```

This follows `rerender-split-combined-hooks` — reusable logic should be extracted.

---

## 7. Layout & Navigation UX

### 7.1 Sparse Workspace Header

**File:** `app/workspace/layout.tsx` (line 209)

```tsx
<header className="flex h-12 items-center gap-2 border-b px-4">
  <SidebarTrigger />
</header>
```

The workspace header contains only a sidebar toggle button. This is the most prominent persistent UI element and it's functionally empty.

**Recommendation:** Add to the header:
- Page title / breadcrumbs (see 7.2)
- Search trigger / command palette shortcut hint (see 15.1)
- Quick action button(s) contextual to the current page
- User avatar with dropdown (currently in sidebar, but header is more conventional)

### 7.2 No Breadcrumb Navigation

The shadcn `breadcrumb` component is installed but unused. Nested pages like `/workspace/closer/meetings/[meetingId]` rely only on a "Back" button with `router.back()` — which fails if the user navigated directly to the URL.

**Recommendation:**
- Add breadcrumbs to the workspace header for all routes deeper than 1 level
- Meeting detail: `Dashboard > Meetings > Meeting #X`
- Pipeline: `Dashboard > My Pipeline`
- Use shadcn `Breadcrumb` component (already installed)

### 7.3 Sidebar Branding

The sidebar has no logo or brand mark. The user sees their name at the top, navigation in the middle, and sign-out at the bottom. There's no visual anchor.

**Recommendation:**
- Add "Magnus" wordmark or icon to `SidebarHeader` above the user info
- This reinforces brand identity and provides a home-link affordance

### 7.4 Sidebar: Missing Active State Visual Weight

The sidebar active state uses `isActive` prop on `SidebarMenuButton`, but there's no strong visual differentiation between active and inactive items in the dark theme. In a monochrome sidebar, subtle active indicators get lost.

**Recommendation:**
- Ensure the active item has a distinct left-border accent or background fill
- Consider using the `menuAccent: "subtle"` config to verify it's working as intended

### 7.5 No Mobile Responsive Testing Indicators

The `use-mobile.ts` hook exists but isn't used in any page component. The calendar views have fixed `h-[600px]` heights that may not work on mobile viewports.

**Recommendation:**
- Audit all fixed heights against mobile breakpoints
- Consider `h-[calc(100dvh-...)]` for calendar views on mobile
- Verify the sidebar collapses properly on small screens (shadcn handles this, but verify)

---

## 8. Page-by-Page UI/UX Review

### 8.1 Landing Page (`app/page.tsx`)

**Strengths:**
- Clean hero layout with dot grid background
- Staggered animation on steps (tasteful, not excessive)
- Semantic markup with `<ol role="list">`
- Proper `motion-safe:` guards
- Loading pill with Spinner for authenticated routing

**Issues:**
- **Copy is developer-facing, not customer-facing**: "WorkOS handles identity, Convex handles tenant state" — a customer doesn't know or care about the tech stack. This should describe the value proposition
- **"Open Admin Console" CTA** is the only action beyond Sign In / Create Account. Tenant users who land here would be confused about what to do
- **No illustration or visual anchor** — the dot grid is subtle but the hero area is text-heavy with no supporting visual
- **Footer is anemic**: `"Magnus CRM · Tenant onboarding control plane"` in 11px — no links, no legal, no contact

**Recommendation:**
- Rewrite hero copy to be outcome-focused: "Manage sales meetings. Track pipelines. Close deals faster."
- Add secondary CTA for tenant users (or auto-route them faster)
- Consider a simple illustration or screenshot of the dashboard
- Flesh out footer with at least legal/privacy links

### 8.2 Admin Console (`app/admin/page.tsx`)

**Strengths:**
- Excellent tenant table with status filtering
- Three-state gate screen (loading, unauthenticated, non-admin)
- Invite banner with copy-to-clipboard and expiry display
- Proper pagination with "Load More"

**Issues:**
- **GateScreen** renders the same visual for "not logged in" and "not a system admin" — only the text differs. Consider different visual treatments for auth vs authorization failures
- **Tenant row actions** could benefit from a kebab menu (DropdownMenu) instead of separate buttons for consistency with the team page
- **No tenant search** — as the tenant count grows, scrolling through paginated rows without search becomes painful
- **Created date** format is absolute (`M/d/yyyy`) — consider relative time for recent tenants ("2 hours ago") with tooltip for exact date

### 8.3 Onboarding Flow (`app/onboarding/`)

**Strengths:**
- `OnboardingShell` provides consistent framing with dot-grid background
- `PulsingDots` respects `prefers-reduced-motion`
- Error taxonomy is comprehensive with context-aware CTAs
- Session storage bridge for token passing is pragmatic

**Issues:**
- **Onboarding page** (`page.tsx`): The validation -> redirect flow shows "Validating your invitation..." with no progress indicator beyond text. Consider a stepper/progress bar showing: Validate -> Sign Up -> Connect Calendly
- **Connect page** (`connect/page.tsx`): Permission list animations delay content visibility. On slow connections, users see blank space for 400-600ms before content appears. Consider making content visible immediately with a subtle animation overlay instead
- **Error recovery**: When Calendly OAuth fails, the error page shows a retry button but no alternative path. Consider offering email-based setup assistance as a fallback
- **Session storage fragility**: No TTL on stored invite data. If a user leaves and returns days later, stale data could cause confusion

### 8.4 Admin Dashboard (`app/workspace/page.tsx`)

**Strengths:**
- Stats row with 4 metric cards is clean and scannable
- 60-second polling for time-sensitive "meetings today" stat
- Good skeleton loading that mirrors layout

**Issues:**
- **No time context**: "Meetings Today" doesn't show which timezone or the current date
- **Stats cards** (`stats-card.tsx`) use a `variant` prop with 4 options (default, success, warning, destructive) but the variant colors use raw Tailwind classes instead of mapping to semantic tokens
- **Pipeline summary** shows only 3 numbers (Active, Won, Total) — consider adding a mini chart or sparkline showing trend over time
- **No quick actions**: The admin dashboard is read-only. Consider adding "Invite User", "View Pipeline" quick action buttons
- **System Health** section at the bottom may be missed — consider making connection issues more prominent (banner at top) when there are problems

### 8.5 Team Page (`app/workspace/team/page.tsx`)

**Strengths:**
- Role badges use Badge variants semantically
- Calendly link status is visible per member
- Dropdown menu per row with contextual actions (prevents self-removal, prevents owner modification)

**Issues:**
- **12 useState calls** for 3 dialogs (see Section 6.1)
- **No sorting** — table is in whatever order Convex returns it
- **No search/filter** for team members — fine for small teams, but should scale
- **"Not linked" badge** for Calendly status uses `variant="destructive"` which is visually alarming. Consider `variant="outline"` with a warning icon instead — it's not an error, it's a configuration gap
- **InviteUserDialog** trigger button placement is in the page header (`justify-between`). On mobile, this may not be visible alongside the heading. Consider a floating action or a more prominent placement

### 8.6 Settings Page (`app/workspace/settings/page.tsx`)

**Strengths:**
- Event type configuration grid is clean
- Payment link editor with add/remove pattern works well

**Issues:**
- **Two sections only**: Calendly Connection + Event Type Config. The page feels sparse
- **No settings categories** — as features grow, this needs tabs or a sidebar nav within the page
- **Event Type Config cards** show "None configured" for payment links but don't explain WHY payment links matter or how to add them
- **Payment link editor** uses a flat grid for provider/label/URL per row. On mobile, this 3-column layout won't work well — verified: it uses responsive classes, but the UX of adding multiple links on mobile needs testing

### 8.7 Closer Dashboard (`app/workspace/closer/page.tsx`)

**Strengths:**
- Excellent section composition: greeting -> featured meeting -> pipeline strip -> calendar
- Featured meeting card with live countdown and urgency color coding
- Pipeline strip cards link directly to filtered pipeline page
- Calendar self-manages its own state and queries

**Issues:**
- **Unmatched banner** (`unmatched-banner.tsx`): Tells the closer their account isn't linked but provides no CTA to resolve it. The message says "Please contact your administrator" — consider adding a direct link or at least the admin's name/email
- **Featured meeting card**: No countdown timer is visible until the component renders — the `useState(() => Date.now())` lazy init is good, but the "in 2 hours" text could flash to a different value on first render. Consider server-rendering the initial time reference
- **"My Schedule" section** label is an `<h2>` but the calendar itself has no date context visible above the fold. Users need to scroll to see the CalendarHeader with the date range
- **No greeting personalization beyond name** — consider showing "Good morning/afternoon" based on time of day for a warmer UX
- **Pipeline strip** takes significant vertical space with 7 cards. On mobile (2-col grid), this pushes the calendar below the fold

### 8.8 Meeting Detail Page (`app/workspace/closer/meetings/[meetingId]/page.tsx`)

**Strengths:**
- Two-column layout is appropriate for this information density
- One-shot fetch is intentionally chosen over reactive subscription (documented why)
- Comprehensive outcome action bar with status-aware button visibility
- Meeting notes with debounced auto-save and visual feedback

**Issues:**
- **Back button** uses `router.back()` — fails if user navigated directly to this URL. Should fallback to `/workspace/closer`
- **Left column (lead info) is 1/4 width** — on medium screens (`md:grid-cols-3`), it gets `col-span-1` which is 33%. On large screens (`lg:grid-cols-4`), it's 25%. The lead info panel may feel cramped on medium screens
- **No refresh after status change** — `OutcomeActionBar` calls `onStatusChanged` (which is `refreshDetail`), but the function catches errors silently. If the refresh fails, the UI stays stale
- **Payment links section** disappears entirely when none are configured. Consider showing a subtle "No payment links configured for this event type" message to prevent confusion
- **Meeting notes** have no character count or visual indication of length constraints
- **MeetingNotFound** uses the same visual for "doesn't exist" and "no access" — these are different user intents. "No access" should suggest contacting admin

### 8.9 Calendar Views

**Strengths:**
- Three view modes (day/week/month) with smooth switching
- Memoized date ranges prevent Convex subscription thrashing
- Meeting blocks are positioned absolutely with calculated top/height — good for time grid accuracy
- Month view uses a Map for O(1) meeting lookups per date
- Week view has sticky day headers

**Issues:**
- **Fixed `h-[600px]` height** on day and week views — doesn't adapt to viewport. On a 900px tall screen with sidebar header, the calendar is scrollable. On a 1400px screen, there's wasted space below
- **No "current time" indicator** — day and week views show the time grid but don't indicate where "now" is. This is a standard calendar UX affordance
- **Month view meeting dots** are tiny (3px or so) and may not be visible to users with visual impairments. The "+N more" badge is good but the dots themselves need more visual weight
- **No meeting creation** — the calendar is read-only. Consider at least a visual prompt that meetings come from Calendly
- **Click targets**: Meeting blocks in day/week view use `Link` which is good, but very short meetings (< 30 min) get min-height 20px with condensed text — these are hard to click on mobile

---

## 9. Accessibility Gaps

### 9.1 Identified Issues

| Issue | Location | WCAG | Severity |
|-------|----------|------|----------|
| No `aria-label` on sidebar toggle | `workspace/layout.tsx` line 210 | 4.1.2 | High |
| Icon-only buttons missing labels | Various dropdown triggers | 4.1.2 | High |
| No `aria-live` on dashboard stats | `workspace/page.tsx` | 4.1.3 | Medium |
| Calendar time grid has no semantic landmarks | day/week views | 1.3.1 | Medium |
| Color-only status differentiation in month view dots | `month-view.tsx` | 1.4.1 | Medium |
| No skip-to-content link | `workspace/layout.tsx` | 2.4.1 | Medium |
| Missing `role="status"` on some loading indicators | Various | 4.1.3 | Low |
| Staggered animations may cause focus confusion | Landing page, onboarding | 2.3.3 | Low |

### 9.2 Positive Accessibility Patterns Already in Place

- `motion-safe:` guards on all animations
- `aria-hidden="true"` on decorative icons
- `data-icon` attribute on Button icons (shadcn pattern)
- `role="status"` on landing page loading pill
- `aria-live="polite"` on invite banner
- `<ol role="list">` on steps list
- `scope="col"` on table headers
- `aria-current="step"` on meeting history timeline
- `aria-label` on meeting block links

### 9.3 Recommendations

- Add `aria-label="Toggle sidebar"` to `SidebarTrigger`
- Add skip-to-content link as first child of `<body>`
- Audit all icon-only buttons (dropdown triggers, copy buttons) for `aria-label`
- Add `role="region" aria-label="..."` to calendar views
- Ensure month view dots have tooltip or text alternative

---

## 10. Performance Opportunities

### 10.1 Bundle & Loading

| Opportunity | Rule | Impact | Details |
|-------------|------|--------|---------|
| Lazy-load dialogs | `bundle-dynamic-imports` | Medium | All dialogs (payment form, follow-up, mark lost, invite user, etc.) are statically imported. Use `next/dynamic` for dialog contents since they're only shown on user interaction |
| Barrel import check | `bundle-barrel-imports` | Medium | Verify lucide-react imports are tree-shaking correctly. Importing 6+ icons per file from `lucide-react` may pull in more than needed |
| Preload on hover | `bundle-preload` | Low | Meeting blocks link to detail pages. Preload the detail page on hover for perceived speed |
| Defer Sonner | `bundle-defer-third-party` | Low | Toast provider loads on every page but is only used on interaction |

### 10.2 Async & Waterfalls

| Opportunity | Rule | Impact | Details |
|-------------|------|--------|---------|
| Admin page gate query | `async-cheap-condition-before-await` | Medium | `app/admin/page.tsx` runs auth check then fetches tenants sequentially. The auth and tenant list could start in parallel |
| Workspace page dual fetch | `async-parallel` | Medium | Admin dashboard starts stats polling in useEffect but the `useQuery` for user runs first. These could be parallelized |
| Meeting detail page | `async-suspense-boundaries` | Medium | The one-shot fetch blocks the entire page. Consider Suspense boundary around the detail content with the header (back button) rendering immediately |

### 10.3 Re-render

| Opportunity | Rule | Impact | Details |
|-------------|------|--------|---------|
| Team page 12 useState | `rerender-functional-setstate` | Medium | Compound state via discriminated union reduces re-render triggers |
| Calendar view date range | Already using useMemo | N/A | Good pattern, already optimized |
| Hoisted nav arrays | `rendering-hoist-jsx` | N/A | Already done in workspace layout — good |

---

## 11. React & Next.js Best Practices

### 11.1 Violations

| Rule | File | Issue |
|------|------|-------|
| `rerender-no-inline-components` | None found | All components are properly extracted |
| `server-serialization` | All pages are `"use client"` | No RSC data fetching — everything is client-side via Convex. This is architecturally intentional (Convex is client-first), but means we get no server-rendered HTML for SEO or initial paint |
| `rendering-conditional-render` | Multiple files | Uses `&&` pattern: `{condition && <Component />}`. Should prefer ternary or early return for clarity, though `&&` is not incorrect |
| `rerender-derived-state-no-effect` | `workspace/page.tsx` | Stats are derived from a useEffect + useState instead of being derived during render. The polling pattern necessitates this, but consider the custom hook extraction |

### 11.2 Good Patterns Already in Place

- `useState(() => Date.now())` — lazy state initialization (`rerender-lazy-state-init`)
- Hoisted static nav arrays outside components (`rendering-hoist-jsx`)
- `useCallback` for stable handlers (`rerender-functional-setstate`)
- Conditional Convex query skipping: `useQuery(api.x, condition ? {} : "skip")` — prevents unnecessary backend calls
- `useRef` for deduplication flags (claim attempt) — proper transient value pattern (`rerender-use-ref-transient-values`)

### 11.3 Opportunities

- **Extract `usePollingQuery` hook**: The one-shot-with-polling pattern repeats 3 times. A shared hook would reduce boilerplate and standardize error handling
- **Consider Suspense boundaries**: For pages that have a fast-loading header and slow-loading content (meeting detail, admin page), wrapping the content in Suspense with a skeleton fallback would show the header immediately
- **RSC for static shells**: The workspace layout is `"use client"` for auth, but the sidebar structure itself could be a server component with a client boundary only around the auth-dependent parts. This would allow the shell HTML to be server-rendered

---

## 12. shadcn/ui Compliance

### 12.1 Violations of Critical Rules

| Rule | File | Issue |
|------|------|-------|
| **`className` for layout, not styling** | `status-badge.tsx`, `status-config.ts`, `pipeline-summary.tsx`, `stats-card.tsx` | Raw color classes passed via `className` to override component colors |
| **No `space-x-*` or `space-y-*`** | None found | All uses are `flex gap-*` — compliant |
| **Use `size-*` when equal** | Mostly compliant, a few `w-* h-*` pairs exist | Minor |
| **No manual `dark:` overrides** | `status-config.ts`, `status-badge.tsx`, `stats-card.tsx`, etc. | Many `dark:` color overrides instead of semantic tokens |
| **Forms use `FieldGroup` + `Field`** | Dialogs mostly use this correctly | Compliant |

### 12.2 Component Usage Audit

| shadcn Component | Installed | Used | Notes |
|-----------------|-----------|------|-------|
| `breadcrumb` | Yes | **No** | Should be used in workspace header |
| `command` | Yes | **No** | Should be used for command palette |
| `hover-card` | Yes | **No** | Could enhance table cells with preview |
| `resizable` | Yes | **No** | Could be useful for meeting detail layout |
| `navigation-menu` | Yes | **No** | Using Sidebar instead — fine |
| `carousel` | Yes | **No** | No clear use case currently |
| `aspect-ratio` | Yes | **No** | Could be used for future media display |
| `context-menu` | Yes | **No** | Could enhance table rows |
| `menubar` | Yes | **No** | Not needed with sidebar nav |
| `empty` | Yes | **Yes** | Used correctly in workspace layout and meeting detail |
| `spinner` | Yes | **Yes** | Used in loading states |
| `field` | Yes | **Yes** | Used in dialog forms |
| `input-group` | Yes | **No** | Could enhance search inputs |
| `kbd` | Yes | **No** | Should be used for keyboard shortcut hints |

### 12.3 Opportunities

- **Use `Command` for a command palette** (`Cmd+K` or `/`) — the component is already installed
- **Use `Breadcrumb`** in the workspace header
- **Use `Kbd`** to show keyboard shortcut hints in tooltips and the command palette
- **Use `HoverCard`** for rich previews on lead names or meeting references in tables

---

## 13. Web Interface Guidelines Compliance

Based on the Vercel Web Interface Guidelines:

### 13.1 Compliant Patterns

- **Optimistic updates**: Toast notifications provide immediate feedback on actions
- **Loading states**: Skeleton screens prevent layout shift
- **Error boundaries**: Gate screens and empty states handle error cases
- **Focus management**: Dialogs trap focus correctly (via Radix primitives)
- **Motion**: `motion-safe:` prefix respects user preferences

### 13.2 Violations

| Guideline | Issue | Location |
|-----------|-------|----------|
| **Buttons should show loading state** | Some mutation buttons don't show spinner during async operations | Various dialogs |
| **Preserve scroll position on navigation** | `{ scroll: false }` used on closer pipeline but not on admin pipeline filter changes | `pipeline/page.tsx` |
| **Forms should validate on submit, not on change** | Some forms show errors on change (field-level), which is fine, but inconsistent — some validate only on submit | Various |
| **Provide undo for destructive actions** | "Mark as Lost" and "Remove User" are irreversible with no undo | Team page, meeting detail |
| **Show confirmation for irreversible actions** | Done correctly for most actions via AlertDialog | Compliant |
| **Avoid layout shift** | Skeleton screens are good, but the Calendly reconnect banner appearing at the top of the page pushes content down | `CalendlyConnectionGuard` |

---

## 14. WorkOS AuthKit Integration Review

### 14.1 Current Implementation

**Files reviewed:**
- `app/ConvexClientProvider.tsx` — Client-side auth bridge
- `app/sign-in/route.ts`, `app/sign-up/route.ts` — Auth routes
- `app/workspace/layout.tsx` — Workspace auth gating

**Assessment:**
- Auth flow is correctly implemented via `@workos-inc/authkit-nextjs`
- The `ConvexProviderWithAuth` bridge correctly fetches access tokens
- Sign-in/sign-up use WorkOS route handlers — standard pattern
- No middleware.ts — auth checking happens client-side in layout components

### 14.2 Issues

- **No middleware protection**: Without Next.js middleware, all workspace routes serve their client-side JavaScript before auth checking happens. A user hitting `/workspace` while unauthenticated sees the skeleton, then gets redirected. This is functional but not ideal — middleware would prevent the initial JavaScript payload
- **No session refresh handling**: If the WorkOS session expires mid-use, the Convex auth hook may start failing silently. Consider showing a "Session expired — please sign in again" toast
- **Organization switching**: The current implementation assumes one org per user session. If WorkOS multi-org is enabled, the user has no UI to switch organizations
- **No profile page**: Users can't update their display name, email, or preferences within the CRM. Any changes require WorkOS admin portal

### 14.3 Recommendations

- Consider adding `middleware.ts` for route protection (prevents serving client JS to unauthenticated users)
- Add session expiry detection and graceful re-auth prompt
- Consider a minimal profile/account page for user self-service

---

## 15. Missing UX Patterns

### 15.1 Command Palette / Global Search

No way to quickly navigate between pages, search for leads/meetings, or trigger actions via keyboard. The `Command` component is installed but unused.

**Recommendation:** Implement `Cmd+K` command palette with:
- Page navigation (Dashboard, Team, Pipeline, Settings)
- Lead search (by name or email)
- Meeting search (by lead name or date)
- Quick actions (Invite User, Connect Calendly)

### 15.2 Keyboard Shortcuts

No keyboard shortcuts exist for common actions. In a B2B CRM where users perform repetitive tasks, keyboard shortcuts dramatically improve efficiency.

**Recommendation:**
- `Cmd+K`: Command palette
- `Cmd+/`: Focus search
- `Escape`: Close dialog/sheet
- Navigation shortcuts shown via `Kbd` component in tooltips

### 15.3 Notification Center

No in-app notification system. Status changes, new meetings, and connection issues are only shown via toast (ephemeral) or banner (Calendly guard).

**Recommendation:** Consider a notification dropdown in the header showing recent events:
- New meeting assigned
- Payment logged
- Calendly connection issue
- Team member joined

### 15.4 Empty State CTAs

Several empty states inform the user but don't provide an actionable next step:
- "No upcoming meetings" — no link to Calendly to create one
- Pipeline empty — no explanation of how meetings flow in
- Admin dashboard with 0 stats — no "Get Started" flow

**Recommendation:** Add contextual CTAs to all empty states:
- Link to relevant documentation or setup page
- "Learn how meetings appear here" help text
- Primary action button where applicable

### 15.5 Data Export

No way to export pipeline data, team lists, or meeting records. For a B2B tool, admins frequently need CSV/PDF exports for reporting.

**Recommendation:** Add export buttons to table views (Pipeline, Team) — even a simple CSV download is valuable.

### 15.6 Page Titles & Meta

Only the root layout sets `<title>` to "MAGNUS CRM". Inner pages don't update the document title, so the browser tab always shows "MAGNUS CRM" regardless of which page you're on.

**Recommendation:** Use Next.js `metadata` API or `<title>` in each page layout to show contextual titles:
- "Dashboard — Magnus CRM"
- "Team — Magnus CRM"
- "Meeting with John Doe — Magnus CRM"

---

## 16. Prioritised Improvement Plan

### Phase 1: Critical Fixes (Days 1-3)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 1 | **Fix global font stack**: Change `font-mono` to `font-sans` globally, apply mono only to code/data elements | Typography readability across entire app | Low |
| 2 | **Unify status config**: Create single `lib/status-config.ts`, delete `pipeline/_components/status-badge.tsx`, update all imports | Visual consistency across admin and closer views | Medium |
| 3 | **Update DESIGN_SYSTEM.md**: Rewrite to match actual OKLch theme, current fonts, and real component patterns | Developer clarity, prevents further drift | Low |
| 4 | **Audit raw color classes**: Replace raw Tailwind colors with either semantic tokens or centralized config references where possible | Maintainability, theme consistency | Medium |

### Phase 2: Navigation & Layout (Days 4-7)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 5 | **Enrich workspace header**: Add breadcrumbs, page title, search trigger | Navigation clarity, orientation | Medium |
| 6 | **Add sidebar branding**: Magnus wordmark/icon in SidebarHeader | Brand identity, home navigation | Low |
| 7 | **Implement command palette**: Wire up `Command` component with `Cmd+K` trigger | Power user efficiency, navigation speed | Medium |
| 8 | **Add dynamic page titles**: Use Next.js metadata for per-page `<title>` | Browser tab context, accessibility | Low |
| 9 | **Fix calendar fixed height**: Use `calc(100dvh - ...)` or container-responsive height | Mobile and large screen adaptability | Low |

### Phase 3: UX Refinement (Days 8-12)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 10 | **Refactor Team page dialog state**: Discriminated union pattern | Code quality, fewer re-renders | Low |
| 11 | **Extract `usePollingQuery` hook**: Centralise the one-shot polling pattern | DRY code, consistent error handling | Low |
| 12 | **Sync admin pipeline filters to URL**: Match closer pipeline's URL-driven filter pattern | Shareability, consistency | Low |
| 13 | **Add empty state CTAs**: Contextual actions on all empty states | User guidance, reduced confusion | Medium |
| 14 | **Add "current time" indicator to calendar**: Show a horizontal line at the current time in day/week views | Calendar usability, temporal orientation | Low |
| 15 | **Lazy-load dialogs**: Use `next/dynamic` for dialog contents | Bundle size reduction | Low |

### Phase 4: Accessibility & Polish (Days 13-16)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 16 | **Add aria-labels**: Sidebar trigger, icon-only buttons, dropdown triggers | Screen reader support | Low |
| 17 | **Add skip-to-content link**: First child of body | Keyboard navigation | Low |
| 18 | **Add `role="region"` to calendar views** | Semantic landmarks | Low |
| 19 | **Rewrite landing page copy**: Outcome-focused messaging, not tech-focused | First impression, conversion | Medium |
| 20 | **Add session expiry handling**: Detect expired WorkOS session, show re-auth prompt | Auth reliability | Medium |
| 21 | **Unmatched closer banner CTA**: Add link or contact info for resolving the issue | Closer self-service | Low |

### Phase 5: Progressive Enhancements (Days 17+)

| # | Task | Impact | Effort |
|---|------|--------|--------|
| 22 | **Table sorting**: Add sortable column headers to team and pipeline tables | Data exploration | Medium |
| 23 | **Notification center**: Header dropdown with recent events | Awareness of changes | High |
| 24 | **Data export (CSV)**: Export buttons on pipeline and team tables | Admin reporting | Medium |
| 25 | **Profile/account page**: User self-service for name, preferences | User autonomy | Medium |
| 26 | **Keyboard shortcuts**: Common actions with `Kbd` hints | Power user efficiency | Medium |
| 27 | **Settings page restructure**: Tabs or sidebar nav within settings for scalability | Future-proofing | Medium |

---

## Appendix A: Files Referenced

| File | Section(s) |
|------|-----------|
| `app/layout.tsx` | 2, 9 |
| `app/globals.css` | 2, 3, 5 |
| `app/page.tsx` | 8.1 |
| `app/workspace/layout.tsx` | 6.2, 7.1, 7.2, 7.3, 7.4, 9 |
| `app/workspace/page.tsx` | 6.2, 8.4, 10 |
| `app/workspace/team/page.tsx` | 6.1, 8.5 |
| `app/workspace/pipeline/page.tsx` | 6.3, 8.6 |
| `app/workspace/settings/page.tsx` | 8.6 |
| `app/workspace/closer/page.tsx` | 8.7 |
| `app/workspace/closer/pipeline/page.tsx` | 6.3 |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | 8.8 |
| `app/workspace/closer/_components/status-config.ts` | 4 |
| `app/workspace/closer/_components/calendar-view.tsx` | 8.9 |
| `app/workspace/closer/_components/day-view.tsx` | 8.9 |
| `app/workspace/closer/_components/week-view.tsx` | 8.9 |
| `app/workspace/closer/_components/month-view.tsx` | 8.9 |
| `app/workspace/closer/_components/featured-meeting-card.tsx` | 8.7 |
| `app/workspace/closer/_components/unmatched-banner.tsx` | 8.7 |
| `app/workspace/pipeline/_components/status-badge.tsx` | 4 |
| `app/workspace/pipeline/_components/opportunities-table.tsx` | 8.6 |
| `app/workspace/_components/stats-card.tsx` | 5 |
| `app/workspace/_components/pipeline-summary.tsx` | 5 |
| `app/workspace/_components/system-health.tsx` | 5 |
| `app/admin/page.tsx` | 4, 8.2 |
| `app/onboarding/page.tsx` | 8.3 |
| `app/onboarding/connect/page.tsx` | 8.3 |
| `app/ConvexClientProvider.tsx` | 14 |
| `components/calendly-connection-guard.tsx` | 13.2 |
| `DESIGN_SYSTEM.md` | 3 |
| `PRODUCT.md` | Context |

## Appendix B: Skills & Guidelines Applied

| Skill/Guideline | Key Findings |
|----------------|-------------|
| **frontend-design** | Typography needs bold direction; current monospace-everywhere lacks intentionality; color system is modern (OKLch) but inconsistently applied |
| **shadcn** | Raw color overrides violate critical styling rules; several installed components unused (breadcrumb, command, kbd); form patterns mostly correct |
| **vercel-react-best-practices** | One-shot polling pattern should be extracted to hook; dialog imports could be lazy-loaded; Suspense boundaries could improve perceived performance |
| **vercel-composition-patterns** | Team page dialog state is a textbook case for discriminated union; nav items properly hoisted (good) |
| **web-design-guidelines** | Loading states are strong; destructive actions need undo consideration; scroll position preservation is inconsistent |
| **workos** | No middleware protection; no session expiry handling; no profile page; auth flow otherwise correct |

---

## Appendix C: Detailed Phase Plans

Each phase has been expanded into a detailed implementation plan with subphases, code examples, file lists, and dependency graphs:

| Phase | File | Subphases | Est. Time |
|-------|------|-----------|-----------|
| **Phase 1** — Critical Fixes | [`phases/phase1.md`](./phases/phase1.md) | 1A–1E (Typography, Status Config, CSS Properties, Color Audit, Design System) | 2–3 days |
| **Phase 2** — Navigation & Layout | [`phases/phase2.md`](./phases/phase2.md) | 2A–2F (Sidebar Branding, Breadcrumbs, Command Palette, Page Titles, Layout Integration, Calendar Height) | 3–4 days |
| **Phase 3** — UX Refinement | [`phases/phase3.md`](./phases/phase3.md) | 3A–3F (Polling Hook, Dialog Refactor, URL Filters, Empty States, Time Indicator, Lazy Dialogs) | 3–4 days |
| **Phase 4** — Accessibility & Polish | [`phases/phase4.md`](./phases/phase4.md) | 4A–4F (ARIA Audit, Skip Link, Calendar Semantics, Landing Copy, Session Expiry, Unmatched CTA) | 3–4 days |
| **Phase 5** — Progressive Enhancements | [`phases/phase5.md`](./phases/phase5.md) | 5A–5F (Table Sorting, Notifications, CSV Export, Profile Page, Keyboard Shortcuts, Settings Tabs) | 5–7 days |
