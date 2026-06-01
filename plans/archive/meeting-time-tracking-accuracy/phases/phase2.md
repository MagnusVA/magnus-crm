# Phase 2 — Explicit "End Meeting" Closer Button

**Goal:** After this phase, closers see a dedicated **End Meeting** button on the meeting detail page whenever the meeting is `in_progress`. Pressing it calls the existing `stopMeeting` mutation (extended to write `stoppedAtSource: "closer"`), pins the true meeting end time, and surfaces a success toast indicating any overrun. The button is visually separated into a "lifecycle row" that is independent of the "outcome row" — the closer can press End Meeting before or after recording an outcome, in any order, and the UI reacts correctly because meeting lifecycle (driven by `meeting.status`) and opportunity lifecycle (driven by `opportunity.status`) are fully decoupled.

**Prerequisite:** Phase 1 complete. Specifically:
- Schema field `meetings.stoppedAtSource` and `meetings.startedAtSource` deployed (from 1A).
- Generated types updated (`Doc<"meetings">` surfaces the new fields).
- Outcome-mutation contract comments in place (from 1C) — informational only, not a runtime dependency, but required for reviewer sanity.

**Runs in PARALLEL with:** **Phase 3** (fully independent file set — Phase 2 touches `convex/closer/meetingActions.ts` and `app/workspace/closer/meetings/[meetingId]/_components/*`; Phase 3 touches `convex/reviews/*`, `convex/lib/manualMeetingTimes.ts`, and `app/workspace/reviews/[reviewId]/_components/*`).

**Skills to invoke:**
- `shadcn` — Button component + layout; verify `Button` and `Square` icon are already registered (both are standard).
- `frontend-design` — two-row layout pattern for `OutcomeActionBar` (lifecycle vs. outcome separation).
- `web-design-guidelines` — WCAG audit: aria-label on End Meeting, keyboard focus behaviour, toast announcement.
- `vercel-react-best-practices` — verify `useMutation` hook placement, avoid unnecessary re-renders when status flips.
- `expect` — browser verification (happy path + mid-call-payment-then-end-meeting + overrun toast + accessibility).

**Acceptance Criteria:**
1. Navigating to `/workspace/closer/meetings/{meetingId}` for a meeting in `scheduled` status shows **only** the Start Meeting button in the lifecycle row (no End Meeting button).
2. After a closer presses Start Meeting (meeting becomes `in_progress`), the lifecycle row shows **only** the End Meeting button — Start is hidden.
3. Pressing End Meeting within the meeting window transitions `meetings.status` → `"completed"`, sets `stoppedAt` to the click time, and writes `stoppedAtSource: "closer"`. Verified by refreshing the Convex dashboard row after the click.
4. If the meeting is ended after the scheduled end time, the toast message reads `"Meeting ended — ran N min over schedule"` where N = `round(exceededScheduledDurationMs / 60_000)`.
5. If the meeting is ended before the scheduled end time, the toast reads `"Meeting ended"` (no overrun suffix).
6. Pressing Log Payment **before** End Meeting transitions `opportunities.status` → `"payment_received"` while leaving `meetings.status` unchanged as `"in_progress"`; End Meeting is still visible and still works afterwards.
7. Pressing End Meeting **before** Log Payment transitions `meetings.status` → `"completed"` while leaving `opportunities.status` as `"in_progress"`; Log Payment remains visible (the outcome row is gated on opportunity status, not meeting status).
8. Admins (`tenant_master`, `tenant_admin`) navigating to a closer's meeting detail page can also see and press End Meeting — the backend already allows it for admins (existing `stopMeeting` role check).
9. Pressing End Meeting on a meeting already in `completed`, `no_show`, `canceled`, or `meeting_overran` is impossible from the UI (button hidden) AND rejected by the backend (`"Cannot stop a meeting with status '...'"`).
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (backend source attribution) ───────┐
                                       │
2B (EndMeetingButton component) ───────┤
                                       │
                                       ├── 2C (OutcomeActionBar integration — needs 2A + 2B)
                                       │
                                       └── 2D (browser verification — needs 2C complete)
