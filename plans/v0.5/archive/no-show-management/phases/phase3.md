# Phase 3 -- No-Show Action Bar & Reschedule

**Goal:** After Phase 3, a meeting in `no_show` status displays an amber action bar with "Request Reschedule" and "Schedule Follow-Up" buttons. Clicking "Request Reschedule" generates a UTM-tagged scheduling link, transitions the opportunity to `reschedule_link_sent`, and displays the link for copying. When the lead books through the link, the pipeline links the new meeting to the existing opportunity and sets `rescheduledFromMeetingId`.

**Prerequisite:** Phase 1 complete (schema changes deployed -- `startedAt`, no-show tracking fields, `rescheduledFromMeetingId` on meetings, `reschedule_link_sent` status in opportunity union, status transitions registered). Phase 2 complete (`markNoShow` mutation in `convex/closer/noShowActions.ts`, `MarkNoShowDialog` component, `OutcomeActionBar` integration -- meetings can reach `no_show` status from either the closer dialog or the Calendly webhook handler).

**Runs in PARALLEL with:** Phase 4 (Heuristic Reschedule Detection) and Phase 5 (Reschedule Chain Display & Attribution) can both start after Phase 1, independently of Phase 3. Phase 3 and Phase 4 modify different sections of `convex/pipeline/inviteeCreated.ts` (Phase 3 touches the UTM deterministic linking block; Phase 4 adds a new heuristic block after identity resolution) -- coordinate if running simultaneously.

**Skills to invoke:**
- `frontend-design` -- Building the NoShowActionBar and RescheduleLinkDisplay components with proper dark/light theming
- `shadcn` -- Using Card, Alert, InputGroup, Button component composition
- `web-design-guidelines` -- Ensuring accessibility (keyboard navigation, screen reader labels, color contrast on amber/blue banners)
- `expect` -- Browser verification of the action bar rendering, copy-to-clipboard, and reactivity transitions

**Acceptance Criteria:**
1. When `opportunity.status === "no_show"`, the meeting detail page shows an amber NoShowActionBar above the grid layout, displaying the lead name, reason label, wait duration, optional note, and two action buttons.
2. Clicking "Request Reschedule" calls `createNoShowRescheduleLink`, which creates a `followUps` record with `reason: "no_show_follow_up"` and `type: "scheduling_link"`, generates a URL from `user.personalEventTypeUri` with UTMs (`utm_source=ptdom`, `utm_medium=noshow_resched`, `utm_campaign={opportunityId}`, `utm_content={meetingId}`, `utm_term={userId}`), and transitions the opportunity to `reschedule_link_sent`.
3. After the mutation succeeds, a blue `RescheduleLinkDisplay` card appears at the page level with a copy-to-clipboard input, surviving the NoShowActionBar unmount caused by Convex reactivity.
4. Clicking "Schedule Follow-Up" in the NoShowActionBar opens the existing FollowUpDialog from Feature A.
5. When `opportunity.status === "reschedule_link_sent"` and the closer navigates away and returns, a `RescheduleLinkSentBanner` is shown indicating a link was previously sent.
6. When a lead books via the reschedule link, the pipeline's UTM routing in `inviteeCreated.ts` accepts `reschedule_link_sent` status (in addition to `follow_up_scheduled`), transitions the opportunity to `scheduled`, and sets `rescheduledFromMeetingId` on the new meeting.
7. The `createNoShowRescheduleLink` mutation throws if the opportunity is not in `no_show` status, if the closer is not the assigned owner, or if the user has no `personalEventTypeUri`.
8. All new components pass WCAG color contrast requirements in both light and dark modes.
9. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (createNoShowRescheduleLink mutation) ──────────────────────────┐
                                                                   ├── 3D (MeetingDetailPageClient integration)
3B (NoShowActionBar component) ────────────────────────────────────┤
                                                                   │
3C (RescheduleLinkDisplay component) ──────────────────────────────┘

