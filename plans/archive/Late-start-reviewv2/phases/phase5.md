# Phase 5 — Frontend: Admin Review Updates

**Goal:** Extend the admin review pipeline UI with v2 semantics: surface the Fathom recording link as first-class evidence in the review context card, show an active-follow-up card when the closer created a follow-up that left the opportunity in `meeting_overran`, add a "Dispute" resolution button (and its destructive-variant dialog), narrow the resolution-bar action set to `Acknowledge` / `Dispute` when the closer has already acted, replace v1-era reviews-table columns (closer self-reported fields) with v2 evidence signals (Fathom presence / current state / active follow-up), and reuse `FathomLinkField` on the admin meeting detail page so admins can save/update Fathom links directly. After this phase, a tenant admin can fully validate (acknowledge) or reject (dispute) any v2 review with complete evidence visibility.

**Prerequisite:**
- **Phase 1 complete.** `meetingReviews.resolutionAction` accepts `"disputed"`.
- **Phase 3C complete.** `listPendingReviews` and `getReviewDetail` return `activeFollowUp`. Without this, the admin UI cannot detect "closer already acted via follow-up on still-overran" cases.
- **Phase 3D complete.** The `resolveReview` backend accepts `resolutionAction: "disputed"` and enforces the closer-already-acted gate. Without this, the UI would call a mutation that rejects at the validator.
- **Phase 4A complete.** `FathomLinkField` component is authored and stable (5A reuses it verbatim).
- **Phase 4** completion is NOT required overall for Phase 5 to start — 5A depends on 4A only. 5B–5F are independent of other Phase 4 subphases.

**Runs in PARALLEL with:** Phase 4 (Frontend — Closer UX Overhaul). Both are frontend streams. **Shared file concern:** `app/workspace/closer/meetings/_components/fathom-link-field.tsx` — created in 4A, imported in 5A. Not modified in Phase 5. Treat as a read-only dependency.

**Skills to invoke:**
- `frontend-design` — The admin review detail page is the admin's primary decision surface. Investment in evidence clarity (Fathom card, active follow-up card) directly improves decision quality. Apply distinctive, polished UI.
- `shadcn` — Use `Card`, `Badge`, `Button`, `AlertDialog` primitives. Verify `ShieldAlertIcon` in `lucide-react` for the dispute action.
- `web-design-guidelines` — WCAG audit: dispute button must use destructive variant with sufficient contrast; resolved-disputed state in context card must not rely on color alone (include icon + text); reviews table must be navigable by keyboard.
- `vercel-react-best-practices` — Avoid waterfall renders on the review detail. The `preloadQuery` pattern is already in place (Phase 4 context survey). Ensure new data (`activeFollowUp`) is consumed from the same preloaded query.
- `expect` — Browser-verify: admin opens a review where closer logged payment → dispute → verify opportunity reverts, payment marked disputed, customer rollback happens, banner flips to red on closer view. Test all 4 "closer already acted" sub-states (acted-via-status, acted-via-follow-up-with-scheduling-link, acted-via-follow-up-with-manual-reminder, not-acted). Accessibility audit across review detail and reviews table.

**Acceptance Criteria:**
1. Admin navigates to `/workspace/reviews/[id]` for a pending review → `ReviewContextCard` shows a **Fathom Recording** card:
   - If `meeting.fathomLink` is set: card displays the clickable URL (opens in new tab via `rel="noopener noreferrer"`) + "Saved {time}" label.
   - If not set: card shows amber "No Fathom link provided" with `AlertTriangleIcon`.
2. `ReviewContextCard` shows an **Current Follow-Up** card when `activeFollowUp` is non-null, displaying type (Manual reminder / Scheduling link), status (`pending`), and `reminderScheduledAt` when present.
3. `ReviewResolutionBar` on a pending review WHERE the closer has not acted (opportunity still `meeting_overran` AND no active follow-up) shows 6 buttons: Log Payment, Schedule Follow-Up, Mark No-Show, Mark as Lost, Acknowledge, **Dispute** (new).
4. `ReviewResolutionBar` on a pending review WHERE the closer has acted (opportunity status !== "meeting_overran" OR active follow-up exists) shows only 2 buttons: Acknowledge, Dispute. Above the bar, a contextual message explains what the closer already did (`"The closer has already taken action — the opportunity is now <status>. You may acknowledge or dispute that action."` OR `"The closer already created a <manual reminder|scheduling link> while leaving the opportunity in meeting overran. You may acknowledge or dispute that action."`).
5. Clicking Dispute opens `ReviewResolutionDialog` with title "Dispute Review" and description explaining the revert behavior + audit preservation; the submit button label is "Dispute & Finalize" with `destructive` variant.
6. Clicking "Dispute & Finalize" calls `resolveReview({ resolutionAction: "disputed", resolutionNote })`, the mutation succeeds, the page navigates back to `/workspace/reviews` (or the detail page re-fetches), and the review row in the table now shows the `Disputed` resolution label.
7. `ReviewContextCard` displays `Disputed` label and a red/destructive styling treatment on resolved-disputed reviews (not the green/success treatment used for acknowledged).
8. Admin meeting detail page `/workspace/pipeline/meetings/[id]` renders `FathomLinkField` above `MeetingNotes`. Saving a Fathom link from the admin page persists it and reflects the saved timestamp.
9. `ReviewsTable` columns replace v1 `Closer Said` + `Stated Outcome` with: **Fathom** (yes/no badge), **Current State** (opp status OR `Follow-up pending` OR `Disputed` for resolved-disputed rows), with the Lead/Closer/Detected/Action columns unchanged.
10. All `resolutionLabels` maps across the frontend include `disputed: "Disputed"`.
11. `ReviewDetailPageClient` passes `activeFollowUp` through to both `ReviewContextCard` and `ReviewResolutionBar`.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (admin-meeting-detail-client.tsx — reuse FathomLinkField) ──────────┐
                                                                        │  (independent from 5B–5F)
                                                                        │