```

**Optimal execution:**
1. Start 2A and 2B in parallel. 2A is a ~10-line change to `startMeeting` and `stopMeeting` handlers; 2B is a new self-contained component file. No overlap.
2. Once 2A is deployed *and* 2B exists on disk, run 2C (modify `OutcomeActionBar` to render the new button). 2C takes ~20 minutes.
3. Run 2D — browser verification with the `expect` skill, covering the interaction matrix in design §5.5.

**Estimated time:** 1–1.5 days

---

## Subphases

### 2A — Backend: `startMeeting` / `stopMeeting` Write Attribution

**Type:** Backend
**Parallelizable:** Yes with 2B (different file, different concern). Depends only on Phase 1A generated types.

**What:** Update two existing mutations in `convex/closer/meetingActions.ts`:
- `startMeeting` — add `startedAtSource: "closer"` to the meeting patch.
- `stopMeeting` — add `stoppedAtSource: "closer"` to the meeting patch.

**Why:** Phase 3 reads `stoppedAtSource` to determine whether a meeting's end time is authoritative (closer-set / no-show-set) or admin-overridden. Without this attribution, admin reporting can't distinguish "closer explicitly ended the call" from "admin filled in a forgotten time during review". The fields were added in 1A; this subphase populates them from the two legitimate lifecycle mutations. No behaviour change otherwise.

**Where:**
- `convex/closer/meetingActions.ts` (modify — two handlers, `startMeeting` at ~line 80 and `stopMeeting` at ~line 173)

**How:**

**Step 1: Update `startMeeting`.** Find the `ctx.db.patch(meetingId, { ... })` call at ~line 132:

```typescript
// Path: convex/closer/meetingActions.ts — BEFORE (inside startMeeting)
await ctx.db.patch(meetingId, {
  status: "in_progress",
  startedAt: now,
  lateStartDurationMs,
});
```

Replace with:

```typescript
// Path: convex/closer/meetingActions.ts — AFTER (inside startMeeting)
await ctx.db.patch(meetingId, {
  status: "in_progress",
  startedAt: now,
  startedAtSource: "closer" as const,   // NEW — Phase 2A attribution
  lateStartDurationMs,
});
```

**Step 2: Update `stopMeeting`.** Find the `ctx.db.patch(meetingId, { ... })` call at ~line 196:

```typescript
// Path: convex/closer/meetingActions.ts — BEFORE (inside stopMeeting)
await ctx.db.patch(meetingId, {
  status: "completed",
  stoppedAt: now,
  completedAt: now,
  exceededScheduledDurationMs,
});
```

Replace with:

```typescript
// Path: convex/closer/meetingActions.ts — AFTER (inside stopMeeting)
await ctx.db.patch(meetingId, {
  status: "completed",
  stoppedAt: now,
  stoppedAtSource: "closer" as const,   // NEW — Phase 2A attribution
  completedAt: now,
  exceededScheduledDurationMs,
});
```

**Step 3: Regenerate types + verify.**

```bash
pnpm tsc --noEmit
```

**Step 4: Manual smoke test.**
1. Convex dashboard → find a `scheduled` test meeting within its start window.
2. Run `startMeeting({ meetingId })`. Refresh — confirm `startedAtSource === "closer"`.
3. Run `stopMeeting({ meetingId })`. Refresh — confirm `stoppedAtSource === "closer"`.

**Key implementation notes:**
- **`stopMeeting`'s role check already supports admin**. `requireTenantUser(ctx, ["closer", "tenant_master", "tenant_admin"])` is unchanged — admins can stop meetings as a recovery lever (design §11.3). The source attribution stays `"closer"` in both cases because that's the UI button being pressed; if in the future we need to distinguish admin-forced stops, introduce a new literal `"admin_force_stop"`. Out of scope here.
- **Do NOT touch `markAsLost` or `logPayment` in this subphase.** They correctly don't write meeting time fields (confirmed in 1C contract comments).
- **The `as const` assertion** is required because of the union validator (`v.union(v.literal("closer"), ...)`). Without it, TypeScript widens `"closer"` → `string` and the patch fails typecheck.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Add `startedAtSource` to `startMeeting` patch; add `stoppedAtSource` to `stopMeeting` patch. |

---

### 2B — Frontend: New `EndMeetingButton` Component

**Type:** Frontend
**Parallelizable:** Yes with 2A. Pure UI — renders a button that wraps a mutation call. The mutation it calls (`stopMeeting`) already exists pre-Phase-2; it only gains the attribution field in 2A, which this component is indifferent to.

**What:** Create a new client component at `app/workspace/closer/meetings/[meetingId]/_components/end-meeting-button.tsx` that renders an outline button with a `Square` lucide icon, calls `useMutation(api.closer.meetingActions.stopMeeting)`, and shows contextual success/error toasts.

**Why:** The `stopMeeting` mutation has had no UI surface since v0.6 deployed. Closers today have no way to explicitly end the meeting — meetings stay `in_progress` until the browser is closed or a `markNoShow` is triggered. Design §5.1 specifies this button as the canonical "I am done with this call" affordance, independent of outcome.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/end-meeting-button.tsx` (new)