3D complete ──> 3E (Pipeline UTM routing enhancement)
```

**Optimal execution:**
1. Start 3A, 3B, and 3C all in parallel (3A is a backend mutation, 3B and 3C are independent frontend components in different files).
2. Once 3A, 3B, and 3C are done -> start 3D (integrates all three into the meeting detail page).
3. Once 3D is done -> start 3E (modifies pipeline to handle the `reschedule_link_sent` status and `noshow_resched` UTM medium -- requires 3D complete so the full flow can be tested end-to-end).

**Estimated time:** 2-3 days

---

## Subphases

### 3A -- Backend `createNoShowRescheduleLink` Mutation

**Type:** Backend
**Parallelizable:** Yes -- touches only `convex/closer/noShowActions.ts` (same file as Phase 2's `markNoShow`, but a separate exported mutation). No overlap with 3B or 3C.

**What:** Add the `createNoShowRescheduleLink` mutation to `convex/closer/noShowActions.ts`. This single-step mutation validates the closer's access, creates a followUp record, generates a UTM-tagged scheduling link, and transitions the opportunity to `reschedule_link_sent`.

**Why:** This is the core backend operation for the reschedule flow. The NoShowActionBar (3B) calls this mutation when the closer clicks "Request Reschedule". Without it, the frontend has no way to generate reschedule links or transition the opportunity.

**Where:**
- `convex/closer/noShowActions.ts` (modify -- add export below existing `markNoShow`)

**How:**

**Step 1: Add the mutation to `noShowActions.ts`**

Append the following export below the existing `markNoShow` mutation:

```typescript
// Path: convex/closer/noShowActions.ts

/**
 * Generate a reschedule link for a no-show meeting.
 *
 * Single-step mutation that:
 * 1. Validates the closer has access and the opportunity is in no_show
 * 2. Creates a followUp record (reason: "no_show_follow_up", type: "scheduling_link")
 * 3. Generates a scheduling link from the closer's personalEventTypeUri with no-show UTMs
 * 4. Transitions the opportunity to "reschedule_link_sent"
 *
 * After this mutation, the lead is responsible for booking. The system waits.
 * When the lead books, the pipeline's UTM routing handles reschedule_link_sent -> scheduled.
 */
export const createNoShowRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, { opportunityId, meetingId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const now = Date.now();
    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }
    if (!user.personalEventTypeUri) {
      throw new Error(
        "No personal calendar configured. Ask your admin to assign one in Team settings.",
      );
    }

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }
    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }
    if (opportunity.status !== "no_show") {
      throw new Error(
        `Reschedule is only available for no-show opportunities (current: "${opportunity.status}")`,
      );
    }
    if (!validateTransition(opportunity.status, "reschedule_link_sent")) {
      throw new Error("Cannot transition to reschedule_link_sent from current status");
    }

    // Verify the meeting exists and belongs to this opportunity
    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.opportunityId !== opportunityId) {
      throw new Error("Meeting not found or does not belong to this opportunity");
    }

    // Create follow-up record
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId,
      leadId: opportunity.leadId,
      closerId: userId,
      type: "scheduling_link",
      reason: "no_show_follow_up",
      status: "pending",
      createdAt: now,
    });

    // Generate scheduling link with no-show UTMs (closer's personal link)
    let schedulingLinkUrl: string;
    try {
      const bookingUrl = new URL(user.personalEventTypeUri);
      bookingUrl.searchParams.set("utm_source", "ptdom");
      bookingUrl.searchParams.set("utm_medium", "noshow_resched");
      bookingUrl.searchParams.set("utm_campaign", opportunityId);
      bookingUrl.searchParams.set("utm_content", meetingId);
      bookingUrl.searchParams.set("utm_term", userId);
      schedulingLinkUrl = bookingUrl.toString();
    } catch {
      throw new Error("Personal calendar URL is invalid");
    }

    // Patch follow-up with the generated link
    await ctx.db.patch(followUpId, { schedulingLinkUrl });

    // Transition opportunity -- the lead is now responsible for scheduling
    await ctx.db.patch(opportunityId, {
      status: "reschedule_link_sent",
      updatedAt: now,
    });

    console.log("[Closer:NoShow] Reschedule link created + opportunity transitioned", {
      followUpId,
      opportunityId,
      originalMeetingId: meetingId,
      newStatus: "reschedule_link_sent",
    });

    return { schedulingLinkUrl, followUpId };
  },
});
```

**Step 2: Verify imports are present at the top of the file**

The file already imports `v`, `mutation`, `requireTenantUser`, and `validateTransition` from the Phase 2 `markNoShow` mutation. No new imports are needed.

**Key implementation notes:**
- The mutation returns `{ schedulingLinkUrl, followUpId }` -- the frontend needs the URL to display in the RescheduleLinkDisplay component.
- UTM parameter mapping: `utm_campaign` = opportunityId (for pipeline lookup), `utm_content` = meetingId (for `rescheduledFromMeetingId` on the new meeting), `utm_term` = userId (for attribution).
- The `personalEventTypeUri` is the closer's Calendly personal booking page. It is set by admins in Team settings. If missing, the mutation throws a user-friendly error directing the closer to their admin.
- The followUp record uses `reason: "no_show_follow_up"` (already in the schema union) and `type: "scheduling_link"` (already in the schema union). Both values exist in the `followUps` table schema from Feature A.
- The opportunity transitions `no_show -> reschedule_link_sent` atomically in the same mutation. This is validated by `validateTransition()` from `convex/lib/statusTransitions.ts` (Phase 1 adds this transition).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/noShowActions.ts` | Modify | Add `createNoShowRescheduleLink` mutation below existing `markNoShow` |

