# Phase 4 — Frontend: Closer UX Overhaul

**Goal:** Rebuild the closer-side meeting detail UX for v2: a new `FathomLinkField` component rendered on every meeting, a review-aware `OutcomeActionBar` that enables overran actions only while the review is pending, a persistent informational `MeetingOverranBanner` that stays visible across the review lifecycle (not only while status literally equals `meeting_overran`), and a corrected "Mark as Lost" dialog copy that no longer claims the action is permanent. After this phase, a closer on a flagged meeting can save their Fathom link, then take any normal outcome action (payment, follow-up, no-show, lost) exactly like on an in-progress meeting — the banner remains visible as informational context.

**Prerequisite:**
- **Phase 1 complete and deployed.** `meeting.fathomLink` / `fathomLinkSavedAt` are typed on `Doc<"meetings">`.
- **Phase 2 complete.** Closer mutations (`markAsLost`, `markNoShow`, `logPayment`, follow-up mutations) accept `meeting_overran` while review is pending. Without this, the UI would call mutations that still throw.
- **Phase 3A complete.** `api.closer.meetingActions.saveFathomLink` is exposed — the frontend needs this endpoint.
- **Phase 3D need NOT be complete** for Phase 4 to start. The closer-side UI doesn't call `resolveReview` or depend on the `disputed` branch. The banner reads `meetingReview.status` + `meetingReview.resolutionAction` from the meeting-detail query, which is already populated by v1 code.

**Runs in PARALLEL with:** Phase 5 (Frontend — Admin Review Updates). Both are frontend streams. **Shared file concern:** `FathomLinkField` (created in 4A) is also imported in Phase 5A (`admin-meeting-detail-client.tsx`). To make this true parallelism, 4A's component must exist and export stably BEFORE 5A imports it. Either:
- Sequence: 4A completes first (2 hours), then both streams run.
- OR: Same developer does 4A then immediately 5A, treating it as a shared foundation subphase.

**Skills to invoke:**
- `frontend-design` — New `FathomLinkField` component must be production-grade. Apply distinctive, polished UI (see component spec in Section 7.3 of `overhaul-v2.md`).
- `shadcn` — Use `Card`, `CardHeader`, `CardTitle`, `CardContent`, `Input`, `Button`, `Spinner` primitives. Confirm `LinkIcon` and `SaveIcon` exist in `lucide-react` (they do).
- `web-design-guidelines` — WCAG audit: the Fathom link field must have proper labeling (`aria-label` on input, visible `<label>` association via shadcn `Field` components), error state announcement via `aria-live`, keyboard focus management on save. Banner color contrast across the 4 states (pending-awaiting / pending-acted / resolved-acknowledged / resolved-disputed) must meet WCAG AA in both light and dark modes.
- `vercel-react-best-practices` — `FathomLinkField` should NOT re-render on every keystroke of unrelated components. Use controlled input pattern; memoize the save handler with `useCallback`. Confirm no unnecessary renders from the parent page.
- `expect` — Browser-verify all 4 review states in the banner, the Fathom field save + re-save flow, and the overran action-bar behavior with pending vs. resolved reviews. Test at 4 viewports, run accessibility audit, check console errors, verify no CLS on skeleton → real content.
- `vercel-react-view-transitions` — The banner state transitions (pending → resolved → disputed) are good candidates for View Transitions. Non-blocking; apply if time permits but do not block on it.

**Acceptance Criteria:**
1. `FathomLinkField` component renders on `/workspace/closer/meetings/[meetingId]` above `MeetingNotes`, regardless of meeting status (scheduled, in_progress, completed, canceled, no_show, meeting_overran).
2. Typing a URL into `FathomLinkField` and clicking Save persists it; reloading the page shows the saved value in the input and displays "✓ Saved {time}".
3. Clicking Save with an empty input shows an inline error "Fathom link is required" and does NOT call the mutation.
4. `OutcomeActionBar` on a `meeting_overran` opportunity with `meetingReview.status === "pending"` shows: Log Payment, Schedule Follow-Up, Mark No-Show, Mark as Lost (4 buttons).
5. `OutcomeActionBar` on a `meeting_overran` opportunity with `meetingReview.status === "resolved"` returns `null` (no actions shown).
6. `OutcomeActionBar` on a non-overran opportunity behaves identically to v1 (in_progress shows all 4 actions; canceled shows Schedule Follow-Up only; etc.).
7. `MeetingOverranBanner` is visible whenever `meetingReview` exists — independent of `opportunity.status`. It renders 4 distinct visual states:
   - **pending + still overran** (amber) — "Meeting Overran — Flagged for Review" (calls to save Fathom link / take action).
   - **pending + closer already acted** (blue) — "Your action has been recorded and is awaiting admin validation."
   - **resolved + acknowledged** (emerald) — "This review was acknowledged by an admin."
   - **resolved + disputed** (red) — "This review was disputed by an admin. Meeting overran is the final outcome."
