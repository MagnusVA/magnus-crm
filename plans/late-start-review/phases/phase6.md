# Phase 6 — Frontend: Admin Review Pipeline

**Goal:** Build the complete admin-facing review pipeline: list page with filtering and sorting, review detail page with full context cards and resolution actions, resolution dialog with outcome-specific forms, sidebar navigation with reactive pending count badge, and admin pipeline integration. After this phase, admins can discover, review, and resolve all flagged meetings from a dedicated section in the workspace.

**Prerequisite:** Phase 1 complete (schema + status renames). Phase 4 complete (admin backend queries and mutations). Phase 3 is NOT required — admin queries work independently of closer responses.

**Runs in PARALLEL with:** Phase 5 (Closer Experience). Phase 5 modifies closer-facing routes (`app/workspace/closer/`). Phase 6 creates admin-facing routes (`app/workspace/reviews/`) and modifies `app/workspace/_components/workspace-shell-client.tsx`. The only shared file is the workspace shell — Phase 5 does NOT modify it.

**Skills to invoke:**
- `frontend-design` — Review list page, review detail page, resolution bar, all with high design quality.
- `shadcn` — Using Table, Badge, Card, Dialog, Select, Textarea, Button, Alert, Tabs components.
- `vercel-react-best-practices` — SSR preloading, component optimization, lazy loading dialogs.
- `next-best-practices` — RSC wrappers, page conventions, `unstable_instant`, streaming.
- `vercel-composition-patterns` — Review detail page component hierarchy.
- `web-design-guidelines` — Accessibility audit on review pages.
- `expect` — Browser verification of the review pipeline.

**Acceptance Criteria:**
1. Navigating to `/workspace/reviews` (as admin) renders the review list page with a table of pending reviews, including: lead name, closer name, closer response, stated outcome, detection date, opportunity status, and action column.
2. The review list page has "Pending" and "Resolved" tabs that filter the table reactively.
3. The "Pending" tab shows a count badge (e.g., "Pending (3)").
4. Clicking a review row navigates to `/workspace/reviews/[reviewId]` — the review detail page.
5. The review detail page shows: system detection card (detection time, meeting time, closer info), closer response card (response type, stated outcome, duration, note, response time — or "No response"), meeting info section, lead info section, and resolution bar.
6. The resolution bar has 5 buttons: Log Payment, Schedule Follow-Up, Mark No-Show, Mark as Lost, Acknowledge. Each opens a confirmation dialog with action-specific fields.
7. "Log Payment" resolution dialog has: amount, currency, provider, optional reference code, optional proof upload. Submitting calls `resolveReview` with `paymentData`.
8. "Schedule Follow-Up" dialog has: admin note (required). Submitting calls `resolveReview`.
9. "Mark No-Show" dialog has: reason select, optional note. Submitting calls `resolveReview`.
10. "Mark as Lost" dialog has: optional reason, optional note. Submitting calls `resolveReview`.
11. "Acknowledge" dialog has: optional note. Submitting calls `resolveReview`.
12. After resolution, the review disappears from the pending list (reactive via Convex real-time).
13. The admin sidebar shows "Reviews" nav item with a `ClipboardCheckIcon` icon and a reactive pending count badge (hidden when 0, shows "99+" when ≥ 100).
14. The admin pipeline page shows `meeting_overran` as a status group with count linking to `/workspace/reviews`.
15. `/workspace/reviews` is gated by `requireRole(["tenant_master", "tenant_admin"])`.
16. `/workspace/reviews/[reviewId]` uses `preloadQuery` for SSR optimization.
17. Loading skeletons exist for both list and detail pages (`loading.tsx`).
18. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
6A (Review list page — route + client component) ────────────────────┐
                                                                      │
6B (Review detail page — route + client component) ──────────────────┤
                                                                      │
6C (Resolution bar + resolution dialogs) ────────────────────────────┤
                                                                      │
6B + 6C complete ─── 6D (Sidebar navigation + badge) ────────────────┤
                                                                      │
6E (Admin pipeline integration) ──────────────────────────────────────┘
```

**Optimal execution:**
1. Start 6A, 6B, 6C, and 6E all in parallel.
   - 6A creates `app/workspace/reviews/` route + list page.
   - 6B creates `app/workspace/reviews/[reviewId]/` route + detail page.
   - 6C creates the resolution bar and dialog components used by 6B.
   - 6E modifies admin pipeline components (independent).
2. Once 6B and 6C complete → 6B integrates the resolution bar from 6C.
3. 6D (sidebar navigation) can start after 6A establishes the route. It modifies `workspace-shell-client.tsx`.

**Estimated time:** 3–4 days

---

## Subphases

### 6A — Review List Page

**Type:** Frontend
**Parallelizable:** Yes — creates new route directory. No overlap with other subphases.

**What:** Create the `/workspace/reviews` route with RSC wrapper, loading skeleton, and client component containing a filterable, sortable table of reviews.

**Why:** This is the admin's entry point to the review pipeline. They need to see all pending reviews at a glance, filter between pending and resolved, and navigate to individual reviews for resolution.

**Where:**
- `app/workspace/reviews/page.tsx` (new)
- `app/workspace/reviews/loading.tsx` (new)
- `app/workspace/reviews/_components/reviews-page-client.tsx` (new)
- `app/workspace/reviews/_components/reviews-table.tsx` (new)

**How:**

**Step 1: Create the RSC page wrapper**

```tsx
// Path: app/workspace/reviews/page.tsx
import { requireRole } from "@/lib/auth";
import { ReviewsPageClient } from "./_components/reviews-page-client";