---

### 3B -- Frontend `NoShowActionBar` Component

**Type:** Frontend
**Parallelizable:** Yes -- new file with no dependencies on 3A or 3C (uses the mutation via `useMutation` which only needs the generated API type, not the runtime implementation).

**What:** Create the `NoShowActionBar` component at `app/workspace/closer/meetings/_components/no-show-action-bar.tsx`. Amber warning banner showing lead name, reason label, wait duration, optional note. Two buttons: "Request Reschedule" (calls the mutation and lifts the URL to the page) and "Schedule Follow-Up" (reuses existing FollowUpDialog via dynamic import).

**Why:** This is the primary UI for the closer's next actions after a no-show. It must appear immediately when `meeting.status === "no_show"` (both the closer-initiated and Calendly webhook paths). The "Request Reschedule" button is the key differentiator from the existing FollowUpDialog -- it generates a UTM-tagged link and transitions the opportunity to a distinct `reschedule_link_sent` status.

**Where:**
- `app/workspace/closer/meetings/_components/no-show-action-bar.tsx` (new)

**How:**

**Step 1: Create the component file**

```tsx
// Path: app/workspace/closer/meetings/_components/no-show-action-bar.tsx
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import posthog from "posthog-js";

const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);

type NoShowActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  lead: Doc<"leads">;
  onStatusChanged?: () => Promise<void>;
  onRescheduleLinkCreated?: (url: string) => void;
};

const REASON_LABELS: Record<string, string> = {
  no_response: "Lead didn't show up",
  late_cancel: "Lead messaged -- couldn't make it",
  technical_issues: "Technical issues",
  other: "Other reason",
};

export function NoShowActionBar({
  meeting,
  opportunity,
  lead,
  onStatusChanged,
  onRescheduleLinkCreated,
}: NoShowActionBarProps) {
  const createRescheduleLink = useMutation(
    api.closer.noShowActions.createNoShowRescheduleLink,
  );
  const [isCreating, setIsCreating] = useState(false);

  const reasonLabel = meeting.noShowReason
    ? REASON_LABELS[meeting.noShowReason] ?? meeting.noShowReason
    : "No-show";

  const sourceLabel =
    meeting.noShowSource === "calendly_webhook"
      ? "Marked by Calendly"
      : meeting.noShowWaitDurationMs
        ? `Waited ${Math.round(meeting.noShowWaitDurationMs / 60000)} min`
        : undefined;

  const handleRequestReschedule = async () => {
    setIsCreating(true);
    try {
      const result = await createRescheduleLink({
        opportunityId: opportunity._id,
        meetingId: meeting._id,
      });

      posthog.capture("no_show_reschedule_link_sent", {
        meeting_id: meeting._id,
        opportunity_id: opportunity._id,
      });

      // Lift the URL to page level -- the NoShowActionBar will unmount due to
      // reactivity (opportunity status is now reschedule_link_sent), but
      // RescheduleLinkDisplay will render the link at the page level.
      onRescheduleLinkCreated?.(result.schedulingLinkUrl);

      toast.success("Reschedule link generated -- copy and send to the lead");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create reschedule link",
      );
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="No-show actions"
      className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/40 dark:bg-amber-950/20"
    >
      <div className="flex items-start gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="flex-1">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            {lead.fullName ?? lead.email} &mdash; {reasonLabel}
          </p>
          <p className="mt-0.5 text-sm text-amber-700 dark:text-amber-300">
            {format(new Date(meeting.scheduledAt), "MMM d, h:mm a")}
            {sourceLabel && ` \u00b7 ${sourceLabel}`}
            {meeting.noShowNote && ` \u00b7 "${meeting.noShowNote}"`}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleRequestReschedule}
          disabled={isCreating}
        >
          {isCreating ? (
            <>
              <Spinner data-icon="inline-start" />
              Generating...
            </>
          ) : (
            <>
              <RefreshCwIcon data-icon="inline-start" />
              Request Reschedule
            </>
          )}
        </Button>

        <FollowUpDialog
          opportunityId={opportunity._id}
          onSuccess={onStatusChanged}
        />
      </div>
    </div>
  );
}
```

