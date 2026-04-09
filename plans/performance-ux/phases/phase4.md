# Phase 4 — View Transitions, Lazy Loading & Validation

**Goal:** Add smooth client-side view transitions for polished page animations, lazy-load heavy components (recharts, CalendarView) to reduce initial bundle size, add CSS animations for streamed content and skeleton shimmer, validate the streaming architecture with `unstable_instant` exports, enable DevTools inspection, and wire up Web Vitals reporting. After this phase, navigations animate smoothly, the initial JavaScript bundle is smaller, animations respect `prefers-reduced-motion`, and the build validates that all routes produce an instant static shell.

**Prerequisite:** Phase 3 complete (dashboard pages have granular Suspense boundaries, section components exist for lazy-loading).

**Runs in PARALLEL with:** Nothing — this is the final phase. All performance work culminates here.

**Skills to invoke:**
- `vercel-react-view-transitions` — `<ViewTransition>` component, `addTransitionType`, CSS `::view-transition-*` pseudo-elements, Suspense reveal animations, `prefers-reduced-motion` accessibility
- `vercel-react-best-practices` — `bundle-dynamic-imports` (CRITICAL — lazy load heavy components), `bundle-defer-third-party` (MEDIUM — defer non-critical client code), `bundle-barrel-imports` verification
- `next-best-practices` — `unstable_instant` validation, `instantNavigationDevToolsToggle`, bundle analysis
- `web-design-guidelines` — WCAG 2.1 Level AA: `prefers-reduced-motion: reduce` for all animations, `aria-live` for dynamic content updates, focus management

**Acceptance Criteria:**
1. Navigating between workspace routes shows a smooth cross-fade animation (200ms ease-out) instead of an abrupt page swap.
2. `prefers-reduced-motion: reduce` disables all animations (view transitions, stream-in, shimmer, progress bar) — verified in Chrome DevTools "Emulate CSS media feature prefers-reduced-motion".
3. `recharts` / chart components are lazy-loaded via `dynamic()` — not included in the initial page bundle (verified via bundle analysis).
4. `CalendarView` on the closer dashboard is lazy-loaded via `dynamic()` — not included in the initial page bundle.
5. All workspace routes export `unstable_instant = { prefetch: "static" }` and the build validates instant navigation without errors.
6. `pnpm next experimental-analyze` shows reduced bundle size vs. Phase 1 baseline — heavy libraries moved to dynamic chunks.
7. Web Vitals reporter logs FCP, LCP, CLS, INP, TTFB in the browser console during development.
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (View transition CSS + component) ──────────────────┐
                                                        │
4B (Lazy loading heavy components) ─────────────────────┤
                                                        ├── 4E (Build validation + bundle comparison)
4C (unstable_instant exports + DevTools config) ────────┤
                                                        │
4D (Web Vitals reporter) ──────────────────────────────┘
```

**Optimal execution:**
1. Start 4A, 4B, 4C, 4D all in parallel — they touch different files with no overlap.
2. Once all four are done → run 4E (build, type-check, bundle analysis, visual verification).

**Estimated time:** 1.5 hours

---

## Subphases

### 4A — View Transitions & CSS Animations

**Type:** Frontend
**Parallelizable:** Yes — touches only `globals.css` and creates one new component. No overlap with other subphases.

**What:** Add React View Transition support for smooth page navigations, a CSS animation for streamed content entrance, an enhanced skeleton shimmer, and a `prefers-reduced-motion` media query that disables all animations.

**Why:** Without view transitions, page navigations are abrupt — the old page disappears and the new page appears instantly. With `<ViewTransition>`, React coordinates with the View Transition API to cross-fade between old and new content (200ms). Streamed content animations (fade-in + slide-up) provide visual continuity when Suspense boundaries resolve. The shimmer effect gives skeletons a more polished appearance. All animations must respect reduced motion preferences (WCAG 2.1 Level AA, Success Criterion 2.3.3).

**Where:**
- `app/globals.css` (modify)
- `components/ui/stream-boundary.tsx` (new)

**How:**

**Step 1: Add view transition CSS to globals.css**

```css
/* Path: app/globals.css (additions at the end of the file) */

/* ============================================================
   View Transitions & Streaming Animations (Phase 4)
   ============================================================ */

