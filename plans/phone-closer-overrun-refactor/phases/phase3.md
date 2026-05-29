# Phase 3 - Frontend: Join Link and Direct Outcomes

**Goal:** Replace the Start/End meeting UI with a plain Join link plus direct scheduled outcome actions for closers and admins. After this phase, users can no longer initiate the old lifecycle from the browser.

**Prerequisite:** Phase 2 backend deployed or available in the target branch. Outcome mutations accept scheduled meetings, admin wrappers are meeting-aware where needed, and no new attendance checks are produced.

**Runs in PARALLEL with:** Phase 4 can run in parallel after route/nav ownership is coordinated. Do not edit `workspace-shell-client.tsx` or command-palette review entries from two branches at once.

**Skills to invoke:**
- `frontend-design` - rework the action bar and meeting detail UI into a production-grade direct-outcome workflow.
- `next-best-practices` - preserve App Router RSC/client boundaries and route deletion conventions.
- `vercel-react-best-practices` - keep reactive meeting detail rendering and dynamic dialogs efficient.
- `vercel-composition-patterns` - replace boolean lifecycle gating with explicit scheduled-outcome composition.
- `shadcn` - preserve button/dialog/form patterns.
- `web-design-guidelines` - accessibility review for link buttons, dialogs, and empty states.

**Docs and references to read first:**
- `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` Sections 6, 12, 13, and 14.
- `.docs/convex/nextjs.md` and `.docs/convex/module-nextjs.md` for preloaded query/client component patterns.
- `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`.
- `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`.
- `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md`.
- `node_modules/next/dist/docs/01-app/02-guides/forms.md`.
- Current UI files under `app/workspace/closer/meetings/**`, `app/workspace/pipeline/meetings/**`, `app/workspace/reviews/**`, `app/workspace/_components/workspace-shell-client.tsx`, and `components/command-palette.tsx`.

**Deploy / backfill / manual operations:**
- **Deploy required:** Yes. Deploy after Phase 2 backend is deployed.
- **Backfill or migration required:** No.
- **Manual operations:** Browser QA as closer and tenant admin. Confirm Join does not mutate Convex and scheduled outcomes resolve records through CLI verification.

**Acceptance Criteria:**
1. The meeting detail action bar shows Join as a plain external link when `meetingJoinUrl` or `zoomJoinUrl` exists.
2. Clicking Join does not call any Convex mutation and does not emit `meeting_started`.
3. Start Meeting, End Meeting, start-window alerts, in-progress navigation guard, and overran banners/dialogs are removed from closer meeting detail.
4. Payment, follow-up, no-show, and lost controls render for eligible scheduled meetings and pass `meetingId` where the backend needs to complete the meeting.
5. Closer outcome controls remain hidden before `scheduledAt - 5 minutes`; admins can act from scheduled meetings without that UI time gate.
6. Admin pipeline meeting actions no longer show `AdminResolveMeetingDialog` and instead expose direct payment/follow-up/no-show/lost actions for scheduled meetings.
7. `/workspace/reviews/**` routes and workspace review navigation entries are removed without leaving broken sidebar, command-palette, or link targets.
8. No frontend import references `meetingReviews`, `startMeeting`, `stopMeeting`, `MeetingOverranBanner`, `EndMeetingButton`, or `useInProgressMeetingGuard`.
9. Browser QA confirms scheduled -> payment, scheduled -> follow-up, scheduled -> no-show, and scheduled -> lost from the meeting page.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (client eligibility hook + action bar) --> 3B (dialogs pass meetingId) --\
                                                                            \
3C (detail page + info panel cleanup) ---------------------------------------> 3F (browser/manual QA)
                                                                            /
3D (admin action parity) ---------------------------------------------------/
                                                                           /