**Key implementation notes:**
- The `onRescheduleLinkCreated` callback is critical for the lifted state pattern (3D). When the mutation succeeds, the opportunity transitions to `reschedule_link_sent`, which causes this component to unmount. The callback lifts the URL to page-level state before that happens.
- The `FollowUpDialog` is dynamically imported to avoid loading its code until needed. It uses the same signature as the existing OutcomeActionBar usage: `{ opportunityId, onSuccess }`.
- Wait duration display: `Math.round(meeting.noShowWaitDurationMs / 60000)` converts ms to minutes. For webhook-driven no-shows, `noShowWaitDurationMs` is `undefined` and the "Waited X min" label is omitted.
- The amber color scheme (`amber-50`/`amber-950/20` for light/dark bg, `amber-200`/`amber-800/40` for border) matches the `no_show` status color from `lib/status-config.ts` (orange/amber family).
- The `role="region"` and `aria-label` ensure screen readers announce the action bar as a distinct landmark.
- The loading state uses `Spinner` with `data-icon="inline-start"` following the codebase icon pattern, and disables the button to prevent double-clicks.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/no-show-action-bar.tsx` | Create | Amber action bar with "Request Reschedule" and "Schedule Follow-Up" |

---

### 3C -- Frontend `RescheduleLinkDisplay` Component

**Type:** Frontend
**Parallelizable:** Yes -- new file, independent of 3A and 3B. Uses only shadcn/ui primitives.

**What:** Create the `RescheduleLinkDisplay` component at `app/workspace/closer/meetings/_components/reschedule-link-display.tsx`. Blue card with a heading, helper text, a read-only input with a copy-to-clipboard button, and a dismiss button. Also create a `RescheduleLinkSentBanner` in the same file for the case where the closer navigates away and returns.

**Why:** The reschedule link must be visible after the NoShowActionBar unmounts (due to reactivity changing the opportunity status to `reschedule_link_sent`). This component is rendered at the page level with state lifted from the NoShowActionBar. The `RescheduleLinkSentBanner` handles the case where the closer revisits the page after already generating the link.

**Where:**
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx` (new)

**How:**

**Step 1: Create the component file with both exports**

