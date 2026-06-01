# Phase 4 — Reassignment Display & Audit Trail

**Goal:** Surface reassignment metadata across the closer-facing and admin-facing UI. After this phase, reassigned closers see a "Reassigned" badge on their dashboard and full reassignment context on meeting detail pages, and admins can view a recent reassignments audit trail. The feature is fully end-to-end complete.

**Prerequisite:** Phase 3 complete (redistribution mutations write `meetingReassignments` audit records, set `meetings.reassignedFromCloserId`, and update `opportunity.assignedCloserId`).

**Runs in PARALLEL with:** Nothing — this is the final phase.

**Skills to invoke:**
- `shadcn` — Badge and Alert components for reassignment display
- `web-design-guidelines` — Accessibility for badges (role, aria-label), color contrast in both light and dark themes
- `expect` — Browser-based QA for badge rendering on dashboard, meeting detail reassignment alert, audit table on admin side

**Acceptance Criteria:**
1. The `getMeetingDetail` query returns a `reassignmentInfo` object (with `reassignedFromCloserName`, `reassignedAt`, `reason`) when `meeting.reassignedFromCloserId` is set, and `null` when it's not.
2. The closer dashboard's `FeaturedMeetingCard` shows a "Reassigned" badge with a `ShuffleIcon` when the featured meeting has `reassignedFromCloserId`.
3. The meeting detail page shows an Alert with "This meeting was reassigned to you from {originalCloserName} — {reason}" when `reassignmentInfo` is present.
4. The meeting detail page renders normally (no badge, no alert) for meetings that were never reassigned.
5. The `getRecentReassignments` query returns the 20 most recent reassignment records enriched with closer names, admin name, meeting time, and lead name.
6. The admin team page (or a dedicated section) displays a recent reassignments table with columns: Date, From, To, Reason, Lead, Reassigned By.
7. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (Meeting detail query enrichment) ──────────────────┐
                                                        ├── 4D (Meeting detail page UI)
4B (Recent reassignments query) ────────────────────────┤
                                                        │
4C (Featured meeting card badge) ───────────────────────┘── 4E (Admin audit table)
```

**Optimal execution:**
1. Start 4A, 4B, 4C all in parallel (different files).
2. Once 4A is done → start 4D (meeting detail page UI depends on query shape).
3. Once 4B is done → start 4E (admin audit table depends on query shape).
4. 4C is fully independent and can be done alongside anything.

**Estimated time:** 1 day

---

## Subphases

### 4A — Meeting Detail Query Enrichment

**Type:** Backend
**Parallelizable:** Yes — modifies `convex/closer/meetingDetail.ts`, no overlap with 4B or 4C.

**What:** Extend the `getMeetingDetail` query to include a `reassignmentInfo` field in the return object. When the meeting has `reassignedFromCloserId`, fetch the original closer's name and the latest reassignment audit record.

**Why:** The meeting detail page needs to show who the meeting was originally assigned to, when the reassignment happened, and why. Without this query enrichment, the client would need to make separate queries to `meetingReassignments` and `users`, adding latency and complexity.

**Where:**
- `convex/closer/meetingDetail.ts` (modify)

**How:**

**Step 1: Add reassignment info resolution**

Add the following block inside the `getMeetingDetail` handler, after the existing payment records loading and before the return statement:

```typescript
// Path: convex/closer/meetingDetail.ts (MODIFIED)

// NEW: Load reassignment metadata (Feature H)
let reassignmentInfo: {
  reassignedFromCloserName: string;
  reassignedAt: number;
  reason: string;
} | null = null;

if (meeting.reassignedFromCloserId) {
  const fromCloser = await ctx.db.get(
    meeting.reassignedFromCloserId,
  );
  const reassignment = await ctx.db
    .query("meetingReassignments")
    .withIndex("by_meetingId", (q) =>
      q.eq("meetingId", meetingId),
    )
    .order("desc")
    .first();

  reassignmentInfo = {
    reassignedFromCloserName:
      fromCloser?.fullName ?? fromCloser?.email ?? "Unknown",
    reassignedAt:
      reassignment?.reassignedAt ?? meeting._creationTime,
    reason: reassignment?.reason ?? "Reassigned",
  };
}
```

**Step 2: Include reassignmentInfo in the return object**

```typescript
// Path: convex/closer/meetingDetail.ts (MODIFIED)