/* Page transition: cross-fade between old and new page content */
::view-transition-group(page-transition) {
  animation-duration: 200ms;
  animation-timing-function: ease-out;
}

::view-transition-old(page-transition) {
  animation: vt-fade-out 150ms ease-out;
}

::view-transition-new(page-transition) {
  animation: vt-fade-in 200ms ease-out;
}

@keyframes vt-fade-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

@keyframes vt-fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* Streamed content entrance — applied when Suspense resolves */
@keyframes stream-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-stream-in {
  animation: stream-in 300ms ease-out;
}

/* Enhanced skeleton shimmer (replaces default pulse) */
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

.skeleton-shimmer {
  background: linear-gradient(
    90deg,
    hsl(var(--muted)) 25%,
    hsl(var(--muted-foreground) / 0.08) 50%,
    hsl(var(--muted)) 75%
  );
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}

/* Navigation progress bar (optional — use if needed) */
@keyframes progress-bar {
  0% { width: 0; }
  50% { width: 70%; }
  100% { width: 100%; }
}

.animate-progress-bar {
  animation: progress-bar 500ms ease-out forwards;
}

/* ============================================================
   Accessibility: Respect reduced motion preference
   WCAG 2.1 Level AA — Success Criterion 2.3.3
   ============================================================ */
@media (prefers-reduced-motion: reduce) {
  /* Disable view transitions */
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) {
    animation-duration: 0.01ms !important;
  }

  /* Disable streaming and shimmer animations */
  .animate-stream-in,
  .animate-progress-bar,
  .skeleton-shimmer {
    animation: none !important;
  }

  /* Ensure stream-in content is immediately visible */
  .animate-stream-in {
    opacity: 1;
    transform: none;
  }
}
```

**Step 2: Create the StreamBoundary component**

```typescript
// Path: components/ui/stream-boundary.tsx
"use client";

import { type ReactNode, Suspense } from "react";

interface StreamBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Suspense boundary that adds an entrance animation when content resolves.
 * Wraps the resolved content in an animate-stream-in container.
 *
 * Note: Adds an extra <div> wrapper. When used inside a grid or flex parent,
 * pass className="contents" to make the wrapper invisible to CSS layout.
 * If View Transitions already provide sufficient visual continuity, this
 * component may be unnecessary — test both approaches.
 */
export function StreamBoundary({ fallback, children, className }: StreamBoundaryProps) {
  return (
    <Suspense fallback={fallback}>
      <div className={`animate-stream-in ${className ?? ""}`}>
        {children}
      </div>
    </Suspense>
  );
}
```

**Step 3: Wire view transitions into the workspace shell**

Add `<ViewTransition>` wrapper around page content in the workspace layout. This goes in `WorkspaceShellFrame` or `WorkspaceShellClient` (from Phase 2):

```typescript
// Path: app/workspace/_components/workspace-shell-frame.tsx (modification — add ViewTransition)

// Add to the import section:
import { ViewTransition } from "react";

// Wrap the main content area:
<div id="main-content" className="flex-1 overflow-auto p-6" tabIndex={-1}>
  <ViewTransition default="page-transition">
    {children}
  </ViewTransition>
</div>
```

> **Implementation note:** `<ViewTransition>` is from React 19's View Transition API. It requires `react@19.2.4+` (which this project has). The component automatically calls `document.startViewTransition()` when its children change during navigation. If the browser doesn't support the View Transition API, it degrades gracefully — no animation, but no error.

**Key implementation notes:**
- View transitions only animate during client-side navigations (not initial page load or hard refresh).
- The `page-transition` name on `<ViewTransition>` maps to the `::view-transition-group(page-transition)` CSS selector.
- `vt-fade-out` is 150ms and `vt-fade-in` is 200ms — the old page fades out slightly faster than the new page fades in, creating a natural cross-dissolve.
- `translateY(4px)` on fade-in adds subtle upward motion — enough to feel dynamic without being distracting.
- `StreamBoundary` is optional — if `<ViewTransition>` already handles Suspense reveal animations, `StreamBoundary` may be redundant. Test both approaches.
- All animations use `ease-out` timing for natural deceleration.
- The `prefers-reduced-motion` block uses `0.01ms` (not `0ms`) for view transitions because some browsers interpret `0ms` as "no animation" vs "animation-duration: 0" differently.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/globals.css` | Modify | Add view transition CSS, stream-in, shimmer, reduced-motion |
| `components/ui/stream-boundary.tsx` | Create | Animated Suspense wrapper |
| `app/workspace/_components/workspace-shell-frame.tsx` | Modify | Add `<ViewTransition>` around page content |

