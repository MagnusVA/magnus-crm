# Phase 1 — Information Architecture & Sidebar

**Goal:** Replace the admin-facing Pipeline entry with Operations, create a safe `/workspace/operations` landing route, preserve legacy bookmarks through redirects, and move the remaining broad opportunity browsing/export behavior into the Opportunities page.

**Prerequisite:** The design spec in `plans/pipeline-operations-redesign/pipeline-operations-redesign-design.md` is accepted for Phase 1 scope. No schema deployment is required for this phase.

**Runs in PARALLEL with:** Phase 2 after subphase 1A creates the Operations route stub. Phase 3 and Phase 4 depend on the route and navigation shape from this phase.

**Skills to invoke:**
- `next-best-practices` — Next.js 16 page `searchParams` are promises, pages stay server components, and `useSearchParams()` client trees need Suspense.
- `frontend-design` — Operations is an operational workspace surface, so the UI should stay dense, scannable, and consistent with the existing workspace shell.
- `shadcn` — Reuse existing Sidebar, Command, Tabs, Table, Empty, Skeleton, and Button primitives.
- `vercel-react-best-practices` — Keep static nav definitions hoisted and avoid expanding client bundles while introducing the route shell.

**Acceptance Criteria:**
1. Admin and owner sidebar navigation shows `Operations` at `/workspace/operations` instead of `Pipeline`.
2. Closer navigation still shows `My Pipeline` at `/workspace/closer/pipeline` and is otherwise unchanged.
3. `/workspace/operations` is reachable only by `tenant_master` and `tenant_admin`; closers are redirected by `requireRole()` to `/workspace/closer`.
4. `/workspace/pipeline` redirects instead of rendering `PipelinePageClient`.
5. Legacy pipeline query params map predictably: meeting statuses route to `/workspace/operations?tab=phone-sales`, while broad opportunity filters route to `/workspace/opportunities`.
6. Command palette admin pages show `Operations`, keep `Opportunities`, and keep `Create opportunity`.
7. Opportunities filters include `slack_qualified` as a source option.
8. The disabled Opportunities CSV export button is replaced with a working export for the currently visible rows.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (Operations route stub) ─────────────┬── 1B (Sidebar + shortcuts)
                                        ├── 1C (Command palette)
                                        └── 1D (Legacy pipeline redirect)

1B + 1C complete ───────────────────────── 1E (Opportunity source filter + CSV export)

1A + 1D + 1E complete ──────────────────── 1F (Manual routing/access verification)
```

**Optimal execution:**
1. Start 1A first so navigation and redirects never point at a missing route.
2. Run 1B, 1C, and 1D in parallel because they touch separate files.
3. Run 1E after confirming the Opportunities page remains the canonical all-opportunities registry.
4. Finish with 1F route, shortcut, and redirect verification.

**Estimated time:** 1-2 days

---

## Subphases

### 1A — Operations Route Stub

**Type:** Frontend
**Parallelizable:** No — sidebar and redirect work should not point users to `/workspace/operations` until this route exists.

**What:** Create a guarded Operations route with URL-backed tab placeholders for `qualifications`, `scheduling`, and `phone-sales`.

**Why:** Phase 1 changes navigation before the real Operations queries exist. A route stub lets admins land somewhere coherent while Phase 2-4 backend work proceeds.

**Where:**
- `app/workspace/operations/page.tsx` (new)
- `app/workspace/operations/loading.tsx` (new)
- `app/workspace/operations/_components/operations-page-client.tsx` (new)
- `app/workspace/operations/_components/operations-page-skeleton.tsx` (new)

**How:**

**Step 1: Add the server page with admin auth.**

```tsx
// Path: app/workspace/operations/page.tsx
import { Suspense } from "react";
import { requireRole } from "@/lib/auth";
import { OperationsPageClient } from "./_components/operations-page-client";
import { OperationsPageSkeleton } from "./_components/operations-page-skeleton";

export const unstable_instant = false;

export default async function OperationsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<OperationsPageSkeleton />}>
      <OperationsPageClient />
    </Suspense>
  );
}
```

**Step 2: Add a route loading fallback that matches workspace skeleton conventions.**

```tsx
// Path: app/workspace/operations/loading.tsx
import { OperationsPageSkeleton } from "./_components/operations-page-skeleton";

export default function OperationsLoading() {
  return <OperationsPageSkeleton />;
}
```

**Step 3: Add a client tab shell using `useSearchParams()` inside the page Suspense boundary.**

```tsx
// Path: app/workspace/operations/_components/operations-page-client.tsx
"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { usePageTitle } from "@/hooks/use-page-title";

type OperationsTab = "qualifications" | "scheduling" | "phone-sales";