// Add to the existing return object:
return {
  meeting,
  opportunity,
  lead,
  assignedCloser: assignedCloserSummary,
  meetingHistory,
  eventTypeName,
  paymentLinks,
  payments,
  // NEW: Feature H
  reassignmentInfo,
};
```

**Key implementation notes:**
- `meeting.reassignedFromCloserId` may be `undefined` for meetings that were never reassigned — the `if` guard handles this gracefully.
- The `meetingReassignments` query uses `order("desc").first()` to get the most recent reassignment for this meeting (in case of multiple reassignments).
- Fallback `reassignment?.reassignedAt ?? meeting._creationTime` handles the edge case where the audit record was somehow missing.
- The extra DB reads (1 user lookup + 1 index query) are cheap — only triggered for reassigned meetings, and always return ≤1 document each.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | Add `reassignmentInfo` to return object |

---

### 4B — Recent Reassignments Query

**Type:** Backend
**Parallelizable:** Yes — adds to `convex/unavailability/queries.ts`, no overlap with 4A or 4C.

**What:** Add a `getRecentReassignments` query to `convex/unavailability/queries.ts` that returns the 20 most recent reassignment audit records for the tenant, enriched with closer names, admin name, meeting time, and lead name.

**Why:** Admins need an audit trail view to review all reassignments across the team. This query provides the data for a simple table on the admin side without requiring the admin to navigate to individual meetings.

**Where:**
- `convex/unavailability/queries.ts` (modify)

**How:**

**Step 1: Add the getRecentReassignments query**

```typescript
// Path: convex/unavailability/queries.ts (addition)

/**
 * Get recent reassignments for the tenant.
 * Used by the admin to review the audit trail.
 */
export const getRecentReassignments = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { limit }) => {
    console.log("[Unavailability] getRecentReassignments called");

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const reassignments = await ctx.db
      .query("meetingReassignments")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(limit ?? 20);

    // Enrich with names
    return await Promise.all(
      reassignments.map(async (r) => {
        const fromCloser = await ctx.db.get(r.fromCloserId);
        const toCloser = await ctx.db.get(r.toCloserId);
        const reassignedBy = await ctx.db.get(
          r.reassignedByUserId,
        );
        const meeting = await ctx.db.get(r.meetingId);

        return {
          ...r,
          fromCloserName:
            fromCloser?.fullName ??
            fromCloser?.email ??
            "Unknown",
          toCloserName:
            toCloser?.fullName ??
            toCloser?.email ??
            "Unknown",
          reassignedByName:
            reassignedBy?.fullName ??
            reassignedBy?.email ??
            "Unknown",
          meetingScheduledAt: meeting?.scheduledAt,
          leadName: meeting?.leadName,
        };
      }),
    );
  },
});
```

**Key implementation notes:**
- The query uses `order("desc").take(limit ?? 20)` to get the most recent records first, bounded to 20 by default. This avoids unbounded results.
- Each reassignment record triggers 4 `ctx.db.get()` calls for enrichment. For 20 records, that's 80 lookups — acceptable for an admin-only query. If this becomes a performance concern, the `convex-performance-audit` skill should be invoked.
- The `meetingScheduledAt` and `leadName` fields come from the meeting document — they provide context about *which* meeting was reassigned without requiring a join on the client side.
- The query is gated to `["tenant_master", "tenant_admin"]` — closers cannot access the audit trail.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/unavailability/queries.ts` | Modify | Add `getRecentReassignments` query |

---

### 4C — Featured Meeting Card Badge

**Type:** Frontend
**Parallelizable:** Yes — modifies a single client component, no overlap with 4A or 4B.

**What:** Add a "Reassigned" badge to the `FeaturedMeetingCard` component that appears when the meeting's `reassignedFromCloserId` field is set.

