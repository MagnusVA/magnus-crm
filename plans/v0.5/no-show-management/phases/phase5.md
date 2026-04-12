# Phase 5 — Reschedule Chain Display & Attribution

**Goal:** Add visual indicators on the meeting detail page when a meeting is a reschedule of a no-show. After this phase, meetings with `rescheduledFromMeetingId` show a banner linking back to the original meeting, and the Attribution card correctly displays "No-Show Reschedule" as the booking origin for both UTM-linked (B3 path) and heuristic-linked (B4 path) reschedules.

**Prerequisite:** Phase 1 complete (schema deployed with `rescheduledFromMeetingId` on the `meetings` table, `no_show` status on both meetings and opportunities).

**Runs in PARALLEL with:** Phase 2 (Mark No-Show Dialog — different files), Phase 4 (Pipeline Heuristic Detection — different files). Zero shared file conflicts.

**Skills to invoke:**
- `frontend-design` — Production-quality banner component and attribution card enhancement with proper visual hierarchy.
- `shadcn` — Correct usage of `Alert`, `AlertDescription`, `Badge`, `Button` primitives from the design system.
- `expect` — Browser QA: responsive testing (4 viewports), accessibility audit, console error check, performance metrics.

**Acceptance Criteria:**
1. `getMeetingDetail` returns a `rescheduledFromMeeting` field containing `{ _id, scheduledAt, status }` when the meeting has `rescheduledFromMeetingId` set; returns `null` otherwise.
2. The `rescheduledFromMeeting` lookup enforces tenant isolation — only returns data if the original meeting belongs to the same tenant.
3. The `RescheduleChainBanner` renders between the reassignment info alert and the grid layout when `rescheduledFromMeeting` is non-null.
4. The banner displays the original meeting's date (formatted as "MMM d, h:mm a"), status, and a "View original" link that navigates to the original meeting's detail page.
5. The `AttributionCard` shows a "No-Show Reschedule" badge when `utm_medium === "noshow_resched"` (UTM path from B3).
6. The `AttributionCard` shows a "No-Show Reschedule" badge when no UTMs are present but `meeting.rescheduledFromMeetingId` is set (heuristic path from B4).
7. The `MeetingDetailData` type in `meeting-detail-page-client.tsx` includes the `rescheduledFromMeeting` field matching the backend return shape.
8. When `rescheduledFromMeeting` is `null`, neither the banner nor the "No-Show Reschedule" booking type displays — existing behavior is unchanged.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Backend: getMeetingDetail enhancement) ──────────────────────┐
                                                                  │
5B (Frontend: RescheduleChainBanner component) ──────────────────┤
                                                                  ├── 5D (Integration: MeetingDetailPageClient wiring)
5C (Frontend: AttributionCard booking origin) ───────────────────┘
```

**Optimal execution:**
1. Start **5A** first — the backend must return `rescheduledFromMeeting` before the frontend can consume it.
2. Start **5B** and **5C** in parallel after 5A completes (they touch different files with no overlap).
3. Once 5A, 5B, and 5C are all done, start **5D** (integration — imports and wires the new data and components into the page).

**Estimated time:** 2-3 hours

---

## Subphases

### 5A — Backend: Enhance `getMeetingDetail` to Resolve Reschedule Chain

**Type:** Backend
**Parallelizable:** No — must complete first. Subphases 5B and 5D depend on the return shape established here, and the `MeetingDetailData` type update in 5D must match.

**What:** Modify `convex/closer/meetingDetail.ts` to check if the meeting has `rescheduledFromMeetingId` set. If so, load the original meeting via `ctx.db.get()` and include `rescheduledFromMeeting: { _id, scheduledAt, status }` in the return object. Add `null` when the field is not set.

**Why:** The frontend banner (5B) and page integration (5D) both need the original meeting's data to render the reschedule chain link. Without this backend enrichment, the client would need to make a separate query, breaking the single-query-per-page pattern established by `getMeetingDetail`.

**Where:**
- `convex/closer/meetingDetail.ts` (modify)

**How:**

**Step 1: Add reschedule chain resolution after the existing Feature E block**

Insert the new block between the `// === End Feature E ===` comment and the final `console.log` / `return` statement.

Before:

```typescript
// Path: convex/closer/meetingDetail.ts

    // === End Feature E ===

    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
      hasPotentialDuplicate: !!potentialDuplicate,
    });
    return {
      meeting,
      opportunity,
      lead,
      assignedCloser: assignedCloserSummary,
      meetingHistory,
      eventTypeName,
      paymentLinks,
      payments,
      reassignmentInfo,
      potentialDuplicate,
    };
```

