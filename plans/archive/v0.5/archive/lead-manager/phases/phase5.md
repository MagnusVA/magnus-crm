# Phase 5 — Frontend: Lead Detail Page

**Goal:** Build the full-page lead detail route at `/workspace/leads/[leadId]` with back navigation, header with role-gated action buttons, and a 5-tab content area (Overview, Meetings, Opportunities, Activity, Custom Fields). After this phase, users can view a complete lead profile from the list page, see all associated meetings and opportunities, review merge audit history, and navigate to the merge page.

**Prerequisite:** Phase 2 complete (`getLeadDetail` query deployed and returning `{ redirectToLeadId, lead, identifiers, opportunities, meetings, followUps, mergeHistory }`). Phase 4 shared components complete (`LeadStatusBadge` available at `app/workspace/leads/_components/lead-status-badge.tsx`).

**Runs in PARALLEL with:** Nothing — Phase 6 (merge page at `/workspace/leads/[leadId]/merge`) depends on this phase for the route structure and shared components.

**Skills to invoke:**
- `frontend-design` — detail page layout quality, header composition, tab content density
- `shadcn` — Tabs, Badge, Card, Table components usage and composition
- `vercel-composition-patterns` — tabbed composition with shared data prop drilling from single query
- `expect` — browser verification: responsive layout (4 viewports), accessibility audit, performance metrics, console error check

**Acceptance Criteria:**

1. Navigating to `/workspace/leads/[leadId]` renders the lead detail page with back link, header, and tabbed content.
2. The page uses `useQuery(api.leads.queries.getLeadDetail)` for a reactive subscription — all tabs update in real time when data changes.
3. When `detail.redirectToLeadId` is non-null (merged lead), `router.replace` navigates to the active lead's page.
4. When the lead is not found (`!lead`), a "Lead not found" empty state with a "Back to Leads" link is shown.
5. The header displays: lead name (or email fallback), email, phone (if present), social handle badges, and `LeadStatusBadge`.
6. Action buttons are role-gated: "Edit" requires `lead:edit`, "Merge Lead" requires `lead:merge`, "Convert to Customer" requires `lead:convert` and is disabled with "Coming soon" tooltip.
7. "Merge Lead" is a `<Link>` to `/workspace/leads/[leadId]/merge`.
8. All 5 tabs render correctly: Overview, Meetings (with count), Opportunities (with count), Activity, Fields.
9. Meetings tab rows link to the meeting detail page via `router.push`.
10. Activity tab aggregates meetings, follow-ups, and merge history into a unified chronological timeline.
11. Custom Fields tab renders `lead.customFields` as key-value pairs when the object is populated.
12. `loading.tsx` renders `LeadDetailSkeleton` with appropriate `role="status"` and `aria-label`.
13. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Route files: page.tsx + loading.tsx + skeleton) ──────┐
                                                           │
                                                           └── 5B (Lead Detail Page Client)
                                                                │
                                                                ├── 5C (Tab: Overview)
                                                                ├── 5D (Tab: Meetings)
                                                                ├── 5E (Tab: Opportunities)
                                                                ├── 5F (Tab: Activity)
                                                                └── 5G (Tab: Custom Fields)
```

**Optimal execution:**

1. Start **5A** first — creates the route files and skeleton that the client component imports.
2. Once 5A is done, start **5B** — the main page client component with header, merge redirect, and tab shell.
3. Once 5B is done, start **5C**, **5D**, **5E**, **5F**, and **5G** all in parallel — each tab is a self-contained component in its own file with no cross-dependencies.

**Estimated time:** 3-4 hours

---

## Subphases

### 5A — Route Files: `[leadId]/page.tsx` + `loading.tsx` + Skeleton

**Type:** Frontend
**Parallelizable:** No — must complete first. 5B imports the skeleton and the page file defines the route entry point.

**What:** Create the route entry point (`page.tsx`), loading state (`loading.tsx`), and detail skeleton component. Follows the established three-layer page pattern: thin RSC wrapper around a client component.

**Why:** The route files must exist before the client component can be developed. The skeleton provides immediate visual feedback while `useQuery` resolves, preventing layout shift and meeting the Suspense/skeleton standard from the codebase architecture.

**Where:**
- `app/workspace/leads/[leadId]/page.tsx` (create)
- `app/workspace/leads/[leadId]/loading.tsx` (create)
- `app/workspace/leads/_components/skeletons/lead-detail-skeleton.tsx` (create)

**How:**

**Step 1: Create the page entry point**

```tsx
// Path: app/workspace/leads/[leadId]/page.tsx
import { LeadDetailPageClient } from "./_components/lead-detail-page-client";

export const unstable_instant = false;