---

### 4B — Lazy Loading Heavy Components

**Type:** Frontend
**Parallelizable:** Yes — touches only section wrapper components. No overlap with 4A, 4C, 4D.

**What:** Wrap `recharts`-based chart components and the `CalendarView` in `dynamic()` imports with `{ ssr: false }` and loading skeletons. This removes ~200KB (recharts) and ~80KB (calendar + date-fns locale) from the initial page bundle.

**Why:** `recharts` is a ~200KB library only used in dashboard stats charts. `CalendarView` pulls in `react-day-picker`, `date-fns` locale data, and multiple view mode components — only needed on the closer dashboard. Neither is needed for initial page paint. Loading them lazily via `dynamic()` means the JavaScript only downloads when the component is about to render, significantly improving Time to Interactive (TTI) and reducing the critical rendering path.

**Where:**
- `app/workspace/_components/stats-section.tsx` (modify — from Phase 3)
- `app/workspace/closer/_components/calendar-section.tsx` (modify — from Phase 3)

**How:**

**Step 1: Lazy-load stats charts**

If the `StatsRow` component imports from `recharts`, wrap the chart rendering in a dynamic import:

```typescript
// Path: app/workspace/_components/stats-section.tsx (modification)

// BEFORE (from Phase 3):
import { StatsRow } from "./stats-row";

export async function StatsSection() {
  const preloadedStats = await preloadQuery(
    api.dashboard.adminStats.getAdminDashboardStats,
    {},
  );
  return <StatsRow preloadedStats={preloadedStats} />;
}
```

```typescript
// Path: app/workspace/_components/stats-section.tsx (modification)

// AFTER:
"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

// Lazy-load the chart component — recharts (~200KB) only loads when needed
const StatsCharts = dynamic(
  () => import("./stats-charts").then((m) => ({ default: m.StatsCharts })),
  {
    ssr: false,
    loading: () => (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-[300px] rounded-xl" />
        <Skeleton className="h-[300px] rounded-xl" />
      </div>
    ),
  },
);

export function StatsSection() {
  // Data fetching happens via useQuery/usePreloadedQuery inside StatsCharts
  return <StatsCharts />;
}
```

> **Implementation note:** The exact refactoring depends on how `StatsRow` currently uses recharts. If `StatsRow` itself contains chart rendering, extract the chart portion into a separate `stats-charts.tsx` file and lazy-load that. If `StatsRow` is already a thin wrapper, lazy-load `StatsRow` directly. The key rule: the `import()` boundary must be **above** the `recharts` import in the module graph.

**Step 2: Lazy-load CalendarView**

```typescript
// Path: app/workspace/closer/_components/calendar-section.tsx (modification)

// BEFORE (from Phase 3):
"use client";

import { CalendarView } from "./calendar-view";

export function CalendarSection() {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
        My Schedule
      </h2>
      <CalendarView />
    </div>
  );
}
```

```typescript
// Path: app/workspace/closer/_components/calendar-section.tsx (modification)

// AFTER:
"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

// Lazy-load CalendarView — react-day-picker + date-fns locale + view modes (~80KB)
const CalendarView = dynamic(
  () => import("./calendar-view").then((m) => ({ default: m.CalendarView })),
  {
    ssr: false,
    loading: () => <Skeleton className="h-[400px] rounded-xl" />,
  },
);

export function CalendarSection() {
  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold tracking-tight text-pretty">
        My Schedule
      </h2>
      <CalendarView />
    </div>
  );
}
```