3E (review routes/nav deletion) -------------------------------------------/
```

**Optimal execution:**
1. Start 3A and 3C together; coordinate imports in the meeting detail page.
2. Start 3B after 3A determines exact props for each dialog.
3. Run 3D in parallel if backend admin mutation contracts from Phase 2 are stable.
4. Run 3E after route/nav ownership is clear with Phase 4.
5. Finish with 3F across closer and admin roles.

**Estimated time:** 2-4 days

---

## Subphases

### 3A - Replace Lifecycle Action Bar with Scheduled Outcome Actions

**Type:** Frontend
**Parallelizable:** Yes - can run alongside 3C, but coordinate final props.

**What:** Remove Start/End lifecycle gating and render a plain Join link plus direct outcome actions when the meeting and opportunity are scheduled.

**Why:** The action bar is the primary user-facing behavior change. It must no longer mutate state on join.

**Where:**
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)
- `hooks/use-outcome-eligibility.ts` (create, or keep local if only used by action bar)

**How:**

**Step 1: Add a small client-side eligibility hook.**

```tsx
// Path: hooks/use-outcome-eligibility.ts
"use client";

import { useEffect, useState } from "react";
import type { Doc } from "@/convex/_generated/dataModel";

const OUTCOME_LEAD_MS = 5 * 60_000;
const TICK_INTERVAL_MS = 15_000;

export function useOutcomeEligibility(meeting: Doc<"meetings">): boolean {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  return (
    meeting.status === "scheduled" &&
    now >= meeting.scheduledAt - OUTCOME_LEAD_MS
  );
}
```

**Step 2: Remove lifecycle imports and mutations.**

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx
// Remove:
// import { useMutation } from "convex/react";
// import posthog from "posthog-js";
// import { EndMeetingButton } from "./end-meeting-button";
// const startMeeting = useMutation(api.closer.meetingActions.startMeeting);
```

**Step 3: Render Join and outcomes from one predicate.**

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ExternalLinkIcon, UserXIcon } from "lucide-react";
import { useOutcomeEligibility } from "@/hooks/use-outcome-eligibility";