export const unstable_instant = false;

export default async function ReviewsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);
  return <ReviewsPageClient />;
}
```

**Step 2: Create the loading skeleton**

```tsx
// Path: app/workspace/reviews/loading.tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function ReviewsLoading() {
  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header skeleton */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
      </div>

      {/* Tabs skeleton */}
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
      </div>

      {/* Table skeleton */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    </div>
  );
}
```

**Step 3: Create the client component**

```tsx
// Path: app/workspace/reviews/_components/reviews-page-client.tsx
"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { ReviewsTable } from "./reviews-table";

type StatusFilter = "pending" | "resolved";

export function ReviewsPageClient() {
  usePageTitle("Meeting Reviews");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");

  const reviews = useQuery(api.reviews.queries.listPendingReviews, {
    statusFilter,
  });
  const pendingCount = useQuery(
    api.reviews.queries.getPendingReviewCount,
  );

  const isLoading = reviews === undefined;

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Meeting Reviews
        </h1>
        <p className="text-muted-foreground">
          Meetings flagged by the system where the closer did not attend.
          Review each case and resolve with the appropriate outcome.
        </p>
      </div>

      {/* Tabs */}
      <Tabs
        value={statusFilter}
        onValueChange={(v) => setStatusFilter(v as StatusFilter)}
      >
        <TabsList>
          <TabsTrigger value="pending" className="gap-1.5">
            Pending
            {pendingCount && pendingCount.count > 0 && (
              <Badge
                variant="secondary"
                className="ml-1 min-w-[1.25rem] px-1 text-xs"
              >
                {pendingCount.count >= 100
                  ? "99+"
                  : pendingCount.count}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Table */}
      <ReviewsTable reviews={reviews ?? []} isLoading={isLoading} />
    </div>
  );
}
```

**Step 4: Create the reviews table component**

```tsx
// Path: app/workspace/reviews/_components/reviews-table.tsx
"use client";

import { useRouter } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EyeIcon, CheckCircle2Icon } from "lucide-react";
import { format } from "date-fns";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";

type EnrichedReview = {
  _id: string;
  closerResponse?: string | null;
  closerStatedOutcome?: string | null;
  closerRespondedAt?: number | null;
  createdAt: number;
  meetingScheduledAt?: number;
  meetingDurationMinutes?: number;
  leadName: string;
  leadEmail?: string;
  closerName: string;
  opportunityStatus?: string;
  status: string;
  resolutionAction?: string;
};

const CLOSER_RESPONSE_SHORT: Record<string, string> = {
  forgot_to_press: "Forgot to start",
  did_not_attend: "Didn't attend",
};

const STATED_OUTCOME_SHORT: Record<string, string> = {
  sale_made: "Sale made",
  follow_up_needed: "Follow-up needed",
  lead_not_interested: "Not interested",
  lead_no_show: "Lead no-show",
  other: "Other",
};

const RESOLUTION_LABELS: Record<string, string> = {
  log_payment: "Payment Logged",
  schedule_follow_up: "Follow-up Scheduled",
  mark_no_show: "Marked No-Show",
  mark_lost: "Marked Lost",
  acknowledged: "Acknowledged",
};

type ReviewsTableProps = {
  reviews: EnrichedReview[];
  isLoading: boolean;
};