8. `MarkLostDialog` copy no longer says "permanent and cannot be undone" — updated to explicitly note that overran reviews can be disputed.
9. Save + act flow: on a freshly-detected overran meeting, closer saves Fathom link → clicks "Log Payment" → payment dialog opens → submits → meeting-detail page refreshes → opportunity status is `payment_received` → banner flips to blue "awaiting admin validation" state → Fathom field still shows saved link → action bar returns `null` (payment_received is terminal).
10. `meeting-overran-context-dialog.tsx` is **NOT deleted in this phase** — Phase 6 owns the deletion. The import of this dialog inside `meeting-overran-banner.tsx` is removed in 4C, but the file itself remains until Phase 6.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
4A (FathomLinkField — new component)
         │
         ├── 4E (meeting-detail-page-client.tsx — wire up FathomLinkField)
         │
4B (OutcomeActionBar — review awareness) ──────────┐
                                                    ├── 4E
4C (MeetingOverranBanner — persistent 4-state)  ───┤
                                                    │
4D (MarkLostDialog — copy fix) ────────────────────┘
```

**Optimal execution:**
1. Start **4A, 4B, 4C, 4D in parallel** — all four touch different files with no shared state.
2. Once 4A, 4B, and 4C are at least stable (4D is a 5-minute copy change — trivially completes alongside), run **4E** as the integration subphase that wires everything into `meeting-detail-page-client.tsx`. 4E also triggers `expect` browser verification.

**Estimated time:** 2 days (16 hours — 4 hours for 4A, 3 hours for 4B, 4 hours for 4C including the 4-state messaging blocks, 15 minutes for 4D, 2 hours for 4E including integration testing, plus 2.5 hours for expect verification across all screens).

---

## Subphases

### 4A — New Component: `FathomLinkField`

**Type:** Frontend (new client component)
**Parallelizable:** Yes — new file with no upstream dependencies on other subphases. Required by 4E (integration) and Phase 5A (admin meeting detail reuse).

**What:** A new `"use client"` component at `app/workspace/closer/meetings/_components/fathom-link-field.tsx`. Displays a shadcn `Card` with an input for a Fathom URL, a Save button, and a status indicator ("Saving…" / "✓ Saved 3:15 PM"). Uses `useMutation(api.closer.meetingActions.saveFathomLink)`. Validates non-empty input before submit. Shows inline error on failure. Mirrors the interaction pattern of `MeetingNotes` (status indicator, error handling, controlled input) but with explicit Save button instead of debounced auto-save.

**Why:** v2's primary attendance artifact is the Fathom recording link. It must be easy to record on every meeting — not only flagged ones. The component is reused on both the closer meeting detail (`/workspace/closer/meetings/[id]`) and the admin meeting detail (`/workspace/pipeline/meetings/[id]`) pages; building it as a shared component prevents duplication and guarantees identical UX.

**Where:**
- `app/workspace/closer/meetings/_components/fathom-link-field.tsx` (new)

**How:**

**Step 1: Scaffold the component file with types and imports**

```tsx
// Path: app/workspace/closer/meetings/_components/fathom-link-field.tsx
"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { toast } from "sonner";
import { LinkIcon, SaveIcon, CheckCircle2Icon, AlertTriangleIcon } from "lucide-react";
import posthog from "posthog-js";

import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

type SaveStatus = "idle" | "saving" | "saved" | "error";

type FathomLinkFieldProps = {
  meetingId: Id<"meetings">;
  initialLink: string;
  savedAt: number | undefined;
};
```

**Step 2: Implement the core component**

```tsx
// Path: app/workspace/closer/meetings/_components/fathom-link-field.tsx (continued)