**Key implementation notes:**
- `{ ssr: false }` prevents server-side rendering of these components. Since they're inside Suspense boundaries that already have server-rendered skeleton fallbacks, this is correct — the client loads the JavaScript and renders the component after hydration.
- The `loading` callback in `dynamic()` shows a skeleton while the chunk downloads. This is different from the Suspense fallback — the Suspense fallback shows during server-side streaming, while the `dynamic()` loading shows during client-side chunk loading.
- Verify that `CalendarView` is exported as a named export (`export function CalendarView`) — the `.then((m) => ({ default: m.CalendarView }))` pattern handles named exports.
- If `CalendarView` is a default export, simplify to `dynamic(() => import("./calendar-view"))`.
- After lazy-loading, the `recharts` and `react-day-picker` chunks will only download when the user visits a page that renders them — not on every workspace navigation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/stats-section.tsx` | Modify | Lazy-load recharts via dynamic() |
| `app/workspace/closer/_components/calendar-section.tsx` | Modify | Lazy-load CalendarView via dynamic() |

---

### 4C — unstable_instant Exports & DevTools Config

**Type:** Config
**Parallelizable:** Yes — adds exports to page files and modifies next.config.ts. No overlap with 4A, 4B, 4D.

**What:** Add `export const unstable_instant = { prefetch: "static" }` to all workspace route pages and enable `instantNavigationDevToolsToggle` in next.config.ts. This validates at build time that every workspace navigation produces an instant static shell.

**Why:** `unstable_instant` tells Next.js to validate at build time that the page's Suspense boundaries are correctly placed — if any component would block navigation (access uncached data outside Suspense), the build catches it. Without this, misplaced Suspense boundaries silently degrade performance. The DevTools toggle adds an "Instant Navs" panel for visual inspection during development.

**Where:**
- `app/workspace/page.tsx` (modify)
- `app/workspace/closer/page.tsx` (modify)
- `app/workspace/pipeline/page.tsx` (modify)
- `app/workspace/team/page.tsx` (modify)
- `app/workspace/settings/page.tsx` (modify)
- `app/workspace/profile/page.tsx` (modify)
- `next.config.ts` (modify)

**How:**

**Step 1: Add unstable_instant to all workspace pages**

Add this export to the top of each page file, after any existing imports:

```typescript
// Path: app/workspace/page.tsx (add after imports)
export const unstable_instant = { prefetch: "static" };
```

```typescript
// Path: app/workspace/closer/page.tsx (add after imports)
export const unstable_instant = { prefetch: "static" };
```

```typescript
// Path: app/workspace/pipeline/page.tsx (add after imports)
export const unstable_instant = { prefetch: "static" };
```

```typescript
// Path: app/workspace/team/page.tsx (add after imports)
export const unstable_instant = { prefetch: "static" };
```

```typescript
// Path: app/workspace/settings/page.tsx (add after imports)
export const unstable_instant = { prefetch: "static" };
```

```typescript
// Path: app/workspace/profile/page.tsx (add after imports)
export const unstable_instant = { prefetch: "static" };
```

**Step 2: Enable DevTools toggle in next.config.ts**

```typescript
// Path: next.config.ts (modification)

// BEFORE (from Phase 1):
const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
  },
  // ...
};
```

```typescript
// Path: next.config.ts (modification)

// AFTER:
const nextConfig: NextConfig = {
  cacheComponents: true,
  experimental: {
    optimizePackageImports: ["lucide-react", "date-fns", "recharts"],
    instantNavigationDevToolsToggle: true,
  },
  // ...
};
```

**Step 3: Understand validation behavior**

- **During `pnpm dev`:** The error overlay shows warnings if a route's Suspense boundaries are misplaced (e.g., a component accesses cookies outside Suspense).
- **During `pnpm next build`:** The build simulates navigations at every shared layout boundary. If a component blocks navigation, the build error identifies the blocking component and suggests a fix.
- **DevTools toggle:** In the browser, the Next.js DevTools overlay gains an "Instant Navs" button:
  - **Page load mode:** Freezes the page at the static shell to verify what prerendered.
  - **Navigation mode:** Shows the prefetched UI for the target page before dynamic content streams in.

**Key implementation notes:**
- `unstable_instant` validates at every *shared layout boundary*, not just the page's own Suspense. This means it checks that navigating from `/workspace` to `/workspace/pipeline` (shared layout: `workspace/layout.tsx`) produces an instant shell.
- If validation fails, the error will identify the specific component that accesses uncached data outside Suspense — fix by wrapping it in `<Suspense>` or moving the data access.
- The `unstable_` prefix indicates this API may change in future Next.js versions. It's stable enough for production use in Next.js 16.
- `instantNavigationDevToolsToggle` is development-only — it has zero production impact.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/page.tsx` | Modify | Add `unstable_instant` export |
| `app/workspace/closer/page.tsx` | Modify | Add `unstable_instant` export |
| `app/workspace/pipeline/page.tsx` | Modify | Add `unstable_instant` export |
| `app/workspace/team/page.tsx` | Modify | Add `unstable_instant` export |
| `app/workspace/settings/page.tsx` | Modify | Add `unstable_instant` export |
| `app/workspace/profile/page.tsx` | Modify | Add `unstable_instant` export |
| `next.config.ts` | Modify | Add `instantNavigationDevToolsToggle` |

