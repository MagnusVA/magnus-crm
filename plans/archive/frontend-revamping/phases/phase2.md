# Phase 2 — Navigation & Layout: Header, Breadcrumbs, Command Palette, Page Titles, Calendar

**Goal:** Transform the sparse workspace shell into a fully-featured navigation layer with breadcrumbs, search, brand identity, dynamic page titles, and responsive calendar views.

**Prerequisite:** Phase 1 complete (font stack and status config must be stable before touching the layout shell).

**Runs in PARALLEL with:** Nothing — this phase modifies the workspace layout which wraps all pages.

**Skills to invoke:**
- `shadcn` — Breadcrumb, Command, Kbd, Separator components
- `frontend-design` — header composition, command palette UX
- `vercel-react-best-practices` — `bundle-dynamic-imports` for command palette, `rendering-hoist-jsx` for nav config
- `web-design-guidelines` — keyboard navigation, focus management

**Acceptance Criteria:**
1. The workspace header displays: sidebar trigger, breadcrumbs (derived from pathname), a `Cmd+K` search trigger button with `Kbd` hint, and the user avatar.
2. Pressing `Cmd+K` (or `Ctrl+K` on Windows) opens a command palette with page navigation, and the palette is dynamically imported (not in the initial bundle).
3. The sidebar displays a "Magnus" wordmark/icon above the user info in `SidebarHeader`.
4. Every page under `/workspace` has a unique `<title>` reflecting its content (e.g., "Team — Magnus CRM").
5. Calendar day/week views adapt to viewport height instead of using a fixed `h-[600px]`.
6. Breadcrumbs for `/workspace/closer/meetings/[meetingId]` display: `Dashboard > Meetings > [lead name or Meeting ID]`.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Sidebar branding) ──────────────────────────────┐
                                                     │
2B (Breadcrumb system) ────────────────────────────┤
                                                     ├──→ 2E (Integration — wire into layout)
2C (Command palette) ──────────────────────────────┤
                                                     │
2D (Dynamic page titles) ──────────────────────────┘

2F (Calendar responsive height) — independent, can run in PARALLEL with anything
```

**Optimal execution:**
1. Start 2A, 2B, 2C, 2D, 2F all in parallel (they create independent artifacts).
2. Once 2A + 2B + 2C + 2D are done → start 2E (wires everything into the layout).

**Estimated time:** 3–4 days

---

### 2A — Sidebar Branding

**Type:** Frontend
**Parallelizable:** Yes — touches only SidebarHeader in workspace layout

**What:** Add a Magnus CRM wordmark/logo to the sidebar header, above the user info. The wordmark doubles as a home-link back to the user's default page.

**Why:** The sidebar currently has no brand identity. Users see their name, navigation items, and sign-out — no visual anchor. A wordmark provides brand reinforcement and a predictable "home" link.

**Where:**
- `app/workspace/layout.tsx`

**How:**

Add a wordmark element as the first child of `SidebarHeader`, before the user info `div`:

```tsx
// Path: app/workspace/layout.tsx — inside <SidebarHeader>

<SidebarHeader>
  {/* Brand wordmark — links to role-appropriate home */}
  <Link
    href={isAdmin ? "/workspace" : "/workspace/closer"}
    className="flex items-center gap-2 px-2 py-1.5"
  >
    <span className="text-xs font-semibold uppercase tracking-[0.25em] text-sidebar-foreground/80">
      Magnus
    </span>
  </Link>
  <Separator className="mx-2" />
  {/* Existing user info */}
  <div className="flex flex-col gap-1 px-2 py-1.5">
    <p className="truncate text-sm font-medium">
      {resolvedUser.fullName ?? resolvedUser.email}
    </p>
    <p className="text-xs capitalize text-sidebar-foreground/70">
      {resolvedUser.role.replace(/_/g, " ")}
    </p>
  </div>
</SidebarHeader>
```

**Key implementation notes:**
- The wordmark uses the same uppercase tracking style as the landing page header for visual consistency
- The link `href` is role-aware: admins go to `/workspace`, closers go to `/workspace/closer`
- A `Separator` visually divides the brand from the user info
- No logo image is needed — the text wordmark is sufficient for an internal B2B tool
- `isAdmin` is already computed in the layout component

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/layout.tsx` | Modified | Add wordmark + Separator to SidebarHeader |

---

### 2B — Breadcrumb System

**Type:** Frontend
**Parallelizable:** Yes — creates a new hook + component, no overlap with 2A/2C/2D

