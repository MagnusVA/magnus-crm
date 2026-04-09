# Phase 4 — Accessibility & Polish: ARIA, Skip Link, Calendar Semantics, Landing Page Copy, Session Expiry, Unmatched CTA

**Goal:** Bring the application to WCAG AA compliance by adding missing ARIA attributes, semantic landmarks, and a skip-to-content link. Simultaneously polish user-facing copy (landing page) and improve auth reliability (session expiry). Resolve the unmatched closer banner dead-end.

**Prerequisite:** Phase 1 complete (design tokens stable). Phase 2 recommended (workspace header exists for skip link target). Phase 3 not required.

**Runs in PARALLEL with:** Phase 3 (no file conflicts — Phase 4 touches accessibility attributes, Phase 3 touches data/state logic).

**Skills to invoke:**
- `web-design-guidelines` — WCAG AA contrast, focus management, ARIA patterns
- `frontend-design` — landing page copy and visual composition
- `workos` — session expiry detection and re-auth flow
- `shadcn` — Alert component for banners

**Acceptance Criteria:**
1. All icon-only buttons have `aria-label` attributes describing their function.
2. A skip-to-content link is the first focusable element in the workspace layout, jumping to `#main-content`.
3. `SidebarTrigger` has `aria-label="Toggle sidebar"`.
4. Calendar day and week views are wrapped in `role="region" aria-label="Calendar"`.
5. Landing page hero copy describes user value, not technical implementation.
6. A session expiry detection mechanism shows a toast when the WorkOS session expires.
7. The unmatched closer banner includes a CTA or contact information for resolution.
8. Axe DevTools reports no critical or serious violations on all workspace pages.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (ARIA labels audit) ─────────────────────────┐
                                                  │
4B (Skip-to-content link) ──────────────────────┤  All independent,
                                                  │  run in PARALLEL
4C (Calendar semantic landmarks) ───────────────┤
                                                  │
4D (Landing page copy rewrite) ─────────────────┤
                                                  │
4E (Session expiry detection) ──────────────────┤
                                                  │
4F (Unmatched closer banner CTA) ───────────────┘
```

**Optimal execution:**
All 6 subphases are independent and can run in PARALLEL.

**Estimated time:** 3–4 days

---

### 4A — ARIA Labels Audit & Fix

**Type:** Frontend (accessibility)
**Parallelizable:** Yes — touches ARIA attributes across multiple files

**What:** Add `aria-label` to all icon-only buttons, dropdown triggers, and interactive elements that lack accessible names. Add `role="status"` to loading indicators missing it.

**Why:** Screen reader users cannot determine the purpose of icon-only buttons without accessible labels. The audit (Section 9.1) identified high-severity gaps: sidebar toggle, dropdown menu triggers, copy buttons, and some loading indicators.

**Where:** Multiple component files across the application.

**How:**

**Sidebar trigger:**
```tsx
// Path: app/workspace/layout.tsx
<SidebarTrigger aria-label="Toggle sidebar" />
```

**Dropdown menu triggers in team table:**
```tsx
// Path: app/workspace/team/_components/team-members-table.tsx
<DropdownMenuTrigger asChild>
  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.fullName || member.email}`}>
    <MoreHorizontalIcon />
  </Button>
</DropdownMenuTrigger>
```

**Copy-to-clipboard buttons:**
```tsx
// Path: app/admin/_components/invite-banner.tsx
<Button size="icon-sm" variant="outline" onClick={handleCopy} aria-label="Copy invite URL">
  <CopyIcon />
</Button>

// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx
<Button size="icon-sm" variant="outline" onClick={handleCopy} aria-label={copied ? "Copied" : "Copy link"}>
  {copied ? <CheckIcon /> : <CopyIcon />}
</Button>

// Path: app/workspace/closer/meetings/_components/meeting-info-panel.tsx
<Button size="icon-sm" variant="outline" onClick={handleCopyZoom} aria-label="Copy Zoom link">
  <CopyIcon />
</Button>

// Path: app/workspace/closer/meetings/_components/payment-links-panel.tsx
<Button size="icon-sm" variant="outline" onClick={() => handleCopy(link.url)} aria-label={`Copy ${link.label} link`}>
  <CopyIcon />
</Button>
```

