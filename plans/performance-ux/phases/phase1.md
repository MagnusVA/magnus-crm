# Phase 1 — Streaming Foundation & Config

**Goal:** Enable instant navigation feedback and Partial Prerendering (PPR) by adding `loading.tsx` and `error.tsx` boundaries to every workspace route segment and enabling `cacheComponents` + `optimizePackageImports` in `next.config.ts`. After this phase, every workspace navigation shows a meaningful skeleton within 50ms, errors are contained per-route, and the framework is configured for PPR, Activity, and barrel import optimization.

**Prerequisite:** Authorization Revamp Phase 2 complete (workspace layout is RSC). No backend/Convex changes required.

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on `loading.tsx`, `error.tsx`, and `cacheComponents` being in place.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).
> Start immediately.

**Skills to invoke:**
- `next-best-practices` — file conventions for `loading.tsx`/`error.tsx`, Suspense boundary requirements, bundling strategy
- `vercel-react-best-practices` — barrel import optimization (`optimizePackageImports` config), `bundle-barrel-imports` (CRITICAL priority)
- `frontend-design` — building skeleton components with Cumulative Layout Shift (CLS) prevention
- `shadcn` — using `Skeleton`, `Card`, `Button` components in loading/error states
- `web-design-guidelines` — WCAG compliance for loading states, `aria-live` for dynamic content, focus management in error boundaries

**Acceptance Criteria:**
1. `loading.tsx` exists in all 8 workspace route segments: `/workspace`, `/workspace/closer`, `/workspace/pipeline`, `/workspace/team`, `/workspace/settings`, `/workspace/profile`, `/workspace/closer/pipeline`, `/workspace/closer/meetings/[meetingId]`.
2. `error.tsx` exists at the `/workspace` level, catching errors for all child routes without crashing the workspace shell.
3. All loading skeletons render within 50ms of navigation — skeleton dimensions match final content to prevent CLS (< 0.1).
4. `next.config.ts` has `cacheComponents: true` and `optimizePackageImports: ["lucide-react", "date-fns", "recharts"]` configured.
5. Error boundary shows a retry button and error digest; workspace sidebar and header remain interactive when an error is caught.
6. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (next.config.ts) ─────────────────────────────┐
                                                   ├── 1D (Validation & Verify)
1B (Loading skeletons — 8 files) ─────────────────┤
                                                   │
1C (Error boundary) ──────────────────────────────┘
```

**Optimal execution:**
1. Start 1A, 1B, 1C all in parallel (they touch completely different files).
2. Once all three are done → run 1D (build, type-check, visual verify).

**Estimated time:** 2 hours

---

## Subphases

### 1A — Next.js Config: cacheComponents & optimizePackageImports

**Type:** Config
**Parallelizable:** Yes — independent of skeleton and error boundary files.

**What:** Enable `cacheComponents: true` and configure `optimizePackageImports` in `next.config.ts` to unlock Partial Prerendering, `<Activity>` state preservation, and barrel import tree-shaking.

**Why:** `cacheComponents` is the feature flag that enables PPR (static shell + streaming dynamic content), React `<Activity>` (state preservation across navigations), and the `use cache` directive. Without it, `loading.tsx` files are just basic Suspense fallbacks with no PPR benefit. `optimizePackageImports` is a CRITICAL Vercel performance rule — barrel imports from `lucide-react`, `date-fns`, and `recharts` pull in thousands of unused modules, adding 200–800ms to cold starts and 28% to build time.

**Where:**
- `next.config.ts` (modify)

**How:**

**Step 1: Update next.config.ts**

```typescript
// Path: next.config.ts

// BEFORE:
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  // Required to support PostHog trailing slash API requests
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
```

```typescript
// Path: next.config.ts

// AFTER:
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default nextConfig;
```

**Step 2: Verify dev server starts**

```bash
pnpm dev
```

Watch for "Cache Components: enabled" or similar in the terminal output. The dev server should start without errors.

**Key implementation notes:**
- `optimizePackageImports` lives under `experimental` but is stable in Next.js 16 — the namespace is for API stability reasons.
- `cacheComponents` replaces old route segment configs (`dynamic`, `revalidate`, `fetchCache`). All data is now dynamic by default unless marked with `use cache`.
- With `cacheComponents: true`, any component that accesses runtime APIs (`cookies()`, `headers()`) MUST be inside a `<Suspense>` boundary — this is enforced in Phase 2.
- Keep all existing `rewrites()` and `skipTrailingSlashRedirect` unchanged.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `next.config.ts` | Modify | Add `cacheComponents: true` and `optimizePackageImports` |

---

### 1B — Loading Skeletons for All Workspace Routes

**Type:** Frontend
**Parallelizable:** Yes — each `loading.tsx` is independent; they touch different route directories with no shared imports.

**What:** Create `loading.tsx` files for all 8 workspace route segments. Each skeleton matches the dimensions of the final rendered content to prevent Cumulative Layout Shift (CLS). Uses the shadcn `Skeleton` and `Card` components.

**Why:** `loading.tsx` wraps the route's `page.tsx` in a `<Suspense>` boundary automatically. The skeleton appears instantly on navigation while the server processes `getWorkspaceAccess()` + `requireRole()` + `preloadQuery()` (200–800ms). Without `loading.tsx`, the UI freezes during this time. Additionally, `loading.tsx` enables Next.js route prefetching — the framework prefetches up to the loading boundary on link hover, making navigations feel instant.

**Where:**
- `app/workspace/loading.tsx` (new)
- `app/workspace/closer/loading.tsx` (new)
- `app/workspace/pipeline/loading.tsx` (new)
- `app/workspace/team/loading.tsx` (new)
- `app/workspace/settings/loading.tsx` (new)
- `app/workspace/profile/loading.tsx` (new)
- `app/workspace/closer/pipeline/loading.tsx` (new)
- `app/workspace/closer/meetings/[meetingId]/loading.tsx` (new)

**How:**

**Step 1: Create admin dashboard loading skeleton**

The admin dashboard (`/workspace`) shows a header, 4 stats cards, pipeline summary, and system health card.

```typescript
// Path: app/workspace/loading.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function WorkspaceDashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-80" />
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-3">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="mt-2 h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pipeline summary */}
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-36" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* System health */}
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 2: Create closer dashboard loading skeleton**