**What:** Create a breadcrumb generation hook that derives breadcrumb segments from the current pathname and renders them using the shadcn `Breadcrumb` component.

**Why:** Nested pages like `/workspace/closer/meetings/[meetingId]` currently rely on `router.back()` which fails on direct navigation. Breadcrumbs provide persistent orientation and reliable navigation.

**Where:**
- `hooks/use-breadcrumbs.ts` (new)
- `components/workspace-breadcrumbs.tsx` (new)

**How:**

**Step 1: Create breadcrumb hook**

```typescript
// Path: hooks/use-breadcrumbs.ts
"use client";

import { usePathname } from "next/navigation";

export type BreadcrumbSegment = {
  label: string;
  href: string;
};

/**
 * Static breadcrumb label map.
 * Dynamic segments (e.g., [meetingId]) are resolved at render time
 * by the component, not the hook.
 */
const SEGMENT_LABELS: Record<string, string> = {
  workspace: "Home",
  closer: "Dashboard",
  pipeline: "Pipeline",
  team: "Team",
  settings: "Settings",
  meetings: "Meetings",
  admin: "Admin",
};

/**
 * Derives breadcrumb segments from the current pathname.
 *
 * Rules:
 * - `/workspace` → no breadcrumbs (it's the root)
 * - `/workspace/team` → [Home, Team]
 * - `/workspace/closer` → no breadcrumbs (it's the closer root)
 * - `/workspace/closer/pipeline` → [Dashboard, Pipeline]
 * - `/workspace/closer/meetings/[id]` → [Dashboard, Meetings, <dynamic>]
 *
 * Dynamic segments (IDs) are returned with label "..." — the
 * consuming component should replace them with meaningful text.
 */
export function useBreadcrumbs(): BreadcrumbSegment[] {
  const pathname = usePathname();
  const parts = pathname.split("/").filter(Boolean);

  // No breadcrumbs for root pages
  if (parts.length <= 1) return [];
  if (parts.join("/") === "workspace") return [];
  if (parts.join("/") === "workspace/closer") return [];

  const segments: BreadcrumbSegment[] = [];
  let href = "";

  for (const part of parts) {
    href += `/${part}`;

    if (SEGMENT_LABELS[part]) {
      segments.push({ label: SEGMENT_LABELS[part], href });
    } else {
      // Dynamic segment (e.g., meetingId) — placeholder label
      segments.push({ label: "...", href });
    }
  }

  return segments;
}
```

**Step 2: Create breadcrumb component**

```tsx
// Path: components/workspace-breadcrumbs.tsx
"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useBreadcrumbs, type BreadcrumbSegment } from "@/hooks/use-breadcrumbs";
import { Fragment } from "react";

interface WorkspaceBreadcrumbsProps {
  /**
   * Override the label for a specific segment by href.
   * Used for dynamic routes like /meetings/[id] where
   * the label should be the lead name, not the raw ID.
   */
  overrides?: Record<string, string>;
}

export function WorkspaceBreadcrumbs({ overrides }: WorkspaceBreadcrumbsProps) {
  const segments = useBreadcrumbs();

  if (segments.length <= 1) return null;

  const resolvedSegments = segments.map((seg) => ({
    ...seg,
    label: overrides?.[seg.href] ?? seg.label,
  }));

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {resolvedSegments.map((segment, idx) => {
          const isLast = idx === resolvedSegments.length - 1;
          return (
            <Fragment key={segment.href}>
              {idx > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {isLast ? (
                  <BreadcrumbPage>{segment.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={segment.href}>
                    {segment.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
```

**Key implementation notes:**
- The hook returns raw segments; the component resolves dynamic labels via `overrides` prop
- On the meeting detail page, the parent page passes `overrides={{ "/workspace/closer/meetings/abc123": "John Doe" }}` to show the lead name
- Breadcrumbs only render when there are 2+ segments — root pages don't show breadcrumbs
- Uses shadcn `Breadcrumb` compound component (already installed, never used)

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `hooks/use-breadcrumbs.ts` | Created | Pathname → breadcrumb segments |
| `components/workspace-breadcrumbs.tsx` | Created | Renders shadcn Breadcrumb |

---

### 2C — Command Palette

**Type:** Frontend
**Parallelizable:** Yes — creates a new component, no overlap with 2A/2B/2D

**What:** Build a command palette (Cmd+K) using the already-installed shadcn `Command` component inside a `Dialog`. Dynamically import it to keep the initial bundle small.