export default function LeadDetailPage() {
  return <LeadDetailPageClient />;
}
```

**Step 2: Create the loading state**

```tsx
// Path: app/workspace/leads/[leadId]/loading.tsx
import { LeadDetailSkeleton } from "../_components/skeletons/lead-detail-skeleton";

export default function LeadDetailLoading() {
  return <LeadDetailSkeleton />;
}
```

**Step 3: Create the detail skeleton**

The skeleton matches the layout of the real content: back button row, header area, and tabbed content area. Follows the established skeleton pattern from `app/workspace/closer/meetings/[meetingId]/loading.tsx`.

```tsx
// Path: app/workspace/leads/_components/skeletons/lead-detail-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function LeadDetailSkeleton() {
  return (
    <div
      className="flex flex-col gap-6"
      role="status"
      aria-label="Loading lead details"
    >
      {/* Back button + status badge */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>

      {/* Lead header: name, contact info, social handles */}
      <div className="flex flex-col gap-3">
        <div>
          <Skeleton className="h-8 w-56" />
          <div className="mt-1 flex flex-col gap-1">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>

        {/* Social handle badges */}
        <div className="flex gap-1.5">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-24 rounded-full" />
          ))}
        </div>

        {/* Action buttons */}
        <div className="flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-28 rounded-md" />
          ))}
        </div>
      </div>

      {/* Tab bar */}
      <Skeleton className="h-10 w-full max-w-lg rounded-md" />

      {/* Tab content area */}
      <div className="flex flex-col gap-4">
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- `unstable_instant = false` follows the PPR-ready architecture established across all workspace pages.
- The skeleton matches the real page structure: back button row (h-9 w-20), header with name (h-8 w-56), contact lines, badge row, button row, tab bar, and content area.
- `role="status"` and `aria-label` follow the accessibility standard from `workspace-shell-skeleton.tsx` and the meeting detail loading state.
- The skeleton is placed under `_components/skeletons/` (not under `[leadId]/`) so it can be shared by both `loading.tsx` and the inline loading state in the client component.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/page.tsx` | Create | Thin RSC wrapper with `unstable_instant = false` |
| `app/workspace/leads/[leadId]/loading.tsx` | Create | Route-level loading state |
| `app/workspace/leads/_components/skeletons/lead-detail-skeleton.tsx` | Create | Shared detail skeleton |

---

### 5B — Lead Detail Page Client Component

**Type:** Frontend
**Parallelizable:** No — depends on 5A (route files exist). All tab subphases (5C-5G) depend on this.

**What:** Create the main `LeadDetailPageClient` component that loads data via `useQuery`, handles the merged-lead redirect, renders the header with role-gated action buttons, and provides the tab shell that hosts all 5 tab components.

**Why:** This is the orchestrating component for the entire detail page. It owns the single `useQuery` subscription to `getLeadDetail` and passes data down to each tab. The merged-lead redirect logic must live here (client-side `useEffect` + `router.replace`) because the query result determines whether to render or redirect. Action buttons are gated by `useRole().hasPermission()` for UI visibility (backend re-validates on every call).

**Where:**
- `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` (create)

**How:**

**Step 1: Create the client component file**

```tsx
// Path: app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRole } from "@/components/auth/role-context";
import { usePageTitle } from "@/hooks/use-page-title";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ArrowLeftIcon,
  EditIcon,
  MergeIcon,
  UserCheckIcon,
} from "lucide-react";
import Link from "next/link";
import { LeadStatusBadge } from "../../_components/lead-status-badge";
import { LeadOverviewTab } from "./tabs/lead-overview-tab";
import { LeadMeetingsTab } from "./tabs/lead-meetings-tab";
import { LeadOpportunitiesTab } from "./tabs/lead-opportunities-tab";
import { LeadActivityTab } from "./tabs/lead-activity-tab";
import { LeadCustomFieldsTab } from "./tabs/lead-custom-fields-tab";
import type { Id } from "@/convex/_generated/dataModel";