export function FathomLinkField({
  meetingId,
  initialLink,
  savedAt: initialSavedAt,
}: FathomLinkFieldProps) {
  const [value, setValue] = useState(initialLink);
  const [savedAt, setSavedAt] = useState<number | undefined>(initialSavedAt);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const saveFathomLink = useMutation(api.closer.meetingActions.saveFathomLink);

  const hasUnsavedChanges = value.trim() !== initialLink.trim();
  const isEmpty = value.trim().length === 0;

  const handleSave = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setErrorMessage("Fathom link is required");
      setSaveStatus("error");
      return;
    }
    setErrorMessage(null);
    setSaveStatus("saving");
    try {
      await saveFathomLink({ meetingId, fathomLink: trimmed });
      const now = Date.now();
      setSavedAt(now);
      setSaveStatus("saved");
      posthog.capture("meeting_fathom_link_saved", {
        meetingId,
        hasLink: true,
      });
      toast.success("Fathom link saved");
    } catch (err) {
      setSaveStatus("error");
      const message =
        err instanceof Error ? err.message : "Failed to save. Please try again.";
      setErrorMessage(message);
    }
  }, [meetingId, saveFathomLink, value]);

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      if (errorMessage) setErrorMessage(null);
      if (saveStatus === "saved") setSaveStatus("idle");
    },
    [errorMessage, saveStatus],
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <LinkIcon className="size-4" aria-hidden />
            Fathom Recording
          </CardTitle>
          <StatusIndicator status={saveStatus} savedAt={savedAt} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor={`fathom-link-${meetingId}`} className="sr-only">
            Fathom recording URL
          </Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id={`fathom-link-${meetingId}`}
              type="url"
              inputMode="url"
              placeholder="https://fathom.video/call/..."
              value={value}
              onChange={(e) => handleChange(e.target.value)}
              onKeyDown={(e) => {
                // Enter submits, Escape resets
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (hasUnsavedChanges && !isEmpty) handleSave();
                }
                if (e.key === "Escape") handleChange(initialLink);
              }}
              disabled={saveStatus === "saving"}
              aria-invalid={saveStatus === "error"}
              aria-describedby={errorMessage ? `fathom-error-${meetingId}` : undefined}
              className={cn(
                "font-mono text-sm",
                saveStatus === "error" && "border-destructive",
              )}
            />
            <Button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === "saving" || isEmpty || !hasUnsavedChanges}
              className="sm:w-auto"
            >
              {saveStatus === "saving" ? (
                <Spinner className="size-4" data-icon="inline-start" />
              ) : (
                <SaveIcon className="size-4" data-icon="inline-start" aria-hidden />
              )}
              {saveStatus === "saving" ? "Saving…" : "Save"}
            </Button>
          </div>
          {errorMessage && (
            <p
              id={`fathom-error-${meetingId}`}
              role="alert"
              className="flex items-center gap-1 text-xs text-destructive"
            >
              <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
              {errorMessage}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Paste your Fathom recording link for this meeting.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusIndicator({
  status,
  savedAt,
}: {
  status: SaveStatus;
  savedAt: number | undefined;
}) {
  if (status === "saving") {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Spinner className="size-3" aria-hidden />
        Saving…
      </span>
    );
  }
  if (status === "saved" || (status === "idle" && savedAt)) {
    if (!savedAt) return null;
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-500">
        <CheckCircle2Icon className="size-3" aria-hidden />
        Saved {format(new Date(savedAt), "h:mm a")}
      </span>
    );
  }
  return null;
}
```

**Step 3: Sanity-check hook dependencies**

- `useCallback` deps for `handleSave`: `[meetingId, saveFathomLink, value]`.
- `useCallback` deps for `handleChange`: `[errorMessage, saveStatus]`.
- The `saveFathomLink` mutation reference is stable across renders (Convex guarantees this), so including it in deps is cheap.

**Step 4: Test responsiveness in dev**

Verify:
- Mobile (320–640px): Input stacks above button.
- Tablet+ (640px+): Input and button are side-by-side (flex-row).
- Dark mode: StatusIndicator emerald color uses the `dark:` variant, border-destructive applies cleanly.

**Key implementation notes:**
- **Explicit Save button, NOT debounced auto-save.** Unlike `MeetingNotes` (which auto-saves as you type), the Fathom link is a discrete artifact — the closer pastes once. A Save button gives clear confirmation and matches users' mental model for URL inputs.
- **Enter submits.** Power users expect keyboard-first URL entry. Enter triggers `handleSave` if the form is in a saveable state.
- **Escape resets.** Accessibility nicety — quick undo for mis-pastes.
- **`sr-only` label via shadcn `Label`.** The visual title is "Fathom Recording" in `CardTitle`; the input itself gets a screen-reader-only `<Label>` for form semantics.
- **`aria-invalid` + `role="alert"`.** Error state is announced to screen readers.
- **`inputMode="url"` + `type="url"`.** Mobile keyboards show the URL-friendly layout (slashes visible). Browsers apply minimal URL format hints without hard-rejecting non-URL input.
- **`hasUnsavedChanges` gates the Save button.** Prevents accidental re-save of the current value. Paired with `isEmpty` guard.
- **`useState` seeded from `initialLink` / `initialSavedAt` props.** On parent-driven re-renders (e.g., real-time Convex update from another tab), this component's state may drift from props. That's acceptable for this field — saves are rare and explicit. If it becomes an issue, add a `useEffect` that syncs state from props when the user isn't actively editing.
- **No Fathom URL validation.** Phase 3 decision (Section 13.4 of `overhaul-v2.md`). The backend accepts any non-empty string. If we wanted URL validation, we'd add `z.string().url()` in a Zod schema — but we're intentionally not doing that.
- **PostHog event** `meeting_fathom_link_saved` tracks the action; use `hasLink: true` as a property. Do NOT log the actual URL value (privacy).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/fathom-link-field.tsx` | Create | New reusable component (used in 4E and Phase 5A) |