The closer dashboard (`/workspace/closer`) shows a header, featured meeting card, pipeline strip (7 status columns), and calendar section.

```typescript
// Path: app/workspace/closer/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function CloserDashboardLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Page header */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Featured meeting card */}
      <Skeleton className="h-[180px] rounded-xl" />

      {/* Pipeline strip */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-[76px] rounded-lg" />
          ))}
        </div>
      </div>

      {/* Calendar section */}
      <Skeleton className="h-px w-full" /> {/* Separator */}
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-[400px] rounded-xl" />
      </div>
    </div>
  );
}
```

**Step 3: Create pipeline loading skeleton**

The admin pipeline (`/workspace/pipeline`) shows a header, filters bar, and table rows.

```typescript
// Path: app/workspace/pipeline/loading.tsx
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function PipelineLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-5 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>
      <Skeleton className="h-10 w-full rounded-lg" /> {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 4: Create team loading skeleton**

```typescript
// Path: app/workspace/team/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function TeamLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-5 w-64" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex flex-col gap-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    </div>
  );
}
```

**Step 5: Create settings loading skeleton**

```typescript
// Path: app/workspace/settings/loading.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-5 w-64" />
      </div>
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
```

**Step 6: Create profile loading skeleton**

```typescript
// Path: app/workspace/profile/loading.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function ProfileLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-5 w-48" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Step 7: Create closer pipeline loading skeleton**

```typescript
// Path: app/workspace/closer/pipeline/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function CloserPipelineLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-full rounded-lg" /> {/* Status tabs */}
      <div className="flex flex-col gap-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 rounded-md" />
        ))}
      </div>
    </div>
  );
}
```

**Step 8: Create meeting detail loading skeleton**

```typescript
// Path: app/workspace/closer/meetings/[meetingId]/loading.tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function MeetingDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-5 w-24" /> {/* Back button */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><Skeleton className="h-6 w-32" /></CardHeader>
          <CardContent><Skeleton className="h-32 w-full" /></CardContent>
        </Card>
        <Card>
          <CardHeader><Skeleton className="h-6 w-32" /></CardHeader>
          <CardContent><Skeleton className="h-32 w-full" /></CardContent>
        </Card>
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- `loading.tsx` files are Server Components by default (no `"use client"` needed) — they render pure JSX with no interactivity.
- Skeleton dimensions must match the final rendered content to prevent CLS. Use the same Card structure, grid layouts, and approximate heights as the real pages.
- Each `loading.tsx` only applies to its own route segment — it does NOT wrap `layout.tsx`, `template.tsx`, or `error.tsx` in the same segment.
- The skeletons reuse the shadcn `Skeleton` component (`animate-pulse rounded-md bg-muted`).
- Consistent spacing: `gap-6` between sections, `gap-4` within grids, `gap-2` for header text.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/loading.tsx` | Create | Admin dashboard skeleton |
| `app/workspace/closer/loading.tsx` | Create | Closer dashboard skeleton |
| `app/workspace/pipeline/loading.tsx` | Create | Admin pipeline skeleton |
| `app/workspace/team/loading.tsx` | Create | Team management skeleton |
| `app/workspace/settings/loading.tsx` | Create | Settings skeleton |
| `app/workspace/profile/loading.tsx` | Create | Profile skeleton |
| `app/workspace/closer/pipeline/loading.tsx` | Create | Closer pipeline skeleton |
| `app/workspace/closer/meetings/[meetingId]/loading.tsx` | Create | Meeting detail skeleton |

---

### 1C — Workspace Error Boundary

**Type:** Frontend
**Parallelizable:** Yes — independent of config and skeleton files.

**What:** Create an `error.tsx` at the `/workspace` level that catches render errors for all workspace child routes. Shows a retry UI while keeping the workspace shell (sidebar, header) interactive.