5B (ReviewResolutionBar — add dispute, narrow on already-acted) ──┐    │
                                                                   │    │
5C (ReviewResolutionDialog — add dispute config) ─────────────────┤    │
                                                                   │    │
5D (ReviewContextCard — Fathom card, active follow-up, disputed) ─┼── 5F (ReviewDetailPageClient — integration: pass activeFollowUp)
                                                                   │
5E (ReviewsTable — v2 columns) ────────────────────────────────────┘
```

**Optimal execution:**
1. Start **5A, 5B, 5C, 5D, 5E in parallel** — each touches a different file.
2. Once 5B–5E are at least stable, run **5F** as the integration subphase — it wires the new `activeFollowUp` prop into the resolution bar and context card from the review detail page.
3. 5A runs independently in parallel the whole time — it doesn't touch review-pipeline files.

**Estimated time:** 2 days (16 hours — 1 hour for 5A, 3 hours for 5B, 2 hours for 5C, 4 hours for 5D with the two new cards and disputed styling, 3 hours for 5E column rework, 2 hours for 5F integration + testing, 1 hour for expect verification).

---

## Subphases

### 5A — `AdminMeetingDetailClient` — Reuse `FathomLinkField`

**Type:** Frontend (page modification)
**Parallelizable:** Yes — independent of all other 5* subphases. Only dependency is Phase 4A (FathomLinkField component exists).

**What:** Modify `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` to import and render `FathomLinkField` above `MeetingNotes`. The component is the same one from Phase 4A — no admin-specific variant.

**Why:** The Fathom link is a meeting attribute accessible to both closers (on their own meetings) and admins (on any tenant meeting). Reusing the component on the admin detail page gives admins the ability to save Fathom links for any meeting they're reviewing — useful when the closer forgot to paste it. The backend mutation `saveFathomLink` already authorizes admins (Phase 3A auth pattern).

**Where:**
- `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` (modify)

**How:**

**Step 1: Import the component**

```tsx
// Path: app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx

// ADD to imports:
import { FathomLinkField } from "@/app/workspace/closer/meetings/_components/fathom-link-field";
```

Note the import path: the component lives under `closer/meetings/_components/`. This is intentional — the component is shared; its location reflects where it was first introduced. A future refactor could move it to a neutral path like `components/meetings/` but that's out-of-scope for v2.

**Step 2: Insert `FathomLinkField` above `MeetingNotes`**

```tsx
// Path: app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx

// BEFORE (the v1 layout — approx lines 246–250):
<AttributionCard ... />
<MeetingNotes
  meetingId={meeting._id}
  initialNotes={meeting.notes ?? ""}
  meetingOutcome={meeting.meetingOutcome}
/>
{paymentLinks && paymentLinks.length > 0 && <PaymentLinksPanel ... />}

// AFTER:
<AttributionCard ... />

{/* v2: Fathom Recording Link — admin can save/update for any meeting */}
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
{paymentLinks && paymentLinks.length > 0 && <PaymentLinksPanel ... />}
```

**Step 3: Verify page-level authorization is already correct**

The admin meeting detail page uses `requireRole(["tenant_master", "tenant_admin"])` at the RSC level. That already excludes closers and system admin. The Fathom mutation (`saveFathomLink`) additionally enforces the same allowed roles at the mutation layer, so a closer hitting the admin URL would be rejected at both the page and the mutation.

**Key implementation notes:**
- **No component modification.** The existing `FathomLinkField` works verbatim on the admin page because its auth logic delegates entirely to the backend mutation (which accepts both closer and admin roles).
- **Admin-saved Fathom links show the admin's save timestamp.** There is no audit distinction between closer-saved and admin-saved links in the `meetings` document — just the latest `fathomLinkSavedAt`. If the product team later wants to distinguish, schema can add `fathomLinkSavedByUserId` — out of scope for v2.
- **Import path resilience.** If the component path is ever changed, this import must move with it. A simple `codemod` sweep or VS Code "find references" suffices.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | Modify | Import + render FathomLinkField above MeetingNotes |

---

### 5B — `ReviewResolutionBar` — Add Dispute Button + Narrow Actions When Closer Already Acted

**Type:** Frontend (component modification)
**Parallelizable:** Yes — different file from 5A, 5C, 5D, 5E.

**What:** Modify `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` to:
1. Add a `disputed` entry to `RESOLUTION_BUTTONS` with `ShieldAlertIcon` and `destructive` variant.
2. Accept a new prop `activeFollowUp: ActiveFollowUp | null`.
3. Compute `closerAlreadyActed = opportunityStatus !== "meeting_overran" || Boolean(activeFollowUp)`.
4. When `closerAlreadyActed`: filter the visible buttons to only `acknowledged` and `disputed`; render a contextual message above the bar explaining why the action set is narrowed.
5. When NOT `closerAlreadyActed`: show all 6 buttons.

**Why:** The admin's action set must reflect the review state. If the closer has already chosen an outcome (either via status move or via follow-up on still-overran), the admin can only validate (acknowledge) or reject (dispute) — not replace. This matches the backend gate in Phase 3D (the backend also rejects direct-override actions when the closer has acted; the frontend hides them for UX).

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` (modify)