**Why:** There's no way to quickly navigate between pages, search for leads/meetings, or trigger actions via keyboard. The `Command` component is installed but unused. For a B2B CRM where users perform repetitive tasks, a command palette is a significant productivity boost.

**Where:**
- `components/command-palette.tsx` (new)
- `components/command-palette-trigger.tsx` (new)

**How:**

**Step 1: Create the command palette component**

```tsx
// Path: components/command-palette.tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  LayoutDashboardIcon,
  UsersIcon,
  KanbanIcon,
  SettingsIcon,
  CalendarIcon,
} from "lucide-react";

interface CommandPaletteProps {
  isAdmin: boolean;
}

// Hoisted static page definitions
const adminPages = [
  { label: "Overview", href: "/workspace", icon: LayoutDashboardIcon },
  { label: "Team", href: "/workspace/team", icon: UsersIcon },
  { label: "Pipeline", href: "/workspace/pipeline", icon: KanbanIcon },
  { label: "Settings", href: "/workspace/settings", icon: SettingsIcon },
];

const closerPages = [
  { label: "Dashboard", href: "/workspace/closer", icon: LayoutDashboardIcon },
  { label: "My Pipeline", href: "/workspace/closer/pipeline", icon: KanbanIcon },
  { label: "My Schedule", href: "/workspace/closer", icon: CalendarIcon },
];

export function CommandPalette({ isAdmin }: CommandPaletteProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Global keyboard shortcut: Cmd+K or Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const navigate = useCallback(
    (href: string) => {
      router.push(href);
      setOpen(false);
    },
    [router],
  );

  const pages = isAdmin ? adminPages : closerPages;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages, actions..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Pages">
          {pages.map((page) => (
            <CommandItem
              key={page.href}
              onSelect={() => navigate(page.href)}
            >
              <page.icon />
              <span>{page.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Quick Actions">
          <CommandItem onSelect={() => navigate("/workspace/team")}>
            <UsersIcon />
            <span>Invite team member</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
```

**Step 2: Create the trigger button**

```tsx
// Path: components/command-palette-trigger.tsx
"use client";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { SearchIcon } from "lucide-react";

/**
 * A button that hints at Cmd+K to open the command palette.
 * Placed in the workspace header.
 * The actual opening is handled by the CommandPalette's keydown listener.
 */
export function CommandPaletteTrigger() {
  return (
    <Button
      variant="outline"
      size="sm"
      className="hidden gap-2 text-muted-foreground sm:flex"
      onClick={() => {
        // Dispatch Cmd+K to trigger the palette
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true }),
        );
      }}
    >
      <SearchIcon className="size-3.5" />
      <span className="text-xs">Search</span>
      <Kbd className="ml-1">
        <span className="text-[10px]">&#8984;K</span>
      </Kbd>
    </Button>
  );
}
```

**Step 3: Dynamic import wrapper**

The command palette should be lazy-loaded since it's only shown on user interaction:

```tsx
// In the workspace layout, import dynamically:
import dynamic from "next/dynamic";

const CommandPalette = dynamic(
  () => import("@/components/command-palette").then((m) => ({ default: m.CommandPalette })),
  { ssr: false },
);
```

**Key implementation notes:**
- The `Command` and `CommandDialog` components are already installed in `components/ui/command.tsx`
- The `Kbd` component is already installed in `components/ui/kbd.tsx`
- The palette is dynamically imported (`next/dynamic`) per `bundle-dynamic-imports` rule
- Future enhancement: add lead/meeting search via Convex fulltext query in the palette
- `ssr: false` because the palette uses `document.addEventListener`

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `components/command-palette.tsx` | Created | Command palette with navigation |
| `components/command-palette-trigger.tsx` | Created | Header trigger button with Kbd hint |

---

### 2D — Dynamic Page Titles

**Type:** Frontend
**Parallelizable:** Yes — touches only page-level `<title>`, no overlap with layout

**What:** Add unique browser tab titles to every page under `/workspace` using a client-side `useEffect` pattern (since all pages are `"use client"`).

**Why:** Every page shows "MAGNUS CRM" in the browser tab regardless of context. Users with multiple tabs open can't distinguish between Dashboard, Team, and Pipeline. Dynamic titles also improve accessibility (screen readers announce the page title on navigation).

**Where:**
- `hooks/use-page-title.ts` (new)
- All page components under `app/workspace/`

**How:**