```tsx
// Path: app/workspace/closer/meetings/_components/reschedule-link-display.tsx
"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { CopyIcon, CheckIcon, XIcon, SendIcon, ClockIcon } from "lucide-react";
import { toast } from "sonner";

type RescheduleLinkDisplayProps = {
  url: string;
  onDismiss: () => void;
};

export function RescheduleLinkDisplay({
  url,
  onDismiss,
}: RescheduleLinkDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    toast.success("Link copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <SendIcon className="size-4" />
          Reschedule Link Ready
        </CardTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDismiss}
          aria-label="Dismiss reschedule link"
        >
          <XIcon className="size-4" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Copy this link and send it to the lead. They&rsquo;ll book directly on
          your calendar &mdash; the new meeting will be linked automatically.
        </p>
        <InputGroup>
          <InputGroupInput value={url} readOnly aria-label="Reschedule link URL" />
          <InputGroupAddon align="inline-end">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleCopy}
              aria-label={copied ? "Link copied" : "Copy reschedule link"}
            >
              {copied ? (
                <CheckIcon className="size-4 text-green-600" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </Button>
          </InputGroupAddon>
        </InputGroup>
      </CardContent>
    </Card>
  );
}

/**
 * Shown when opportunity.status === "reschedule_link_sent" but the closer
 * doesn't have the link URL in local state (navigated away and came back).
 */
type RescheduleLinkSentBannerProps = {
  opportunityId: Id<"opportunities">;
};

export function RescheduleLinkSentBanner({
  opportunityId,
}: RescheduleLinkSentBannerProps) {
  return (
    <Alert className="border-blue-200 bg-blue-50 dark:border-blue-800/40 dark:bg-blue-950/20">
      <ClockIcon className="size-4 text-blue-600 dark:text-blue-400" />
      <AlertDescription className="text-blue-900 dark:text-blue-100">
        A reschedule link was sent for this opportunity. Waiting for the lead to
        book.
      </AlertDescription>
    </Alert>
  );
}
```

**Key implementation notes:**
- The `InputGroupInput` renders a read-only input inside the `InputGroup` shell. The `InputGroupAddon` with `align="inline-end"` places the copy button on the right side -- following the existing `InputGroup` + `InputGroupAddon` pattern used in `components/ui/input-group.tsx`.
- The `copied` state is local -- resets after 2 seconds via `setTimeout`. This gives the closer visual feedback (check icon) that the copy succeeded.
- `navigator.clipboard.writeText` requires HTTPS or localhost. This is safe because the app always runs behind HTTPS in production.
- The `RescheduleLinkSentBanner` accepts `opportunityId` as a prop for future use (could look up the follow-up to re-display the link). For now it shows a simple status message. The `opportunityId` prop is included to avoid a breaking change if we add link retrieval later.
- Blue color scheme (`blue-50`/`blue-950/20` for light/dark bg, `blue-200`/`blue-800/40` for border) distinguishes this from the amber NoShowActionBar, signaling a positive "action taken" state.
- `aria-label` attributes on the dismiss and copy buttons ensure screen readers announce the button purpose.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/reschedule-link-display.tsx` | Create | Blue card with copy-to-clipboard + return-visit banner |

---

### 3D -- `MeetingDetailPageClient` Integration (Lifted State)

**Type:** Frontend
**Parallelizable:** No -- depends on 3A (mutation must exist for `useMutation` type resolution), 3B (NoShowActionBar component), and 3C (RescheduleLinkDisplay + RescheduleLinkSentBanner components).

**What:** Modify `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` to add page-level `rescheduleLinkUrl` state, render `NoShowActionBar` when `opportunity.status === "no_show"`, render `RescheduleLinkDisplay` when the URL is present, and render `RescheduleLinkSentBanner` when the closer returns to a `reschedule_link_sent` opportunity.

**Why:** The lifted state pattern is essential for the reschedule flow. When the `createNoShowRescheduleLink` mutation succeeds, Convex reactivity pushes `opportunity.status = "reschedule_link_sent"`, which unmounts the NoShowActionBar. The link URL must survive this unmount via page-level `useState`. Without this integration, the closer would lose the link after clicking "Request Reschedule".

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Add imports**

Add the following imports at the top of the file, alongside the existing component imports:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (existing imports):
import { OutcomeActionBar } from "../../_components/outcome-action-bar";
import { BookingAnswersCard } from "../../_components/booking-answers-card";
// ...

// ADD these imports:
import { useState } from "react";
import { NoShowActionBar } from "../../_components/no-show-action-bar";
import {
  RescheduleLinkDisplay,
  RescheduleLinkSentBanner,
} from "../../_components/reschedule-link-display";
```