**Loading indicators:**
```tsx
// Anywhere a Spinner or loading message is shown without role="status":
<div role="status" aria-live="polite">
  <Spinner className="size-4" />
  <span className="sr-only">Loading...</span>
</div>
```

**Dashboard stats (live region for auto-updating data):**
```tsx
// Path: app/workspace/_components/stats-row.tsx
<div className="grid ..." aria-live="polite" aria-atomic="true">
  {/* stats cards */}
</div>
```

**Full checklist of elements to fix:**

| Element | File | Fix |
|---------|------|-----|
| `SidebarTrigger` | `workspace/layout.tsx` | `aria-label="Toggle sidebar"` |
| Dropdown trigger (team table) | `team/_components/team-members-table.tsx` | `aria-label="Actions for {name}"` |
| Copy button (invite banner) | `admin/_components/invite-banner.tsx` | `aria-label="Copy invite URL"` |
| Copy button (follow-up dialog) | `closer/meetings/_components/follow-up-dialog.tsx` | `aria-label` dynamic |
| Copy button (meeting info) | `closer/meetings/_components/meeting-info-panel.tsx` | `aria-label="Copy Zoom link"` |
| Copy button (payment links) | `closer/meetings/_components/payment-links-panel.tsx` | `aria-label` dynamic |
| Stats row | `workspace/_components/stats-row.tsx` | `aria-live="polite"` |
| Loading spinners (various) | Multiple files | `role="status"` + sr-only text |

**Key implementation notes:**
- `aria-label` on buttons overrides any child text content for screen readers — use it only on icon-only buttons
- `aria-live="polite"` on the stats row means screen readers will announce changes (e.g., "Meetings Today: 5") without interrupting current narration
- The `sr-only` span inside loading indicators provides context for "what is loading"
- Do NOT add `aria-label` to buttons that already have visible text — that would create duplicate announcements

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/layout.tsx` | Modified | aria-label on SidebarTrigger |
| `app/workspace/team/_components/team-members-table.tsx` | Modified | aria-label on dropdown triggers |
| `app/admin/_components/invite-banner.tsx` | Modified | aria-label on copy button |
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modified | aria-label on copy button |
| `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` | Modified | aria-label on copy button |
| `app/workspace/closer/meetings/_components/payment-links-panel.tsx` | Modified | aria-label on copy buttons |
| `app/workspace/_components/stats-row.tsx` | Modified | aria-live on stats container |

---

### 4B — Skip-to-Content Link

**Type:** Frontend (accessibility)
**Parallelizable:** Yes — touches only the workspace layout

**What:** Add a visually hidden skip-to-content link as the first focusable element in the workspace layout, and an `id="main-content"` target on the main content area.

**Why:** WCAG 2.4.1 requires a mechanism to bypass repeated navigation (sidebar, header). Keyboard users currently have to tab through every sidebar link and header element to reach page content. A skip link lets them jump directly to the content.

**Where:**
- `app/workspace/layout.tsx`

**How:**

```tsx
// Path: app/workspace/layout.tsx

// Add as first child of <SidebarProvider>, before <Sidebar>:
<a
  href="#main-content"
  className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:ring-2 focus:ring-ring"
>
  Skip to content
</a>

// Add id="main-content" to the content container:
<div id="main-content" className="flex-1 overflow-auto p-6" tabIndex={-1}>
  {children}
