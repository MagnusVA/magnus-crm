# Phase 3: Admin Meeting Detail Page

> Build the admin/owner meeting detail view, reusing display components from the closer meeting detail.

## Dependencies

- Phase 2 (View button linking)
- Existing query `api.closer.meetingDetail.getMeetingDetail` already supports admin access

---

## New files to create

```
app/workspace/pipeline/meetings/[meetingId]/
├── page.tsx
├── loading.tsx
└── _components/
    └── admin-meeting-detail-client.tsx
```

---

## Step 1: Create the loading skeleton

**File**: `app/workspace/pipeline/meetings/[meetingId]/loading.tsx`

Reuse the same skeleton layout as the closer detail page:

```tsx
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminMeetingDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-3">
          <Skeleton className="h-56 rounded-xl" />
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-52 rounded-xl" />
        </div>
      </div>
      <div className="flex gap-3 border-t pt-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-32 rounded-md" />
        ))}
      </div>
    </div>
  );
}
```

---

## Step 2: Create the page RSC

**File**: `app/workspace/pipeline/meetings/[meetingId]/page.tsx`

```tsx
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { preloadQuery } from "convex/nextjs";
import { requireRole, verifySession } from "@/lib/auth";
import { AdminMeetingDetailClient } from "./_components/admin-meeting-detail-client";

export const unstable_instant = false;

export default async function AdminMeetingDetailPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const [session, { meetingId }] = await Promise.all([
    requireRole(["tenant_master", "tenant_admin"]),
    params,
  ]);

  const preloaded = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: meetingId as Id<"meetings"> },
    { token: session.session.accessToken },
  );

  return <AdminMeetingDetailClient preloadedDetail={preloaded} />;
}
```

Note: `requireRole` returns the ready access state which includes the session. Check the exact return type in `lib/auth.ts` and adjust the token extraction accordingly.

---

## Step 3: Create the admin meeting detail client

**File**: `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx`

This is the core component. It mirrors the closer's `MeetingDetailPageClient` but with admin-specific differences.

### Imports — reuse from closer components

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Preloaded } from "convex/react";
import { usePreloadedQuery } from "convex/react";
import type { Doc } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { usePageTitle } from "@/hooks/use-page-title";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import {
  ArrowLeftIcon,
  AlertCircleIcon,
  PencilIcon,
  ShuffleIcon,
  UserIcon,
} from "lucide-react";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  opportunityStatusConfig,
  type OpportunityStatus,
} from "@/lib/status-config";
import Link from "next/link";