**Step 2: Add state inside the `MeetingDetailPageClient` component**

Add the `rescheduleLinkUrl` state inside the component, after the existing hooks:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (existing):
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail) as MeetingDetailData;
  usePageTitle(detail?.lead?.fullName ?? "Meeting");

  const refreshDetail = async () => {
    router.refresh();
  };

// ADD after refreshDetail:
  const [rescheduleLinkUrl, setRescheduleLinkUrl] = useState<string | null>(null);
```

**Step 3: Add NoShowActionBar, RescheduleLinkDisplay, and RescheduleLinkSentBanner to the JSX**

Insert the three conditional blocks between the reassignment info alert and the grid layout. The placement order follows the design doc's JSX layout specification:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (existing):
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
            &mdash; {reassignmentInfo.reason}
          </AlertDescription>
        </Alert>
      )}

// ADD after the reassignment info alert, BEFORE the grid layout:

      {/* Feature B: No-Show Action Bar */}
      {opportunity.status === "no_show" && (
        <NoShowActionBar
          meeting={meeting}
          opportunity={opportunity}
          lead={lead}
          onStatusChanged={refreshDetail}
          onRescheduleLinkCreated={(url) => setRescheduleLinkUrl(url)}
        />
      )}

      {/* Feature B: Reschedule Link Display (survives NoShowActionBar unmount) */}
      {rescheduleLinkUrl && (
        <RescheduleLinkDisplay
          url={rescheduleLinkUrl}
          onDismiss={() => setRescheduleLinkUrl(null)}
        />
      )}

      {/* Feature B: Reschedule Link Sent Banner (closer returned to page) */}
      {opportunity.status === "reschedule_link_sent" && !rescheduleLinkUrl && (
        <RescheduleLinkSentBanner opportunityId={opportunity._id} />
      )}

      <div className="grid grid-cols-1 gap-6 md:grid-cols-3 lg:grid-cols-4">
// ... rest of existing JSX
```

**Key implementation notes:**
- **Rendering order matters**: The three Feature B blocks are placed between the reassignment alert and the grid layout. This matches the design doc's JSX layout specification: `{potentialDuplicate banner} -> {reassignment info alert} -> {reschedule chain banner (Phase 5)} -> {no-show action bar (Phase 3)} -> {reschedule link display (Phase 3)} -> {grid layout} -> {outcome action bar}`.
- **Mutual exclusivity**: `NoShowActionBar` renders when `opportunity.status === "no_show"`. `RescheduleLinkSentBanner` renders when `opportunity.status === "reschedule_link_sent" && !rescheduleLinkUrl`. `RescheduleLinkDisplay` renders whenever `rescheduleLinkUrl` is set (regardless of status). These three conditions do not overlap in normal flow.
- **Reactivity flow**: When the closer clicks "Request Reschedule" -> mutation succeeds -> `onRescheduleLinkCreated` fires (setting `rescheduleLinkUrl`) -> Convex pushes `opportunity.status = "reschedule_link_sent"` -> `NoShowActionBar` unmounts (status is no longer `no_show`) -> `RescheduleLinkDisplay` renders (because `rescheduleLinkUrl` is set). The sequence happens within a single React render cycle thanks to Convex's reactive query system.
- **Return-visit case**: If the closer navigates away and returns, `rescheduleLinkUrl` is `null` (local state is gone), but `opportunity.status` is still `reschedule_link_sent`. The `RescheduleLinkSentBanner` handles this case with a simple informational message.
- The `useState` import may already be present if other state hooks are added by Phase 2 (for the `MarkNoShowDialog`). If so, just ensure it is imported once.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Add state, imports, and three conditional JSX blocks |

---

### 3E -- Pipeline UTM Routing Enhancement

**Type:** Backend
**Parallelizable:** No -- depends on 3D (full flow must be testable end-to-end). Modifies `convex/pipeline/inviteeCreated.ts`, which is a critical file.