export function LeadDetailPageClient() {
  const params = useParams<{ leadId: string }>();
  const router = useRouter();
  const { hasPermission } = useRole();
  const [activeTab, setActiveTab] = useState("overview");

  const leadId = params.leadId as Id<"leads">;

  const detail = useQuery(api.leads.queries.getLeadDetail, { leadId });

  usePageTitle(
    detail?.lead?.fullName ?? detail?.lead?.email ?? "Lead Detail",
  );

  // If the lead was merged, redirect to the active lead's page
  useEffect(() => {
    if (detail?.redirectToLeadId) {
      router.replace(`/workspace/leads/${detail.redirectToLeadId}`);
    }
  }, [detail?.redirectToLeadId, router]);

  const lead = detail?.lead;

  // Loading state — query is still resolving
  if (!detail) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  // Lead not found or was redirected
  if (!lead) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-20">
        <p className="text-muted-foreground">Lead not found.</p>
        <Button variant="outline" asChild>
          <Link href="/workspace/leads">Back to Leads</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Back button + status */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/workspace/leads">
            <ArrowLeftIcon className="mr-1.5 h-4 w-4" />
            Leads
          </Link>
        </Button>
        <LeadStatusBadge status={lead.status ?? "active"} />
      </div>

      {/* Lead header */}
      <div className="flex flex-col gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {lead.fullName ?? lead.email}
          </h1>
          <div className="flex flex-col gap-0.5 text-sm text-muted-foreground">
            <span>{lead.email}</span>
            {lead.phone && <span>{lead.phone}</span>}
          </div>
        </div>

        {/* Social handles */}
        {lead.socialHandles && lead.socialHandles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {lead.socialHandles.map(
              (s: { type: string; handle: string }, i: number) => (
                <Badge key={i} variant="secondary" className="text-xs">
                  {s.type}: @{s.handle}
                </Badge>
              ),
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap gap-2">
          {hasPermission("lead:edit") && (
            <Button variant="outline" size="sm">
              <EditIcon className="mr-1.5 h-3.5 w-3.5" />
              Edit
            </Button>
          )}
          {hasPermission("lead:merge") && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/workspace/leads/${leadId}/merge`}>
                <MergeIcon className="mr-1.5 h-3.5 w-3.5" />
                Merge Lead
              </Link>
            </Button>
          )}
          {hasPermission("lead:convert") && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" disabled>
                  <UserCheckIcon className="mr-1.5 h-3.5 w-3.5" />
                  Convert to Customer
                </Button>
              </TooltipTrigger>
              <TooltipContent>Coming soon (Feature D)</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      {/* Tabbed content */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="meetings">
            Meetings ({detail.meetings.length})
          </TabsTrigger>
          <TabsTrigger value="opportunities">
            Opps ({detail.opportunities.length})
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
          <TabsTrigger value="fields">Fields</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <LeadOverviewTab
            lead={lead}
            identifiers={detail.identifiers}
            opportunities={detail.opportunities}
            meetings={detail.meetings}
          />
        </TabsContent>

        <TabsContent value="meetings">
          <LeadMeetingsTab meetings={detail.meetings} />
        </TabsContent>

        <TabsContent value="opportunities">
          <LeadOpportunitiesTab opportunities={detail.opportunities} />
        </TabsContent>

        <TabsContent value="activity">
          <LeadActivityTab
            meetings={detail.meetings}
            followUps={detail.followUps}
            mergeHistory={detail.mergeHistory}
          />
        </TabsContent>

        <TabsContent value="fields">
          <LeadCustomFieldsTab lead={lead} meetings={detail.meetings} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

**Key implementation notes:**
- **Single query, all tabs:** `useQuery(api.leads.queries.getLeadDetail)` provides a single reactive subscription. All tabs receive data via props from the same query result. This avoids per-tab query overhead and ensures all tabs show consistent data.
- **Merged lead redirect:** The `useEffect` with `router.replace` handles the case where a merged lead's URL is visited directly (e.g., from a bookmarked link). The replace (not push) ensures the merged URL is removed from browser history.
- **Back link (not `router.back()`):** The back button is a `<Link href="/workspace/leads">`, not `router.back()`. Since this page opens in a new tab, `router.back()` would navigate to `about:blank`. A deterministic link is more reliable.
- **Action button gating:** `hasPermission()` from `useRole()` controls UI visibility only. The backend mutations (`updateLead`, `mergeLead`) re-validate roles independently. The "Convert to Customer" button uses a `<Tooltip>` wrapper around the disabled button to show "Coming soon" — `title` attribute on disabled buttons is inconsistent across browsers, so the Tooltip component is the accessible approach.
- **Social handle type annotation:** The `map` callback includes explicit typing `(s: { type: string; handle: string }, i: number)` because `lead.socialHandles` is typed as an optional array from the Convex schema, and the individual element type may not be directly inferred without the full `Doc<"leads">` type narrowing.
- **Tab counts:** Meeting and opportunity counts are shown directly in the tab triggers (`Meetings (3)`, `Opps (2)`) — these update reactively as the query subscription fires.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Create | Main page client with header, redirect logic, and tab shell |

---

### 5C — Tab: Overview

**Type:** Frontend
**Parallelizable:** Yes — independent of 5D, 5E, 5F, 5G. Depends only on 5B (tab shell renders this component).

**What:** Create the Overview tab component showing a summary card with first seen date, total meetings count, opportunity count, and identifiers list with type badges and confidence indicators.

**Why:** The Overview tab is the default landing tab. It gives a quick snapshot of the lead's profile: when they first appeared, how many interactions they've had, and all known identifiers. The identifiers list with type and confidence is the primary surface for understanding how the identity resolution pipeline linked this lead's data.

**Where:**
- `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` (create)

**How:**

**Step 1: Create the overview tab component**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import {
  CalendarIcon,
  BriefcaseIcon,
  UsersIcon,
  FingerprintIcon,
} from "lucide-react";

type LeadOverviewTabProps = {
  lead: {
    _id: string;
    fullName?: string;
    email: string;
    phone?: string;
    firstSeenAt: number;
    customFields?: Record<string, unknown>;
  };
  identifiers: Array<{
    _id: string;
    type: string;
    value: string;
    confidence?: number;
    source?: string;
  }>;
  opportunities: Array<{ _id: string }>;
  meetings: Array<{ _id: string }>;
};

export function LeadOverviewTab({
  lead,
  identifiers,
  opportunities,
  meetings,
}: LeadOverviewTabProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* Summary stats */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Lead Summary</CardTitle>
          <CardDescription>
            Overview of this lead&apos;s activity and identifiers
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="flex items-start gap-2">
              <CalendarIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">First Seen</p>
                <p className="text-sm text-muted-foreground">
                  {format(new Date(lead.firstSeenAt), "MMM d, yyyy")}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <UsersIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Meetings</p>
                <p className="text-sm text-muted-foreground">
                  {meetings.length}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <BriefcaseIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Opportunities</p>
                <p className="text-sm text-muted-foreground">
                  {opportunities.length}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <FingerprintIcon className="mt-0.5 h-4 w-4 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">Identifiers</p>
                <p className="text-sm text-muted-foreground">
                  {identifiers.length}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Identifiers list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Known Identifiers</CardTitle>
          <CardDescription>
            All identifiers linked to this lead by the identity resolution
            pipeline
          </CardDescription>
        </CardHeader>
        <CardContent>
          {identifiers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No identifiers found.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {identifiers.map((id) => (
                <div
                  key={id._id}
                  className="flex items-center justify-between rounded-md border px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs capitalize">
                      {id.type}
                    </Badge>
                    <span className="text-sm font-medium">{id.value}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {id.source && (
                      <span className="text-xs text-muted-foreground">
                        via {id.source}
                      </span>
                    )}
                    {id.confidence !== undefined && (
                      <Badge
                        variant="secondary"
                        className="text-xs tabular-nums"
                      >
                        {Math.round(id.confidence * 100)}%
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
```

**Key implementation notes:**
- **Summary stats grid:** Uses a responsive 2-column (mobile) / 4-column (sm+) grid for the four stats. Each stat has an icon from `lucide-react` for visual clarity.
- **Identifiers list:** Each identifier row shows: type badge (email, phone, social_handle, etc.), the value, the source (pipeline, merge, manual), and confidence percentage when available. The confidence badge uses `tabular-nums` for consistent digit width.
- **Empty state:** A simple text message when no identifiers exist. This handles the edge case of pre-Feature E leads that were never backfilled.
- **Date formatting:** Uses `date-fns` `format()` for `firstSeenAt` — consistent with the rest of the codebase.
- **Type props:** Props are typed as pick interfaces (not full `Doc<"leads">`) to decouple the tab from the exact Convex document shape. The parent component passes the relevant fields.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` | Create | Summary stats card + identifiers list card |

---

### 5D — Tab: Meetings

**Type:** Frontend
**Parallelizable:** Yes — independent of 5C, 5E, 5F, 5G. Depends only on 5B.

**What:** Create the Meetings tab showing a chronological list of all meetings associated with this lead. Each row displays date, closer name, event type, status badge, and outcome tag. Rows are clickable and navigate to the meeting detail page.

**Why:** The Meetings tab lets users see the full interaction history with this lead. Clicking a row navigates to the existing meeting detail page for that specific meeting, allowing drill-down without losing context (the lead detail page remains in the current tab if the meeting link opens inline, or the user can navigate back).

**Where:**
- `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` (create)

**How:**

**Step 1: Create the meetings tab component**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx
"use client";

import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";

type Meeting = {
  _id: string;
  scheduledAt: number;
  status: string;
  opportunityStatus: string;
  closerName: string | null;
  meetingOutcome?: string;
};

type LeadMeetingsTabProps = {
  meetings: Meeting[];
};

const OUTCOME_LABELS: Record<string, string> = {
  interested: "Interested",
  needs_more_info: "Needs Info",
  price_objection: "Price Objection",
  not_qualified: "Not Qualified",
  ready_to_buy: "Ready to Buy",
};

export function LeadMeetingsTab({ meetings }: LeadMeetingsTabProps) {
  const router = useRouter();

  if (meetings.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No meetings found for this lead.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Meeting History</CardTitle>
        <CardDescription>
          All meetings with this lead, most recent first
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Closer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Outcome</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {meetings.map((mtg) => {
              const statusCfg =
                opportunityStatusConfig[
                  mtg.opportunityStatus as OpportunityStatus
                ];

              return (
                <TableRow
                  key={mtg._id}
                  className="cursor-pointer"
                  onClick={() =>
                    router.push(`/workspace/closer/meetings/${mtg._id}`)
                  }
                >
                  <TableCell className="font-medium">
                    {format(new Date(mtg.scheduledAt), "MMM d, yyyy h:mm a")}
                  </TableCell>
                  <TableCell>
                    {mtg.closerName ?? (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {statusCfg ? (
                      <Badge
                        variant="secondary"
                        className={cn("text-xs", statusCfg.badgeClass)}
                      >
                        {statusCfg.label}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        {mtg.opportunityStatus}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {mtg.meetingOutcome ? (
                      <Badge variant="outline" className="text-xs">
                        {OUTCOME_LABELS[mtg.meetingOutcome] ??
                          mtg.meetingOutcome}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">--</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- **Row click navigation:** `router.push(`/workspace/closer/meetings/${mtg._id}`)` navigates to the existing meeting detail page. This is an in-tab navigation — the user can use the browser back button to return to the lead detail.
- **Status badge:** Uses `opportunityStatusConfig` from `lib/status-config.ts` with the `opportunityStatus` field (from the enriched query). Falls back to a plain outline badge if the status is unrecognized.
- **Outcome tag:** Maps `meetingOutcome` to human-readable labels. Shows `--` when no outcome has been set.
- **Chronological order:** Meetings come from the query already sorted by `scheduledAt` descending. No client-side sorting needed.
- **Empty state:** A centered message inside a Card when no meetings exist.
- **`cursor-pointer`:** Applied to `TableRow` to indicate clickability. Matches the interaction pattern from the pipeline table.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` | Create | Clickable meeting table with status badges and outcome tags |

---

### 5E — Tab: Opportunities

**Type:** Frontend
**Parallelizable:** Yes — independent of 5C, 5D, 5F, 5G. Depends only on 5B.

**What:** Create the Opportunities tab showing a table of all opportunities for this lead with status badge, closer name, event type, and created date.

**Why:** The Opportunities tab provides the sales pipeline view scoped to a single lead. Admins and closers can see at a glance which opportunities are active, which have converted, and who is responsible.

**Where:**
- `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx` (create)

**How:**

**Step 1: Create the opportunities tab component**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { format } from "date-fns";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import { cn } from "@/lib/utils";

type Opportunity = {
  _id: string;
  status: string;
  closerName: string | null;
  eventTypeName: string | null;
  _creationTime: number;
};

type LeadOpportunitiesTabProps = {
  opportunities: Opportunity[];
};

export function LeadOpportunitiesTab({
  opportunities,
}: LeadOpportunitiesTabProps) {
  if (opportunities.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No opportunities found for this lead.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Opportunities</CardTitle>
        <CardDescription>
          All sales opportunities associated with this lead
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Closer</TableHead>
              <TableHead>Event Type</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {opportunities.map((opp) => {
              const statusCfg =
                opportunityStatusConfig[opp.status as OpportunityStatus];

              return (
                <TableRow key={opp._id}>
                  <TableCell>
                    {statusCfg ? (
                      <Badge
                        variant="secondary"
                        className={cn("text-xs", statusCfg.badgeClass)}
                      >
                        {statusCfg.label}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        {opp.status}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {opp.closerName ?? (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {opp.eventTypeName ?? (
                      <span className="text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format(new Date(opp._creationTime), "MMM d, yyyy")}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- **Status badge:** Same pattern as the Meetings tab — uses `opportunityStatusConfig` from `lib/status-config.ts`. Falls back to a plain outline badge for unrecognized statuses.
- **Created date:** Uses `_creationTime` (Convex system field, always present) formatted as `MMM d, yyyy`. This is more reliable than a `createdAt` field because `_creationTime` is set automatically by Convex.
- **No row click:** Unlike the Meetings tab, opportunity rows are not clickable. There is no dedicated opportunity detail page — the opportunity context is viewed through the pipeline or meeting detail. If a future phase adds opportunity detail, row clicks can be added.
- **Empty state:** Consistent with the Meetings tab pattern.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx` | Create | Opportunity table with status badges, closer, event type |

---

### 5F — Tab: Activity

**Type:** Frontend
**Parallelizable:** Yes — independent of 5C, 5D, 5E, 5G. Depends only on 5B.

**What:** Create the Activity tab showing a unified timeline that aggregates meetings, follow-ups, and merge history entries into a single chronological feed. Each entry has an icon, timestamp, and description. Merge history entries show who merged what — the primary admin audit surface.

**Why:** The Activity tab is the "audit trail" view. Admins review merge history here to understand lead data provenance. All users benefit from seeing the full timeline of interactions (meetings scheduled, follow-ups created/completed, merges executed) in one place, without switching between tabs.

**Where:**
- `app/workspace/leads/[leadId]/_components/tabs/lead-activity-tab.tsx` (create)

**How:**

**Step 1: Create the activity tab component**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-activity-tab.tsx
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { format } from "date-fns";
import {
  CalendarIcon,
  ClockIcon,
  MergeIcon,
  CheckCircleIcon,
  XCircleIcon,
  AlertTriangleIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Meeting = {
  _id: string;
  scheduledAt: number;
  status: string;
  closerName: string | null;
};

type FollowUp = {
  _id: string;
  createdAt: number;
  status?: string;
  scheduledAt?: number;
  note?: string;
};

type MergeHistoryEntry = {
  _id: string;
  sourceLeadId: string;
  targetLeadId: string;
  mergedByUserId: string;
  identifiersMoved: number;
  opportunitiesMoved: number;
  createdAt: number;
};

type TimelineEntry = {
  id: string;
  timestamp: number;
  type: "meeting" | "follow_up" | "merge";
  icon: React.ReactNode;
  iconColorClass: string;
  title: string;
  description: string;
};

type LeadActivityTabProps = {
  meetings: Meeting[];
  followUps: FollowUp[];
  mergeHistory: MergeHistoryEntry[];
};

function getMeetingIcon(status: string): {
  icon: React.ReactNode;
  colorClass: string;
} {
  switch (status) {
    case "completed":
      return {
        icon: <CheckCircleIcon className="h-4 w-4" />,
        colorClass: "text-green-600 dark:text-green-400",
      };
    case "canceled":
      return {
        icon: <XCircleIcon className="h-4 w-4" />,
        colorClass: "text-red-600 dark:text-red-400",
      };
    case "no_show":
      return {
        icon: <AlertTriangleIcon className="h-4 w-4" />,
        colorClass: "text-orange-600 dark:text-orange-400",
      };
    default:
      return {
        icon: <CalendarIcon className="h-4 w-4" />,
        colorClass: "text-blue-600 dark:text-blue-400",
      };
  }
}

function buildTimeline(
  meetings: Meeting[],
  followUps: FollowUp[],
  mergeHistory: MergeHistoryEntry[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // Meeting entries
  for (const mtg of meetings) {
    const { icon, colorClass } = getMeetingIcon(mtg.status);
    const closerText = mtg.closerName ? ` with ${mtg.closerName}` : "";

    entries.push({
      id: `meeting-${mtg._id}`,
      timestamp: mtg.scheduledAt,
      type: "meeting",
      icon,
      iconColorClass: colorClass,
      title: `Meeting ${mtg.status === "scheduled" ? "scheduled" : mtg.status}`,
      description: `Meeting${closerText} on ${format(new Date(mtg.scheduledAt), "MMM d, yyyy 'at' h:mm a")}`,
    });
  }

  // Follow-up entries
  for (const fu of followUps) {
    const isCompleted = fu.status === "completed";
    entries.push({
      id: `followup-${fu._id}`,
      timestamp: fu.createdAt,
      type: "follow_up",
      icon: <ClockIcon className="h-4 w-4" />,
      iconColorClass: isCompleted
        ? "text-green-600 dark:text-green-400"
        : "text-muted-foreground",
      title: isCompleted ? "Follow-up completed" : "Follow-up created",
      description: fu.note
        ? fu.note.length > 100
          ? `${fu.note.slice(0, 100)}...`
          : fu.note
        : fu.scheduledAt
          ? `Scheduled for ${format(new Date(fu.scheduledAt), "MMM d, yyyy")}`
          : "Follow-up reminder created",
    });
  }

  // Merge history entries
  for (const merge of mergeHistory) {
    entries.push({
      id: `merge-${merge._id}`,
      timestamp: merge.createdAt,
      type: "merge",
      icon: <MergeIcon className="h-4 w-4" />,
      iconColorClass: "text-purple-600 dark:text-purple-400",
      title: "Lead merge executed",
      description: `${merge.opportunitiesMoved} opportunit${merge.opportunitiesMoved === 1 ? "y" : "ies"} and ${merge.identifiersMoved} identifier${merge.identifiersMoved === 1 ? "" : "s"} moved`,
    });
  }

  // Sort by timestamp descending (most recent first)
  entries.sort((a, b) => b.timestamp - a.timestamp);

  return entries;
}

export function LeadActivityTab({
  meetings,
  followUps,
  mergeHistory,
}: LeadActivityTabProps) {
  const timeline = buildTimeline(meetings, followUps, mergeHistory);

  if (timeline.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No activity recorded for this lead.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Activity Timeline</CardTitle>
        <CardDescription>
          Chronological history of meetings, follow-ups, and merge events
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="relative flex flex-col gap-0">
          {timeline.map((entry, idx) => (
            <div key={entry.id} className="relative flex gap-3 pb-6 last:pb-0">
              {/* Vertical connector line */}
              {idx < timeline.length - 1 && (
                <div className="absolute left-[11px] top-6 h-full w-px bg-border" />
              )}

              {/* Icon */}
              <div
                className={cn(
                  "relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-background ring-2 ring-border",
                  entry.iconColorClass,
                )}
              >
                {entry.icon}
              </div>

              {/* Content */}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{entry.title}</p>
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {format(new Date(entry.timestamp), "MMM d, yyyy")}
                  </time>
                </div>
                <p className="text-sm text-muted-foreground">
                  {entry.description}
                </p>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- **Unified timeline:** The `buildTimeline()` helper merges three data sources into a single sorted array. Each entry has a consistent shape (`TimelineEntry`) regardless of source type. Sorting is descending (most recent first).
- **Icon semantics:** Meeting icons vary by status: green checkmark (completed), red X (canceled), orange triangle (no-show), blue calendar (scheduled/in-progress). Follow-ups use a clock icon. Merges use a purple merge icon. The purple color for merges makes them visually distinct as administrative events.
- **Vertical timeline connector:** A `bg-border` vertical line connects timeline entries. The line starts below each icon and extends to the next entry. The last entry has no connector (`last:pb-0` and conditional rendering).
- **Icon ring:** Each icon sits in a `bg-background ring-2 ring-border` circle, creating a clean node on the timeline that works in both light and dark modes.
- **Merge description:** Shows the count of opportunities and identifiers moved. This is the primary audit information admins need — "what was affected by this merge". The plural handling (`opportunit${count === 1 ? "y" : "ies"}`) keeps descriptions grammatically correct.
- **Follow-up note truncation:** Long follow-up notes are truncated at 100 characters with ellipsis to prevent timeline entries from becoming excessively tall.
- **No user name resolution for merge:** The `mergedByUserId` is included in the data but not resolved to a name in this phase. The `getLeadDetail` query returns the raw merge history. If user names are needed, a follow-up enrichment can be added to the query (similar to how `closerName` is enriched for meetings). This keeps the phase scope contained.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/tabs/lead-activity-tab.tsx` | Create | Unified timeline with meetings, follow-ups, and merge history |

---

### 5G — Tab: Custom Fields

**Type:** Frontend
**Parallelizable:** Yes — independent of 5C, 5D, 5E, 5F. Depends only on 5B.

**What:** Create the Custom Fields tab that displays `lead.customFields` as key-value pairs. If the custom fields object is populated, render each key-value in a styled definition list.

**Why:** Custom fields contain Calendly form answers that were collected across all bookings and merged into the lead document by the pipeline (Feature F). Users need to see this data to understand the lead's profile beyond the standard fields (name, email, phone).

**Where:**
- `app/workspace/leads/[leadId]/_components/tabs/lead-custom-fields-tab.tsx` (create)

**How:**

**Step 1: Create the custom fields tab component**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-custom-fields-tab.tsx
"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type LeadCustomFieldsTabProps = {
  lead: {
    customFields?: Record<string, unknown>;
  };
  meetings: Array<{
    _id: string;
    customFields?: Record<string, unknown>;
  }>;
};

/**
 * Format a custom field key from snake_case or camelCase to a readable label.
 * Example: "company_name" -> "Company Name", "companyName" -> "Company Name"
 */
function formatFieldKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format a custom field value for display.
 * Handles strings, numbers, booleans, arrays, and nested objects.
 */
function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value || "--";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function LeadCustomFieldsTab({
  lead,
  meetings,
}: LeadCustomFieldsTabProps) {
  const customFields = lead.customFields;
  const hasFields =
    customFields && typeof customFields === "object" &&
    Object.keys(customFields).length > 0;

  if (!hasFields) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">
            No custom fields have been collected for this lead.
          </p>
        </CardContent>
      </Card>
    );
  }

  const entries = Object.entries(customFields);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Custom Fields</CardTitle>
        <CardDescription>
          Form data collected from Calendly bookings
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {entries.map(([key, value]) => (
            <div key={key} className="rounded-md border px-3 py-2">
              <dt className="text-xs font-medium text-muted-foreground">
                {formatFieldKey(key)}
              </dt>
              <dd className="mt-0.5 text-sm">{formatFieldValue(value)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- **Key formatting:** `formatFieldKey()` converts `snake_case` and `camelCase` to "Title Case" for readability. Calendly custom field keys come from the event type configuration and may use either convention.
- **Value formatting:** `formatFieldValue()` handles all possible JSON value types. Booleans render as "Yes"/"No", arrays as comma-separated strings, and objects as JSON (fallback). The `--` placeholder is used for null/undefined/empty values.
- **Definition list:** Uses semantic `<dl>` / `<dt>` / `<dd>` HTML for the key-value pairs. This is the correct HTML element for name-value groups and is accessible by default.
- **Responsive grid:** 1 column on mobile, 2 columns on `sm+`. Each field pair is in a bordered card-like container for visual separation.
- **`meetings` prop:** Passed but not used in the initial implementation. Reserved for a future enhancement where custom fields are grouped by the meeting that provided them (showing which booking collected which data). The prop is included now to avoid a breaking prop change later.
- **Empty state:** Shows when `customFields` is undefined, null, or an empty object.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/tabs/lead-custom-fields-tab.tsx` | Create | Key-value definition list with field formatting |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/leads/[leadId]/page.tsx` | Create | 5A |
| `app/workspace/leads/[leadId]/loading.tsx` | Create | 5A |
| `app/workspace/leads/_components/skeletons/lead-detail-skeleton.tsx` | Create | 5A |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Create | 5B |
| `app/workspace/leads/[leadId]/_components/tabs/lead-overview-tab.tsx` | Create | 5C |
| `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` | Create | 5D |
| `app/workspace/leads/[leadId]/_components/tabs/lead-opportunities-tab.tsx` | Create | 5E |
| `app/workspace/leads/[leadId]/_components/tabs/lead-activity-tab.tsx` | Create | 5F |
| `app/workspace/leads/[leadId]/_components/tabs/lead-custom-fields-tab.tsx` | Create | 5G |

---

## Notes for Implementer

- **All files are new creations.** This phase does not modify any existing files. No merge conflicts are possible.
- **No new Convex functions.** This phase is purely frontend. The `getLeadDetail` query from Phase 2 provides all data. No backend changes are needed.
- **No new permissions.** The `lead:edit`, `lead:merge`, and `lead:convert` permissions referenced in the action buttons must already exist in `convex/lib/permissions.ts` from Phase 1. If they do not exist yet, Phase 1 must be completed first.
- **`LeadStatusBadge` dependency.** The header imports `LeadStatusBadge` from `../../_components/lead-status-badge`. This component must exist from Phase 4. If Phase 4 is not yet complete, create a stub that renders a `<Badge>` with the status text.
- **`useRole().hasPermission()` is UI-only.** The "Edit", "Merge Lead", and "Convert to Customer" buttons are shown/hidden based on client-side role context. The backend mutations (`updateLead`, `mergeLead`) independently validate roles via `requireTenantUser`. Never rely on the frontend gating for security.
- **"Edit" button has no handler yet.** The Edit button in 5B is rendered but has no `onClick` handler — the edit dialog/sheet is not in scope for Phase 5. It can be wired in a follow-up. The button is rendered now so users see the action is available.
- **"Convert to Customer" is disabled.** The button is always `disabled` with a `<Tooltip>` showing "Coming soon (Feature D)". It is gated behind `lead:convert` so closers never see it.
- **Tab data flow:** All 5 tabs receive data as props from the single `useQuery` result in `LeadDetailPageClient`. No tab makes its own query. This ensures: (a) one reactive subscription, (b) consistent data across tabs, (c) no waterfall on tab switch.
- **Responsive testing:** After implementation, use `expect` to verify the page at 4 viewports minimum (mobile 375px, tablet 768px, desktop 1024px, wide 1440px). The summary stats grid (5C) and custom fields grid (5G) are the most responsive-sensitive areas.
- **Accessibility:** Run the `expect` accessibility audit after all subphases. Key areas: (a) skeleton has `role="status"` + `aria-label`, (b) tab navigation is keyboard-accessible (shadcn Tabs handle this via Radix), (c) timeline entries have semantic structure, (d) definition list in Custom Fields uses `<dl>`/`<dt>`/`<dd>`.
- **Dark mode:** Test both themes. The activity timeline icon colors use explicit `dark:` variants. The Card borders and backgrounds inherit from the shadcn theme variables.
- **Read Convex AI guidelines** (`convex/_generated/ai/guidelines.md`) is not required for this phase (no Convex changes), but understanding the `getLeadDetail` return type helps when typing the tab component props.