</div>
```

**Key implementation notes:**
- `sr-only` makes the link invisible until focused via keyboard (Tab key)
- `focus:not-sr-only` reveals it when focused, styled as a floating pill
- `focus:fixed focus:left-4 focus:top-4 focus:z-50` positions it above everything
- `tabIndex={-1}` on the target allows the `#main-content` anchor to receive focus when the skip link is activated, without adding it to the tab order
- This pattern is used by GitHub, Vercel, and most WCAG-compliant sites
- Test by pressing Tab on page load — the skip link should appear first, before the sidebar

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/layout.tsx` | Modified | Skip-to-content link + main-content id |

---

### 4C — Calendar Semantic Landmarks

**Type:** Frontend (accessibility)
**Parallelizable:** Yes — touches only calendar components

**What:** Wrap calendar views in semantic `role="region"` landmarks with descriptive `aria-label` attributes. Add `aria-label` to the view mode toggle.

**Why:** Calendar grids are complex interactive regions that screen readers need to identify. Without landmarks, keyboard users hear a flat list of hour labels, meeting titles, and day numbers with no context.

**Where:**
- `app/workspace/closer/_components/calendar-view.tsx`
- `app/workspace/closer/_components/day-view.tsx`
- `app/workspace/closer/_components/week-view.tsx`
- `app/workspace/closer/_components/month-view.tsx`
- `app/workspace/closer/_components/calendar-header.tsx`

**How:**

**Calendar container:**
```tsx
// Path: app/workspace/closer/_components/calendar-view.tsx

// Wrap the entire calendar output in a region:
<div role="region" aria-label={`Calendar — ${rangeLabel}`}>
  <CalendarHeader
    viewMode={viewMode}
    rangeLabel={rangeLabel}
    onViewModeChange={setViewMode}
    onPrev={goPrev}
    onNext={goNext}
    onToday={goToday}
  />
  {/* View content */}
</div>
```

**View mode tabs:**
```tsx
// Path: app/workspace/closer/_components/calendar-header.tsx

<Tabs value={viewMode} onValueChange={onViewModeChange} aria-label="Calendar view mode">
  {/* ... TabsTrigger items ... */}
</Tabs>
```

**Navigation buttons:**
```tsx
// Path: app/workspace/closer/_components/calendar-header.tsx

<Button variant="outline" size="icon-sm" onClick={onPrev} aria-label="Previous period">
  <ChevronLeftIcon />
</Button>
<Button variant="outline" size="icon-sm" onClick={onNext} aria-label="Next period">
  <ChevronRightIcon />
</Button>
```

**Day/Week views — time grid:**
```tsx
// Path: day-view.tsx, week-view.tsx

// The time gutter labels should use aria-hidden (they're visual guides):
<span className="..." aria-hidden="true">{formatHour(hour)}</span>

// Meeting blocks already have aria-label (good — no change needed)
```

**Month view — day cells:**
```tsx
// Path: month-view.tsx

// Each day cell should have an aria-label:
<div
  key={day.toISOString()}
  aria-label={`${format(day, "EEEE, MMMM d")}${dayMeetings.length > 0 ? `, ${dayMeetings.length} meeting${dayMeetings.length > 1 ? "s" : ""}` : ""}`}
>
```

**Key implementation notes:**
- `role="region"` with `aria-label` creates a named landmark that screen readers can jump to
- The `aria-label` on the region includes the date range so screen readers announce "Calendar — Mar 30 – Apr 5, 2026"
- Navigation buttons get explicit labels since they only contain icons
- Month view day cells announce "Wednesday, April 3, 2 meetings" for screen reader users
- The time gutter hours (7 AM, 8 AM, etc.) are decorative in the context of screen readers — the meeting blocks have their own time info

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/closer/_components/calendar-view.tsx` | Modified | role="region" wrapper |
| `app/workspace/closer/_components/calendar-header.tsx` | Modified | aria-labels on nav buttons and tabs |
| `app/workspace/closer/_components/day-view.tsx` | Modified | aria-hidden on time labels |
| `app/workspace/closer/_components/week-view.tsx` | Modified | aria-hidden on time labels |
| `app/workspace/closer/_components/month-view.tsx` | Modified | aria-label on day cells |

---

### 4D — Landing Page Copy Rewrite

**Type:** Frontend (copy/UX)
**Parallelizable:** Yes — touches only `app/page.tsx`

**What:** Rewrite the landing page hero copy to be outcome-focused (value for the customer) instead of developer-focused (technical implementation details).