**Why:** Reassigned closers need an immediate visual signal on their dashboard that a meeting was transferred to them. The badge is the primary in-app notification mechanism for v0.5 (email/push notifications are deferred to v0.6+).

**Where:**
- `app/workspace/closer/_components/featured-meeting-card.tsx` (modify)

**How:**

**Step 1: Update the props type to include reassignment data**

```typescript
// Path: app/workspace/closer/_components/featured-meeting-card.tsx (MODIFIED)

// BEFORE:
type FeaturedMeetingCardProps = {
  meeting: {
    _id: string;
    scheduledAt: number;
    durationMinutes: number;
    meetingJoinUrl?: string;
    zoomJoinUrl?: string;
  };
  lead: {
    fullName?: string;
    email: string;
  } | null;
  eventTypeName: string | null;
};

// AFTER:
type FeaturedMeetingCardProps = {
  meeting: {
    _id: string;
    scheduledAt: number;
    durationMinutes: number;
    meetingJoinUrl?: string;
    zoomJoinUrl?: string;
    reassignedFromCloserId?: string;
  };
  lead: {
    fullName?: string;
    email: string;
  } | null;
  eventTypeName: string | null;
};
```

**Step 2: Add the badge to the card header**

Inside the card header area, after the meeting time display, add:

```tsx
// Path: app/workspace/closer/_components/featured-meeting-card.tsx (MODIFIED)

// Add import:
import { ShuffleIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

// Inside the card header, after the meeting time display:
{meeting.reassignedFromCloserId && (
  <Badge variant="secondary" className="gap-1">
    <ShuffleIcon className="size-3" />
    Reassigned
  </Badge>
)}
```

**Key implementation notes:**
- The `reassignedFromCloserId` field is optional on `Doc<"meetings">` — the badge renders only when it's set.
- The parent component (`featured-meeting-section.tsx` or the dashboard page client) already passes the full meeting document — the new field is automatically available after the schema migration without changing the parent.
- `variant="secondary"` gives a subtle visual distinction without being alarming. The badge uses `ShuffleIcon` consistent with the design doc.
- The badge is purely informational — no interaction, no dismiss. Per design doc open question #3, the badge persists permanently.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/featured-meeting-card.tsx` | Modify | Add "Reassigned" badge |

---

### 4D — Meeting Detail Page Reassignment Alert

**Type:** Frontend
**Parallelizable:** No — depends on 4A (query enrichment must be deployed so `reassignmentInfo` is available in the response).

**What:** Add a reassignment context Alert to the meeting detail page that shows who the meeting was originally assigned to, when the reassignment happened, and why.

**Why:** The closer needs full context about a reassigned meeting — not just that it was reassigned, but from whom and why. This helps the closer prepare for a meeting that may have context they're not aware of (previous interactions with the original closer).

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Update the MeetingDetailData type**

Add the `reassignmentInfo` field to the type:

```typescript
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx (MODIFIED)

// BEFORE:
type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<...>;
  eventTypeName: string | null;
  paymentLinks: Array<...> | null;
  payments: Array<...>;
} | null;

// AFTER (add the reassignmentInfo field):
type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<...>;
  eventTypeName: string | null;
  paymentLinks: Array<...> | null;
  payments: Array<...>;
  // NEW: Feature H
  reassignmentInfo: {
    reassignedFromCloserName: string;
    reassignedAt: number;
    reason: string;
  } | null;
} | null;
```

**Step 2: Add the reassignment Alert in the meeting detail header**

Inside the meeting detail layout, after the main header area and before the content sections, add:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx (MODIFIED)