export function ReviewsTable({ reviews, isLoading }: ReviewsTableProps) {
  const router = useRouter();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }

  if (reviews.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed p-12 text-center">
        <CheckCircle2Icon className="mb-3 size-10 text-muted-foreground/40" />
        <p className="text-lg font-medium">No reviews to show</p>
        <p className="text-sm text-muted-foreground">
          All clear — no flagged meetings in this category.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lead</TableHead>
            <TableHead>Closer</TableHead>
            <TableHead>Closer Said</TableHead>
            <TableHead>Stated Outcome</TableHead>
            <TableHead>Detected</TableHead>
            <TableHead>Opp Status</TableHead>
            <TableHead className="w-20">Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviews.map((review) => {
            const statusConfig = review.opportunityStatus
              ? opportunityStatusConfig[
                  review.opportunityStatus as OpportunityStatus
                ]
              : null;

            return (
              <TableRow
                key={review._id}
                className="cursor-pointer"
                onClick={() =>
                  router.push(`/workspace/reviews/${review._id}`)
                }
              >
                <TableCell>
                  <div>
                    <p className="font-medium">{review.leadName}</p>
                    {review.leadEmail && (
                      <p className="text-xs text-muted-foreground">
                        {review.leadEmail}
                      </p>
                    )}
                  </div>
                </TableCell>
                <TableCell>{review.closerName}</TableCell>
                <TableCell>
                  {review.closerResponse ? (
                    <Badge variant="outline" className="text-xs">
                      {CLOSER_RESPONSE_SHORT[review.closerResponse] ??
                        review.closerResponse}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">
                      No response
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {review.closerStatedOutcome ? (
                    <span className="text-sm">
                      {STATED_OUTCOME_SHORT[review.closerStatedOutcome] ??
                        review.closerStatedOutcome}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <span className="text-sm">
                    {format(new Date(review.createdAt), "MMM d")}
                  </span>
                </TableCell>
                <TableCell>
                  {statusConfig ? (
                    <Badge className={statusConfig.badgeClass}>
                      {statusConfig.label}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Unknown
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  {review.status === "resolved" ? (
                    <Badge variant="outline" className="text-xs text-green-700 dark:text-green-400">
                      {RESOLUTION_LABELS[review.resolutionAction ?? ""] ??
                        "Resolved"}
                    </Badge>
                  ) : (
                    <Button variant="ghost" size="sm">
                      <EyeIcon className="size-4" />
                      <span className="sr-only">View</span>
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

**Key implementation notes:**
- The table rows are clickable (cursor-pointer) and navigate to the detail page via `router.push`.
- The "Closer Said" column uses short labels to keep the table compact. Full details are on the detail page.
- The "Opp Status" column uses the shared `opportunityStatusConfig` for consistent badge styling.
- For resolved reviews, the action column shows the resolution type as a green badge instead of a "View" button.
- Empty state uses a bordered dashed container with a check icon — consistent with existing empty states in the codebase.
- Loading state renders skeletons matching the table row dimensions to prevent CLS.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/page.tsx` | Create | RSC wrapper with `requireRole` |
| `app/workspace/reviews/loading.tsx` | Create | Loading skeleton |
| `app/workspace/reviews/_components/reviews-page-client.tsx` | Create | Client component with tabs + table |
| `app/workspace/reviews/_components/reviews-table.tsx` | Create | Review table with enriched data |

---

### 6B — Review Detail Page

**Type:** Frontend
**Parallelizable:** Yes — creates new route directory. Consumes 6C (resolution bar) but can scaffold without it.

**What:** Create the `/workspace/reviews/[reviewId]` route with SSR preloading, system detection card, closer response card, meeting info, lead info, and resolution bar integration.

**Why:** The admin needs full context before making a resolution decision. The detail page consolidates: what the system detected, what the closer said, the meeting details, and the lead profile — all in one view with resolution actions.

**Where:**
- `app/workspace/reviews/[reviewId]/page.tsx` (new)
- `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` (new)
- `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` (new)

**How:**

**Step 1: Create the RSC page with preloading**

```tsx
// Path: app/workspace/reviews/[reviewId]/page.tsx
import { requireRole } from "@/lib/auth";
import { preloadQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ReviewDetailPageClient } from "./_components/review-detail-page-client";

export const unstable_instant = false;

export default async function ReviewDetailPage({
  params,
}: {
  params: Promise<{ reviewId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { reviewId } = await params;
  const typedReviewId = reviewId as Id<"meetingReviews">;

  const preloadedDetail = await preloadQuery(
    api.reviews.queries.getReviewDetail,
    { reviewId: typedReviewId },
    { token: session.accessToken },
  );

  return <ReviewDetailPageClient preloadedDetail={preloadedDetail} />;
}
```

**Step 2: Create the review detail client component**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx
"use client";

import { useRouter } from "next/navigation";
import { usePreloadedQuery, type Preloaded } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeftIcon } from "lucide-react";
import { opportunityStatusConfig, type OpportunityStatus } from "@/lib/status-config";
import { ReviewContextCard } from "./review-context-card";
import { ReviewResolutionBar } from "./review-resolution-bar";

export function ReviewDetailPageClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<typeof api.reviews.queries.getReviewDetail>;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);

  usePageTitle(detail ? `Review — ${detail.lead?.fullName ?? "Unknown"}` : "Review");

  if (!detail) {
    return (
      <div className="flex flex-col items-center justify-center p-12 text-center">
        <p className="text-lg font-medium">Review not found</p>
        <Button
          variant="link"
          onClick={() => router.push("/workspace/reviews")}
          className="mt-2"
        >
          Back to Reviews
        </Button>
      </div>
    );
  }

  const { review, meeting, opportunity, lead, closerName, closerEmail, resolverName } = detail;
  const statusConfig = opportunityStatusConfig[opportunity.status as OpportunityStatus];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/workspace/reviews")}
          aria-label="Back to reviews"
        >
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Review — {lead?.fullName ?? lead?.email ?? "Unknown Lead"}
          </h1>
        </div>
        {statusConfig && (
          <Badge className={statusConfig.badgeClass}>
            {statusConfig.label}
          </Badge>
        )}
        {review.status === "resolved" && (
          <Badge variant="outline" className="text-green-700 dark:text-green-400 border-green-300 dark:border-green-800">
            Resolved
          </Badge>
        )}
      </div>

      {/* Context cards */}
      <ReviewContextCard
        review={review}
        meeting={meeting}
        closerName={closerName}
        closerEmail={closerEmail}
        resolverName={resolverName}
      />

      {/* Meeting & Lead info grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Meeting info card */}
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 font-medium">Meeting Details</h3>
          {/* Reuse or replicate meeting info display */}
          {/* Show: scheduled time, duration, event type, join URL (read-only) */}
        </div>

        {/* Lead info card */}
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 font-medium">Lead Information</h3>
          {/* Show: name, email, phone, social handles */}
        </div>
      </div>

      {/* Resolution bar — only for pending reviews */}
      {review.status === "pending" && (
        <ReviewResolutionBar
          reviewId={review._id}
          closerResponse={review.closerResponse}
          opportunityStatus={opportunity.status}
        />
      )}
    </div>
  );
}
```

**Step 3: Create the review context card**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-context-card.tsx
"use client";

import type { Doc } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScanSearchIcon, MessageSquareIcon, ShieldCheckIcon } from "lucide-react";
import { format } from "date-fns";

const CLOSER_RESPONSE_LABELS: Record<string, string> = {
  forgot_to_press: "I forgot to press start — I actually attended",
  did_not_attend: "I didn't attend this meeting",
};

const STATED_OUTCOME_LABELS: Record<string, string> = {
  sale_made: "Sale was made — payment needs to be logged",
  follow_up_needed: "Lead wants to think about it — needs follow-up",
  lead_not_interested: "Lead is not interested — deal is lost",
  lead_no_show: "Lead didn't show up",
  other: "Other",
};

const RESOLUTION_LABELS: Record<string, string> = {
  log_payment: "Payment Logged",
  schedule_follow_up: "Follow-Up Scheduled",
  mark_no_show: "Marked as No-Show",
  mark_lost: "Marked as Lost",
  acknowledged: "Acknowledged",
};

type ReviewContextCardProps = {
  review: Doc<"meetingReviews">;
  meeting: Doc<"meetings">;
  closerName: string;
  closerEmail: string;
  resolverName: string | null;
};

export function ReviewContextCard({
  review,
  meeting,
  closerName,
  closerEmail,
  resolverName,
}: ReviewContextCardProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* System Detection Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ScanSearchIcon className="size-4" />
            System Detection
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex gap-8">
            <div>
              <span className="text-muted-foreground">Detected:</span>{" "}
              {format(new Date(review.createdAt), "MMM d, yyyy 'at' h:mm a")}
            </div>
            <div>
              <span className="text-muted-foreground">Meeting:</span>{" "}
              {format(new Date(meeting.scheduledAt), "MMM d, h:mm a")}
              {" – "}
              {format(
                new Date(meeting.scheduledAt + meeting.durationMinutes * 60_000),
                "h:mm a",
              )}
              {" "}({meeting.durationMinutes} min)
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Closer:</span>{" "}
            {closerName} ({closerEmail})
          </div>
        </CardContent>
      </Card>

      {/* Closer Response Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquareIcon className="size-4" />
            Closer Response
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {review.closerResponse ? (
            <>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Response:</span>
                <Badge variant="outline">
                  {CLOSER_RESPONSE_LABELS[review.closerResponse] ??
                    review.closerResponse}
                </Badge>
              </div>
              {review.closerRespondedAt && (
                <div>
                  <span className="text-muted-foreground">Responded:</span>{" "}
                  {format(
                    new Date(review.closerRespondedAt),
                    "MMM d, yyyy 'at' h:mm a",
                  )}
                </div>
              )}
              {review.closerStatedOutcome && (
                <div>
                  <span className="text-muted-foreground">
                    Stated Outcome:
                  </span>{" "}
                  {STATED_OUTCOME_LABELS[review.closerStatedOutcome] ??
                    review.closerStatedOutcome}
                </div>
              )}
              {review.estimatedMeetingDurationMinutes && (
                <div>
                  <span className="text-muted-foreground">
                    Estimated Duration:
                  </span>{" "}
                  ~{review.estimatedMeetingDurationMinutes} minutes
                </div>
              )}
              {review.closerNote && (
                <div className="mt-2 rounded-md bg-muted/50 p-3 italic">
                  "{review.closerNote}"
                </div>
              )}
            </>
          ) : (
            <p className="italic text-muted-foreground">
              No response from closer.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Resolution Card (only when resolved) */}
      {review.status === "resolved" && review.resolutionAction && (
        <Card className="border-green-200 dark:border-green-800/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-green-800 dark:text-green-200">
              <ShieldCheckIcon className="size-4" />
              Resolution
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Action:</span>
              <Badge
                variant="outline"
                className="text-green-700 dark:text-green-400"
              >
                {RESOLUTION_LABELS[review.resolutionAction] ??
                  review.resolutionAction}
              </Badge>
            </div>
            {review.resolvedAt && (
              <div>
                <span className="text-muted-foreground">Resolved:</span>{" "}
                {format(
                  new Date(review.resolvedAt),
                  "MMM d, yyyy 'at' h:mm a",
                )}
              </div>
            )}
            {resolverName && (
              <div>
                <span className="text-muted-foreground">By:</span>{" "}
                {resolverName}
              </div>
            )}
            {review.resolutionNote && (
              <div className="mt-2 rounded-md bg-muted/50 p-3 italic">
                "{review.resolutionNote}"
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

**Key implementation notes:**
- Uses SSR preloading (`preloadQuery` in RSC → `usePreloadedQuery` in client) for fast initial render.
- The context cards follow the codebase pattern: `Card` > `CardHeader` + `CardTitle` > `CardContent`.
- The resolution bar (6C) is only shown when `review.status === "pending"`.
- The meeting info and lead info sections should reuse or replicate the patterns from the closer meeting detail page. Since those components are role-specific (`requireTenantUser(ctx, ["closer"])`), the admin version may need its own variants or the underlying components should accept generic props.
- The detail page is reactive — when the admin resolves (or the closer provides context), the data updates in real-time via Convex subscriptions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/page.tsx` | Create | RSC wrapper with preloading |
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | Create | Detail page client component |
| `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` | Create | System detection + closer response cards |

---

### 6C — Resolution Bar & Resolution Dialogs

**Type:** Frontend
**Parallelizable:** Yes — creates new components. Can scaffold independently from 6B.

**What:** Create the `ReviewResolutionBar` component with 5 resolution action buttons, each opening a type-specific confirmation dialog with the appropriate form fields.

**Why:** Each resolution action has different requirements: Log Payment needs a full payment form, Schedule Follow-Up needs a note, Mark No-Show needs a reason, etc. The dialogs ensure the admin provides the required data before resolving, and the confirmation step prevents accidental resolutions.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` (new)
- `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` (new)

**How:**

**Step 1: Create the resolution bar**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx
"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  DollarSignIcon,
  CalendarPlusIcon,
  UserXIcon,
  XCircleIcon,
  CheckIcon,
} from "lucide-react";
import { ReviewResolutionDialog } from "./review-resolution-dialog";

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged";

type ReviewResolutionBarProps = {
  reviewId: Id<"meetingReviews">;
  closerResponse?: string | null;
  opportunityStatus: string;
};

const RESOLUTION_BUTTONS: Array<{
  action: ResolutionAction;
  label: string;
  icon: typeof DollarSignIcon;
  variant: "default" | "outline" | "destructive" | "secondary";
  description: string;
}> = [
  {
    action: "log_payment",
    label: "Log Payment",
    icon: DollarSignIcon,
    variant: "default",
    description: "Log a payment for this opportunity. Meeting will be corrected to 'completed' if closer claimed attendance.",
  },
  {
    action: "schedule_follow_up",
    label: "Schedule Follow-Up",
    icon: CalendarPlusIcon,
    variant: "outline",
    description: "Schedule a follow-up with the lead.",
  },
  {
    action: "mark_no_show",
    label: "Mark No-Show",
    icon: UserXIcon,
    variant: "outline",
    description: "Mark as lead no-show.",
  },
  {
    action: "mark_lost",
    label: "Mark as Lost",
    icon: XCircleIcon,
    variant: "destructive",
    description: "Mark the deal as lost.",
  },
  {
    action: "acknowledged",
    label: "Acknowledge",
    icon: CheckIcon,
    variant: "secondary",
    description: "Acknowledge this review without changing the opportunity status. Use when the closer has already handled the follow-up.",
  },
];

export function ReviewResolutionBar({
  reviewId,
  closerResponse,
  opportunityStatus,
}: ReviewResolutionBarProps) {
  const [activeAction, setActiveAction] = useState<ResolutionAction | null>(null);

  // If opportunity has already moved (closer acted), highlight "Acknowledge"
  const opportunityAlreadyMoved = opportunityStatus !== "meeting_overran";

  return (
    <>
      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 font-medium">Resolve This Review</h3>
        {opportunityAlreadyMoved && (
          <p className="mb-3 text-sm text-muted-foreground">
            The closer has already taken action — the opportunity is now{" "}
            <strong>{opportunityStatus.replace(/_/g, " ")}</strong>.
            You may acknowledge this review or override with a different outcome.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {RESOLUTION_BUTTONS.map(({ action, label, icon: Icon, variant }) => (
            <Button
              key={action}
              variant={variant}
              size="sm"
              onClick={() => setActiveAction(action)}
              className={
                opportunityAlreadyMoved && action === "acknowledged"
                  ? "ring-2 ring-primary ring-offset-2"
                  : ""
              }
            >
              <Icon data-icon="inline-start" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {activeAction && (
        <ReviewResolutionDialog
          open={!!activeAction}
          onOpenChange={(open) => {
            if (!open) setActiveAction(null);
          }}
          reviewId={reviewId}
          resolutionAction={activeAction}
          closerResponse={closerResponse}
        />
      )}
    </>
  );
}
```

**Step 2: Create the resolution dialog**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2Icon } from "lucide-react";
import { toast } from "sonner";

type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged";

// ── Action-specific schemas ───────────────────────────────────────────
const paymentSchema = z.object({
  amount: z.coerce.number().min(0.01, "Amount must be greater than 0"),
  currency: z.string().min(1, "Currency is required"),
  provider: z.string().min(1, "Provider is required"),
  referenceCode: z.string().optional(),
  resolutionNote: z.string().optional(),
});

const followUpSchema = z.object({
  resolutionNote: z.string().min(1, "A note about the follow-up plan is required"),
});

const noShowSchema = z.object({
  noShowReason: z.enum(["no_response", "late_cancel", "technical_issues", "other"]),
  resolutionNote: z.string().optional(),
});

const lostSchema = z.object({
  lostReason: z.string().optional(),
  resolutionNote: z.string().optional(),
});

const acknowledgedSchema = z.object({
  resolutionNote: z.string().optional(),
});

// ── Dialog config per action ──────────────────────────────────────────
const ACTION_CONFIG: Record<
  ResolutionAction,
  { title: string; description: string; confirmLabel: string }
> = {
  log_payment: {
    title: "Log Payment",
    description: "Record a payment for this opportunity. If the closer claimed they attended, the meeting will be corrected to 'completed'.",
    confirmLabel: "Log Payment & Resolve",
  },
  schedule_follow_up: {
    title: "Schedule Follow-Up",
    description: "Schedule a follow-up with the lead and resolve this review.",
    confirmLabel: "Schedule & Resolve",
  },
  mark_no_show: {
    title: "Mark as No-Show",
    description: "Mark the lead as a no-show for this meeting.",
    confirmLabel: "Mark No-Show & Resolve",
  },
  mark_lost: {
    title: "Mark as Lost",
    description: "Mark this deal as lost.",
    confirmLabel: "Mark Lost & Resolve",
  },
  acknowledged: {
    title: "Acknowledge Review",
    description: "Acknowledge this review without changing the opportunity or meeting status. Use when the closer has already handled the situation.",
    confirmLabel: "Acknowledge & Resolve",
  },
};

const NO_SHOW_REASONS = [
  { value: "no_response", label: "Lead didn't show up" },
  { value: "late_cancel", label: "Lead messaged — couldn't make it" },
  { value: "technical_issues", label: "Technical issues" },
  { value: "other", label: "Other" },
] as const;

// ── Component ─────────────────────────────────────────────────────────
type ReviewResolutionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewId: Id<"meetingReviews">;
  resolutionAction: ResolutionAction;
  closerResponse?: string | null;
};

export function ReviewResolutionDialog({
  open,
  onOpenChange,
  reviewId,
  resolutionAction,
  closerResponse,
}: ReviewResolutionDialogProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const resolveReview = useMutation(api.reviews.mutations.resolveReview);

  const config = ACTION_CONFIG[resolutionAction];

  // Select the right schema based on action
  const schema =
    resolutionAction === "log_payment"
      ? paymentSchema
      : resolutionAction === "schedule_follow_up"
        ? followUpSchema
        : resolutionAction === "mark_no_show"
          ? noShowSchema
          : resolutionAction === "mark_lost"
            ? lostSchema
            : acknowledgedSchema;

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues:
      resolutionAction === "log_payment"
        ? { amount: undefined, currency: "USD", provider: "", referenceCode: "", resolutionNote: "" }
        : resolutionAction === "mark_no_show"
          ? { noShowReason: undefined, resolutionNote: "" }
          : resolutionAction === "mark_lost"
            ? { lostReason: "", resolutionNote: "" }
            : { resolutionNote: "" },
  });

  const handleSubmit = async (data: Record<string, unknown>) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await resolveReview({
        reviewId,
        resolutionAction,
        resolutionNote: (data.resolutionNote as string) || undefined,
        ...(resolutionAction === "log_payment" && {
          paymentData: {
            amount: Math.round((data.amount as number) * 100), // Convert to minor units
            currency: data.currency as string,
            provider: data.provider as string,
            referenceCode: (data.referenceCode as string) || undefined,
          },
        }),
        ...(resolutionAction === "mark_lost" && {
          lostReason: (data.lostReason as string) || undefined,
        }),
        ...(resolutionAction === "mark_no_show" && {
          noShowReason: data.noShowReason as "no_response" | "late_cancel" | "technical_issues" | "other",
        }),
      });

      toast.success("Review resolved");
      onOpenChange(false);
      router.push("/workspace/reviews");
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Failed to resolve review",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{config.title}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {submitError && (
              <Alert variant="destructive">
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}

            {closerResponse === "forgot_to_press" &&
              resolutionAction !== "acknowledged" && (
                <Alert>
                  <AlertDescription>
                    The closer claimed they attended but forgot to press start.
                    Resolving will correct the meeting status to "completed".
                  </AlertDescription>
                </Alert>
              )}

            {/* Payment fields */}
            {resolutionAction === "log_payment" && (
              <>
                <FormField
                  control={form.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          step="0.01"
                          placeholder="0.00"
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="currency"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Currency <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="USD" disabled={isSubmitting} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="provider"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Provider <span className="text-destructive">*</span></FormLabel>
                        <FormControl>
                          <Input {...field} placeholder="Stripe, PayPal..." disabled={isSubmitting} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="referenceCode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Reference Code</FormLabel>
                      <FormControl>
                        <Input {...field} placeholder="Optional" disabled={isSubmitting} />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </>
            )}

            {/* No-show reason */}
            {resolutionAction === "mark_no_show" && (
              <FormField
                control={form.control}
                name="noShowReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason <span className="text-destructive">*</span></FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value as string}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select reason..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {NO_SHOW_REASONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Lost reason */}
            {resolutionAction === "mark_lost" && (
              <FormField
                control={form.control}
                name="lostReason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reason</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        value={field.value as string}
                        placeholder="Optional reason for marking as lost"
                        disabled={isSubmitting}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}

            {/* Admin note — all actions */}
            <FormField
              control={form.control}
              name="resolutionNote"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Admin Note
                    {resolutionAction === "schedule_follow_up" && (
                      <span className="text-destructive"> *</span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      value={field.value as string}
                      placeholder={
                        resolutionAction === "schedule_follow_up"
                          ? "What was agreed? What should the follow-up cover?"
                          : "Optional note about this resolution..."
                      }
                      rows={2}
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2Icon className="animate-spin" data-icon="inline-start" />
                    Resolving...
                  </>
                ) : (
                  config.confirmLabel
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Key implementation notes:**
- Each resolution action has its own Zod schema — the dialog dynamically selects the correct one.
- Payment `amount` is converted to minor units (`* 100`) before sending to the mutation, matching `createPaymentRecord` which expects `amountMinor`.
- The false-positive correction alert ("`closerResponse === "forgot_to_press"`") warns the admin that resolving will correct the meeting status.
- After successful resolution, the dialog closes and navigates back to the review list. The resolved review disappears from the "Pending" tab reactively.
- The dialog uses `standardSchemaResolver` per AGENTS.md form patterns.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | Create | Resolution action buttons |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | Create | Action-specific resolution dialog |

---

### 6D — Sidebar Navigation & Badge

**Type:** Frontend
**Parallelizable:** No — depends on 6A (route exists) and 4C (query exists).

**What:** Add "Reviews" to the admin sidebar navigation with a `ClipboardCheckIcon` icon and a reactive pending count badge.

**Why:** Without the nav item, admins can only reach the review pipeline by typing the URL. The badge ensures admins are aware of pending reviews at all times without navigating to the page.

**Where:**
- `app/workspace/_components/workspace-shell-client.tsx` (modify)

**How:**

**Step 1: Add the Reviews nav item to `adminNavItems`**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx

import { ClipboardCheckIcon } from "lucide-react";

// Add to adminNavItems array (after "Pipeline", before "Leads"):
const adminNavItems: NavItem[] = [
  { href: "/workspace", label: "Overview", icon: LayoutDashboardIcon, exact: true },
  { href: "/workspace/pipeline", label: "Pipeline", icon: KanbanIcon },
  { href: "/workspace/reviews", label: "Reviews", icon: ClipboardCheckIcon },  // NEW
  { href: "/workspace/leads", label: "Leads", icon: ContactIcon },
  { href: "/workspace/customers", label: "Customers", icon: UsersRoundIcon },
  { href: "/workspace/team", label: "Team", icon: UsersIcon },
  { href: "/workspace/settings", label: "Settings", icon: SettingsIcon },
];
```

**Step 2: Add the reactive badge**

The pending review count query needs to fire only for admins. Add it inside the component:

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx

// Inside the component, add the query hook:
const pendingReviewCount = useQuery(
  api.reviews.queries.getPendingReviewCount,
  isAdmin ? {} : "skip",
);

// In the nav item rendering, add badge support:
// Extend the NavItem type to include an optional badge:
type NavItem = {
  href: string;
  label: string;
  icon: React.ElementType;
  exact?: boolean;
  badge?: number;  // NEW
};
```

**Step 3: Render the badge in the sidebar menu**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx

// When rendering nav items, compute the badge for the Reviews item:
const navItemsWithBadge = navItems.map((item) => ({
  ...item,
  badge:
    item.href === "/workspace/reviews" && pendingReviewCount
      ? pendingReviewCount.count
      : undefined,
}));

// In the SidebarMenuItem rendering:
{navItemsWithBadge.map((item) => {
  const isActive = item.exact
    ? pathname === item.href
    : pathname.startsWith(item.href);
  return (
    <SidebarMenuItem key={item.href}>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={item.label}
      >
        <Link href={item.href}>
          <item.icon />
          <span>{item.label}</span>
          {item.badge != null && item.badge > 0 && (
            <span className="ml-auto inline-flex size-5 items-center justify-center rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground">
              {item.badge >= 100 ? "99+" : item.badge}
            </span>
          )}
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
})}
```

**Key implementation notes:**
- The query uses `"skip"` for non-admin roles to prevent unnecessary API calls.
- Badge styling: `bg-destructive text-destructive-foreground text-[10px] rounded-full` — matches existing notification badge patterns in the codebase.
- Badge is hidden when count is 0 (`item.badge > 0` check).
- Badge shows "99+" when count ≥ 100 (the query returns `.take(100).length`).
- The badge is inside the `<Link>` so it's clickable together with the nav item.
- `ClipboardCheckIcon` from lucide-react is the appropriate icon for review/audit actions.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Add "Reviews" nav item with badge |

---

### 6E — Admin Pipeline Integration

**Type:** Frontend
**Parallelizable:** Yes — independent of all other subphases.

**What:** Ensure the admin pipeline page correctly displays `meeting_overran` as a status group. Optionally, the `meeting_overran` count could link to the review pipeline page instead of filtering the pipeline.

**Why:** Admins viewing the pipeline need to see how many opportunities are in the `meeting_overran` state. Clicking the count should take them to the review page where they can act on these reviews.

**Where:**
- `app/workspace/_components/pipeline-section.tsx` (verify/modify)
- `app/workspace/pipeline/_components/pipeline-page-client.tsx` (verify/modify)

**How:**

**Step 1: Verify the admin pipeline displays `meeting_overran`**

The pipeline section uses `PIPELINE_DISPLAY_ORDER` from `lib/status-config.ts` (updated in Phase 1D). Verify that `meeting_overran` appears with the amber styling.

**Step 2: Optionally, make the `meeting_overran` count link to `/workspace/reviews`**

```tsx
// In the admin pipeline section, when rendering the meeting_overran status card:
// Instead of linking to /workspace/pipeline?status=meeting_overran,
// link to /workspace/reviews (the dedicated review page):

const getStatusLink = (status: string) => {
  if (status === "meeting_overran") {
    return "/workspace/reviews";
  }
  return `/workspace/pipeline?status=${status}`;
};
```

**Key implementation notes:**
- This is a UX enhancement — linking to the review page is more actionable than filtering the pipeline by status.
- The change should only apply to the admin pipeline view, not the closer pipeline strip (closers don't have access to the review page).
- If the pipeline section doesn't support custom links per status, this can be deferred to post-MVP. The status will still appear with the correct label and count.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/_components/pipeline-section.tsx` | Verify/Modify | Ensure meeting_overran displays; optionally link to /workspace/reviews |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Verify | Status filter includes meeting_overran |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/reviews/page.tsx` | Create | 6A |
| `app/workspace/reviews/loading.tsx` | Create | 6A |
| `app/workspace/reviews/_components/reviews-page-client.tsx` | Create | 6A |
| `app/workspace/reviews/_components/reviews-table.tsx` | Create | 6A |
| `app/workspace/reviews/[reviewId]/page.tsx` | Create | 6B |
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | Create | 6B |
| `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` | Create | 6B |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | Create | 6C |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | Create | 6C |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 6D |
| `app/workspace/_components/pipeline-section.tsx` | Verify/Modify | 6E |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Verify | 6E |