**Why:** The current hero reads: "WorkOS handles identity, Convex handles tenant state, and Calendly onboarding is staged so each account starts with a clean audit trail." — a customer doesn't know or care about WorkOS, Convex, or audit trails. The landing page should describe what the product DOES for them.

**Where:**
- `app/page.tsx`

**How:**

**Current hero copy:**
```tsx
<h1>Onboard Operators Fast. Keep Tenant Setup Under Control.</h1>
<p>WorkOS handles identity, Convex handles tenant state, and Calendly
   onboarding is staged so each account starts with a clean audit trail.</p>
```

**New hero copy:**
```tsx
<h1>Sales Meetings. Pipeline Tracking. Deal Closing. All in One Place.</h1>
<p>Magnus CRM turns your Calendly meetings into a structured sales
   pipeline — from booking to payment, with real-time visibility
   for closers and admins.</p>
```

**Update the steps:**
```tsx
const STEPS = [
  "Leads book meetings through your Calendly link",
  "Closers manage meetings, notes, and payments in one dashboard",
  "Admins track pipeline, team performance, and revenue",
] as const;
```

**Update the CTA:**
```tsx
// From: "Open Admin Console" (confusing for non-admins)
// To: "Get Started" (or role-appropriate)
<Button asChild size="lg">
  <Link href="/sign-in">
    Get Started
    <ArrowRightIcon data-icon="inline-end" aria-hidden="true" />
  </Link>
</Button>
<p className="text-xs text-muted-foreground">
  Sign in to access your workspace, or contact your admin for an invite.
</p>
```

**Update the footer:**
```tsx
<footer className="flex items-center justify-between px-6 pb-5">
  <p className="text-[11px] text-muted-foreground/60">
    Magnus CRM
  </p>
  <div className="flex gap-4 text-[11px] text-muted-foreground/40">
    <span>Privacy</span>
    <span>Terms</span>
  </div>
</footer>
```

**Key implementation notes:**
- The new copy focuses on the three value pillars: meetings, pipeline, closing
- Steps describe the user journey, not the tech stack
- The CTA says "Get Started" with a link to `/sign-in` — authenticated users are auto-routed by the existing `useEffect`
- Footer adds placeholder Privacy/Terms links (can link to real pages later)
- The dot grid background and staggered animations remain — they're visually effective

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/page.tsx` | Modified | Rewrite hero copy, steps, CTA, footer |

---

### 4E — Session Expiry Detection

**Type:** Frontend (auth reliability)
**Parallelizable:** Yes — touches only the auth provider

**What:** Detect when the WorkOS session expires during active use and show a non-blocking toast prompting re-authentication, instead of silently failing on Convex queries.

**Why:** If a user's WorkOS session expires (token TTL exceeded, server-side revocation), the Convex auth hook starts returning `null` for `isAuthenticated`. Currently, the workspace layout shows the "Account Not Found" screen — which is misleading. A session expiry should prompt re-auth, not suggest the user doesn't exist.

**Where:**
- `app/ConvexClientProvider.tsx`
- `app/workspace/layout.tsx`

**How:**

**Step 1: Add expiry detection in the auth provider**

```tsx
// Path: app/ConvexClientProvider.tsx

// Inside the useAuth bridge function, track previous auth state:
const wasAuthenticatedRef = useRef(false);

// When isAuthenticated transitions from true → false, it's a session expiry:
useEffect(() => {
  if (isAuthenticated) {
    wasAuthenticatedRef.current = true;
  } else if (wasAuthenticatedRef.current && !isAuthenticated && !isLoading) {
    // Session expired — was authenticated, now isn't
    toast.error("Your session has expired. Please sign in again.", {
      action: {
        label: "Sign In",
        onClick: () => window.location.assign("/sign-in"),
      },
      duration: Infinity, // Don't auto-dismiss — user must act
    });
    wasAuthenticatedRef.current = false;
  }
}, [isAuthenticated, isLoading]);
```

**Step 2: Distinguish expiry from "not provisioned" in workspace layout**

```tsx
// Path: app/workspace/layout.tsx

