# In-App Tabs for Closers: Cost Analysis

## The Idea

Closers navigate between dashboard (`/workspace/closer`) and meeting details (`/workspace/closer/meetings/[meetingId]`) as full page transitions. Instead, give them browser-like in-app tabs:

- **Pinned tab:** Dashboard — always open, always first
- **Dynamic tabs:** Meeting details — opened on demand, closeable
- Multiple meetings open simultaneously; switching preserves scroll, unsaved notes, form state

---

## What We're Working With

Before estimating cost, here's what the current architecture looks like and why it matters.

### Current page structure (closer)

```
/workspace/closer              → CloserDashboardPageClient  (128 lines, 3 useQuery subscriptions)
/workspace/closer/pipeline     → CloserPipelinePageClient   (164 lines, 2 useQuery subscriptions)
/workspace/closer/meetings/[id] → MeetingDetailPageClient   (252 lines, 1 usePreloadedQuery)
```

Each page is a separate Next.js route. Navigation = full route transition. Previous page unmounts completely.

### The data loading split that matters

| Page | How data loads | Implication for tabs |
|------|---------------|---------------------|
| Dashboard | `useQuery()` × 3 client-side (profile, pipeline, next meeting) | Easy — just keep mounted, subscriptions stay alive |
| Pipeline | `useQuery()` × 2 client-side + `useSearchParams` for filters | Easy — same as dashboard |
| Meeting detail | **`preloadQuery()` in RSC** → `usePreloadedQuery()` in client | **Hard** — server preloads in `page.tsx` before component renders. Tabs are client-only; can't invoke RSC preloading on tab open |

The meeting detail page is the expensive one. Here's why:

```tsx
// app/workspace/closer/meetings/[meetingId]/page.tsx (current)
export default async function MeetingDetailPage({ params }) {
  const { session } = await requireRole(["closer"]);        // server auth
  const preloadedDetail = await preloadQuery(                // server preload
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId },
    { token: session.accessToken },
  );
  return <MeetingDetailPageClient preloadedDetail={preloadedDetail} />;
}
```

`MeetingDetailPageClient` expects a `Preloaded<...>` prop — a serialized server-side query result. In a tab system, you can't call `preloadQuery` from the client. You'd need a **parallel loading path** that uses `useQuery` directly.

### Where the tab bar would live

```
<WorkspaceShellFrame>
  <Sidebar> ... </Sidebar>
  <SidebarInset>
    <header> breadcrumbs, toolbar </header>
    <div id="main-content">       ← content area (currently renders {children})
      ┌─────────────────────────┐
      │ TAB BAR GOES HERE       │  ← new
      ├─────────────────────────┤
      │ active tab content      │  ← replaces current {children}
      └─────────────────────────┘
    </div>
  </SidebarInset>
</WorkspaceShellFrame>
```

The tab system sits **inside** the closer layout, not at the workspace level. Admin pages don't get tabs.

---

## Three Possible Approaches

### Approach A: "Parallel Mount" (recommended)

Render all open tabs simultaneously. Hide inactive tabs with CSS (`hidden`/`display:none`). Active tab visible.

```tsx
{tabs.map(tab => (
  <div key={tab.id} className={tab.id === activeId ? "block" : "hidden"}>
    {tab.type === 'dashboard' && <CloserDashboardPageClient />}
    {tab.type === 'meeting' && <MeetingTabContent meetingId={tab.meetingId} />}
  </div>
))}
```

**Why this works:**
- React trees stay mounted → scroll position, local state, form inputs all preserved
- Convex `useQuery` subscriptions stay alive → data is always fresh when switching back
- No serialization/deserialization of state needed
- Simplest mental model: "tabs work like browser tabs"

**Why it costs:**
- Each open meeting tab = 1 active Convex subscription to `getMeetingDetail`
- DOM stays in memory for all tabs — cap at ~5 open tabs
- Need a new `MeetingTabContent` wrapper that uses `useQuery` instead of `usePreloadedQuery`

### Approach B: "Unmount + Cache State"

Only render the active tab. When switching away, serialize key state (scroll position, form values) to a Map. Restore on switch back.

**Why not:** Meeting detail has rich nested state (notes textarea, outcome select, payment dialogs). Serializing and restoring all of it reliably is fragile and more code than just keeping the tree mounted. The Convex subscription also needs to re-establish on every switch, causing a flash of loading state.

### Approach C: "Route-Synced Tabs"

Keep Next.js routing for each page. Tab bar is just a visual indicator of "recently visited" routes. Clicking a tab calls `router.push()`.

**Why not:** React unmounts the previous page on navigation. You lose all state — scroll, form inputs, notes in progress. The tab metaphor is broken if switching tabs causes a loading skeleton flash. This is basically browser history with extra chrome.

**Verdict:** Approach A is the only one that delivers the UX the user expects from "tabs."

---

## Implementation Breakdown (Approach A)

### 1. Tab State Manager — `CloserTabProvider`

**~120–150 lines, 1 new file**