After:

```typescript
// Path: convex/closer/meetingDetail.ts

    // === End Feature E ===

    // === Feature B: Resolve reschedule chain ===
    let rescheduledFromMeeting: {
      _id: string;
      scheduledAt: number;
      status: string;
    } | null = null;

    if (meeting.rescheduledFromMeetingId) {
      const originalMeeting = await ctx.db.get(
        meeting.rescheduledFromMeetingId,
      );
      // Tenant isolation: only expose if the original meeting belongs to the same tenant
      if (originalMeeting && originalMeeting.tenantId === tenantId) {
        rescheduledFromMeeting = {
          _id: originalMeeting._id,
          scheduledAt: originalMeeting.scheduledAt,
          status: originalMeeting.status,
        };
      }
    }
    // === End Feature B ===

    console.log("[Closer:MeetingDetail] getMeetingDetail completed", {
      meetingId,
      meetingHistoryCount: meetingHistory.length,
      paymentCount: payments.length,
      hasEventType: !!eventTypeName,
      hasPaymentLinks: !!paymentLinks,
      hasUtmParams: !!(meeting.utmParams || opportunity.utmParams),
      hasPotentialDuplicate: !!potentialDuplicate,
      hasRescheduleChain: !!rescheduledFromMeeting,
    });
    return {
      meeting,
      opportunity,
      lead,
      assignedCloser: assignedCloserSummary,
      meetingHistory,
      eventTypeName,
      paymentLinks,
      payments,
      reassignmentInfo,
      potentialDuplicate,
      rescheduledFromMeeting,
    };
```

**Key implementation notes:**
- The `ctx.db.get()` call is a single point-read by ID — no index needed, no scan. Very cheap.
- Tenant isolation check (`originalMeeting.tenantId === tenantId`) prevents cross-tenant data leakage if `rescheduledFromMeetingId` were ever set incorrectly.
- Returns `null` (not `undefined`) for explicit absence — matches the pattern used by `reassignmentInfo` and `potentialDuplicate` in the same query.
- The `_id` field is typed as `string` (not `Id<"meetings">`) because the client-side type casts from the Convex `Doc` type. The `_id` is serialized as a string across the Convex transport layer.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | Add reschedule chain resolution block + update return object + update log |

---

### 5B — Frontend: `RescheduleChainBanner` Component

**Type:** Frontend
**Parallelizable:** Yes — after 5A completes. Independent of 5C (different file). Must complete before 5D (5D imports this component).

**What:** Create `app/workspace/closer/meetings/_components/reschedule-chain-banner.tsx`. A client component that renders an `Alert` banner showing the original meeting date, status, and a "View original" link button that navigates to the original meeting's detail page.

**Why:** This is the primary visual indicator for reschedule chains (goal B5). Without it, closers have no way to see that a meeting is a reschedule or navigate back to the original no-show meeting for context.

**Where:**
- `app/workspace/closer/meetings/_components/reschedule-chain-banner.tsx` (new)

**How:**

**Step 1: Create the banner component**

```tsx
// Path: app/workspace/closer/meetings/_components/reschedule-chain-banner.tsx
"use client";

import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RefreshCwIcon, ArrowRightIcon } from "lucide-react";
import { format } from "date-fns";

type RescheduleChainBannerProps = {
  rescheduledFromMeeting: {
    _id: string;
    scheduledAt: number;
    status: string;
  };
};

export function RescheduleChainBanner({
  rescheduledFromMeeting,
}: RescheduleChainBannerProps) {
  const router = useRouter();

  return (
    <Alert className="mb-0">
      <RefreshCwIcon className="size-4" />
      <AlertDescription className="flex items-center justify-between">
        <span>
          This is a reschedule of the{" "}
          {format(
            new Date(rescheduledFromMeeting.scheduledAt),
            "MMM d, h:mm a",
          )}{" "}
          meeting ({rescheduledFromMeeting.status.replace("_", " ")})
        </span>
        <Button
          variant="link"
          size="sm"
          className="gap-1 px-0"
          onClick={() =>
            router.push(
              `/workspace/closer/meetings/${rescheduledFromMeeting._id}`,
            )
          }
        >
          View original
          <ArrowRightIcon className="size-3" />
        </Button>
      </AlertDescription>
    </Alert>
  );
}
```