// Add imports:
import { ShuffleIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { format } from "date-fns";

// Inside the component, extract reassignmentInfo from data:
const { meeting, opportunity, lead, assignedCloser, meetingHistory, eventTypeName, paymentLinks, payments, reassignmentInfo } = data;

// Add this block in the JSX, after the page header and before the main content grid:
{reassignmentInfo && (
  <Alert className="mb-4">
    <ShuffleIcon className="size-4" />
    <AlertDescription>
      This meeting was reassigned to you from{" "}
      <span className="font-medium">
        {reassignmentInfo.reassignedFromCloserName}
      </span>{" "}
      on{" "}
      {format(
        new Date(reassignmentInfo.reassignedAt),
        "MMM d, h:mm a",
      )}{" "}
      — {reassignmentInfo.reason}
    </AlertDescription>
  </Alert>
)}
```

**Key implementation notes:**
- The Alert is placed before the main content grid so it's the first thing the closer sees — high visibility for context that affects their meeting preparation.
- `reassignmentInfo` is `null` for meetings that were never reassigned — the conditional render prevents any UI change for normal meetings.
- The date formatting uses `"MMM d, h:mm a"` (e.g., "Apr 10, 2:30 PM") — concise but specific enough to identify the reassignment time.
- Both `Alert` and `ShuffleIcon` are already imported in this file's import section — check for duplicates and merge if needed.
- The component already destructures `data` into individual fields — just add `reassignmentInfo` to the destructuring.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Add reassignment Alert, update MeetingDetailData type |

---

### 4E — Admin Reassignment Audit Table

**Type:** Frontend
**Parallelizable:** No — depends on 4B (the `getRecentReassignments` query must be deployed).

**What:** Add a "Recent Reassignments" section to the team page that displays a table of recent reassignment audit records.

**Why:** Admins need visibility into the reassignment history across the team — who was reassigned, from whom, to whom, and why. This completes the audit trail visibility promised by the feature.

**Where:**
- `app/workspace/team/_components/recent-reassignments.tsx` (new)
- `app/workspace/team/_components/team-page-client.tsx` (modify — add the section)

**How:**

**Step 1: Create the RecentReassignments component**

```tsx
// Path: app/workspace/team/_components/recent-reassignments.tsx

"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShuffleIcon } from "lucide-react";
import { format } from "date-fns";

export function RecentReassignments() {
  const reassignments = useQuery(
    api.unavailability.queries.getRecentReassignments,
    {},
  );

  if (reassignments === undefined) {
    return <ReassignmentsSkeleton />;
  }

  if (reassignments.length === 0) {
    return null; // Don't render the section if there are no reassignments
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShuffleIcon className="size-4" />
          Recent Reassignments
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Lead</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reassignments.map((r) => (
              <TableRow key={r._id}>
                <TableCell className="text-xs">
                  {r.meetingScheduledAt
                    ? format(
                        new Date(r.meetingScheduledAt),
                        "MMM d, h:mm a",
                      )
                    : "—"}
                </TableCell>
                <TableCell className="text-sm">
                  {r.fromCloserName}
                </TableCell>
                <TableCell className="text-sm">
                  {r.toCloserName}
                </TableCell>
                <TableCell className="text-sm">
                  {r.leadName ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {r.reason}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.reassignedByName}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ReassignmentsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-48" />
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}
```

**Step 2: Add the component to the team page**

```tsx
// Path: app/workspace/team/_components/team-page-client.tsx (MODIFIED)

// Add import at top:
import { RecentReassignments } from "./recent-reassignments";

// Add after the TeamMembersTable and before the dialog rendering section:
<RecentReassignments />
```

**Key implementation notes:**
- The component returns `null` when there are no reassignments — the section is invisible until the first reassignment happens. This avoids showing an empty table on tenants that haven't used the feature yet.
- The table uses `text-xs` for date and "by" columns to keep the information dense without clutter.
- The `reason` column shows the full reason string (e.g., "Sick - auto-distributed") in a Badge for visual distinction.
- The query passes an empty object `{}` to use the default limit of 20. The admin can't paginate in v0.5 — this is a simple audit trail view.
- The skeleton matches the table structure to prevent CLS during loading.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/recent-reassignments.tsx` | Create | Audit trail table component |
| `app/workspace/team/_components/team-page-client.tsx` | Modify | Import and render RecentReassignments |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | 4A |
| `convex/unavailability/queries.ts` | Modify | 4B |
| `app/workspace/closer/_components/featured-meeting-card.tsx` | Modify | 4C |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 4D |
| `app/workspace/team/_components/recent-reassignments.tsx` | Create | 4E |
| `app/workspace/team/_components/team-page-client.tsx` | Modify | 4E |