A React context that tracks open tabs and active tab:

```tsx
type Tab =
  | { id: 'dashboard'; type: 'dashboard' }
  | { id: `meeting_${string}`; type: 'meeting'; meetingId: Id<"meetings">; label: string };

interface TabState {
  tabs: Tab[];
  activeTabId: string;
  openMeetingTab: (meetingId: Id<"meetings">, label: string) => void;
  closeTab: (tabId: string) => void;
  switchTab: (tabId: string) => void;
}
```

Rules:
- Dashboard tab is always present, can't be closed
- Opening an already-open meeting tab just switches to it
- Closing the active tab falls back to dashboard
- Max 5 open tabs (configurable) — oldest meeting tab auto-closes when exceeded

**Where it goes:** Wraps the closer layout's children. NOT at workspace level — admin routes don't use tabs.

```
app/workspace/closer/layout.tsx (new file, or modify page.tsx)
  └── <CloserTabProvider>
        └── <CloserTabShell />    ← tab bar + content renderer
```

### 2. `MeetingTabContent` — Client-side meeting loader

**~40–60 lines, 1 new file**

The current `MeetingDetailPageClient` expects a `preloadedDetail` prop from the server. Tabs can't use that. Need a thin wrapper:

```tsx
function MeetingTabContent({ meetingId }: { meetingId: Id<"meetings"> }) {
  const detail = useQuery(api.closer.meetingDetail.getMeetingDetail, { meetingId });
  
  if (detail === undefined) return <MeetingDetailSkeleton />;
  if (detail === null) return <MeetingNotFound />;
  
  return (
    <MeetingDetailContent
      detail={detail}
      allowOutOfWindowMeetingStart={false}  // can't call isNonProductionDeployment() client-side
    />
  );
}
```

**Key change:** Extract the rendering logic from `MeetingDetailPageClient` into a shared `MeetingDetailContent` component that both the RSC route AND the tab wrapper can use. The RSC route passes preloaded data; the tab wrapper passes `useQuery` data. Same component underneath.

**Files touched:**
- `meeting-detail-page-client.tsx` — extract `MeetingDetailContent` (rendering) from `MeetingDetailPageClient` (data loading)
- New `meeting-tab-content.tsx` — thin client-side loader
- `page.tsx` stays unchanged — direct URL access still gets SSR preloading

### 3. Tab Bar Component

**~100–130 lines, 1 new file**

Visual tab strip above content area:

```
┌──────────┬───────────────────┬──────────────────┬─────┐
│ Dashboard│ John Smith ✕      │ Jane Doe ✕       │     │
└──────────┴───────────────────┴──────────────────┴─────┘
```

- Dashboard tab: icon + label, no close button
- Meeting tabs: lead name (from `detail.lead.fullName`), close button
- Active tab gets accent underline (reuse existing `variant="line"` from `components/ui/tabs.tsx`)
- Overflow: horizontal scroll when >4 tabs, or collapse into a dropdown

**Should NOT use the Radix `Tabs` primitive** — Radix tabs expect static content panels as children. Our tabs dynamically mount/unmount meeting components. Build with plain `<button>` elements + the `cn()` utility for styling. Can reuse the visual styles from `tabsListVariants` though.

### 4. Tab Rendering Shell

**~80–120 lines, 1 new file**

The component that reads tab state and renders content:

```tsx
function CloserTabShell() {
  const { tabs, activeTabId } = useTabManager();
  
  return (
    <div className="flex flex-col h-full">
      <TabBar />
      <div className="flex-1 overflow-hidden relative">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={cn(
              "absolute inset-0 overflow-auto",
              tab.id === activeTabId ? "z-10" : "z-0 hidden"
            )}
          >
            {tab.type === 'dashboard' && <CloserDashboardPageClient />}
            {tab.type === 'meeting' && (
              <MeetingTabContent meetingId={tab.meetingId} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

Using `absolute` positioning + `hidden` keeps each tab's scroll position independent — no scroll restoration logic needed. Each tab's `div` is its own scroll container.

### 5. Wiring Up Meeting Open Actions

**~30–50 lines changed across 4–5 existing files**

Every place that currently does `router.push(`/workspace/closer/meetings/${id}`)` or `<Link href="/workspace/closer/meetings/...">` needs to instead call `openMeetingTab(id, leadName)`.

Files to modify:
| File | Current behavior | Change |
|------|-----------------|--------|
| `featured-meeting-card.tsx` | `<Link>` to meeting route | `onClick` → `openMeetingTab()` |
| `pipeline-strip.tsx` | Links to pipeline with status filter | No change (goes to pipeline, not meeting detail) |
| `reminders-section.tsx` | Links to meeting detail | `onClick` → `openMeetingTab()` |
| `calendar-section.tsx` | Links to meeting detail (if clickable) | `onClick` → `openMeetingTab()` |
| `closer-pipeline-page-client.tsx` | Table row links to meeting detail | `onClick` → `openMeetingTab()` |

Each change is ~5–8 lines: import the hook, replace `Link`/`router.push` with `openMeetingTab(meetingId, leadName)`.

### 6. Back Button in Meeting Detail

**~5 lines changed**

Currently `MeetingDetailPageClient` has a "Back" button that calls `router.back()`. In tab mode, this should close the tab instead:

```tsx
// Before
<Button onClick={() => router.back()}>Back</Button>