**Step 1: Create the hook**

```typescript
// Path: hooks/use-page-title.ts
"use client";

import { useEffect } from "react";

const SUFFIX = " — Magnus CRM";

/**
 * Sets the document title for the current page.
 * Restores the default title on unmount.
 *
 * Usage: usePageTitle("Team") → "Team — Magnus CRM"
 */
export function usePageTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = `${title}${SUFFIX}`;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
```

**Step 2: Apply to each page**

| Page | Title |
|------|-------|
| `app/workspace/page.tsx` | `usePageTitle("Dashboard")` |
| `app/workspace/team/page.tsx` | `usePageTitle("Team")` |
| `app/workspace/pipeline/page.tsx` | `usePageTitle("Pipeline")` |
| `app/workspace/settings/page.tsx` | `usePageTitle("Settings")` |
| `app/workspace/closer/page.tsx` | `usePageTitle("My Dashboard")` |
| `app/workspace/closer/pipeline/page.tsx` | `usePageTitle("My Pipeline")` |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | `usePageTitle(lead?.name ?? "Meeting")` |
| `app/admin/page.tsx` | `usePageTitle("Admin Console")` |
| `app/onboarding/page.tsx` | `usePageTitle("Onboarding")` |
| `app/onboarding/connect/page.tsx` | `usePageTitle("Connect Calendly")` |

**Key implementation notes:**
- We use `useEffect` + `document.title` instead of Next.js `metadata` because all pages are `"use client"` (Convex client-first architecture)
- The hook restores the previous title on unmount to avoid stale titles during transitions
- The meeting detail page passes the lead name dynamically — the title updates when data loads
- The suffix ` — Magnus CRM` provides context when the tab is narrow

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `hooks/use-page-title.ts` | Created | Document title hook |
| `app/workspace/page.tsx` | Modified | Add `usePageTitle("Dashboard")` |
| `app/workspace/team/page.tsx` | Modified | Add `usePageTitle("Team")` |
| `app/workspace/pipeline/page.tsx` | Modified | Add `usePageTitle("Pipeline")` |
| `app/workspace/settings/page.tsx` | Modified | Add `usePageTitle("Settings")` |
| `app/workspace/closer/page.tsx` | Modified | Add `usePageTitle("My Dashboard")` |
| `app/workspace/closer/pipeline/page.tsx` | Modified | Add `usePageTitle("My Pipeline")` |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Modified | Add `usePageTitle(...)` |
| `app/admin/page.tsx` | Modified | Add `usePageTitle("Admin Console")` |
| `app/onboarding/page.tsx` | Modified | Add `usePageTitle("Onboarding")` |
| `app/onboarding/connect/page.tsx` | Modified | Add `usePageTitle("Connect Calendly")` |

---

### 2E — Layout Integration: Wire Header, Breadcrumbs, Command Palette

**Type:** Frontend
**Parallelizable:** No — depends on 2A, 2B, 2C, 2D being complete

**What:** Integrate all Phase 2 artifacts into the workspace layout: enrich the header with breadcrumbs, command palette trigger, and user avatar; wire the command palette (lazily); integrate the sidebar branding.

**Why:** The current header contains only a sidebar trigger. This subphase brings all the pieces together into a cohesive navigation experience.

**Where:**
- `app/workspace/layout.tsx`

**How:**

Transform the header from:

```tsx
<header className="flex h-12 items-center gap-2 border-b px-4">
  <SidebarTrigger />
</header>
```

To:

```tsx
<header className="flex h-12 items-center gap-2 border-b px-4">
  <SidebarTrigger aria-label="Toggle sidebar" />
  <Separator orientation="vertical" className="h-4" />
  <WorkspaceBreadcrumbs />
  <div className="ml-auto flex items-center gap-2">
    <CommandPaletteTrigger />
  </div>
</header>
```

And add the lazy-loaded CommandPalette at the bottom of the layout:

```tsx
<SidebarProvider>
  <Sidebar>{/* ... sidebar content with 2A branding ... */}</Sidebar>
  <SidebarInset>
    <header>{/* ... enriched header ... */}</header>
    <div className="flex-1 overflow-auto p-6">{children}</div>
  </SidebarInset>
  {/* Command palette — lazy loaded, rendered outside the sidebar */}
  <CommandPalette isAdmin={isAdmin} />
</SidebarProvider>
```

**Expected layout after this subphase:**