**How:**

**Step 1: Create the component file.**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/end-meeting-button.tsx
"use client";

import { useMutation } from "convex/react";
import { Square } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";

type EndMeetingButtonProps = {
  meetingId: Id<"meetings">;
  meetingStatus: Doc<"meetings">["status"];
};

/**
 * End Meeting button.
 *
 * Visible only when meeting.status === "in_progress". Pressing it calls
 * stopMeeting, which writes stoppedAt / stoppedAtSource and transitions
 * the meeting to "completed" without touching the opportunity.
 *
 * Design: see plans/meeting-time-tracking-accuracy/...-design.md §5
 */
export function EndMeetingButton({ meetingId, meetingStatus }: EndMeetingButtonProps) {
  const stopMeeting = useMutation(api.closer.meetingActions.stopMeeting);
  const [isStopping, setIsStopping] = useState(false);

  // Button only surfaces when the meeting is actively in progress.
  // For any other status, the caller (OutcomeActionBar) renders nothing
  // in the lifecycle row or renders StartMeetingButton.
  if (meetingStatus !== "in_progress") return null;

  const handleClick = async () => {
    setIsStopping(true);
    try {
      const { exceededScheduledDuration, exceededScheduledDurationMs } =
        await stopMeeting({ meetingId });

      if (exceededScheduledDuration) {
        const minutesOver = Math.max(
          1,
          Math.round(exceededScheduledDurationMs / 60_000),
        );
        toast.success(`Meeting ended — ran ${minutesOver} min over schedule`);
      } else {
        toast.success("Meeting ended");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not end meeting";
      toast.error(message);
      console.error("[EndMeetingButton] stopMeeting failed", err);
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={isStopping}
      aria-label="End meeting"
    >
      <Square className="h-4 w-4" aria-hidden />
      {isStopping ? "Ending…" : "End Meeting"}
    </Button>
  );
}
```

**Step 2: Verify typecheck.**

```bash
pnpm tsc --noEmit
```

The component imports `Doc` and `Id` from generated types; if this fails, 2A has not deployed yet (check `convex/_generated/dataModel.ts`).

**Key implementation notes:**
- **`"use client"` is required.** The component uses `useMutation` and `useState`. Without the directive, the Next.js compiler errors at build time.
- **Status prop is typed from generated `Doc<"meetings">["status"]`.** This keeps the union in lockstep with the schema. If someone later adds a new meeting status literal, `meetingStatus !== "in_progress"` still compiles but the caller may need updating.
- **Disabled-state feedback.** `isStopping` is a local boolean; when true, the button text changes to `"Ending…"` and the button is disabled. This prevents double-click double-submit.
- **Error handling — why a toast, not an alert?** A toast (via `sonner`) is non-blocking and matches the existing pattern in the repo's other action buttons (e.g., `StartMeetingButton`, `LogPaymentButton`). An inline `<Alert>` would clutter the action bar; the toast is dismissed automatically after 4 seconds.
- **Overrun minute rounding.** `Math.max(1, Math.round(ms / 60_000))` ensures "ran 0 min over" is never displayed — if we're in the overrun branch at all, we say at least 1 min. Prevents the weird "ran 0 min over schedule" edge case when `now - scheduledEndMs` is 30 seconds.
- **No confirmation dialog.** Per design §5.1 rationale, the cost of a wrong click is low (admin can correct via Phase 3 manual times), and a dialog would add friction to the common path.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/end-meeting-button.tsx` | Create | New client component wrapping `stopMeeting`. |

---

### 2C — Frontend: Integrate into `OutcomeActionBar` with Two-Row Layout

**Type:** Frontend
**Parallelizable:** No — depends on 2B (imports `EndMeetingButton`). Depends on 2A for the attribution field to be populated (not a compile dependency, but a correctness one).

**What:** Modify `app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx` to render two distinct rows:
1. **Lifecycle row** (top): renders `StartMeetingButton` when `meeting.status === "scheduled"`, renders `EndMeetingButton` when `meeting.status === "in_progress"`, renders nothing otherwise.
2. **Outcome row** (bottom): unchanged — existing gating on `opportunity.status` continues to drive Log Payment / Schedule Follow-Up / Mark Lost / Mark No-Show visibility.

**Why:** The two rows encode the decoupling invariant at the UI layer. Today, `OutcomeActionBar` renders Start Meeting and the outcome buttons inline, which makes the independence between meeting lifecycle and opportunity outcome visually unclear. Separating them into distinct rows makes it obvious to closers that ending the meeting is a separate action from recording the outcome.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx` (modify)

**How:**

**Step 1: Read the current file** to understand the existing structure. It currently renders buttons in a single flex row based on combined meeting + opportunity status checks.

**Step 2: Import `EndMeetingButton`.** Add at the top of the imports block:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx
import { EndMeetingButton } from "./end-meeting-button";
```

**Step 3: Refactor the JSX into two rows.** The minimal change preserves all existing outcome-row logic and simply wraps the Start Meeting rendering block + a new End Meeting rendering block into a lifecycle row above the existing outcome row. A simplified shape:

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx — AFTER
export function OutcomeActionBar({
  meeting,
  opportunity,
  meetingReview,
  activeFollowUp,
}: OutcomeActionBarProps) {
  // ... existing early-return logic (hide if review resolved, etc.) ...

  return (
    <div className="flex flex-col gap-3">
      {/* === LIFECYCLE ROW === */}
      {/* Drives on meeting.status — independent of opportunity.status. */}
      <div className="flex flex-wrap items-center gap-2">
        {meeting.status === "scheduled" && (
          <StartMeetingButton
            meetingId={meeting._id}
            /* ... existing props (startWindow, joinUrl, etc.) ... */
          />
        )}
        {meeting.status === "in_progress" && (
          <EndMeetingButton
            meetingId={meeting._id}
            meetingStatus={meeting.status}
          />
        )}
      </div>

      {/* === OUTCOME ROW === */}
      {/* Drives on opportunity.status — independent of meeting.status.
          All existing visibility logic unchanged. */}
      <div className="flex flex-wrap items-center gap-2">
        {canShowLogPayment && <LogPaymentButton /* ... existing props ... */ />}
        {canShowFollowUp && <ScheduleFollowUpButton /* ... existing props ... */ />}
        {canShowMarkLost && <MarkLostButton /* ... existing props ... */ />}
        {canShowNoShow && <MarkNoShowButton /* ... existing props ... */ />}
      </div>
    </div>
  );
}
```

**Step 4: Audit the lifecycle row's empty states.** When `meeting.status === "completed"`, `"no_show"`, `"canceled"`, or `"meeting_overran"`, the lifecycle row renders nothing (empty `<div>`). That's fine visually — `gap-2` + no children = zero height. If you want to hide the container entirely, wrap with a conditional:

```tsx
// Optional polish: hide lifecycle row entirely when neither button applies
const showLifecycleRow =
  meeting.status === "scheduled" || meeting.status === "in_progress";

{showLifecycleRow && (
  <div className="flex flex-wrap items-center gap-2">
    {/* ...buttons... */}
  </div>
)}
```

**Step 5: Keep the `meeting_overran` pending-review special case untouched.** That branch currently renders outcome buttons (Log Payment / Mark Lost / etc.) but no Start / End lifecycle button, which matches the spec: during an overran review, the meeting's lifecycle is frozen pending admin resolution. The lifecycle row already renders nothing for `meeting_overran`, so no extra code is needed.

**Step 6: Typecheck + visual pass.**

```bash
pnpm tsc --noEmit
pnpm dev
```

Navigate to a closer meeting in `in_progress` status. Confirm the lifecycle row shows only End Meeting; outcome row shows the full outcome set.

**Key implementation notes:**
- **Do not remove the existing `OutcomeActionBar` early-return for resolved reviews** (lines similar to `if (meetingReview?.status === "resolved") return null;`). That gating stays — the design does not change review-resolution visibility.
- **`meeting.status === "in_progress"` with `opportunity.status === "payment_received"` is a valid state.** In that case, the lifecycle row shows End Meeting, and the outcome row is empty (terminal opportunity). The component should render the single-button lifecycle row — not collapse the whole bar. Test this explicitly.
- **Visual spacing.** `gap-3` between rows is deliberate; `gap-2` within rows matches the existing spacing for other action-bar buttons. If your button set wraps on narrow viewports, `flex-wrap` on each row handles it — no breakpoint-specific styling needed.
- **Accessibility.** `aria-label="End meeting"` is already on the button. The two-row layout does not require a new landmark role — the outer container is still a single logical action bar.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx` | Modify | Introduce lifecycle row above existing outcome row; wire in `EndMeetingButton`. |

---

### 2D — Browser Verification (Interaction Matrix + Accessibility)

**Type:** Manual (browser) — via `expect` MCP tool
**Parallelizable:** No — depends on 2A, 2B, 2C all green on dev.

**What:** Drive a headed browser session through the full interaction matrix in design §5.5 and confirm each state renders correctly. Run `expect`'s accessibility and performance audits on the meeting detail page.

**Why:** The repo's `expect` verification rule (AGENTS.md > Testing with Expect) mandates real browser evidence before declaring UI work complete. The matrix has 8 distinct states and 2 mid-call flow orderings; static-review reasoning is not sufficient.

**Where:**
- Via `expect` MCP tools: `open`, `playwright`, `screenshot`, `console_logs`, `accessibility_audit`, `performance_metrics`, `close`.

**How:**

**Step 1: Seed data.** Ensure the test tenant has at least 3 meetings covering:
- One `scheduled` meeting within its start window.
- One `in_progress` meeting (fresh Start click).
- One `in_progress` meeting whose `opportunity.status` has already transitioned to `"payment_received"` (to verify Row 4 of the interaction matrix).
- One `completed` meeting (End Meeting already clicked).
- One `meeting_overran` meeting with pending review.

**Step 2: Drive the matrix.** In a single playwright session:

| Step | Action | Expectation |
|---|---|---|
| 1 | Open `/workspace/closer/meetings/{scheduled}` | Lifecycle row shows **Start Meeting**; outcome row empty (status=`scheduled`). |
| 2 | Click Start Meeting | Toast appears; page reactively updates; lifecycle row now shows **End Meeting**; outcome row shows 4 outcome buttons. |
| 3 | Click Log Payment → fill form → Submit | Toast; outcome row collapses (opportunity terminal); **End Meeting stays visible**. |
| 4 | Click End Meeting | Toast `"Meeting ended — ran N min over schedule"` (or `"Meeting ended"`). Lifecycle row empty. Refresh — confirm `meetings.status === "completed"`, `stoppedAtSource === "closer"`. |
| 5 | Open `/workspace/closer/meetings/{completed}` (prior step's meeting) | Both rows empty. No buttons. |
| 6 | Open `/workspace/closer/meetings/{meeting_overran}` | Lifecycle row empty (no Start/End during overran). Outcome row visible with overran-pending-review buttons. |

**Step 3: Run accessibility + performance audits.**

```
expect.accessibility_audit  → expect WCAG 2.1 AA clean on the meeting detail page after clicking End Meeting.
expect.performance_metrics  → LCP, CLS, INP must stay within existing budgets (no regression from baseline).
expect.console_logs         → zero errors (may have dev warnings from Convex subscriptions — ignore those).
```

**Step 4: Responsive check.** Run the above matrix at 4 viewports: 1440px, 1024px, 768px, 375px. Confirm the two-row layout wraps cleanly on narrow screens and button text never overflows.

**Step 5: Report.** The `expect` subagent should produce a report with: (a) screenshots at each step, (b) axe-core audit result, (c) performance-metrics delta vs. baseline, (d) any console errors surfaced.

**Key implementation notes:**
- **Delegate to a subagent.** The AGENTS.md browser-verification rule requires a subagent (to keep the main thread free). Launch with `subagent_type: "general-purpose"` and pass the `expect` skill as the tooling.
- **No completion claim without evidence.** If any assertion fails, fix the underlying issue and re-run — do not handwave.
- **Keep screenshots in the plan folder** — e.g., `plans/meeting-time-tracking-accuracy/phases/phase2-evidence/` — so future reviewers can see the state at each step. (Optional; not required by acceptance criteria.)

**Files touched:**

None (verification-only subphase). Optional evidence artifacts under `plans/meeting-time-tracking-accuracy/phases/phase2-evidence/`.

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | 2A |
| `app/workspace/closer/meetings/[meetingId]/_components/end-meeting-button.tsx` | Create | 2B |
| `app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx` | Modify | 2C |

**Total files changed:** 3 (1 backend modify, 1 frontend new, 1 frontend modify).
**New components:** 1 (`EndMeetingButton`).
**No new Convex functions, no new tables, no new indexes.** All backend extension uses existing mutations that Phase 1 schema changes made attribution-aware.