const OPERATION_TABS = new Set<OperationsTab>([
  "qualifications",
  "scheduling",
  "phone-sales",
]);

function readTab(value: string | null): OperationsTab {
  return value && OPERATION_TABS.has(value as OperationsTab)
    ? (value as OperationsTab)
    : "qualifications";
}

export function OperationsPageClient() {
  usePageTitle("Operations");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTab = readTab(searchParams.get("tab"));

  const setTab = (tab: OperationsTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-muted-foreground">
          Review qualification, scheduling, and phone-sales work queues.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setTab(value as OperationsTab)}>
        <TabsList>
          <TabsTrigger value="qualifications">Qualifications</TabsTrigger>
          <TabsTrigger value="scheduling">Scheduling</TabsTrigger>
          <TabsTrigger value="phone-sales">Phone Sales</TabsTrigger>
        </TabsList>
        <TabsContent value="qualifications" className="mt-6">
          <OperationsPlaceholder title="Qualification queue" />
        </TabsContent>
        <TabsContent value="scheduling" className="mt-6">
          <OperationsPlaceholder title="Scheduling queue" />
        </TabsContent>
        <TabsContent value="phone-sales" className="mt-6">
          <OperationsPlaceholder title="Phone sales" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OperationsPlaceholder({ title }: { title: string }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>This tab is implemented in the later Operations phases.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
```

**Step 4: Add a stable skeleton.**

```tsx
// Path: app/workspace/operations/_components/operations-page-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function OperationsPageSkeleton() {
  return (
    <div className="flex flex-col gap-6" role="status" aria-label="Loading operations">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-9 w-96 max-w-full" />
      <Skeleton className="h-[420px] w-full" />
    </div>
  );
}
```

**Key implementation notes:**
- The page itself stays a server component and calls `requireRole()` before rendering the client shell.
- The client shell uses `useSearchParams()`, so the page must keep the Suspense boundary.
- The placeholder copy is temporary and should be replaced by real tabs in Phase 3 and Phase 4.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/operations/page.tsx` | Create | Admin-gated route entry |
| `app/workspace/operations/loading.tsx` | Create | Route loading UI |
| `app/workspace/operations/_components/operations-page-client.tsx` | Create | URL-backed tab shell |
| `app/workspace/operations/_components/operations-page-skeleton.tsx` | Create | Stable skeleton |

---

### 1B — Sidebar Navigation

**Type:** Frontend
**Parallelizable:** Yes — depends only on 1A route availability.

**What:** Replace the admin Pipeline item with Operations and keep shortcut positions stable.

**Why:** Admins should stop treating Pipeline as a fourth entity list. Operations becomes the row-level work hub, while Opportunities remains the canonical registry.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)

**How:**

**Step 1: Update the admin nav item.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
import {
  AlarmClockCheckIcon,
  ActivityIcon,
  BarChart3Icon,
  ClipboardCheckIcon,
  ClockIcon,
  ContactIcon,
  DollarSignIcon,
  KanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MessageSquareTextIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TargetIcon,
  TimerIcon,
  TrendingUpIcon,
  type LucideIcon,
  UserCircleIcon,
  UsersIcon,
  UsersRoundIcon,
} from "lucide-react";

const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/operations", label: "Operations", icon: KanbanIcon },
  { href: "/workspace/reviews", label: "Reviews", icon: ClipboardCheckIcon },
  { href: "/workspace/leads", label: "Leads", icon: ContactIcon },
  { href: "/workspace/customers", label: "Customers", icon: UsersRoundIcon },
  { href: "/workspace/opportunities", label: "Opportunities", icon: TargetIcon },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];
```

**Step 2: Verify shortcut order.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
// Existing shortcut handlers can remain index-based:
useKeyboardShortcut({
  key: "2",
  modifiers: ["meta"],
  handler: () => router.push(navItems[1]?.href ?? "/workspace"),
});
```