```
┌─────────────────────────────────────────────────────────────────┐
│ Sidebar          │ [≡] │ Home > Team                  [⌘K Search] │
│ ─────────────── │─────┼────────────────────────────────────────────│
│ MAGNUS           │     │                                          │
│ ────             │     │  Page content...                         │
│ Jane Smith       │     │                                          │
│ Tenant Admin     │     │                                          │
│                  │     │                                          │
│ ● Overview       │     │                                          │
│   Team           │     │                                          │
│   Pipeline       │     │                                          │
│   Settings       │     │                                          │
│                  │     │                                          │
│ Sign Out         │     │                                          │
└─────────────────────────────────────────────────────────────────┘
```

**Key implementation notes:**
- The `CommandPalette` is imported with `next/dynamic` and `ssr: false`
- `Separator` (already installed) provides visual division between sidebar trigger and breadcrumbs
- `aria-label="Toggle sidebar"` added to `SidebarTrigger` (accessibility fix from Section 9)
- The `CommandPaletteTrigger` is hidden on mobile (`hidden sm:flex`) — on mobile, the command palette is still accessible via `Cmd+K`
- Import `Link` and `Separator` (both already available)

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/layout.tsx` | Modified | Enriched header, lazy CommandPalette, sidebar branding |

---

### 2F — Calendar Responsive Height

**Type:** Frontend
**Parallelizable:** Yes — touches only calendar view files, no overlap with 2A–2E

**What:** Replace the fixed `h-[600px]` on calendar day and week views with a viewport-responsive height using `calc(100dvh - ...)`.

**Why:** On a 900px screen with sidebar header (48px) and page padding, the 600px calendar barely fits and requires scrolling. On a 1400px screen, there's wasted space. The calendar should fill available vertical space.

**Where:**
- `app/workspace/closer/_components/day-view.tsx`
- `app/workspace/closer/_components/week-view.tsx`

**How:**

Replace the fixed height container in both files:

```tsx
// Before:
<div className="relative h-[600px] overflow-y-auto ...">

// After — uses dynamic viewport height minus header/padding:
<div className="relative h-[calc(100dvh-20rem)] min-h-[400px] overflow-y-auto ...">
```

The `20rem` accounts for:
- Workspace header: `h-12` (3rem)
- Page padding: `p-6` top + bottom (3rem)
- Section heading: ~2rem
- Calendar header (day/week tabs + nav): ~3rem
- Pipeline strip above calendar: ~5rem (on closer dashboard)
- Buffer: ~4rem

`min-h-[400px]` ensures the calendar is usable even on very small viewports.

**Key implementation notes:**
- `100dvh` (dynamic viewport height) is used instead of `100vh` to account for mobile browser chrome (URL bar, etc.)
- The month view doesn't need this fix — it uses a CSS grid that naturally fits its content
- If the calendar is used on a page without the pipeline strip (e.g., a future standalone calendar page), the height will be taller — which is correct behavior
- Test on mobile (< 768px) to ensure the calendar is still scrollable and usable

**Files touched:**

| File | Action | Notes |
|------|--------|-------|
| `app/workspace/closer/_components/day-view.tsx` | Modified | Responsive height |
| `app/workspace/closer/_components/week-view.tsx` | Modified | Responsive height |

---

## Phase 2 Summary

| File | Action | Subphase |
|------|--------|----------|
| `app/workspace/layout.tsx` | Modified | 2A, 2E |
| `hooks/use-breadcrumbs.ts` | Created | 2B |
| `components/workspace-breadcrumbs.tsx` | Created | 2B |
| `components/command-palette.tsx` | Created | 2C |
| `components/command-palette-trigger.tsx` | Created | 2C |
| `hooks/use-page-title.ts` | Created | 2D |
| `app/workspace/page.tsx` | Modified | 2D |
| `app/workspace/team/page.tsx` | Modified | 2D |
| `app/workspace/pipeline/page.tsx` | Modified | 2D |
| `app/workspace/settings/page.tsx` | Modified | 2D |
| `app/workspace/closer/page.tsx` | Modified | 2D |
| `app/workspace/closer/pipeline/page.tsx` | Modified | 2D |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Modified | 2D |
| `app/admin/page.tsx` | Modified | 2D |
| `app/onboarding/page.tsx` | Modified | 2D |
| `app/onboarding/connect/page.tsx` | Modified | 2D |
| `app/workspace/closer/_components/day-view.tsx` | Modified | 2F |
| `app/workspace/closer/_components/week-view.tsx` | Modified | 2F |