**Key implementation notes:**
- The `"use client"` directive is required because the component uses `useRouter` for navigation.
- The status string is displayed with underscores replaced by spaces for readability (e.g., `"no_show"` becomes `"no show"`). This is a simple presentation transformation — the canonical status values are maintained in the data.
- `className="mb-0"` matches the pattern used by the reassignment info alert directly above it in the page layout, ensuring consistent spacing via the parent's `gap-6` flex container.
- `format(new Date(scheduledAt), "MMM d, h:mm a")` produces output like "Apr 8, 2:30 PM" — matching the date formatting convention used throughout the meeting detail page.
- `variant="link"` + `size="sm"` + `className="gap-1 px-0"` matches the link button styling used elsewhere in the codebase (e.g., the "View original" link in the Attribution card).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/reschedule-chain-banner.tsx` | Create | New banner component for reschedule chain display |

---

### 5C — Frontend: Enhance `AttributionCard` with No-Show Reschedule Booking Origin

**Type:** Frontend
**Parallelizable:** Yes — after 5A completes. Independent of 5B (different file). Must complete before 5D (5D depends on updated Attribution card behavior).

**What:** Modify `app/workspace/closer/meetings/_components/attribution-card.tsx` to add a `"noshow_reschedule"` booking type with a dedicated badge style, and update the `inferBookingType` function to detect no-show reschedules via two paths: (1) UTM-based when `utm_medium === "noshow_resched"` (B3 UTM path), and (2) field-based when `meeting.rescheduledFromMeetingId` is set with no UTMs (B4 heuristic path).

**Why:** The Attribution card is the canonical place closers look to understand how a meeting was booked. Without this enhancement, reschedules of no-shows would display as generic "Organic" or "Reschedule" bookings, hiding the no-show context that is valuable for closer preparation.

**Where:**
- `app/workspace/closer/meetings/_components/attribution-card.tsx` (modify)

**How:**

**Step 1: Add `noshow_reschedule` to `BOOKING_TYPE_CONFIG`**

Before:

```typescript
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

const BOOKING_TYPE_CONFIG = {
  organic: {
    label: "Organic",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  },
  follow_up: {
    label: "Follow-Up",
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
  },
  reschedule: {
    label: "Reschedule",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
  },
} as const;
```

After:

```typescript
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

const BOOKING_TYPE_CONFIG = {
  organic: {
    label: "Organic",
    badgeClass:
      "bg-blue-500/10 text-blue-700 border-blue-200 dark:text-blue-400 dark:border-blue-900",
  },
  follow_up: {
    label: "Follow-Up",
    badgeClass:
      "bg-violet-500/10 text-violet-700 border-violet-200 dark:text-violet-400 dark:border-violet-900",
  },
  reschedule: {
    label: "Reschedule",
    badgeClass:
      "bg-orange-500/10 text-orange-700 border-orange-200 dark:text-orange-400 dark:border-orange-900",
  },
  noshow_reschedule: {
    label: "No-Show Reschedule",
    badgeClass:
      "bg-red-500/10 text-red-700 border-red-200 dark:text-red-400 dark:border-red-900",
  },
} as const;
```

**Step 2: Update `inferBookingType` to detect no-show reschedules**

The function needs to check two paths before falling through to the existing chronological inference logic:
1. **UTM path (B3):** If the meeting's UTMs have `utm_source === "ptdom"` and `utm_medium === "noshow_resched"`, this is a confirmed no-show reschedule via the CRM-generated scheduling link.
2. **Field path (B4):** If the meeting has `rescheduledFromMeetingId` set (populated by the pipeline heuristic), this is a detected no-show reschedule regardless of UTMs.

Both paths take priority over the existing chronological inference.

Before:

```typescript
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

function inferBookingType(
  meetingId: string,
  meetingHistory: AttributionCardProps["meetingHistory"],
): { type: BookingType; originalMeetingId?: string } {
  // Sort ascending for chronological order
  const sorted = [...meetingHistory].sort(
    (a, b) => a.scheduledAt - b.scheduledAt,
  );
  const currentIdx = sorted.findIndex((m) => m._id === meetingId);

  if (currentIdx <= 0) {
    return { type: "organic" };
  }

  const prevMeeting = sorted[currentIdx - 1];
  if (
    prevMeeting.status === "canceled" ||
    prevMeeting.status === "no_show"
  ) {
    return { type: "reschedule", originalMeetingId: prevMeeting._id };
  }

  return { type: "follow_up", originalMeetingId: prevMeeting._id };
}
```

After:

```typescript
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