**Key implementation notes:**
- Do not modify `closerNavItems`; `My Pipeline` remains the closer workflow.
- `pathname.startsWith(item.href)` will correctly mark `/workspace/operations?tab=...` active because `pathname` excludes the query string.
- If product wants a different icon later, choose a lucide icon already optimized through `next.config.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Admin nav item changes only |

---

### 1C — Command Palette

**Type:** Frontend
**Parallelizable:** Yes — depends only on 1A route availability.

**What:** Replace the admin command palette Pipeline page with Operations while preserving Opportunities and Create opportunity.

**Why:** Keyboard users and command palette users should see the same IA as the sidebar.

**Where:**
- `components/command-palette.tsx` (modify)

**How:**

**Step 1: Replace the admin page entry.**

```tsx
// Path: components/command-palette.tsx
const adminPages = [
  { label: "Overview", href: "/workspace", icon: LayoutDashboardIcon, shortcut: "1" },
  { label: "Operations", href: "/workspace/operations", icon: KanbanIcon, shortcut: "2" },
  { label: "Team", href: "/workspace/team", icon: UsersIcon, shortcut: "3" },
  { label: "Settings", href: "/workspace/settings", icon: SettingsIcon, shortcut: "4" },
  { label: "Opportunities", href: "/workspace/opportunities", icon: TargetIcon },
];
```

**Step 2: Keep quick actions unchanged.**

```tsx
// Path: components/command-palette.tsx
<CommandGroup heading="Quick Actions">
  {isAdmin ? (
    <CommandItem onSelect={() => navigate("/workspace/team")}>
      <UsersIcon />
      <span>Invite team member</span>
    </CommandItem>
  ) : null}
  <CommandItem onSelect={() => navigate("/workspace/opportunities/new")}>
    <PlusIcon />
    <span>Create opportunity</span>
  </CommandItem>
</CommandGroup>
```

**Key implementation notes:**
- Keep closer command palette entries unchanged.
- If shortcut ordering changes here, decide whether to also change `workspace-shell-client.tsx`; avoid inconsistent shortcuts.
- Keep `CommandItem` inside `CommandGroup` per shadcn composition rules.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `components/command-palette.tsx` | Modify | Admin page labels and hrefs |

---

### 1D — Legacy Pipeline Redirect

**Type:** Frontend
**Parallelizable:** Yes — depends on 1A route availability.

**What:** Replace `/workspace/pipeline/page.tsx` with a Next.js 16-compatible server redirect that maps legacy query params to Operations or Opportunities.

**Why:** Existing bookmarks and stale links should not break, but `/workspace/pipeline` should stop rendering a parallel admin table.

**Where:**
- `app/workspace/pipeline/page.tsx` (modify)

**How:**

**Step 1: Replace the client page render with redirect logic.**

```tsx
// Path: app/workspace/pipeline/page.tsx
import { redirect } from "next/navigation";

export const unstable_instant = false;

const PHONE_SALES_STATUSES = new Set([
  "scheduled",
  "in_progress",
  "meeting_overran",
  "completed",
  "no_show",
]);

function firstString(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LegacyPipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const status = firstString(params.status);
  const closer = firstString(params.closer);
  const period = firstString(params.period);

  if (status && PHONE_SALES_STATUSES.has(status)) {
    const next = new URLSearchParams({
      tab: "phone-sales",
      status,
    });
    if (closer) next.set("closerId", closer);
    if (period) next.set("period", period);
    redirect(`/workspace/operations?${next.toString()}`);
  }

  const next = new URLSearchParams();
  if (status) next.set("status", status);
  if (closer) next.set("closer", closer);
  if (period) next.set("period", period);

  redirect(`/workspace/opportunities${next.size ? `?${next.toString()}` : ""}`);
}
```

**Step 2: Keep admin meeting/reminder detail routes untouched.**

```tsx
// Path: app/workspace/pipeline/meetings/[meetingId]/page.tsx
// No Phase 1 change. Admin meeting details keep this route until Phase 5 decides
// whether a new canonical admin meeting detail path is needed.
```

**Key implementation notes:**
- `searchParams` must be a `Promise` and must be awaited in the page.
- `redirect()` throws, so do not wrap it in a catch block.
- Do not remove `app/workspace/pipeline/meetings/[meetingId]` or `app/workspace/pipeline/reminders/[followUpId]` in this phase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/page.tsx` | Modify | Legacy redirect map |

---

### 1E — Opportunities Source Filter and CSV Export

**Type:** Frontend
**Parallelizable:** Yes — depends on Opportunities remaining the canonical entity registry.

**What:** Add `slack_qualified` as a source filter and replace the disabled CSV export with a current-result export.

**Why:** After `/workspace/pipeline` redirects away, admins need a working place to browse Slack-qualified opportunities and export the visible registry rows.

**Where:**
- `app/workspace/opportunities/_components/opportunities-page-client.tsx` (modify)
- `app/workspace/opportunities/_components/opportunity-filters.tsx` (modify)
- `lib/export-csv.ts` (reuse)

**How:**

**Step 1: Add the source filter to client state.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-page-client.tsx
export type SourceFilter = "all" | "calendly" | "side_deal" | "slack_qualified";