export function OutcomeActionBar({
  meeting,
  opportunity,
  viewerRole,
  activeFollowUp = null,
  onStatusChanged,
}: OutcomeActionBarProps) {
  const [showNoShowDialog, setShowNoShowDialog] = useState(false);
  const isAdmin =
    viewerRole === "tenant_master" || viewerRole === "tenant_admin";
  const viewerIsCloser = viewerRole === "closer";
  const eligible = useOutcomeEligibility(meeting);
  const joinUrl = meeting.meetingJoinUrl ?? meeting.zoomJoinUrl;
  const canRecordScheduledOutcome =
    meeting.status === "scheduled" &&
    opportunity.status === "scheduled" &&
    (isAdmin || viewerIsCloser) &&
    (isAdmin || eligible);

  if (!joinUrl && !canRecordScheduledOutcome) return null;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 [&_button]:w-full">
        {joinUrl ? (
          <Button asChild variant="outline">
            <a href={joinUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon data-icon="inline-start" />
              Join Meeting
            </a>
          </Button>
        ) : null}

        {joinUrl && canRecordScheduledOutcome ? <Separator /> : null}

        {canRecordScheduledOutcome ? (
          <>
            <PaymentFormDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />
            <FollowUpDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />
            <Button variant="outline" onClick={() => setShowNoShowDialog(true)}>
              <UserXIcon data-icon="inline-start" />
              Mark No-Show
            </Button>
            <MarkNoShowDialog
              open={showNoShowDialog}
              onOpenChange={setShowNoShowDialog}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />
            <MarkLostDialog
              opportunityId={opportunity._id}
              meetingId={meeting._id}
              onSuccess={onStatusChanged}
            />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
```

**Key implementation notes:**
- The hook is UI-only. Backend `assertCanRecordMeetingOutcome` remains authoritative.
- Remove all `flashKey`, wiggle, start-window, and end-meeting props.
- Keep `NoShowActionBar` for already `no_show` recovery flows; do not mix it into scheduled outcomes.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `hooks/use-outcome-eligibility.ts` | Create | Client-only UI timing predicate |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | Plain Join + direct scheduled outcomes |

---

### 3B - Update Outcome Dialog Props

**Type:** Frontend
**Parallelizable:** Yes - depends on final 3A prop shape.

**What:** Pass `meetingId` through follow-up and lost dialogs from meeting-detail contexts; remove no-show wait-time props.

**Why:** Backend completion requires an explicit meeting id. The UI must not rely on latest meeting inference.

**Where:**
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (modify)
- `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` (modify)
- `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx` (modify)
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx` (modify)
- `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx` (modify)

**How:**

**Step 1: Add optional `meetingId` to follow-up dialog.**

```tsx
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx
type FollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
};

const handleDone = async () => {
  setState("confirming");
  await confirmFollowUp({ opportunityId, meetingId });
  await onSuccess?.();
  onClose();
};
```

Pass the same optional `meetingId` into manual reminder completion only if the Phase 2 backend supports meeting completion for that path. Otherwise keep manual reminders opportunity-only and document the product decision in the component.

**Step 2: Add optional `meetingId` to lost dialog.**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx
type MarkLostDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
};

await markAsLost({
  opportunityId,
  meetingId,
  reason: trimmedReason,
});
```

**Step 3: Remove wait-time display from no-show dialog.**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx
type MarkNoShowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: Id<"meetings">;
  onSuccess?: () => Promise<void>;
};

// Remove startedAt prop, formatWaitTime, live interval, waitMs, and the
// posthog wait_duration_ms payload.
```

**Step 4: Mirror meeting-aware props in admin dialogs.**

```tsx
// Path: app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx
type AdminFollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  onSuccess?: () => Promise<void>;
};

await confirmFollowUp({ opportunityId, meetingId });
```

**Key implementation notes:**
- Keep React Hook Form + Zod v4 + `standardSchemaResolver`; do not switch resolvers.
- Do not pass controlled `value` to file inputs if touching payment dialogs.
- Update PostHog payloads to remove actual duration/wait-time data.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modify | Optional meeting id |
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Modify | Optional meeting id |
| `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx` | Modify | Remove timing props/UI |
| `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx` | Modify | Optional meeting id |
| `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx` | Modify | Optional meeting id |

---

### 3C - Simplify Meeting Detail Page and Info Panel

**Type:** Frontend
**Parallelizable:** Yes - can run with 3A after import ownership is coordinated.

**What:** Remove in-progress navigation guard, overran banners, timing display, and lifecycle-only props from the closer meeting detail page.

**Why:** The page should present meeting details, passive Join, and outcome actions. It should not mention Start/End, in-progress state, or overran review.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` (modify)
- `hooks/use-in-progress-meeting-guard.ts` (delete)
- `app/workspace/closer/meetings/_components/end-meeting-button.tsx` (delete)
- `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` (delete)
- `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` (delete)

**How:**

**Step 1: Remove guard state and warning dialog.**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// Remove:
// import { useInProgressMeetingGuard } from "@/hooks/use-in-progress-meeting-guard";
// AlertDialog imports used only by the in-progress warning.
// isMeetingInProgress, blockBack, warningOpen, dismissWarning, flashKey.

<Button variant="ghost" size="sm" onClick={() => router.back()}>
  <ArrowLeftIcon data-icon="inline-start" />
  Back
</Button>
```

**Step 2: Remove meeting review and banner rendering.**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx
// Remove meetingReview from the destructuring when Phase 3 also updates the
// query. Remove <MeetingOverranBanner ... /> entirely.
```

**Step 3: Drop timing section from `MeetingInfoPanel`.**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-info-panel.tsx
// Remove:
// MeetingTimestampSource
// TIMESTAMP_SOURCE_LABELS
// recordedEndAt
// hasTimingBadges
// hasRecordedTiming
// The "Recorded Timing" <Separator /> block.
```

Keep the existing Meeting Link section as the primary Join surface.

**Step 4: Stop loading `meetingReview` in the detail query.**

```typescript
// Path: convex/closer/meetingDetail.ts
// Remove this Promise.all entry:
// meeting.reviewId ? ctx.db.get(meeting.reviewId) : Promise.resolve(null),

return {
  meeting,
  opportunity,
  lead,
  // Remove meetingReview from the return shape after all callers are updated.
};
```

**Key implementation notes:**
- Preserve `FathomLinkField`; it remains a passive artifact.
- Preserve duplicate/reassignment/reschedule banners.
- Keep skeleton dimensions close to the real layout and include existing skeleton accessibility patterns.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Remove guard/banner/warning/flash |
| `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` | Modify | Remove timing section |
| `convex/closer/meetingDetail.ts` | Modify | Stop loading `meetingReview` |
| `hooks/use-in-progress-meeting-guard.ts` | Delete | Old lifecycle guard |
| `app/workspace/closer/meetings/_components/end-meeting-button.tsx` | Delete | Old lifecycle control |
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | Delete | Review UI removed |
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | Delete | Review UI removed |

---

### 3D - Admin Scheduled Outcome Parity

**Type:** Full-Stack
**Parallelizable:** Yes - separate surface from closer detail.

**What:** Replace admin manual resolve with direct scheduled payment/follow-up/no-show/lost controls.

**Why:** Admins must be able to resolve any tenant meeting without Start/End or overran review tooling.

**Where:**
- `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx` (modify)
- `app/workspace/pipeline/meetings/_components/admin-resolve-meeting-dialog.tsx` (delete)
- `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx` (modify)
- `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx` (modify)
- `convex/admin/meetingActions.ts` (verify Phase 2 contract)

**How:**

**Step 1: Render direct scheduled actions.**

```tsx
// Path: app/workspace/pipeline/meetings/_components/admin-action-bar.tsx
export function AdminActionBar({
  meeting,
  opportunity,
  onRescheduleLinkCreated,
}: AdminActionBarProps) {
  const status = opportunity.status;
  const isScheduledOutcome =
    meeting.status === "scheduled" && status === "scheduled";
  const isTerminal = status === "payment_received" || status === "lost";

  if (isTerminal) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-4">
      {isScheduledOutcome ? (
        <>
          <PaymentFormDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
          />
          <AdminFollowUpDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
          />
          <AdminNoShowButton meetingId={meeting._id} />
          <AdminMarkLostDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
          />
        </>
      ) : null}

      {status === "no_show" ? (
        <AdminRescheduleButton
          opportunityId={opportunity._id}
          meetingId={meeting._id}
          onRescheduleLinkCreated={onRescheduleLinkCreated}
        />
      ) : null}
    </div>
  );
}
```

**Step 2: Delete manual resolve dialog import and file.**

```tsx
// Path: app/workspace/pipeline/meetings/_components/admin-action-bar.tsx
// Remove:
// import { AdminResolveMeetingDialog } from "./admin-resolve-meeting-dialog";
```

**Key implementation notes:**
- If `PaymentFormDialog` uses shared mutation with admin support from Phase 2, reuse it. If not, implement `AdminPaymentFormDialog` against an admin wrapper.
- Admin no-show can use a small dedicated dialog/button if the closer no-show dialog still assumes `closer` role.
- Admins bypass the lead-window UI, but backend still validates tenant and role.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx` | Modify | Direct scheduled outcomes |
| `app/workspace/pipeline/meetings/_components/admin-resolve-meeting-dialog.tsx` | Delete | Manual timing resolver removed |
| `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx` | Modify | Pass meeting id |
| `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx` | Modify | Pass meeting id |

---

### 3E - Delete Workspace Review Routes and Entry Points

**Type:** Frontend
**Parallelizable:** Yes - coordinate nav files with Phase 4.

**What:** Remove the operational review inbox route tree and its shell/command-palette links.

**Why:** There is no replacement review workflow. Keeping a route that depends on `meetingReviews` will block Phase 6 schema deletion.

**Where:**
- `app/workspace/reviews/**` (delete)
- `app/workspace/_components/workspace-shell-client.tsx` (modify)
- `components/command-palette.tsx` (modify)

**How:**

**Step 1: Delete the route tree.**

```bash
# Path: shell
rm -r app/workspace/reviews
```

Use normal file deletion in implementation. The phase plan records that the whole route tree is removed.

**Step 2: Remove pending review query and nav item.**

```tsx
// Path: app/workspace/_components/workspace-shell-client.tsx
// Remove:
// useQuery(api.reviews.queries.getPendingReviewCount)
// Reviews sidebar item
// Review badge count rendering
```

**Step 3: Remove command-palette shortcut.**

```tsx
// Path: components/command-palette.tsx
const WORKSPACE_COMMANDS = [
  { label: "Overview", href: "/workspace", shortcut: "1" },
  { label: "Pipeline", href: "/workspace/pipeline", shortcut: "2" },
  // Remove Reviews and renumber only if the surrounding command list expects
  // dense shortcuts.
];
```

**Key implementation notes:**
- Delete only `/workspace/reviews` in Phase 3. Report review/meeting-time routes are Phase 4.
- After deleting routes, run `rg -n '/workspace/reviews|api\\.reviews|meetingReviews' app components hooks`.
- Preserve role-based workspace nav behavior.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/**` | Delete | Operational review inbox removed |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | Remove review nav/badge query |
| `components/command-palette.tsx` | Modify | Remove Reviews command |

---

### 3F - Browser and CLI QA

**Type:** Manual / QA
**Parallelizable:** No - final phase gate.

**What:** Verify the new UI against backend state using Convex CLI first, then browser QA for closer/admin.

**Why:** TESTING.MD requires CLI validation as source of truth before browser validation.

**Where:**
- `TESTING.MD` helper flow
- Local browser or deployed preview
- Convex CLI

**How:**

**Step 1: Type-check.**

```bash
# Path: shell
pnpm tsc --noEmit
pnpm lint
```

**Step 2: Verify no old frontend imports remain.**

```bash
# Path: shell
rg -n 'startMeeting|stopMeeting|EndMeetingButton|MeetingOverranBanner|meetingReviews|useInProgressMeetingGuard|meeting_started' app components hooks lib
```

Expected: no active frontend matches.

**Step 3: Run role-specific manual QA.**

Use a test scheduled meeting:

- As closer: open meeting detail before the lead window; outcome controls hidden, Join visible.
- As closer: open at/after lead window; payment/follow-up/no-show/lost controls visible.
- As closer: click Join; confirm meeting remains `scheduled` in Convex.
- As tenant admin: open pipeline meeting surface; direct outcome controls visible for scheduled rows.

**Step 4: Verify backend state after each outcome.**

```bash
# Path: shell
npx convex data --prod meetings --limit 20
npx convex data --prod opportunities --limit 20
npx convex logs --prod
```

Expected examples:

- Payment/lost/follow-up: meeting `status: "completed"`, opportunity terminal/next status.
- No-show: meeting `status: "no_show"`, opportunity `status: "no_show"`.
- No outcome writes `startedAt`, `stoppedAt`, or duration fields.

**Key implementation notes:**
- Browser QA should include mobile-width layout if action buttons wrap.
- If UI renders a button that backend rejects for a valid scheduled row, fix server/client contract alignment before Phase 4/5.
- Do not mark Phase 3 complete if `/workspace/reviews` still compiles or appears in nav.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `TESTING.MD` | Reference | Manual QA flow |
| Production / preview environment | Verify | Closer/admin scheduled outcome flows |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `hooks/use-outcome-eligibility.ts` | Create | 3A |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | 3A |
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modify | 3B |
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Modify | 3B |
| `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx` | Modify | 3B |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 3C |
| `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` | Modify | 3C |
| `convex/closer/meetingDetail.ts` | Modify | 3C |
| `hooks/use-in-progress-meeting-guard.ts` | Delete | 3C |
| `app/workspace/closer/meetings/_components/end-meeting-button.tsx` | Delete | 3C |
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | Delete | 3C |
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | Delete | 3C |
| `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx` | Modify | 3D |
| `app/workspace/pipeline/meetings/_components/admin-resolve-meeting-dialog.tsx` | Delete | 3D |
| `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx` | Modify | 3D |
| `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx` | Modify | 3D |
| `app/workspace/reviews/**` | Delete | 3E |
| `app/workspace/_components/workspace-shell-client.tsx` | Modify | 3E |
| `components/command-palette.tsx` | Modify | 3E |