**Why:** Without error boundaries, a single render error (malformed Convex data, auth failure mid-stream, missing field) crashes the entire workspace — sidebar and header disappear. With `error.tsx` at the workspace level, the error is scoped to the main content area. The sidebar and header remain functional because `error.tsx` is nested inside `layout.tsx`. A single error boundary at `/workspace` covers all child routes; specific routes can add their own `error.tsx` later to override.

**Where:**
- `app/workspace/error.tsx` (new)

**How:**

**Step 1: Create the workspace error boundary**

```typescript
// Path: app/workspace/error.tsx
"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";

export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Log to error reporting service (PostHog, Sentry, etc.)
    console.error("[WorkspaceError]", error);
  }, [error]);

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangleIcon className="h-6 w-6 text-destructive" />
          </div>
          <CardTitle>Something went wrong</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          <p className="text-center text-sm text-muted-foreground">
            An unexpected error occurred while loading this page.
            {error.digest && (
              <span className="mt-1 block font-mono text-xs">
                Error ID: {error.digest}
              </span>
            )}
          </p>
          <Button onClick={reset} variant="outline" size="sm">
            <RefreshCwIcon data-icon="inline-start" />
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Key implementation notes:**
- `error.tsx` MUST be a Client Component (`"use client"`) — it handles browser-side error recovery and user interactions.
- Uses `min-h-[50vh]` (not `min-h-screen`) because the error boundary nests inside the workspace layout — the sidebar and header are still visible above/beside it.
- The `reset()` function re-renders the route segment, retrying the failed render. It does NOT cause a full page reload.
- `error.digest` is a server-generated hash for error tracking — show it so users can report issues.
- Error logging in `useEffect` ensures it fires once per error, not on every re-render.
- If a specific route needs custom error handling later (e.g., "Meeting not found"), it can add its own `error.tsx` that overrides this parent.
- Uses `AlertTriangleIcon` and `RefreshCwIcon` from lucide-react — these are already used elsewhere in the app.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/error.tsx` | Create | Workspace-wide error boundary |

---

### 1D — Validation & Bundle Analysis

**Type:** Config / Validation
**Parallelizable:** No — must run after 1A, 1B, 1C to validate everything together.

**What:** Verify the build passes, type-check succeeds, `cacheComponents` is acknowledged, and `optimizePackageImports` reduces bundle size for barrel-heavy dependencies.

**Why:** Ensures all Phase 1 changes work together before Phase 2 restructures the layout. Catches TypeScript errors from new files and confirms the config is correctly applied.

**Where:**
- No new files — validation only.

**How:**

**Step 1: Type-check**

```bash
pnpm tsc --noEmit
```

Must complete without errors.

**Step 2: Run baseline bundle analysis (before Phase 4 comparison)**

```bash
pnpm next experimental-analyze --output
```

Output saved to `.next/diagnostics/analyze`. Check that:
- `lucide-react` imports are tree-shaken (direct paths, not barrel)
- `date-fns` imports are direct
- `recharts` imports are direct

Save the output for before/after comparison after Phase 4.

**Step 3: Dev server verification**

```bash
pnpm dev
```

1. Navigate to `/workspace` — verify admin dashboard skeleton appears instantly.
2. Navigate to `/workspace/closer` — verify closer dashboard skeleton appears.
3. Navigate to `/workspace/pipeline` — verify pipeline skeleton appears.
4. Navigate to `/workspace/team` — verify team skeleton appears.
5. Open DevTools → Network → set "Slow 3G" → navigate between routes → confirm skeletons appear before any data loads.
6. Trigger an error (e.g., temporarily throw in a page component) → confirm `error.tsx` catches it and sidebar remains visible.

**Key implementation notes:**
- `pnpm next experimental-analyze` is built into Next.js 16.1+ — no third-party package needed.
- With `cacheComponents: true`, the build may warn about components accessing uncached data outside `<Suspense>`. This is expected — Phase 2 fixes it by restructuring the layout.
- If the dev server throws `Error: Uncached data was accessed outside of <Suspense>`, the current `workspace/layout.tsx` calls `getWorkspaceAccess()` at the top level. This is resolved in Phase 2 — for now, verify that `loading.tsx` and `error.tsx` files render correctly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (Build artifacts) | Generated | Verification only, no new source files |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `next.config.ts` | Modify | 1A |
| `app/workspace/loading.tsx` | Create | 1B |
| `app/workspace/closer/loading.tsx` | Create | 1B |
| `app/workspace/pipeline/loading.tsx` | Create | 1B |
| `app/workspace/team/loading.tsx` | Create | 1B |
| `app/workspace/settings/loading.tsx` | Create | 1B |
| `app/workspace/profile/loading.tsx` | Create | 1B |
| `app/workspace/closer/pipeline/loading.tsx` | Create | 1B |
| `app/workspace/closer/meetings/[meetingId]/loading.tsx` | Create | 1B |
| `app/workspace/error.tsx` | Create | 1C |