const SOURCE_FILTERS = new Set<SourceFilter>([
  "all",
  "calendly",
  "side_deal",
  "slack_qualified",
]);
```

**Step 2: Add the UI option.**

```tsx
// Path: app/workspace/opportunities/_components/opportunity-filters.tsx
<ToggleGroupItem value="all">All sources</ToggleGroupItem>
<ToggleGroupItem value="calendly">Calendly</ToggleGroupItem>
<ToggleGroupItem value="side_deal">Side deals</ToggleGroupItem>
<ToggleGroupItem value="slack_qualified">Slack</ToggleGroupItem>
```

**Step 3: Wire the CSV export to visible rows.**

```tsx
// Path: app/workspace/opportunities/_components/opportunities-page-client.tsx
import { format } from "date-fns";
import { downloadCSV } from "@/lib/export-csv";

function exportOpportunityRows(opportunities: OpportunityListRow[]) {
  downloadCSV(
    `opportunities-${format(new Date(), "yyyy-MM-dd")}`,
    ["Lead", "Email", "Status", "Source", "Closer", "Latest activity", "Created"],
    opportunities.map((opportunity) => [
      opportunity.lead?.fullName ?? "Unknown lead",
      opportunity.lead?.email ?? "",
      opportunity.status,
      opportunity.source,
      opportunity.assignedCloser?.fullName ?? opportunity.assignedCloser?.email ?? "",
      opportunity.latestActivityAt ? new Date(opportunity.latestActivityAt).toISOString() : "",
      new Date(opportunity.createdAt).toISOString(),
    ]),
  );
}

<Button
  variant="outline"
  size="sm"
  disabled={opportunities.length === 0}
  onClick={() => exportOpportunityRows(opportunities)}
>
  <DownloadIcon data-icon="inline-start" />
  Export CSV
</Button>
```

**Key implementation notes:**
- `convex/opportunities/validators.ts` already accepts `slack_qualified`; this subphase only exposes it in UI.
- Exporting visible rows is acceptable for Phase 1. If product needs full-filter export across unloaded pages, create a bounded export query later.
- Use `downloadCSV()` rather than duplicating CSV escaping.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/opportunities/_components/opportunities-page-client.tsx` | Modify | Source type and export handler |
| `app/workspace/opportunities/_components/opportunity-filters.tsx` | Modify | Slack source toggle |
| `lib/export-csv.ts` | Reuse | Existing CSV helper |

---

### 1F — Route and Access Verification

**Type:** Manual
**Parallelizable:** No — verify after 1A-1E are complete.

**What:** Verify admin/closer access, legacy redirects, and TypeScript.

**Why:** Phase 1 changes high-traffic navigation and can strand users if redirects or shortcuts are wrong.

**Where:**
- Browser routes under `/workspace`
- `app/workspace/_components/workspace-shell-client.tsx` (verify)
- `components/command-palette.tsx` (verify)
- `app/workspace/pipeline/page.tsx` (verify)

**How:**

**Step 1: Run type checking.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
pnpm tsc --noEmit
```

**Step 2: Verify redirects manually.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
pnpm dev
```

Check these URLs in the browser:

| URL | Expected |
|---|---|
| `/workspace/operations` | Admin-only Operations shell |
| `/workspace/pipeline` | Redirects to `/workspace/opportunities` |
| `/workspace/pipeline?status=scheduled&period=today` | Redirects to `/workspace/operations?tab=phone-sales&status=scheduled&period=today` |
| `/workspace/pipeline?status=lost&closer=abc` | Redirects to `/workspace/opportunities?status=lost&closer=abc` |
| `/workspace/closer/pipeline` | Still renders closer pipeline |

**Key implementation notes:**
- Test with an admin and a closer account if local seed data supports both.
- Confirm command palette shortcuts match the sidebar labels.
- Confirm the Opportunities export is disabled only when no rows are visible.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/operations/*` | Verify | New route renders |
| `app/workspace/pipeline/page.tsx` | Verify | Redirect mapping |
| `app/workspace/_components/workspace-shell-client.tsx` | Verify | Admin nav active state |
| `components/command-palette.tsx` | Verify | Admin command entries |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/operations/page.tsx` | Create | 1A |
| `app/workspace/operations/loading.tsx` | Create | 1A |
| `app/workspace/operations/_components/operations-page-client.tsx` | Create | 1A |
| `app/workspace/operations/_components/operations-page-skeleton.tsx` | Create | 1A |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 1B |
| `components/command-palette.tsx` | Modify | 1C |
| `app/workspace/pipeline/page.tsx` | Modify | 1D |
| `app/workspace/opportunities/_components/opportunities-page-client.tsx` | Modify | 1E |
| `app/workspace/opportunities/_components/opportunity-filters.tsx` | Modify | 1E |
| `lib/export-csv.ts` | Reuse | 1E |