**How:**

**Step 1: Extend `ResolutionAction` type and `RESOLUTION_BUTTONS`**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx

import {
  CalendarPlusIcon,
  CheckIcon,
  DollarSignIcon,
  ShieldAlertIcon,
  UserXIcon,
  XCircleIcon,
} from "lucide-react";

// BEFORE:
type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged";

// AFTER:
type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";

const RESOLUTION_BUTTONS: Array<{
  action: ResolutionAction;
  label: string;
  icon: typeof DollarSignIcon;
  variant: "default" | "outline" | "destructive" | "secondary";
}> = [
  { action: "log_payment", label: "Log Payment", icon: DollarSignIcon, variant: "default" },
  { action: "schedule_follow_up", label: "Schedule Follow-Up", icon: CalendarPlusIcon, variant: "outline" },
  { action: "mark_no_show", label: "Mark No-Show", icon: UserXIcon, variant: "outline" },
  { action: "mark_lost", label: "Mark as Lost", icon: XCircleIcon, variant: "destructive" },
  { action: "acknowledged", label: "Acknowledge", icon: CheckIcon, variant: "secondary" },
  // v2: New dispute action — reverts closer's outcome to meeting_overran.
  { action: "disputed", label: "Dispute", icon: ShieldAlertIcon, variant: "destructive" },
];
```

**Step 2: Extend the props**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx

type ActiveFollowUp = {
  _id: Id<"followUps">;
  type: "scheduling_link" | "manual_reminder";
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

// BEFORE:
type ReviewResolutionBarProps = {
  reviewId: Id<"meetingReviews">;
  closerResponse?: string;
  opportunityStatus: string;
};

// AFTER:
type ReviewResolutionBarProps = {
  reviewId: Id<"meetingReviews">;
  closerResponse?: string;
  opportunityStatus: string;
  /**
   * v2: Active pending follow-up on the review's opportunity.
   * Used to detect "closer acted via follow-up on still-overran opportunity".
   */
  activeFollowUp: ActiveFollowUp | null;
};
```

**Step 3: Update the filtering + messaging logic**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx

export function ReviewResolutionBar({
  reviewId,
  closerResponse,
  opportunityStatus,
  activeFollowUp,
}: ReviewResolutionBarProps) {
  const closerAlreadyActed =
    opportunityStatus !== "meeting_overran" || activeFollowUp !== null;

  const visibleButtons = closerAlreadyActed
    ? RESOLUTION_BUTTONS.filter(
        ({ action }) => action === "acknowledged" || action === "disputed",
      )
    : RESOLUTION_BUTTONS;

  // v1 highlight logic (ring around Acknowledge when opp already moved) is
  // preserved for legacy display when closerAlreadyActed is true.
  const highlightAcknowledge = closerAlreadyActed;

  return (
    <div className="rounded-lg border bg-card p-4">
      {/* Context message — v2 */}
      {opportunityStatus !== "meeting_overran" && (
        <p className="mb-3 text-sm text-muted-foreground">
          The closer has already taken action — the opportunity is now{" "}
          <strong>{opportunityStatus.replace(/_/g, " ")}</strong>. You may
          acknowledge or dispute that action.
        </p>
      )}
      {opportunityStatus === "meeting_overran" && activeFollowUp && (
        <p className="mb-3 text-sm text-muted-foreground">
          The closer already created a{" "}
          <strong>
            {activeFollowUp.type === "manual_reminder"
              ? "manual reminder"
              : "scheduling link"}
          </strong>{" "}
          while leaving the opportunity in meeting overran. You may acknowledge
          or dispute that action.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {visibleButtons.map(({ action, label, icon: Icon, variant }) => (
          <Button
            key={action}
            variant={variant}
            onClick={() => setSelectedAction(action)}
            className={cn(
              highlightAcknowledge && action === "acknowledged" &&
                "ring-2 ring-primary ring-offset-2",
            )}
          >
            <Icon className="mr-2 size-4" aria-hidden />
            {label}
          </Button>
        ))}
      </div>

      {/* Resolution dialog (5C) opens here when selectedAction is set */}
      <ReviewResolutionDialog
        reviewId={reviewId}
        resolutionAction={selectedAction}
        onClose={() => setSelectedAction(null)}
        onSuccess={handleResolved}
      />
    </div>
  );
}
```

(The `selectedAction` / `setSelectedAction` / `handleResolved` state wiring is unchanged from v1.)

**Key implementation notes:**
- **`closerAlreadyActed` logic matches Phase 3D backend gate.** This is the single source of truth — if the frontend and backend ever disagree, the backend wins (the mutation throws).
- **Dispute button uses `destructive` variant.** Red/destructive color signals irreversibility (for the admin: this finalizes the overran outcome and reverts closer actions).
- **`ShieldAlertIcon` from `lucide-react`.** Alternatives considered: `BanIcon` (too negative), `AlertOctagonIcon` (visual conflict with other alert icons), `XOctagonIcon` (same). `ShieldAlertIcon` conveys "admin shield / override" clearly.
- **Do NOT remove the v1 `highlightAcknowledge` ring.** When the closer acted via status move (opportunity !== "meeting_overran"), the ring on Acknowledge hints that this is usually the default admin response. The ring also applies when closer acted via follow-up — "ack is the default, unless you want to dispute".
- **Do NOT reorder RESOLUTION_BUTTONS.** Acknowledge and Dispute come last, in that order, so they're grouped visually; the direct-override actions come first for the fresh-review case.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | Modify | Add disputed button, narrow visible buttons on closerAlreadyActed, add contextual message |

---

### 5C — `ReviewResolutionDialog` — Add Disputed Action Config

**Type:** Frontend (component modification)
**Parallelizable:** Yes — different file from 5A, 5B, 5D, 5E.

**What:** Modify `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` to:
1. Extend `ResolutionAction` type to include `"disputed"`.
2. Add a `disputed` entry to `ACTION_CONFIG` with title "Dispute Review", description explaining revert + audit preservation, confirm label "Dispute & Finalize".
3. Update the `schedule_follow_up` entry's description to match v2 semantics (the opportunity stays in meeting overran).
4. Use `destructive` variant for both `mark_lost` and `disputed` submit buttons.

**Why:** The dialog is the confirmation gate for each resolution action. Without a dispute config entry, clicking the Dispute button would try to render a missing dialog title/description and crash.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` (modify)

**How:**

**Step 1: Extend `ResolutionAction` type**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx

// BEFORE:
type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged";

// AFTER:
type ResolutionAction =
  | "log_payment"
  | "schedule_follow_up"
  | "mark_no_show"
  | "mark_lost"
  | "acknowledged"
  | "disputed";
```

**Step 2: Update `ACTION_CONFIG`**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx

const ACTION_CONFIG = {
  log_payment: {
    title: "Log Payment",
    description:
      "Record a payment for this opportunity. If the closer claimed they attended, the meeting will be corrected to 'completed'.",
    confirmLabel: "Log Payment & Resolve",
  },
  schedule_follow_up: {
    title: "Schedule Follow-Up",
    description:
      "Create a follow-up for this lead and resolve the review. The opportunity will remain in 'meeting overran' — follow-ups do NOT transition terminal overran opportunities.",
    confirmLabel: "Create Follow-Up & Resolve",
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
    description:
      "Acknowledge this review without changing the opportunity or meeting status. Use when the closer has already handled the situation correctly.",
    confirmLabel: "Acknowledge & Resolve",
  },
  // v2: NEW disputed action.
  disputed: {
    title: "Dispute Review",
    description:
      "Dispute this review. The opportunity and meeting will revert to 'meeting overran' as the final outcome. " +
      "Any closer actions will be neutralized: disputed payments are marked invalid (reversing revenue + customer conversion if applicable), " +
      "pending follow-ups are expired, no-show and lost outcomes are reversed. Audit history is preserved.",
    confirmLabel: "Dispute & Finalize",
  },
} satisfies Record<
  ResolutionAction,
  { title: string; description: string; confirmLabel: string }
>;
```

**Step 3: Use `destructive` variant for the submit button when the action is `mark_lost` or `disputed`**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx

// In the submit button render:
<Button
  type="submit"
  variant={
    resolutionAction === "mark_lost" || resolutionAction === "disputed"
      ? "destructive"
      : "default"
  }
  disabled={isSubmitting}
>
  {isSubmitting ? <Spinner /> : null}
  {ACTION_CONFIG[resolutionAction].confirmLabel}
</Button>
```

**Step 4: Verify that no additional fields are needed for `disputed`**

The existing dialog form collects:
- `resolutionNote` (optional, always shown)
- `paymentData` (only for `log_payment`)
- `lostReason` (only for `mark_lost`)
- `noShowReason` (only for `mark_no_show`)

`disputed` does NOT require any additional field. The optional `resolutionNote` lets the admin add a short reason (e.g., "No Fathom link and no bank transfer found"). Leave the schedule_follow_up, log_payment, mark_no_show, mark_lost field-rendering conditions unchanged.

**Step 5: Submit path**

The existing submit handler calls `useMutation(api.reviews.mutations.resolveReview)` with the collected args. `disputed` flows through the same handler without modification — the mutation accepts `resolutionAction: "disputed"` (Phase 3D backend change) with only the optional `resolutionNote`.

**Key implementation notes:**
- **Dispute description is long.** It has to be — the dispute is a consequential action with multiple side effects. An admin clicking Dispute without reading the description is a UX failure. The long-form description makes the effects explicit.
- **`satisfies Record<ResolutionAction, {...}>`** gives TypeScript strict checking: if we add a new resolution action to the union later, the compiler will require an entry in `ACTION_CONFIG`. No silent fall-through.
- **Do NOT add a "Are you absolutely sure?" double-confirmation** for dispute. The admin clicked Dispute → dialog opens with full description → admin clicks "Dispute & Finalize" → that IS the confirmation. A second confirmation adds friction without value (admin already read the full description).
- **PostHog event** (optional but recommended) — `admin_review_resolved` with property `action: "disputed"` for analytics on dispute frequency.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | Modify | Extend ResolutionAction type, add disputed to ACTION_CONFIG, destructive variant for disputed |

---

### 5D — `ReviewContextCard` — Fathom Card, Active Follow-Up Card, Disputed Styling

**Type:** Frontend (component modification — large)
**Parallelizable:** Yes — different file from 5A, 5B, 5C, 5E.

**What:** Modify `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` to:
1. Add `disputed: "Disputed"` to `RESOLUTION_LABELS`.
2. Accept a new prop `activeFollowUp: ActiveFollowUp | null`.
3. Render a **Fathom Recording** card (above existing cards): link if `meeting.fathomLink` is set, "No Fathom link provided" (amber with icon) otherwise.
4. Render a **Current Follow-Up** card when `activeFollowUp` is non-null: type, status, reminder time.
5. Apply destructive (red) styling to the resolved resolution row when `resolutionAction === "disputed"` (not the green/success styling).

**Why:** The admin needs to see evidence at a glance. Fathom presence is the primary attendance signal. Active follow-up is the primary "closer already acted" signal (for the case where opportunity is still meeting_overran but the closer created a follow-up). Disputed resolutions need visually distinct treatment so a quick scroll through past reviews flags them correctly.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` (modify)

**How:**

**Step 1: Update imports and types**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-context-card.tsx

import {
  AlertTriangleIcon,
  CalendarPlusIcon,
  CheckCircle2Icon,
  LinkIcon,
  ShieldAlertIcon,
  UserIcon,
} from "lucide-react";
import { format } from "date-fns";

import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ActiveFollowUp = {
  _id: Id<"followUps">;
  type: "scheduling_link" | "manual_reminder";
  status: "pending";
  createdAt: number;
  reminderScheduledAt?: number;
};

type ReviewContextCardProps = {
  review: Doc<"meetingReviews">;
  meeting: Doc<"meetings">;
  closerName: string;
  closerEmail: string | null;
  resolverName: string | null;
  /**
   * v2: Active pending follow-up on the review's opportunity, from reviews
   * queries enrichment. Null when the closer hasn't created a follow-up.
   */
  activeFollowUp: ActiveFollowUp | null;
};
```

**Step 2: Update `RESOLUTION_LABELS`**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-context-card.tsx

const RESOLUTION_LABELS: Record<string, string> = {
  log_payment: "Payment Logged",
  schedule_follow_up: "Follow-Up Scheduled",
  mark_no_show: "Marked as No-Show",
  mark_lost: "Marked as Lost",
  acknowledged: "Acknowledged",
  disputed: "Disputed", // v2
};
```

**Step 3: Add Fathom Recording card (render as the FIRST card in the output)**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-context-card.tsx

export function ReviewContextCard({
  review,
  meeting,
  closerName,
  closerEmail,
  resolverName,
  activeFollowUp,
}: ReviewContextCardProps) {
  return (
    <div className="space-y-4">
      {/* v2: Fathom Recording evidence card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <LinkIcon className="size-4" aria-hidden />
            Fathom Recording
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {meeting.fathomLink ? (
            <div className="space-y-1">
              <a
                href={meeting.fathomLink}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-primary underline-offset-4 hover:underline"
              >
                {meeting.fathomLink}
              </a>
              {meeting.fathomLinkSavedAt && (
                <p className="text-xs text-muted-foreground">
                  Saved {format(new Date(meeting.fathomLinkSavedAt), "MMM d, yyyy 'at' h:mm a")}
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
              <span className="font-medium">No Fathom link provided</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* v2: Active Follow-Up card (only when closer created one on still-overran) */}
      {activeFollowUp && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarPlusIcon className="size-4" aria-hidden />
              Current Follow-Up
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">Type:</span>{" "}
              <span className="font-medium">
                {activeFollowUp.type === "manual_reminder"
                  ? "Manual reminder"
                  : "Scheduling link"}
              </span>
            </div>
            <div>
              <span className="text-muted-foreground">Status:</span>{" "}
              <Badge variant="outline" className="text-xs">{activeFollowUp.status}</Badge>
            </div>
            {activeFollowUp.reminderScheduledAt && (
              <div>
                <span className="text-muted-foreground">Reminder for:</span>{" "}
                {format(new Date(activeFollowUp.reminderScheduledAt), "MMM d, yyyy 'at' h:mm a")}
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              Created {format(new Date(activeFollowUp.createdAt), "MMM d, yyyy 'at' h:mm a")}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Existing System Detection + Closer Response + Resolution cards — below */}
      {/* ... keep v1 existing cards ... */}
    </div>
  );
}
```

**Step 4: Update the Resolution card to apply destructive styling for disputed**

The existing resolution card (displayed when `review.status === "resolved"`) uses a green success treatment. In v2, disputed resolutions need red destructive treatment. Find the resolved-review card block (typically uses `bg-emerald-50` / `text-emerald-700` or similar) and conditionally apply red when `resolutionAction === "disputed"`:

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-context-card.tsx

{review.status === "resolved" && (
  <Card
    className={cn(
      review.resolutionAction === "disputed"
        ? "border-red-200/60 bg-red-50/60 dark:border-red-800/30 dark:bg-red-950/20"
        : "border-emerald-200/60 bg-emerald-50/60 dark:border-emerald-800/30 dark:bg-emerald-950/20",
    )}
  >
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-base">
        {review.resolutionAction === "disputed" ? (
          <ShieldAlertIcon className="size-4 text-red-600 dark:text-red-400" aria-hidden />
        ) : (
          <CheckCircle2Icon className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        )}
        Resolution
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-2 text-sm">
      <div>
        <span className="text-muted-foreground">Action:</span>{" "}
        <span className="font-medium">
          {review.resolutionAction
            ? (RESOLUTION_LABELS[review.resolutionAction] ?? review.resolutionAction)
            : "—"}
        </span>
      </div>
      {review.resolutionNote && (
        <div>
          <span className="text-muted-foreground">Note:</span>{" "}
          <span>{review.resolutionNote}</span>
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        Resolved{" "}
        {review.resolvedAt
          ? format(new Date(review.resolvedAt), "MMM d, yyyy 'at' h:mm a")
          : "—"}{" "}
        by {resolverName ?? "—"}
      </div>
    </CardContent>
  </Card>
)}
```

**Key implementation notes:**
- **Fathom card is ALWAYS rendered** for resolved AND pending reviews. Missing Fathom on a resolved-acknowledged review is useful audit information.
- **Active Follow-Up card is ONLY rendered when `activeFollowUp !== null`.** No placeholder for the absent case.
- **Card ordering: Fathom → Active Follow-Up (if any) → System Detection (v1, kept) → Closer Response (v1, kept for legacy) → Resolution (v1, restyled).** Evidence-first, then system context, then decision.
- **Preserve the legacy Closer Response card.** v1 reviews in production have `closerResponse`, `closerStatedOutcome`, `estimatedMeetingDurationMinutes`, `closerNote`, `closerRespondedAt` populated. The card that displays these is unchanged — this is the "what did the closer say in v1" block that still provides value for historical reviews.
- **Use `ShieldAlertIcon` consistently** for dispute state across the admin UI (resolution bar in 5B, resolution card in 5D). Visual consistency = recognition.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` | Modify | Add Fathom card, Active Follow-Up card, disputed label + destructive styling |

---

### 5E — `ReviewsTable` — Replace v1 Columns with v2 Evidence Signals

**Type:** Frontend (component modification — medium)
**Parallelizable:** Yes — different file from 5A, 5B, 5C, 5D.

**What:** Modify `app/workspace/reviews/_components/reviews-table.tsx` to:
1. Replace the v1 columns `Closer Said` and `Stated Outcome` with v2 columns `Fathom` (yes/no badge) and `Current State` (opp status OR `Follow-up pending` OR `Disputed` for resolved-disputed rows).
2. Add `disputed: "Disputed"` to the inline resolution labels map (or shared labels if centralized).
3. Keep Lead / Closer / Detected / Action columns unchanged.

**Why:** v1 columns surfaced the closer's self-reported context (`forgot_to_press`, `sale_made`, etc.). In v2 that self-report is no longer authoritative; the admin decides based on **evidence** (Fathom presence, current opportunity state, active follow-up). Surfacing those signals in the list view lets the admin triage at a glance.

**Where:**
- `app/workspace/reviews/_components/reviews-table.tsx` (modify)

**How:**

**Step 1: Update the row type (if used locally) and consume `activeFollowUp`**

The `listPendingReviews` query from Phase 3C now returns `activeFollowUp` on each row. Update the local `EnrichedReview` type if necessary (it may auto-derive from the Convex query result type via `FunctionReturnType<typeof api.reviews.queries.listPendingReviews>[number]`).

```tsx
// Path: app/workspace/reviews/_components/reviews-table.tsx

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

type EnrichedReview =
  FunctionReturnType<typeof api.reviews.queries.listPendingReviews>[number];
```

(If `FunctionReturnType` is unavailable in the current Convex version, manually sync the local type with the Phase 3C return shape — the survey showed the local type is currently manually defined.)

**Step 2: Replace the column header row**

```tsx
// Path: app/workspace/reviews/_components/reviews-table.tsx

// BEFORE:
<TableRow>
  <TableHead>Lead</TableHead>
  <TableHead>Closer</TableHead>
  <TableHead>Closer Said</TableHead>
  <TableHead>Stated Outcome</TableHead>
  <TableHead>Detected</TableHead>
  <TableHead>Opp Status</TableHead>
  <TableHead className="text-right">Action</TableHead>
</TableRow>

// AFTER:
<TableRow>
  <TableHead>Lead</TableHead>
  <TableHead>Closer</TableHead>
  <TableHead>Fathom</TableHead>
  <TableHead>Current State</TableHead>
  <TableHead>Detected</TableHead>
  <TableHead className="text-right">Action</TableHead>
</TableRow>
```

(The v1 `Opp Status` column is absorbed into the new `Current State` column, which now shows opp status OR `"Follow-up pending"` for still-overran-with-followup rows OR `"Disputed"` for resolved-disputed rows.)

**Step 3: Update the row cell renders**

```tsx
// Path: app/workspace/reviews/_components/reviews-table.tsx

const resolutionLabels: Record<string, string> = {
  log_payment: "Payment Logged",
  schedule_follow_up: "Follow-Up Scheduled",
  mark_no_show: "Marked No-Show",
  mark_lost: "Marked Lost",
  acknowledged: "Acknowledged",
  disputed: "Disputed", // v2
};

// Inside the .map((row) => (...)) for each review row:
{rows.map((row) => {
  const { review, meeting, opportunity, activeFollowUp, leadName, closerName, ... } = row;

  // Determine Current State display:
  const currentStateLabel =
    review.status === "resolved"
      ? (review.resolutionAction ? (resolutionLabels[review.resolutionAction] ?? review.resolutionAction) : "Resolved")
      : opportunity?.status === "meeting_overran" && activeFollowUp
        ? "Follow-up pending"
        : opportunity?.status
          ? opportunityStatusConfig[opportunity.status as OpportunityStatus]?.label ?? opportunity.status
          : "—";

  return (
    <TableRow key={review._id} onClick={() => router.push(`/workspace/reviews/${review._id}`)}>
      <TableCell>{leadName}</TableCell>
      <TableCell>{closerName}</TableCell>

      {/* Fathom evidence */}
      <TableCell>
        {meeting?.fathomLink ? (
          <Badge variant="outline" className="text-xs text-emerald-700 dark:text-emerald-400">
            Provided
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs text-amber-700 dark:text-amber-400">
            Missing
          </Badge>
        )}
      </TableCell>

      {/* Current State */}
      <TableCell>
        {review.status === "resolved" && review.resolutionAction === "disputed" ? (
          <Badge variant="outline" className="text-xs text-red-700 dark:text-red-400">
            Disputed
          </Badge>
        ) : (
          <Badge variant="outline" className="text-xs">
            {currentStateLabel}
          </Badge>
        )}
      </TableCell>

      <TableCell>{format(new Date(review.createdAt), "MMM d, h:mm a")}</TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm">View</Button>
      </TableCell>
    </TableRow>
  );
})}
```

**Step 4: Confirm the table handles both `statusFilter: "pending"` and `statusFilter: "resolved"` query variants**

The v1 table handles both pending and resolved views via the `statusFilter` arg. The new columns work for both: `Fathom` evidence applies always; `Current State` shows the resolution label for resolved reviews and the opp status for pending ones.

**Key implementation notes:**
- **`FunctionReturnType` auto-sync.** Preferred over manual type re-declaration. If it's not available, manually sync and add a TypeScript comment flagging "keep in sync with listPendingReviews return shape".
- **Sparingly-used colors.** `Provided` (emerald) and `Missing` (amber) use muted tones so the table isn't a riot of color. `Disputed` (red) is the only truly saturated color — reserved for the signal that most demands attention.
- **Follow-up pending** is a derived label — the opp is in `meeting_overran` AND `activeFollowUp` exists. The frontend derives it rather than the backend for flexibility: if we later want to distinguish scheduling-link vs manual-reminder follow-up pending, we already have `activeFollowUp.type`.
- **Row click navigation is unchanged from v1** (`router.push(/workspace/reviews/[id])`).
- **Accessibility: keep `onClick` on the row but also render a `View` button in the last column** so keyboard-only users can navigate via tab-then-enter. Do NOT use `role="button"` on the row — let the button be the a11y-canonical interaction.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/_components/reviews-table.tsx` | Modify | Replace v1 columns with Fathom + Current State; add disputed label |

---

### 5F — `ReviewDetailPageClient` — Pass `activeFollowUp` Through

**Type:** Frontend (integration)
**Parallelizable:** No — depends on 5B (resolution bar accepts activeFollowUp prop) and 5D (context card accepts activeFollowUp prop).

**What:** Modify `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` to:
1. Extract `activeFollowUp` from the preloaded query result.
2. Pass `activeFollowUp` into both `ReviewContextCard` and `ReviewResolutionBar`.

**Why:** Without this wiring, the data added in Phase 3C is invisible to the UI components that need it.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` (modify)

**How:**

**Step 1: Extract `activeFollowUp` from the detail query result**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx

// BEFORE (approx lines 43–60):
const detail = usePreloadedQuery(preloadedDetail);
// ... null check / error handling ...
const { review, meeting, opportunity, lead, closerName, closerEmail, resolverName } = detail;

// AFTER:
const detail = usePreloadedQuery(preloadedDetail);
// ... null check / error handling ...
const {
  review,
  meeting,
  opportunity,
  lead,
  closerName,
  closerEmail,
  resolverName,
  activeFollowUp, // v2
} = detail;
```

**Step 2: Pass into `ReviewContextCard`**

```tsx
// BEFORE:
<ReviewContextCard
  review={review}
  meeting={meeting}
  closerName={closerName}
  closerEmail={closerEmail}
  resolverName={resolverName}
/>

// AFTER:
<ReviewContextCard
  review={review}
  meeting={meeting}
  closerName={closerName}
  closerEmail={closerEmail}
  resolverName={resolverName}
  activeFollowUp={activeFollowUp}
/>
```

**Step 3: Pass into `ReviewResolutionBar`**

```tsx
// BEFORE:
{review.status === "pending" && (
  <ReviewResolutionBar
    reviewId={review._id}
    closerResponse={review.closerResponse}
    opportunityStatus={opportunity.status}
  />
)}

// AFTER:
{review.status === "pending" && (
  <ReviewResolutionBar
    reviewId={review._id}
    closerResponse={review.closerResponse}
    opportunityStatus={opportunity.status}
    activeFollowUp={activeFollowUp}
  />
)}
```

**Step 4: Run `expect` verification**

Delegate to the `expect` skill for a full admin flow test:

```
Scenario 1: Seed a review where opportunity is meeting_overran, no follow-up, no fathom.
Open /workspace/reviews/<id>. Verify all 6 buttons (Log Payment, Schedule Follow-Up,
Mark No-Show, Mark as Lost, Acknowledge, Dispute) render. No context message above bar.

Scenario 2: Seed a review where closer created a scheduling-link follow-up
on a still-overran opportunity. Open the review. Verify only 2 buttons
(Acknowledge, Dispute). Verify contextual message "The closer already created
a scheduling link while leaving the opportunity in meeting overran."
Verify Current Follow-Up card shows Type: Scheduling link, Status: pending.

Scenario 3: Seed a review where closer logged payment (opp = payment_received).
Open the review. Verify only Acknowledge + Dispute. Click Dispute → dialog →
Dispute & Finalize. Verify: page navigates back / re-fetches, review shows
"Disputed" label in red, opportunity badge in the detail is now meeting_overran.

Scenario 4: Open the reviews list. Verify new columns: Fathom (Provided/Missing),
Current State. Verify resolved-disputed rows show red "Disputed" badge in
Current State.

Scenario 5: Navigate to /workspace/pipeline/meetings/<id> for an admin. Verify
FathomLinkField renders above MeetingNotes. Save a test Fathom URL. Reload.
Verify URL is saved.

Accessibility audit at every screen. All 4 viewports.
```

**Key implementation notes:**
- **Pure wiring.** No logic added here beyond prop-threading.
- **`activeFollowUp` from `detail` is typed via the preloaded query** — no manual type declaration needed.
- **If `activeFollowUp` is null**, the context card skips the Follow-Up card render entirely; the resolution bar's `closerAlreadyActed` computation evaluates `opportunityStatus !== "meeting_overran"` only.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | Modify | Extract activeFollowUp from preloaded query; pass to ReviewContextCard + ReviewResolutionBar |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | Modify | 5A (reuse FathomLinkField) |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | Modify | 5B (add dispute button, narrow actions, contextual message) |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | Modify | 5C (add disputed action config + destructive variant) |
| `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` | Modify | 5D (Fathom card, Active Follow-Up card, disputed label + red styling) |
| `app/workspace/reviews/_components/reviews-table.tsx` | Modify | 5E (replace v1 columns with Fathom + Current State; disputed label) |
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | Modify | 5F (pass activeFollowUp to context card + resolution bar) |

**Post-phase state:** Admin review pipeline is fully v2-aligned. Fathom evidence is surfaced in both the reviews table and the review detail. Dispute resolution is available with correct narrowing when the closer has already acted. Admin meeting detail page reuses the same Fathom field as the closer side. `pnpm tsc --noEmit` passes. `expect` browser verification passes for all 5 scenarios across 4 viewports.

**Critical path:** 5F is on the critical path for the admin demo. 5B + 5C + 5D must all land before 5F (integration). 5A is independent and can land any time after 4A.