// After
<Button onClick={onBack}>Back</Button>
// Where onBack is either router.back() (direct route) or closeTab(tabId) (tab mode)
```

Pass `onBack` as a prop from the wrapper.

---

## What We DON'T Need to Build

| Often assumed | Why we skip it |
|---------------|---------------|
| Scroll restoration logic | Parallel-mounted tabs in separate scroll containers handle this automatically |
| State serialization | Tabs stay mounted — no serialize/deserialize |
| Tab persistence (localStorage) | Session-only tabs. Closing the app = clean slate. Closers work in focused sessions — they don't need yesterday's tabs |
| URL sync (`?tab=meeting_xyz`) | Adds ~150 lines for marginal value. Direct URL to a meeting still works via the normal route. Tabs are ephemeral UI state |
| Mobile tab bar | Closers use desktop. If mobile is needed later, swap tab bar for a sheet/drawer — ~100 lines, separate concern |

---

## Final Tally

| Component | New Lines | Complexity | Files |
|-----------|-----------|------------|-------|
| `CloserTabProvider` (context + hook) | 120–150 | Low | 1 new |
| `MeetingTabContent` (client loader) | 40–60 | Low | 1 new |
| `MeetingDetailContent` extraction | ~0 net (refactor) | Low | 1 modified |
| `CloserTabBar` (UI) | 100–130 | Low | 1 new |
| `CloserTabShell` (renderer) | 80–120 | Medium | 1 new |
| Closer layout/page wiring | 20–30 | Low | 1–2 modified |
| Open-tab click handlers | 30–50 | Low | 4–5 modified |
| Back button prop threading | 5–10 | Low | 1–2 modified |
| **Total** | **~400–550** | **Low–Medium** | **4 new, 7–9 modified** |

---

## Where It Gets Tricky

**Convex subscription overhead.** Each open meeting tab is an active `useQuery` subscription to `getMeetingDetail`, which itself joins across `meetings`, `opportunities`, `leads`, `paymentRecords`, and `calendlyEventTypes`. With 5 tabs open, that's 5 parallel subscriptions + the 3 dashboard subscriptions = 8 live subscriptions. Monitor with `npx convex insights`. Probably fine — Convex handles this well — but worth watching.

**`isNonProductionDeployment()` flag.** The meeting detail page gets `allowOutOfWindowMeetingStart` from the server (`page.tsx` calls a server-only function). In tab mode, this flag isn't available client-side. Options:
- Hardcode `false` in tab content (safe default)
- Expose it via an env var (`NEXT_PUBLIC_*`) — simple, ~2 lines
- Fetch it once via a lightweight Convex query — overkill

**Breadcrumbs.** `WorkspaceBreadcrumbs` derives from `pathname`. In tab mode, the URL doesn't change when switching tabs. Either:
- Accept breadcrumbs always showing "Dashboard" (fine, tabs are self-explanatory)
- Feed active tab context into breadcrumbs (~15 lines)

**Keyboard shortcuts.** Existing `Cmd+1/2` navigate sidebar items. Could conflict with tab switching. Recommend `Cmd+Shift+[/]` for tab switching (matches browser/VS Code convention) and `Cmd+W` for close tab.

**Pipeline page.** Currently a separate route (`/workspace/closer/pipeline`). Does it become a tab too? Probably not in v1 — it's a list view, not a contextual detail. Keep it as a route. But the tab system should handle the closer landing on pipeline and then opening a meeting from the pipeline table row.

---

## Recommended Sequence

**Phase 1 — Core (one sitting, ~3–4 hours):**
Build `CloserTabProvider`, `CloserTabShell`, `CloserTabBar`, `MeetingTabContent`. Extract `MeetingDetailContent`. Wire up the closer layout. At the end of this phase, you can manually call `openMeetingTab()` from a console and see it work.

**Phase 2 — Integration (~1–2 hours):**
Wire up click handlers in `FeaturedMeetingCard`, `RemindersSection`, `CalendarSection`, and the pipeline table. Replace `router.push`/`<Link>` with `openMeetingTab()`. Fix the back button.

**Phase 3 — Polish (as needed):**
Keyboard shortcuts (`Cmd+Shift+[/]`, `Cmd+W`), breadcrumb sync, tab overflow dropdown, max-tabs enforcement with toast notification.

---

## Bottom Line

**~500 lines of code, 4 new files, 7–9 files modified.** The architecture cooperates — dashboard and meeting detail are already clean client components with independent data subscriptions. The main work is the tab manager context + one data-loading adapter for meeting detail. No routing rewrites, no state serialization, no provider surgery. Tight scope, clear boundaries.