// The current "no CRM user found" path should check if the user WAS authenticated:
// If the Convex auth is not authenticated, show a session expired message instead
// of "Account Not Found".

const { isAuthenticated } = useConvexAuth();

// After resolvedUser === null check:
if (resolvedUser === null && !isAuthenticated) {
  // Session expired, not "user doesn't exist"
  return null; // The toast from ConvexClientProvider handles the prompt
}

if (resolvedUser === null) {
  return <NotProvisionedScreen onSignOut={() => signOut()} />;
}
```

**Key implementation notes:**
- `toast.error` from Sonner provides a persistent notification with an action button
- `duration: Infinity` prevents auto-dismissal — the user MUST acknowledge
- The `wasAuthenticatedRef` pattern avoids false positives on initial page load (when `isAuthenticated` is false before the token loads)
- This doesn't require any backend changes — it's purely client-side detection
- The `/sign-in` redirect uses `window.location.assign` (full navigation) instead of `router.push` to ensure a fresh auth flow

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/ConvexClientProvider.tsx` | Modified | Session expiry detection + toast |
| `app/workspace/layout.tsx` | Modified | Distinguish expired session from missing user |

---

### 4F — Unmatched Closer Banner CTA

**Type:** Frontend (UX improvement)
**Parallelizable:** Yes — touches only the unmatched banner component

**What:** Add actionable context to the unmatched closer banner: either a direct link to the team settings page (for admins viewing in impersonation mode) or the admin's contact email.

**Why:** The current banner says "Please contact your administrator" but provides no way to do so. The closer is stuck with a dead-end message and no clear path to resolution.

**Where:**
- `app/workspace/closer/_components/unmatched-banner.tsx`

**How:**

```tsx
// Path: app/workspace/closer/_components/unmatched-banner.tsx
"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangleIcon } from "lucide-react";

export function UnmatchedBanner() {
  return (
    <Alert variant="destructive">
      <AlertTriangleIcon />
      <AlertTitle>Calendly Account Not Linked</AlertTitle>
      <AlertDescription>
        Your account is not linked to a Calendly team member.
        Meetings cannot be assigned to you until this is resolved.{" "}
        <strong>Ask your team admin to link your account</strong> in the{" "}
        Team settings page.
      </AlertDescription>
    </Alert>
  );
}
```

**Key implementation notes:**
- Changed from raw color classes (`bg-amber-950 text-amber-200`) to shadcn `Alert variant="destructive"` — this uses semantic tokens and handles dark mode automatically
- Bold text for the action ("Ask your team admin") makes the next step scannable
- We mention "Team settings page" to give the closer context to pass to their admin
- Future enhancement: query the tenant admin's email and display it directly (requires a backend query — out of scope for this phase)
- Alternatively, if the closer has admin/master role (shouldn't happen, but defensive), show a direct link to `/workspace/team`

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/closer/_components/unmatched-banner.tsx` | Modified | Add CTA, use Alert component |

---

## Phase 4 Summary

| File | Action | Subphase |
|------|--------|----------|
| `app/workspace/layout.tsx` | Modified | 4A, 4B |
| `app/workspace/team/_components/team-members-table.tsx` | Modified | 4A |
| `app/admin/_components/invite-banner.tsx` | Modified | 4A |
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modified | 4A |
| `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` | Modified | 4A |
| `app/workspace/closer/meetings/_components/payment-links-panel.tsx` | Modified | 4A |
| `app/workspace/_components/stats-row.tsx` | Modified | 4A |
| `app/workspace/closer/_components/calendar-view.tsx` | Modified | 4C |
| `app/workspace/closer/_components/calendar-header.tsx` | Modified | 4C |
| `app/workspace/closer/_components/day-view.tsx` | Modified | 4C |
| `app/workspace/closer/_components/week-view.tsx` | Modified | 4C |
| `app/workspace/closer/_components/month-view.tsx` | Modified | 4C |
| `app/page.tsx` | Modified | 4D |
| `app/ConvexClientProvider.tsx` | Modified | 4E |
| `app/workspace/closer/_components/unmatched-banner.tsx` | Modified | 4F |