---

### 4D — Web Vitals Reporter

**Type:** Frontend
**Parallelizable:** Yes — creates a new component with no dependencies on other subphases.

**What:** Create a `WebVitalsReporter` client component that uses `useReportWebVitals` from `next/web-vitals` to log Core Web Vitals (FCP, LCP, CLS, INP, TTFB) during development. Wire it into the workspace layout.

**Why:** After all performance phases are complete, we need to measure the impact. Web Vitals reporting captures real user metrics in the browser. During development, it logs to the console for quick validation. In production, it can be extended to send metrics to PostHog or another analytics service.

**Where:**
- `app/workspace/_components/web-vitals-reporter.tsx` (new)
- `app/workspace/layout.tsx` (modify — add reporter)

**How:**

**Step 1: Create the Web Vitals reporter**

```typescript
// Path: app/workspace/_components/web-vitals-reporter.tsx
"use client";

import { useReportWebVitals } from "next/web-vitals";

/**
 * Reports Core Web Vitals to the console during development.
 * Extend with PostHog/analytics in production.
 *
 * Metrics reported:
 * - FCP (First Contentful Paint)
 * - LCP (Largest Contentful Paint)
 * - CLS (Cumulative Layout Shift)
 * - INP (Interaction to Next Paint)
 * - TTFB (Time to First Byte)
 */
export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    // Development: log to console
    console.debug(
      `[WebVitals] ${metric.name}: ${metric.value.toFixed(1)}${metric.name === "CLS" ? "" : "ms"}`,
    );

    // Production: send to analytics
    // Example: posthog.capture("web_vital", { metric_name: metric.name, value: metric.value });
  });

  return null;
}
```

**Step 2: Add the reporter to the workspace layout**

```typescript
// Path: app/workspace/layout.tsx (modification — add after existing imports)

import { WebVitalsReporter } from "./_components/web-vitals-reporter";

// Add inside the layout JSX, before or after the main content:
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return (
    <WorkspaceShellFrame>
      <WebVitalsReporter />
      <Suspense fallback={<WorkspaceShellSkeleton />}>
        <WorkspaceAuth>{children}</WorkspaceAuth>
      </Suspense>
    </WorkspaceShellFrame>
  );
}
```

**Key implementation notes:**
- `WebVitalsReporter` renders `null` — it's a side-effect-only component that doesn't add DOM nodes.
- `useReportWebVitals` fires once per metric per page load. For navigations, it reports new metrics for the new page.
- CLS is a unitless score (not milliseconds) — the formatting handles this with a conditional suffix.
- In production, replace `console.debug` with PostHog event capture or any analytics service. The PostHog integration is already set up in this app (`usePostHogIdentify` in `WorkspaceShellClient`).
- The reporter is placed outside the Suspense boundary so it's always mounted — it reports metrics regardless of whether auth resolves.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/web-vitals-reporter.tsx` | Create | Core Web Vitals console reporter |
| `app/workspace/layout.tsx` | Modify | Add WebVitalsReporter |

---

### 4E — Build Validation & Bundle Comparison

**Type:** Config / Validation
**Parallelizable:** No — must run after 4A, 4B, 4C, 4D to validate everything together.

**What:** Run the full build with `unstable_instant` validation, compare bundle analysis to Phase 1 baseline, run type-check, and perform manual verification of all performance improvements.

**Why:** This is the final quality gate. Confirms that all 4 phases work together: instant navigation (loading.tsx), PPR (static shell), granular streaming (Suspense), view transitions (CSS animations), lazy loading (dynamic imports), and build-time validation (unstable_instant).