---

### 4B — `OutcomeActionBar` — Review-Aware Overran Actions

**Type:** Frontend (component modification)
**Parallelizable:** Yes — different file from 4A, 4C, 4D. 4E consumes the updated props signature.

**What:** Modify `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` to:
1. Accept a new optional prop `meetingReview?: Doc<"meetingReviews"> | null`.
2. Replace the v1 early return (`if (opportunity.status === "meeting_overran") return null;`) with a nuanced check: show actions if opportunity is in an actionable state OR if it's `meeting_overran` with a **pending** review; hide if `meeting_overran` with a **resolved** review.
3. Enable Log Payment, Schedule Follow-Up, Mark No-Show, Mark as Lost on overran-with-pending-review (in addition to the existing in_progress behavior).

**Why:** v2 requires the closer to take normal outcome actions on flagged meetings while the admin has not yet resolved the review. Once resolved, the flow locks (backend also rejects — Phase 2 guards).

**Where:**
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)

**How:**

**Step 1: Extend props**

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

// BEFORE:
type OutcomeActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  payments: Doc<"paymentRecords">[];
  onStatusChanged?: () => Promise<void>;
};

// AFTER:
type OutcomeActionBarProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  payments: Doc<"paymentRecords">[];
  /**
   * v2: Meeting review record (if any). When the opportunity is
   * `meeting_overran`, overran actions render only while review.status === "pending".
   * Resolved reviews lock the action set (backend also rejects — defense in depth).
   */
  meetingReview?: Doc<"meetingReviews"> | null;
  onStatusChanged?: () => Promise<void>;
};
```

**Step 2: Replace the state derivation block**

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

// BEFORE (line ~140–147):
const isScheduled = opportunity.status === "scheduled";
const isInProgress = opportunity.status === "in_progress";
const isNoShow = opportunity.status === "no_show";
const isCanceled = opportunity.status === "canceled";

if (isNoShow) return null;
if (opportunity.status === "meeting_overran") return null;

// AFTER:
const isScheduled = opportunity.status === "scheduled";
const isInProgress = opportunity.status === "in_progress";
const isNoShow = opportunity.status === "no_show";
const isCanceled = opportunity.status === "canceled";
const isMeetingOverran = opportunity.status === "meeting_overran";
const isPendingOverranReview =
  isMeetingOverran && meetingReview?.status === "pending";
const isResolvedOverranReview =
  isMeetingOverran && meetingReview?.status === "resolved";

if (isNoShow) return null;
// v2: Resolved overran reviews lock the action bar. Pending reviews do not.
if (isResolvedOverranReview) return null;

// Catch-all: if the opportunity is in a terminal/unknown state AND not a
// pending-overran-review case, return null.
if (
  !isScheduled &&
  !isInProgress &&
  !isCanceled &&
  !isPendingOverranReview
) {
  return null;
}
```

**Step 3: Update the conditional rendering of individual action buttons**

The v1 file renders each action based on `isInProgress` or `isInProgress || isCanceled`. Add `|| isPendingOverranReview` as appropriate per the action matrix from Section 7.1 of `overhaul-v2.md`:

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

{/* Start Meeting — unchanged (scheduled only, within window) */}
{isScheduled && windowStatus !== "outside_window" && (
  <Button onClick={handleStartMeeting} disabled={isStarting}>
    <PlayIcon data-icon="inline-start" />
    Start Meeting
  </Button>
)}

{/* Log Payment — in_progress OR pending overran review */}
{(isInProgress || isPendingOverranReview) && (
  <PaymentFormDialog
    opportunityId={opportunity._id}
    meetingId={meeting._id}
    onSuccess={onStatusChanged}
  />
)}

{/* Schedule Follow-Up — in_progress OR canceled OR pending overran review */}
{(isInProgress || isCanceled || isPendingOverranReview) && (
  <FollowUpDialog
    opportunityId={opportunity._id}
    onSuccess={onStatusChanged}
  />
)}

{/* Separator — shown before destructive actions */}
{(isInProgress || isPendingOverranReview) && <Separator />}

{/* Mark No-Show — in_progress OR pending overran review */}
{(isInProgress || isPendingOverranReview) && (
  <>
    <Button variant="outline" onClick={() => setShowNoShowDialog(true)}>
      <UserXIcon data-icon="inline-start" />
      Mark No-Show
    </Button>
    <MarkNoShowDialog
      open={showNoShowDialog}
      onOpenChange={setShowNoShowDialog}
      meetingId={meeting._id}
      startedAt={meeting.startedAt}
      onSuccess={onStatusChanged}
    />
  </>
)}