**What:** Modify the UTM deterministic linking block in `convex/pipeline/inviteeCreated.ts` to accept `reschedule_link_sent` status (in addition to `follow_up_scheduled`), and set `rescheduledFromMeetingId` on the new meeting when `utm_medium === "noshow_resched"`.

**Why:** Without this change, when a lead books through the reschedule link, the pipeline sees the opportunity in `reschedule_link_sent` status and falls through to the normal flow (creating a new opportunity). The existing UTM routing only accepts `follow_up_scheduled`. This is the final piece that closes the reschedule loop: `no_show -> reschedule_link_sent -> scheduled`.

**Where:**
- `convex/pipeline/inviteeCreated.ts` (modify -- UTM deterministic linking block, lines ~949-1064)

**How:**

**Step 1: Widen the status check in the UTM routing condition**

Change the status check from `follow_up_scheduled` only to include `reschedule_link_sent`:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

// BEFORE (line ~949-953):
			if (
				targetOpportunity &&
				targetOpportunity.tenantId === tenantId &&
				targetOpportunity.status === "follow_up_scheduled" &&
				validateTransition(targetOpportunity.status, "scheduled")
			) {

// AFTER:
			if (
				targetOpportunity &&
				targetOpportunity.tenantId === tenantId &&
				(targetOpportunity.status === "follow_up_scheduled" ||
					targetOpportunity.status === "reschedule_link_sent") &&
				validateTransition(targetOpportunity.status, "scheduled")
			) {
```

**Step 2: Resolve `rescheduledFromMeetingId` before meeting creation**

Add the `rescheduledFromMeetingId` resolution after the opportunity patch (line ~1003) and before the follow-up handling (line ~1008):

```typescript
// Path: convex/pipeline/inviteeCreated.ts

// AFTER the existing opportunity patch and log line (line ~1005):
					console.log(
						`[Pipeline:invitee.created] [Feature A] Opportunity relinked | opportunityId=${targetOpportunityId} status=follow_up_scheduled->scheduled`,
					);

// ADD Feature B rescheduledFromMeetingId resolution:

					// Feature B: Resolve rescheduledFromMeetingId for no-show reschedules
					const isNoShowReschedule =
						utmParams.utm_medium === "noshow_resched";
					let rescheduledFromMeetingId: Id<"meetings"> | undefined;

					if (isNoShowReschedule && utmParams.utm_content) {
						const candidateId =
							utmParams.utm_content as Id<"meetings">;
						const originalMeeting = await ctx.db.get(candidateId);
						if (
							originalMeeting &&
							originalMeeting.tenantId === tenantId
						) {
							rescheduledFromMeetingId = candidateId;
						} else {
							console.warn(
								`[Pipeline:invitee.created] [Feature B] rescheduledFromMeetingId invalid | id=${candidateId}`,
							);
						}
					}

// Existing follow-up handling continues below...
```

**Step 3: Update `utm_content` interpretation to handle both follow-up and meeting IDs**

The existing code at line ~944 interprets `utm_content` as a followUp ID. For `noshow_resched`, it contains a meeting ID instead. Update the `targetFollowUpId` extraction to skip when `utm_medium === "noshow_resched"`:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

// BEFORE (line ~944):
			const targetFollowUpId = utmParams.utm_content
				? (utmParams.utm_content as Id<"followUps">)
				: undefined;

// AFTER:
			const isNoShowRescheduleUtm =
				utmParams.utm_medium === "noshow_resched";
			const targetFollowUpId =
				!isNoShowRescheduleUtm && utmParams.utm_content
					? (utmParams.utm_content as Id<"followUps">)
					: undefined;
```

**Step 4: Include `rescheduledFromMeetingId` in the meeting insert**

Add the field to the existing `ctx.db.insert("meetings", { ... })` call:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

// BEFORE (line ~1048-1064):
					const meetingId = await ctx.db.insert("meetings", {
						tenantId,
						opportunityId: targetOpportunityId,
						calendlyEventUri,
						calendlyInviteeUri,
						zoomJoinUrl: meetingLocation.zoomJoinUrl,
						meetingJoinUrl: meetingLocation.meetingJoinUrl,
						meetingLocationType:
							meetingLocation.meetingLocationType,
						scheduledAt,
						durationMinutes,
						status: "scheduled",
						notes: meetingNotes,
						leadName: lead.fullName ?? lead.email,
						createdAt: now,
						utmParams,
					});

// AFTER:
					const meetingId = await ctx.db.insert("meetings", {
						tenantId,
						opportunityId: targetOpportunityId,
						calendlyEventUri,
						calendlyInviteeUri,
						zoomJoinUrl: meetingLocation.zoomJoinUrl,
						meetingJoinUrl: meetingLocation.meetingJoinUrl,
						meetingLocationType:
							meetingLocation.meetingLocationType,
						scheduledAt,
						durationMinutes,
						status: "scheduled",
						notes: meetingNotes,
						leadName: lead.fullName ?? lead.email,
						createdAt: now,
						utmParams,
						rescheduledFromMeetingId, // Feature B: links to original no-show meeting
					});

					if (rescheduledFromMeetingId) {
						console.log(
							`[Pipeline:invitee.created] [Feature B] Reschedule chain linked | newMeetingId=${meetingId} rescheduledFrom=${rescheduledFromMeetingId}`,
						);
					}
```

**Step 5: Handle follow-up marking for no-show reschedules**

When `utm_medium === "noshow_resched"`, the follow-up created by `createNoShowRescheduleLink` (3A) should be marked as `booked`. The existing generic `markFollowUpBooked` call handles this -- it finds pending follow-ups for the opportunity. But we need to ensure the `targetFollowUpId`-specific path is skipped for no-show reschedules (already handled in Step 3). After the existing follow-up handling block:

```typescript
// Path: convex/pipeline/inviteeCreated.ts

// The existing targetFollowUpId block (lines ~1008-1038) already handles this:
// - If targetFollowUpId is defined (Feature A), it patches that specific follow-up.
// - If targetFollowUpId is undefined (Feature B noshow_resched), it falls through
//   to the generic markFollowUpBooked call, which finds the pending follow-up
//   for this opportunity and marks it as booked.
//
// No additional changes needed in the follow-up handling block.
```

**Key implementation notes:**
- **Dual interpretation of `utm_content`**: For Feature A (`utm_medium !== "noshow_resched"`), `utm_content` is a `followUps` ID. For Feature B (`utm_medium === "noshow_resched"`), `utm_content` is a `meetings` ID. The `isNoShowRescheduleUtm` flag gates the interpretation. This is documented in the design doc Section 6.5.
- **Status check broadening**: The condition `(targetOpportunity.status === "follow_up_scheduled" || targetOpportunity.status === "reschedule_link_sent")` is safe because `validateTransition()` independently validates that the target status (`"scheduled"`) is reachable. Phase 1 adds `reschedule_link_sent -> scheduled` to the transition table.
- **Meeting validation**: The `rescheduledFromMeetingId` candidate is validated by looking it up in the database and checking its `tenantId`. If invalid (e.g., tampered UTM), it logs a warning and the field is left as `undefined` -- the meeting is still created, just without the chain link.
- **Log message update**: The existing log `"status=follow_up_scheduled->scheduled"` is now slightly inaccurate for `reschedule_link_sent`. Consider updating it to `"status=${targetOpportunity.status}->scheduled"` for clarity.
- **Follow-up booked marking**: The generic `markFollowUpBooked` internal mutation (called when `targetFollowUpId` is undefined) queries pending follow-ups for the opportunity and marks the first one as booked. This correctly handles the follow-up record created by `createNoShowRescheduleLink` in 3A.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/pipeline/inviteeCreated.ts` | Modify | Widen status check, resolve `rescheduledFromMeetingId`, update meeting insert, gate `utm_content` interpretation |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/noShowActions.ts` | Modify | 3A |
| `app/workspace/closer/meetings/_components/no-show-action-bar.tsx` | Create | 3B |
| `app/workspace/closer/meetings/_components/reschedule-link-display.tsx` | Create | 3C |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 3D |
| `convex/pipeline/inviteeCreated.ts` | Modify | 3E |