// Reused display components from closer meeting detail
import { LeadInfoPanel } from "@/app/workspace/closer/meetings/_components/lead-info-panel";
import { MeetingInfoPanel } from "@/app/workspace/closer/meetings/_components/meeting-info-panel";
import { MeetingNotes } from "@/app/workspace/closer/meetings/_components/meeting-notes";
import { PaymentLinksPanel } from "@/app/workspace/closer/meetings/_components/payment-links-panel";
import { BookingAnswersCard } from "@/app/workspace/closer/meetings/_components/booking-answers-card";
import { DealWonCard } from "@/app/workspace/closer/meetings/_components/deal-won-card";
import { AttributionCard } from "@/app/workspace/closer/meetings/_components/attribution-card";
import { PotentialDuplicateBanner } from "@/app/workspace/closer/meetings/_components/potential-duplicate-banner";
import { RescheduleChainBanner } from "@/app/workspace/closer/meetings/_components/reschedule-chain-banner";
import {
  RescheduleLinkDisplay,
  RescheduleLinkSentBanner,
} from "@/app/workspace/closer/meetings/_components/reschedule-link-display";
```

### Component structure

```tsx
export function AdminMeetingDetailClient({
  preloadedDetail,
}: {
  preloadedDetail: Preloaded<typeof api.closer.meetingDetail.getMeetingDetail>;
}) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);
  usePageTitle(detail?.lead?.fullName ? `${detail.lead.fullName} — Admin` : "Meeting");

  const [rescheduleLinkUrl, setRescheduleLinkUrl] = useState<string | null>(null);

  if (detail === undefined) return <AdminMeetingDetailSkeleton />;
  if (detail === null) return <MeetingNotFound />;

  const {
    meeting, opportunity, lead, assignedCloser,
    meetingHistory, eventTypeName, paymentLinks, payments,
    potentialDuplicate, reassignmentInfo, rescheduledFromMeeting,
  } = detail;

  const statusKey = opportunity.status as OpportunityStatus;
  const statusCfg = opportunityStatusConfig[statusKey];

  return (
    <div className="flex flex-col gap-6">
      {/* Header: Back + Status + Edit */}
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => router.push("/workspace/pipeline")}>
          <ArrowLeftIcon data-icon="inline-start" />
          Back to Pipeline
        </Button>
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className={cn(statusCfg?.badgeClass)}>
            {statusCfg?.label ?? opportunity.status}
          </Badge>
          {/* Edit button — links to edit page (Phase 4) */}
          <Button variant="outline" size="sm" asChild>
            <Link href={`/workspace/pipeline/meetings/${meeting._id}/edit`}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </Link>
          </Button>
        </div>
      </div>

      {/* Admin context: Who is this assigned to? */}
      {assignedCloser && (
        <Alert>
          <UserIcon className="size-4" />
          <AlertDescription>
            Assigned to{" "}
            <span className="font-medium">
              {assignedCloser.fullName ?? assignedCloser.email}
            </span>
          </AlertDescription>
        </Alert>
      )}

      {/* Feature E: Potential duplicate banner */}
      {potentialDuplicate && (
        <PotentialDuplicateBanner
          duplicateLead={potentialDuplicate}
          currentLeadName={lead.fullName}
          opportunityId={opportunity._id}
          currentLeadId={lead._id}
        />
      )}

      {/* Feature H: Reassignment info */}
      {reassignmentInfo && (
        <Alert className="mb-0">
          <ShuffleIcon className="size-4" />
          <AlertDescription>
            Reassigned from{" "}
            <span className="font-medium">{reassignmentInfo.reassignedFromCloserName}</span>{" "}
            on {format(new Date(reassignmentInfo.reassignedAt), "MMM d, h:mm a")}{" "}
            — {reassignmentInfo.reason}
          </AlertDescription>
        </Alert>
      )}

      {/* Feature B: Reschedule chain */}
      {rescheduledFromMeeting && (
        <RescheduleChainBanner rescheduledFromMeeting={rescheduledFromMeeting} />
      )}

      {/* Feature B: Reschedule link display */}
      {rescheduleLinkUrl && (
        <RescheduleLinkDisplay
          url={rescheduleLinkUrl}
          onDismiss={() => setRescheduleLinkUrl(null)}
        />
      )}
      {opportunity.status === "reschedule_link_sent" && !rescheduleLinkUrl && (
        <RescheduleLinkSentBanner opportunityId={opportunity._id} />
      )}

      {/* Content grid — same layout as closer detail */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
        <div className="md:col-span-1">
          <LeadInfoPanel lead={lead} meetingHistory={meetingHistory} />
        </div>

        <div className="flex flex-col gap-6 md:col-span-2 lg:col-span-3">
          <MeetingInfoPanel
            meeting={meeting}
            eventTypeName={eventTypeName}
            assignedCloser={assignedCloser}
          />
          <BookingAnswersCard customFields={lead.customFields} />

          {opportunity.status === "payment_received" && payments.length > 0 && (
            <DealWonCard payments={payments} />
          )}

          <AttributionCard
            opportunity={opportunity}
            meeting={meeting}
            meetingHistory={meetingHistory}
          />

          <MeetingNotes
            meetingId={meeting._id}
            initialNotes={meeting.notes ?? ""}
            meetingOutcome={meeting.meetingOutcome}
          />

          {paymentLinks && paymentLinks.length > 0 && (
            <PaymentLinksPanel paymentLinks={paymentLinks} />
          )}
        </div>
      </div>

      {/* Admin Action Bar — Phase 6 */}
      {/* <AdminActionBar ... /> */}
      {/* For Phase 3, render a placeholder or basic actions */}
    </div>
  );
}
```

### Key differences from closer detail

1. **Back button** → goes to `/workspace/pipeline` instead of `/workspace/closer`
2. **Edit button** → links to the edit page (Phase 4)
3. **Assigned closer info** → prominent alert showing who the meeting belongs to
4. **No "Start Meeting" flow** → admins don't start meetings
5. **No OutcomeActionBar** → replaced by AdminActionBar (Phase 6)
6. **Page title** → includes "Admin" suffix to differentiate

---

## Step 4: Verify

- [ ] Navigating from pipeline "View" button loads the admin meeting detail
- [ ] All display panels render correctly (lead info, meeting info, booking answers, etc.)
- [ ] Meeting notes are viewable and editable (auto-save works for admins)
- [ ] Meeting outcome dropdown works (already admin-compatible)
- [ ] Deal Won card shows for `payment_received` opportunities
- [ ] Attribution card shows UTM data
- [ ] Banners (duplicate, reassignment, reschedule chain) render when applicable
- [ ] Back button returns to pipeline
- [ ] Edit button navigates to edit page (stub for now)
- [ ] Loading skeleton shows during data fetch
- [ ] Not-found state shows for invalid meeting IDs
- [ ] Non-admin users get redirected (requireRole gate)

---

## Notes

- The `RescheduleChainBanner` component links to `/workspace/closer/meetings/[id]`. For the admin view, this should link to `/workspace/pipeline/meetings/[id]` instead. Options:
  1. Make the banner accept a `basePath` prop
  2. Detect the current route context
  3. Accept for now (links to closer view, which admin can also access) and refactor later
  
  **Recommendation**: Option 1 — add an optional `linkPrefix` prop to `RescheduleChainBanner`. Default to `/workspace/closer/meetings` for backward compatibility.

- The `MeetingNotes` component calls `updateMeetingNotes` which already supports admin access. No changes needed.