{/* Mark as Lost — in_progress OR pending overran review */}
{(isInProgress || isPendingOverranReview) && (
  <MarkLostDialog
    opportunityId={opportunity._id}
    onSuccess={onStatusChanged}
  />
)}
```

**Step 4: Update `MarkNoShowDialog` invocation to pass `startedAt`**

The `MarkNoShowDialog` already accepts `startedAt` (per v1). For overran meetings, `meeting.startedAt` is `undefined` — the dialog's internal code handles this (Section 14.8 of `overhaul-v2.md`): the wait-duration timer hides when `startedAt` is undefined. No dialog change needed.

**Step 5: Verify no other action logic references `meeting_overran`**

Search within the file for any other `meeting_overran` check and ensure it's been removed or updated. Most v1 checks were the single early-return on line ~147 — but verify by grepping.

**Key implementation notes:**
- **`isPendingOverranReview` requires BOTH opportunity status === `meeting_overran` AND review.status === `pending`.** If `meetingReview` is `null` (no review row for this meeting, which can happen for non-flagged meetings or if the review was hard-deleted), `isPendingOverranReview` is false → catch-all returns null → nothing shown. That's correct; a flagged-but-unreviewed meeting shouldn't be actionable.
- **Defensive catch-all.** The final `if (!isScheduled && !isInProgress && !isCanceled && !isPendingOverranReview) return null;` ensures we never render an empty action bar for unknown statuses (e.g., `payment_received`, `lost`, `follow_up_scheduled`).
- **Do NOT break `canceled` behavior.** The existing `isCanceled`-only flow for Schedule Follow-Up must keep working.
- **The "Start Meeting" button** only appears when `isScheduled` AND within the time window. Overran meetings are never `scheduled`, so this condition naturally excludes them — no change needed.
- **Defense-in-depth with backend.** Even if a stale client renders a button it shouldn't, Phase 2's backend guards reject the mutation. UI is for usability; backend is for security.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | Add `meetingReview` prop, replace early-return, enable overran actions on pending review |

---

### 4C — `MeetingOverranBanner` — Persistent Informational Banner (4 States)

**Type:** Frontend (component modification — large rewrite)
**Parallelizable:** Yes — different file from 4A, 4B, 4D. 4E consumes the updated props signature.

**What:** Significantly rewrite `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx`:
1. Remove the v1 "Provide Context" button and `MeetingOverranContextDialog` import. The banner is now **informational** — no embedded actions. (The file `meeting-overran-context-dialog.tsx` itself is deleted in Phase 6; its import is removed here.)
2. Remove the inline "Schedule Follow-Up" form (v1 had an inline legacy v1 follow-up flow).
3. Accept a new `opportunityStatus` prop so the banner can communicate where in the lifecycle the review is.
4. Render 4 distinct visual states based on review `status` + `resolutionAction` + opportunity status:
   - **pending + still overran** (amber) — flagged, awaiting closer action.
   - **pending + closer already acted** (blue) — action recorded, awaiting admin.
   - **resolved + acknowledged** (emerald) — admin confirmed the outcome.
   - **resolved + disputed** (red) — admin reverted; overran is terminal.
5. Stay visible whenever `meetingReview` exists — do NOT hide when `opportunity.status !== "meeting_overran"`. The `meeting-detail-page-client.tsx` gate in 4E checks `meetingReview` existence, not status.

**Why:** The v1 banner had two problems in v2: (a) it disappeared as soon as the closer took action (because the opportunity left `meeting_overran`), leaving the closer with no context about a pending review; (b) it embedded the "Provide Context" dialog which has been removed. The v2 banner is purely informational, always visible while a review exists, and communicates the current lifecycle state.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` (modify — effectively rewrite)

**How:**

**Step 1: Rewrite imports and props**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-overran-banner.tsx
"use client";

import { format } from "date-fns";
import { AlertTriangleIcon, CheckCircle2Icon, InfoIcon, ShieldAlertIcon } from "lucide-react";