function inferBookingType(
  meeting: Doc<"meetings">,
  meetingHistory: AttributionCardProps["meetingHistory"],
): { type: BookingType; originalMeetingId?: string } {
  // === Feature B: No-Show Reschedule detection (takes priority) ===
  // Path 1 (B3): UTM-linked — closer generated a reschedule link with no-show UTMs
  const utm = meeting.utmParams;
  if (utm?.utm_source === "ptdom" && utm?.utm_medium === "noshow_resched") {
    // utm_content contains the original no-show meeting ID (set by B3 link generation)
    return {
      type: "noshow_reschedule",
      originalMeetingId: utm.utm_content ?? undefined,
    };
  }

  // Path 2 (B4): Field-linked — pipeline heuristic detected an organic reschedule
  if (meeting.rescheduledFromMeetingId) {
    return {
      type: "noshow_reschedule",
      originalMeetingId: meeting.rescheduledFromMeetingId,
    };
  }
  // === End Feature B ===

  // Existing chronological inference for non-no-show bookings
  const sorted = [...meetingHistory].sort(
    (a, b) => a.scheduledAt - b.scheduledAt,
  );
  const currentIdx = sorted.findIndex((m) => m._id === meeting._id);

  if (currentIdx <= 0) {
    return { type: "organic" };
  }

  const prevMeeting = sorted[currentIdx - 1];
  if (
    prevMeeting.status === "canceled" ||
    prevMeeting.status === "no_show"
  ) {
    return { type: "reschedule", originalMeetingId: prevMeeting._id };
  }

  return { type: "follow_up", originalMeetingId: prevMeeting._id };
}
```

**Step 3: Update the call site to pass the full meeting object**

The signature changed from `inferBookingType(meetingId, meetingHistory)` to `inferBookingType(meeting, meetingHistory)`. Update the call inside `AttributionCard`:

Before:

```tsx
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

  const { type: bookingType, originalMeetingId } = inferBookingType(
    meeting._id,
    meetingHistory,
  );
```

After:

```tsx
// Path: app/workspace/closer/meetings/_components/attribution-card.tsx

  const { type: bookingType, originalMeetingId } = inferBookingType(
    meeting,
    meetingHistory,
  );
```

**Key implementation notes:**
- The `noshow_reschedule` badge uses a red color theme (`bg-red-500/10 text-red-700 ...`) to visually distinguish it from the orange "Reschedule" badge. Red signals the no-show context — closers need to know this lead previously no-showed so they can adjust their approach.
- The B3 UTM path checks `utm_content` for the original meeting ID. Phase 3 sets `utm_content={noShowMeetingId}` when generating the reschedule link. This may be `undefined` for edge cases, so we use `?? undefined`.
- The B4 field path uses `meeting.rescheduledFromMeetingId` directly as the `originalMeetingId` — this is the document `_id` set by the pipeline heuristic in Phase 4.
- The function signature change from `meetingId: string` to `meeting: Doc<"meetings">` is necessary to access `utmParams` and `rescheduledFromMeetingId`. The `meeting._id` is used internally where the old `meetingId` parameter was used.
- The no-show reschedule check runs before the chronological inference, so it takes priority. A meeting can match both (e.g., it has `rescheduledFromMeetingId` AND it follows a no-show in the history), but the explicit no-show signal is more precise.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | Modify | Add `noshow_reschedule` booking type, update inference function signature and logic |

---

### 5D — Integration: Wire Banner and Updated Data into `MeetingDetailPageClient`

**Type:** Frontend
**Parallelizable:** No — depends on 5A (backend return shape), 5B (banner component), and 5C (updated attribution card). This is the final wiring step.

**What:** Modify `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` to:
1. Update the `MeetingDetailData` type to include `rescheduledFromMeeting`.
2. Import `RescheduleChainBanner`.
3. Destructure `rescheduledFromMeeting` from the detail object.
4. Render the banner between the reassignment info alert and the grid layout.

**Why:** This is the wiring step that connects the backend data (5A) and the new component (5B) into the existing page. Without it, the data flows from Convex but never reaches the UI.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Add the `RescheduleChainBanner` import**

Add below the existing component imports:

Before:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

import { BookingAnswersCard } from "../../_components/booking-answers-card";
import { DealWonCard } from "../../_components/deal-won-card";
import { AttributionCard } from "../../_components/attribution-card";
import { PotentialDuplicateBanner } from "../../_components/potential-duplicate-banner";
```

After:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

import { BookingAnswersCard } from "../../_components/booking-answers-card";
import { DealWonCard } from "../../_components/deal-won-card";
import { AttributionCard } from "../../_components/attribution-card";
import { PotentialDuplicateBanner } from "../../_components/potential-duplicate-banner";
import { RescheduleChainBanner } from "../../_components/reschedule-chain-banner";
```

**Step 2: Add `rescheduledFromMeeting` to the `MeetingDetailData` type**

Before:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
  eventTypeName: string | null;
  paymentLinks: Array<{
    provider: string;
    label: string;
    url: string;
  }> | null;
  payments: Array<
    Doc<"paymentRecords"> & {
      proofFileUrl: string | null;
      proofFileContentType: string | null;
      proofFileSize: number | null;
      closerName: string | null;
    }
  >;
  potentialDuplicate: {
    _id: string;
    fullName?: string;
    email: string;
  } | null;
  reassignmentInfo: {
    reassignedFromCloserName: string;
    reassignedAt: number;
    reason: string;
  } | null;
} | null;
```

After:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

type MeetingDetailData = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  assignedCloser: { fullName?: string; email: string } | null;
  meetingHistory: Array<
    Doc<"meetings"> & {
      opportunityStatus: Doc<"opportunities">["status"];
      isCurrentMeeting: boolean;
    }
  >;
  eventTypeName: string | null;
  paymentLinks: Array<{
    provider: string;
    label: string;
    url: string;
  }> | null;
  payments: Array<
    Doc<"paymentRecords"> & {
      proofFileUrl: string | null;
      proofFileContentType: string | null;
      proofFileSize: number | null;
      closerName: string | null;
    }
  >;
  potentialDuplicate: {
    _id: string;
    fullName?: string;
    email: string;
  } | null;
  reassignmentInfo: {
    reassignedFromCloserName: string;
    reassignedAt: number;
    reason: string;
  } | null;
  rescheduledFromMeeting: {
    _id: string;
    scheduledAt: number;
    status: string;
  } | null;
} | null;
```

**Step 3: Destructure `rescheduledFromMeeting` from the detail object**

Before:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

  const {
    meeting,
    opportunity,
    lead,
    assignedCloser,
    meetingHistory,
    eventTypeName,
    paymentLinks,
    payments,
    potentialDuplicate,
    reassignmentInfo,
  } = detail;
```

After:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

  const {
    meeting,
    opportunity,
    lead,
    assignedCloser,
    meetingHistory,
    eventTypeName,
    paymentLinks,
    payments,
    potentialDuplicate,
    reassignmentInfo,
    rescheduledFromMeeting,
  } = detail;
```

**Step 4: Add the banner to the JSX layout**

Insert between the reassignment info alert and the grid. The banner renders conditionally when `rescheduledFromMeeting` is non-null.

Before:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

      {/* Feature H: Reassignment info alert */}
      {reassignmentInfo && (
        <Alert className="mb-0">
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

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
```

After:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

      {/* Feature H: Reassignment info alert */}
      {reassignmentInfo && (
        <Alert className="mb-0">
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

      {/* Feature B: Reschedule chain banner */}
      {rescheduledFromMeeting && (
        <RescheduleChainBanner
          rescheduledFromMeeting={rescheduledFromMeeting}
        />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
```

**Key implementation notes:**
- The banner placement between the reassignment alert and the grid means both banners can show simultaneously. A meeting can be both reassigned AND a reschedule (e.g., round-robin reassigned the reschedule to a different closer). Both pieces of context are valuable.
- The `rescheduledFromMeeting` field is typed as `{ _id: string; scheduledAt: number; status: string } | null` — matching the backend return shape exactly. The `null` union is at the field level, not the outer type (the outer `MeetingDetailData` already has its own `| null` for the "not found" case).
- The `RefreshCwIcon` import in the banner component is separate from the page client's icon imports — no conflict since they are in different files.
- Both the reassignment alert and reschedule banner use `className="mb-0"` because the parent `flex flex-col gap-6` handles spacing between siblings. The `mb-0` ensures no extra bottom margin is added by the `Alert` component's default styles.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Add import, update type, destructure field, render banner |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Modify | 5A |
| `app/workspace/closer/meetings/_components/reschedule-chain-banner.tsx` | Create | 5B |
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | Modify | 5C |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 5D |