**Where:**
- No new files — validation and measurement only.

**How:**

**Step 1: Type-check**

```bash
pnpm tsc --noEmit
```

Must complete without errors.

**Step 2: Build with validation**

```bash
pnpm next build
```

Watch for:
- `unstable_instant` validation passing for all workspace routes (no blocking component errors).
- `cacheComponents` acknowledged in build output.
- No TypeScript or build errors.

**Step 3: Bundle analysis comparison**

```bash
pnpm next experimental-analyze --output
```

Compare against the Phase 1 baseline saved in `.next/diagnostics/analyze`. Expected improvements:
- `recharts` moved from initial bundle to dynamic chunk (only loaded on dashboard page).
- `react-day-picker` + `date-fns` locale data moved from initial bundle to dynamic chunk (only loaded on closer dashboard).
- `lucide-react` imports tree-shaken to direct paths.
- Total initial JavaScript size reduced by estimated 200-300KB.

**Step 4: Performance benchmarks**

Start the dev server and measure:

| Metric | Target | How to Measure |
|---|---|---|
| **TTFB** | < 200ms | Chrome DevTools → Network → first response timing |
| **FCP** | < 500ms | Lighthouse or console (WebVitalsReporter) |
| **LCP** | < 1.5s | Lighthouse or console |
| **CLS** | < 0.1 | Lighthouse or console |
| **INP** | < 200ms | Chrome DevTools → Performance |
| **Navigation perceived latency** | < 100ms (skeleton visible) | Manual: click sidebar link, observe skeleton |
| **Client-side navigation time** | < 50ms to skeleton | DevTools → Performance → navigation entries |

**Step 5: Visual verification checklist**

1. **Loading skeletons:** Navigate to each workspace route — skeleton appears instantly.
2. **Error boundary:** Temporarily throw in a page component — error card appears, sidebar stays.
3. **View transitions:** Navigate between routes — smooth cross-fade visible.
4. **Reduced motion:** Enable "prefers-reduced-motion" in DevTools — all animations disabled.
5. **Granular streaming:** Open DevTools Network → throttle to "Slow 3G" → navigate to dashboard — sections appear progressively.
6. **Activity preservation:** Toggle sidebar → navigate away → navigate back — sidebar state preserved.
7. **Lazy loading:** Open DevTools Network → navigate to dashboard — verify recharts chunk loads on demand.
8. **Web Vitals:** Open console → navigate between routes — FCP, LCP, CLS, INP, TTFB metrics logged.
9. **DevTools toggle:** Open Next.js DevTools overlay → use "Instant Navs" button → verify static shell inspection works.

**Key implementation notes:**
- If `unstable_instant` validation fails, the build error will identify the specific component and suggest wrapping it in `<Suspense>`.
- If CLS > 0.1, adjust skeleton dimensions to match the resolved content's height more closely.
- If view transitions cause visual glitches (e.g., double-paint, flash of unstyled content), try adjusting animation timing or moving the `<ViewTransition>` wrapper to a different level in the component tree.
- The `pnpm next experimental-analyze` output is the definitive measurement of bundle optimization success.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (Build artifacts) | Generated | Validation only, no new source files |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/globals.css` | Modify | 4A |
| `components/ui/stream-boundary.tsx` | Create | 4A |
| `app/workspace/_components/workspace-shell-frame.tsx` | Modify | 4A |
| `app/workspace/_components/stats-section.tsx` | Modify | 4B |
| `app/workspace/closer/_components/calendar-section.tsx` | Modify | 4B |
| `app/workspace/page.tsx` | Modify | 4C |
| `app/workspace/closer/page.tsx` | Modify | 4C |
| `app/workspace/pipeline/page.tsx` | Modify | 4C |
| `app/workspace/team/page.tsx` | Modify | 4C |
| `app/workspace/settings/page.tsx` | Modify | 4C |
| `app/workspace/profile/page.tsx` | Modify | 4C |
| `next.config.ts` | Modify | 4C |
| `app/workspace/_components/web-vitals-reporter.tsx` | Create | 4D |
| `app/workspace/layout.tsx` | Modify | 4D |