import type { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// REMOVED from v1:
// - useMutation imports (no longer submits from banner)
// - MeetingOverranContextDialog import (dialog is deleted in Phase 6)
// - inline form state (useState for follow-up form) — follow-up is via OutcomeActionBar now

type MeetingOverranBannerProps = {
  meeting: Doc<"meetings">;
  meetingReview: Doc<"meetingReviews">;
  /**
   * v2: Current opportunity status so the banner can communicate
   * "still flagged / awaiting closer action" vs "closer acted / awaiting admin".
   */
  opportunityStatus: Doc<"opportunities">["status"];
};
```

**Step 2: Derive the state flags**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-overran-banner.tsx

export function MeetingOverranBanner({
  meeting,
  meetingReview,
  opportunityStatus,
}: MeetingOverranBannerProps) {
  const reviewPending = meetingReview.status === "pending";
  const reviewResolved = meetingReview.status === "resolved";
  const closerAlreadyActed = opportunityStatus !== "meeting_overran";
  const resolutionAction = meetingReview.resolutionAction;
  const isDisputed = reviewResolved && resolutionAction === "disputed";
  const isAcknowledged = reviewResolved && !isDisputed;

  const overranDetectedAt = meeting.overranDetectedAt ?? meetingReview.createdAt;
```

**Step 3: Render the 4-state banner**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-overran-banner.tsx (continued)

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-lg border p-4",
        // 4-state color system
        reviewPending && !closerAlreadyActed &&
          "border-amber-200/60 bg-amber-50/60 dark:border-amber-800/30 dark:bg-amber-950/20",
        reviewPending && closerAlreadyActed &&
          "border-blue-200/60 bg-blue-50/60 dark:border-blue-800/30 dark:bg-blue-950/20",
        isAcknowledged &&
          "border-emerald-200/60 bg-emerald-50/60 dark:border-emerald-800/30 dark:bg-emerald-950/20",
        isDisputed &&
          "border-red-200/60 bg-red-50/60 dark:border-red-800/30 dark:bg-red-950/20",
      )}
    >
      <div className="flex items-start gap-3">
        <StateIcon
          isPendingAwaitingCloser={reviewPending && !closerAlreadyActed}
          isPendingAwaitingAdmin={reviewPending && closerAlreadyActed}
          isAcknowledged={isAcknowledged}
          isDisputed={isDisputed}
        />
        <div className="flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              className={cn(
                "text-sm font-semibold",
                reviewPending && !closerAlreadyActed && "text-amber-900 dark:text-amber-200",
                reviewPending && closerAlreadyActed && "text-blue-900 dark:text-blue-200",
                isAcknowledged && "text-emerald-900 dark:text-emerald-200",
                isDisputed && "text-red-900 dark:text-red-200",
              )}
            >
              {reviewPending && !closerAlreadyActed && "Meeting Overran — Flagged for Review"}
              {reviewPending && closerAlreadyActed && "Action Recorded — Awaiting Admin Review"}
              {isAcknowledged && "Review Acknowledged"}
              {isDisputed && "Review Disputed"}
            </h3>
            {reviewPending && <Badge variant="outline" className="text-[10px]">Needs Attention</Badge>}
          </div>

          <p className="text-sm text-muted-foreground">
            {reviewPending && !closerAlreadyActed && (
              <>
                The system did not detect any activity on this meeting. Save your Fathom
                recording link below, then take the appropriate outcome action (Log Payment,
                Schedule Follow-Up, Mark No-Show, or Mark as Lost). An admin will validate.
              </>
            )}
            {reviewPending && closerAlreadyActed && (
              <>
                Your action has been recorded and is awaiting admin validation.
                If the admin disputes the outcome, it will revert to "meeting overran".
              </>
            )}
            {isAcknowledged && (
              <>
                This review was acknowledged by an admin. The current outcome stands.
              </>
            )}
            {isDisputed && (
              <>
                This review was disputed by an admin. "Meeting overran" is the final outcome —
                any action you took has been reverted.
              </>
            )}
          </p>

          <p className="text-xs text-muted-foreground">
            Flagged {format(new Date(overranDetectedAt), "MMM d, yyyy 'at' h:mm a")}
            {meetingReview.resolvedAt && (
              <>
                {" · "}
                Resolved {format(new Date(meetingReview.resolvedAt), "MMM d 'at' h:mm a")}
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

function StateIcon({
  isPendingAwaitingCloser,
  isPendingAwaitingAdmin,
  isAcknowledged,
  isDisputed,
}: {
  isPendingAwaitingCloser: boolean;
  isPendingAwaitingAdmin: boolean;
  isAcknowledged: boolean;
  isDisputed: boolean;
}) {
  if (isPendingAwaitingCloser) {
    return <AlertTriangleIcon className="size-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
  }
  if (isPendingAwaitingAdmin) {
    return <InfoIcon className="size-5 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />;
  }
  if (isAcknowledged) {
    return <CheckCircle2Icon className="size-5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  }
  if (isDisputed) {
    return <ShieldAlertIcon className="size-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />;
  }
  return null;
}
```

**Step 4: Remove legacy v1 code**

Delete from the file:
- `useState` calls for `showFollowUpForm`, etc.
- `useMutation(api.closer.meetingOverrun.respondToOverranReview)` and related.
- The v1 "Provide Context" button block.
- The v1 inline follow-up form block.
- The v1 closer response summary section (the one that displayed `closerResponse`, `closerStatedOutcome`, `estimatedMeetingDurationMinutes`, `closerNote`, `respondedAt`). That summary was v1's "what did the closer say" block; in v2 the admin sees this in `ReviewContextCard` (Phase 5), and the closer doesn't need to see their own response back here.

**Key implementation notes:**
- **Pure presentational.** The banner dispatches zero mutations; it only reads state and renders. All actions moved to `OutcomeActionBar`.
- **`role="status"` + `aria-live="polite"`.** When the banner state changes (e.g., admin resolves the review while the closer is on the page), screen readers announce the change politely.
- **4 colors cover all state transitions.** Amber → Blue (closer acts) → Emerald (admin acknowledges) OR Red (admin disputes). No gaps.
- **The `meeting.overranDetectedAt ?? meetingReview.createdAt` fallback** handles legacy data where `overranDetectedAt` might be missing on old meetings.
- **`Resolved {...}` suffix** only appears if `resolvedAt` exists — i.e., the review is resolved.
- **Do NOT show the v1 closer response data.** Those fields (`closerResponse`, `closerStatedOutcome`, etc.) are deprecated in v2 usage but kept in schema. The closer doesn't need to see their own response in the banner — the admin sees it in `ReviewContextCard`.
- **Do NOT show the resolution note to the closer.** The `resolutionNote` is admin-internal context. If we ever want to show admin feedback to closers, that's a future design.
- **Banner does NOT include the Fathom link display.** That's `FathomLinkField`'s job (rendered separately in the page layout).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | Modify | Rewrite as pure-informational 4-state banner |

---

### 4D — `MarkLostDialog` — Correct the "Permanent" Copy

**Type:** Frontend (copy fix — 5 min)
**Parallelizable:** Yes — different file from 4A, 4B, 4C. Not blocked by anything in Phase 4.

**What:** Update the `AlertDialog` description in `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx`. The v1 copy says the action is "permanent and cannot be undone" — in v2 this is false for flagged meetings (the admin can dispute and revert). Replace with a truthful message.

**Why:** Misleading copy damages user trust. The action is still destructive (opportunity → lost), but the admin's dispute power means it's not strictly permanent for flagged meetings.

**Where:**
- `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` (modify)

**How:**

**Step 1: Locate the `AlertDialogDescription` inside `MarkLostDialog`**

The description will look something like:

```tsx
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx — BEFORE

<AlertDialogDescription>
  This will mark the opportunity as lost. This action is permanent and cannot be undone.
</AlertDialogDescription>
```

**Step 2: Replace with v2 copy**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-lost-dialog.tsx — AFTER

<AlertDialogDescription>
  This marks the opportunity as lost. If this meeting is under overran review,
  an admin may still dispute the outcome and revert the opportunity.
</AlertDialogDescription>
```

**Step 3: Leave the destructive button variant and reason field unchanged**

The warning tone (red destructive button, "Are you sure?" framing) stays — "lost" is still a strong decision. We only correct the factual claim about permanence.

**Key implementation notes:**
- **Single-line copy change.** The component state, form logic, and submit flow are unchanged.
- **No matching update needed in `MarkNoShowDialog`.** v1 `MarkNoShowDialog` did not claim permanence (it already implied reversibility via the Calendly webhook reversal path). Verify by reading the existing `mark-no-show-dialog.tsx` and update only if it makes a similar permanence claim — it does not in practice.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Modify | Update AlertDialogDescription copy |

---

### 4E — `meeting-detail-page-client.tsx` — Integration

**Type:** Frontend (page wiring)
**Parallelizable:** No — depends on 4A (FathomLinkField component exists), 4B (OutcomeActionBar accepts `meetingReview` prop), and 4C (MeetingOverranBanner accepts `opportunityStatus` prop). 4D is not a hard dependency but should land before 4E for a clean end-to-end demo.

**What:** Modify `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` to:
1. Render `MeetingOverranBanner` whenever `meetingReview` exists (regardless of `opportunity.status`).
2. Pass `meetingReview` into `OutcomeActionBar`.
3. Insert `FathomLinkField` above `MeetingNotes` in the page layout.

**Why:** The integration is the moment the three new behaviors become user-visible. Without this wiring, 4A-4D are orphaned code.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Import `FathomLinkField`**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// ADD to imports:
import { FathomLinkField } from "../../_components/fathom-link-field";

// Existing imports remain — MeetingOverranBanner, OutcomeActionBar, MeetingNotes, etc.
```

**Step 2: Update the banner render block**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (approx lines 202–211):
{opportunity.status === "meeting_overran" && meetingReview && (
  <MeetingOverranBanner
    meeting={meeting}
    meetingReview={meetingReview}
  />
)}

// AFTER: Render whenever the review record exists — status-independent.
{meetingReview && (
  <MeetingOverranBanner
    meeting={meeting}
    meetingReview={meetingReview}
    opportunityStatus={opportunity.status}
  />
)}
```

**Step 3: Update the `OutcomeActionBar` render block**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (approx lines 178–186):
<OutcomeActionBar
  meeting={meeting}
  opportunity={opportunity}
  payments={payments}
  onStatusChanged={refreshDetail}
/>

// AFTER:
<OutcomeActionBar
  meeting={meeting}
  opportunity={opportunity}
  payments={payments}
  meetingReview={meetingReview}  // v2: review-aware overran actions
  onStatusChanged={refreshDetail}
/>
```

**Step 4: Insert `FathomLinkField` above `MeetingNotes`**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

// BEFORE (approx lines 251–258):
<AttributionCard ... />
<MeetingNotes
  meetingId={meeting._id}
  initialNotes={meeting.notes ?? ""}
  meetingOutcome={meeting.meetingOutcome}
/>
<PaymentLinksPanel ... />

// AFTER:
<AttributionCard ... />

{/* v2: Fathom Recording Link — available on ALL meetings */}
<FathomLinkField
  meetingId={meeting._id}
  initialLink={meeting.fathomLink ?? ""}
  savedAt={meeting.fathomLinkSavedAt}
/>

<MeetingNotes
  meetingId={meeting._id}
  initialNotes={meeting.notes ?? ""}
  meetingOutcome={meeting.meetingOutcome}
/>
<PaymentLinksPanel ... />
```

**Step 5: Verify `meetingReview` is in the query result**

Confirm that `getMeetingDetail` (the query backing this page) returns `meetingReview` — per the repo survey this is already the case (lines 80, 256–257, 278 of `convex/closer/meetingDetail.ts`). No backend change needed for this integration.

**Step 6: `expect` verification pass**

Delegate to the `expect` skill for browser verification:

```
Use expect to open /workspace/closer/meetings/<test-overran-meeting-id>,
verify the banner renders with amber "Meeting Overran — Flagged for Review",
verify FathomLinkField is visible above MeetingNotes, verify OutcomeActionBar
shows all 4 actions. Then simulate "Log Payment" submission. Verify:
- Banner flips to blue "Action Recorded — Awaiting Admin Review"
- Fathom field still shows saved value
- OutcomeActionBar returns null (payment_received is terminal and not a
  meeting_overran state — so isResolvedOverranReview is false but the
  catch-all returns null because the status is not in the allowed list)
- No console errors
- Axe audit passes (zero violations)
- LCP < 2.5s

Then open a resolved-disputed review meeting and verify the red banner
+ disputed copy. Test at 4 viewports (360, 768, 1024, 1440).
```

**Key implementation notes:**
- **Banner mount gate changes from status-based to record-based.** `meetingReview` truthy → render. This is the key v2 change.
- **Layout position of `FathomLinkField` is NOT above the banner** — it goes into the main content column, just above `MeetingNotes`. The banner sits at the top of the page for visibility; the field sits in the content flow because every meeting has it, flagged or not.
- **The `refreshDetail` prop on `OutcomeActionBar`** is unchanged — it triggers a re-fetch of the meeting-detail query, which pulls the latest `meetingReview`, opportunity status, and meeting status. Convex reactivity should also propagate most changes automatically, but the explicit refresh ensures cross-field consistency.
- **No `loading.tsx` change needed.** The existing route-level skeleton covers the page during navigation. The new FathomLinkField has no additional loading state beyond its internal "Saving…" indicator.
- **No new server-side auth change.** `/workspace/closer/meetings/[id]/page.tsx` already uses `requireWorkspaceUser()` and scopes meetings to the closer. The new FathomLinkField works under the same auth context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Import FathomLinkField, update banner gate, pass meetingReview, insert FathomLinkField above MeetingNotes |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/fathom-link-field.tsx` | Create | 4A (new reusable component) |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | 4B (review-aware actions) |
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | Modify | 4C (4-state persistent informational banner) |
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Modify | 4D (copy correction) |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 4E (integration: banner, action bar props, FathomLinkField placement) |

**Post-phase state:** The closer experience is fully v2-aligned. The banner persists across the review lifecycle with four states; the action bar enables real outcome actions on pending-review overran meetings; the Fathom link field is available on every meeting; the mark-lost copy is honest. Phase 5's admin UI can render the same Fathom field on the admin meeting detail page (Phase 5A depends on 4A). `pnpm tsc --noEmit` passes. Accessibility audit passes on all 4 banner states.

**Critical path:** 4E is on the critical path for the closer demo. 4A is a soft dependency for Phase 5 (admin meeting detail reuses FathomLinkField — coordinate with 5A).
