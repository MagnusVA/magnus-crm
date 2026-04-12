# Phase 2 — Mark No-Show Dialog

**Goal:** After this phase, a closer can start a meeting, click "Mark No-Show" on the meeting detail page, see a live-ticking wait time, select a structured reason, optionally add a note, and confirm -- transitioning both the meeting and opportunity to `no_show`. The `OutcomeActionBar` then returns `null` for `no_show` status, clearing the way for the `NoShowActionBar` (Phase 3).

**Prerequisite:** Phase 1 complete -- schema deployed with `startedAt`, `noShowMarkedAt`, `noShowWaitDurationMs`, `noShowReason`, `noShowNote`, `noShowSource` fields on `meetings`, `in_progress -> no_show` transition available in `statusTransitions.ts`, and `startMeeting` mutation recording `startedAt`.

**Runs in PARALLEL with:** Phase 4 (pipeline heuristic -- touches `convex/pipeline/` files), Phase 5 (chain display -- touches attribution card and meeting detail banner). Zero shared files.

**Skills to invoke:**
- `frontend-design` -- production-quality dialog component with live-ticking timer, destructive action UX
- `shadcn` -- AlertDialog, Select, Textarea, Form primitives composition
- `expect` -- browser verification of the full UX flow (start meeting -> mark no-show -> status transition)
- `web-design-guidelines` -- accessibility audit of the dialog (focus management, ARIA, keyboard nav)
- `vercel-react-best-practices` -- dynamic import pattern, useEffect cleanup, interval management

**Acceptance Criteria:**
1. Calling `api.closer.noShowActions.markNoShow` with a valid `in_progress` meeting transitions both the meeting and opportunity to `no_show` status.
2. Calling `markNoShow` on a meeting that is NOT `in_progress` throws an error.
3. Calling `markNoShow` on a meeting not assigned to the calling closer throws "Not your meeting".
4. The mutation computes `noShowWaitDurationMs` as `Date.now() - meeting.startedAt` and stores it alongside `noShowReason`, `noShowNote`, `noShowSource: "closer"`, and `noShowMarkedAt`.
5. The `MarkNoShowDialog` component renders a live-ticking wait time display that updates every second when `open` is true and `startedAt` is defined.
6. The "Mark No-Show" button appears in the `OutcomeActionBar` when `opportunity.status === "in_progress"`, alongside the existing "Log Payment", "Schedule Follow-up", and "Mark as Lost" buttons.
7. For `opportunity.status === "no_show"`, the `OutcomeActionBar` returns `null` (the `NoShowActionBar` from Phase 3 will handle this status).
8. For `opportunity.status === "canceled"`, the `OutcomeActionBar` renders only `FollowUpDialog`.
9. PostHog captures a `meeting_marked_no_show` event with `meeting_id`, `reason`, and `wait_duration_ms` on successful submission.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (markNoShow mutation) ──────────────────────────────────────┐
                                                               ├── 2C (OutcomeActionBar modification — uses 2A api + 2B component)
2B (MarkNoShowDialog component) ───────────────────────────────┤
                                                               │
                                                               └── 2D (Integration test prep — verifies full flow)
```

**Optimal execution:**
1. Start 2A and 2B in parallel (they touch different directories: `convex/closer/` vs `app/workspace/closer/meetings/_components/`).
2. Once both 2A and 2B are done -> start 2C (imports from both).
3. Once 2C is done -> start 2D (verifies the full flow end-to-end).

**Estimated time:** 1-2 days

---

## Subphases

### 2A -- Backend `markNoShow` Mutation

**Type:** Backend
**Parallelizable:** Yes -- no dependency on other subphases. 2C depends on this (imports the mutation API).

**What:** New `convex/closer/noShowActions.ts` file containing the `markNoShow` mutation. Validates the meeting is `in_progress`, the opportunity is assigned to the calling closer, computes wait duration, patches both meeting and opportunity to `no_show`, and updates denormalized meeting refs.

**Why:** The frontend dialog needs a backend endpoint to call. Without this mutation, the "Confirm No-Show" button has nothing to invoke. This is also the only file in the project that will house all no-show-related Convex mutations (Phase 3's `createNoShowRescheduleLink` will be added to this same file).

**Where:**
- `convex/closer/noShowActions.ts` (new)

**How:**

**Step 1: Create the `noShowActions.ts` file**

```typescript
// Path: convex/closer/noShowActions.ts

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";

/**
 * Mark a meeting as no-show. Primary no-show creation path.
 *
 * Called when the closer decides the lead won't show up.
 * The meeting must be in "in_progress" status (closer has already started it).
 *
 * Records wait duration, structured reason, optional note, and source.
 * Transitions both meeting and opportunity to "no_show".
 */
export const markNoShow = mutation({
  args: {
    meetingId: v.id("meetings"),
    reason: v.union(
      v.literal("no_response"),
      v.literal("late_cancel"),
      v.literal("technical_issues"),
      v.literal("other"),
    ),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { meetingId, reason, note }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    // Load and validate meeting
    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }
    if (meeting.status !== "in_progress") {
      throw new Error(
        `Can only mark no-show on in-progress meetings (current: "${meeting.status}")`,
      );
    }

    // Verify ownership via opportunity
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Validate opportunity transition
    if (!validateTransition(opportunity.status, "no_show")) {
      throw new Error(
        `Cannot transition opportunity from "${opportunity.status}" to no_show`,
      );
    }

    const now = Date.now();

    // Compute wait duration from when the closer started the meeting.
    // startedAt may be undefined for meetings started before Feature B deployment.
    const waitDurationMs = meeting.startedAt
      ? now - meeting.startedAt
      : undefined;

    // Patch the meeting with all no-show tracking fields
    await ctx.db.patch(meetingId, {
      status: "no_show",
      noShowMarkedAt: now,
      noShowWaitDurationMs: waitDurationMs,
      noShowReason: reason,
      noShowNote: note,
      noShowSource: "closer",
    });

    // Transition the opportunity
    await ctx.db.patch(opportunity._id, {
      status: "no_show",
      updatedAt: now,
    });

    // Update denormalized meeting refs on the opportunity
    await updateOpportunityMeetingRefs(ctx, opportunity._id);

    console.log("[Closer:NoShow] No-show marked", {
      meetingId,
      opportunityId: opportunity._id,
      closerId: userId,
      reason,
      waitDurationMs,
      source: "closer",
    });
  },
});
```

**Step 2: Verify the mutation is accessible via the generated API**

Run the Convex dev server and confirm the function appears in the dashboard:

```bash
npx convex dev
```

Check that `api.closer.noShowActions.markNoShow` is available in the generated types.

**Key implementation notes:**
- The `reason` arg uses `v.union(v.literal(...))` to match the schema union type exactly -- no plain `v.string()`.
- `note` is `v.optional(v.string())` -- the frontend sends `undefined` if the field is empty (not an empty string).
- `waitDurationMs` gracefully handles `undefined` `startedAt` (pre-Feature-B meetings or edge cases).
- `requireTenantUser(ctx, ["closer"])` restricts to closers only. Admins cannot mark no-shows on behalf of closers.
- The ownership check goes through `opportunity.assignedCloserId`, not a direct field on the meeting -- consistent with `markAsLost` and `startMeeting` patterns in `meetingActions.ts`.
- `updateOpportunityMeetingRefs` is called after both patches to keep `latestMeetingId`/`nextMeetingId` consistent.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/noShowActions.ts` | Create | `markNoShow` mutation with validation, transition, and logging |

---

### 2B -- Frontend `MarkNoShowDialog` Component

**Type:** Frontend
**Parallelizable:** Yes -- independent of 2A at development time (the Convex API type will resolve once 2A deploys). No overlap with 2C.

**What:** New `mark-no-show-dialog.tsx` component using RHF + Zod (`standardSchemaResolver`), `AlertDialog`, `Select` for reason, `Textarea` for note. Shows a live-ticking wait time using `useEffect` with a 1-second interval. PostHog capture on submit. `sonner` toast for success/error.

**Why:** The closer needs a structured UI to record why the lead didn't show up. The wait time display validates the closer's experience ("you waited 12 min 34 sec") and the structured reason enables future analytics. Without this dialog, the "Mark No-Show" button in 2C has no target component to render.

**Where:**
- `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx` (new)

**How:**

**Step 1: Create the dialog file with schema, types, and utility function**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx

"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ClockIcon, UserXIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";
```

**Step 2: Define the reason options, Zod schema, and types**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx (continued)

const NO_SHOW_REASONS = [
  { value: "no_response", label: "Lead didn't show up (no communication)" },
  { value: "late_cancel", label: "Lead messaged — can't make it" },
  { value: "technical_issues", label: "Technical issues prevented meeting" },
  { value: "other", label: "Other reason" },
] as const;

const markNoShowSchema = z.object({
  reason: z.enum(["no_response", "late_cancel", "technical_issues", "other"]),
  note: z.string().max(500, "Note must be under 500 characters").optional(),
});
type MarkNoShowValues = z.infer<typeof markNoShowSchema>;

type MarkNoShowDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: Id<"meetings">;
  startedAt: number | undefined;
  onSuccess?: () => Promise<void>;
};
```

**Step 3: Add the `formatWaitTime` utility**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx (continued)

/** Format milliseconds as "X min Y sec" */
function formatWaitTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} sec`;
  return `${minutes} min ${seconds} sec`;
}
```

**Step 4: Build the component with live-ticking timer, form, and submission**

```tsx
// Path: app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx (continued)

export function MarkNoShowDialog({
  open,
  onOpenChange,
  meetingId,
  startedAt,
  onSuccess,
}: MarkNoShowDialogProps) {
  const markNoShow = useMutation(api.closer.noShowActions.markNoShow);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Live-ticking wait time: updates every second while the dialog is open
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!open || !startedAt) return;
    // Reset to current time when dialog opens
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [open, startedAt]);

  const waitMs = startedAt ? now - startedAt : undefined;

  // Do NOT pass an explicit generic to useForm — let the resolver infer types
  const form = useForm({
    resolver: standardSchemaResolver(markNoShowSchema),
    defaultValues: {
      reason: undefined as MarkNoShowValues["reason"] | undefined,
      note: "",
    },
  });

  // Reset form state when dialog opens/closes
  useEffect(() => {
    if (!open) {
      form.reset();
    }
  }, [open, form]);

  const handleSubmit = async (values: MarkNoShowValues) => {
    setIsSubmitting(true);
    try {
      await markNoShow({
        meetingId,
        reason: values.reason,
        note: values.note || undefined, // Convert empty string to undefined
      });

      posthog.capture("meeting_marked_no_show", {
        meeting_id: meetingId,
        reason: values.reason,
        wait_duration_ms: waitMs,
      });

      toast.success("Meeting marked as no-show");
      await onSuccess?.();
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to mark no-show",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <UserXIcon className="size-5" />
            Mark as No-Show
          </AlertDialogTitle>
          <AlertDialogDescription>
            Record that the lead didn&rsquo;t show up for this meeting.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Wait time display — live-ticking when startedAt is available */}
        {waitMs !== undefined && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2">
            <ClockIcon className="size-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              You waited{" "}
              <span className="font-semibold text-foreground">
                {formatWaitTime(waitMs)}
              </span>
            </span>
          </div>
        )}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className="space-y-4"
          >
            {/* Reason — required Select */}
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Reason <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select a reason..." />
                      </SelectTrigger>
                      <SelectContent>
                        {NO_SHOW_REASONS.map((r) => (
                          <SelectItem key={r.value} value={r.value}>
                            {r.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Note — optional Textarea */}
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Any additional context..."
                      disabled={isSubmitting}
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <AlertDialogFooter>
              <AlertDialogCancel disabled={isSubmitting}>
                Cancel
              </AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Marking...
                  </>
                ) : (
                  "Confirm No-Show"
                )}
              </Button>
            </AlertDialogFooter>
          </form>
        </Form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
```

**Key implementation notes:**
- **`standardSchemaResolver`** (not `zodResolver`) -- per AGENTS.md, Zod v4 uses Standard Schema and `zodResolver` has type mismatches with the main `"zod"` export.
- **`useForm` with no explicit generic** -- the resolver infers the type from the schema. Passing a generic manually causes type conflicts with `standardSchemaResolver`.
- **`reason` defaultValue is `undefined`** -- not an empty string. This forces the user to actively select a reason before the form validates.
- **`note: values.note || undefined`** converts empty string to `undefined` so the backend stores nothing (not an empty string document field).
- **`form.reset()` in the `useEffect`** -- resets when the dialog closes. This matches the pattern from `RoleEditDialog` (externally controlled dialog with `useEffect` reset).
- **Interval cleanup** -- the `useEffect` returns a cleanup function that calls `clearInterval`. The interval only runs while `open && startedAt` are truthy.
- **`setNow(Date.now())` at interval start** -- ensures the timer starts from the actual current time when the dialog opens, not from a stale captured value.
- **`AlertDialog`** (not `Dialog`) -- this is a destructive confirmation action, matching the pattern from `MarkLostDialog`.
- **`variant="destructive"` on the submit button** -- visually signals the irreversible nature of marking a no-show.
- **500-character max on `note`** -- matches the `markLostSchema` pattern in `mark-lost-dialog.tsx`.
- **`posthog.capture`** fires after the mutation succeeds but before closing the dialog -- ensures the event is captured even if the user navigates away quickly.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx` | Create | Full dialog component with RHF + Zod, live timer, PostHog tracking |

---

### 2C -- `OutcomeActionBar` Modification

**Type:** Frontend
**Parallelizable:** No -- depends on 2A (the `api.closer.noShowActions.markNoShow` API endpoint) and 2B (the `MarkNoShowDialog` component import). Must complete before 2D.

**What:** Modify the existing `OutcomeActionBar` to: (1) split `isCanceledOrNoShow` into separate `isCanceled` and `isNoShow` booleans, (2) add the "Mark No-Show" button for `isInProgress`, (3) return `null` for `isNoShow` (Phase 3's `NoShowActionBar` handles it), (4) render only `FollowUpDialog` for `isCanceled`.

**Why:** The `OutcomeActionBar` currently treats `canceled` and `no_show` identically (both show `FollowUpDialog`). Phase 2 needs to: (a) add the Mark No-Show entry point for `in_progress` meetings, and (b) stop rendering anything for `no_show` so that Phase 3's dedicated `NoShowActionBar` can take over without visual duplication.

**Where:**
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)

**How:**

**Step 1: Add the dynamic import for `MarkNoShowDialog` and the `UserXIcon` import**

Before (lines 16-24):
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

// Lazy-load dialog components that are only shown on user interaction
const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);
```

After:
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

// Lazy-load dialog components that are only shown on user interaction
const MarkLostDialog = dynamic(() =>
  import("./mark-lost-dialog").then((m) => ({ default: m.MarkLostDialog })),
);
const MarkNoShowDialog = dynamic(() =>
  import("./mark-no-show-dialog").then((m) => ({
    default: m.MarkNoShowDialog,
  })),
);
const PaymentFormDialog = dynamic(() =>
  import("./payment-form-dialog").then((m) => ({ default: m.PaymentFormDialog })),
);
const FollowUpDialog = dynamic(() =>
  import("./follow-up-dialog").then((m) => ({ default: m.FollowUpDialog })),
);
```

**Step 2: Add `UserXIcon` to the lucide-react import**

Before (line 10):
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

import { PlayIcon, InfoIcon, ClockIcon } from "lucide-react";
```

After:
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

import { PlayIcon, InfoIcon, ClockIcon, UserXIcon } from "lucide-react";
```

**Step 3: Add `useState` for the dialog open state inside the component**

Add immediately after the existing `useState` declarations (after line 97):

Before:
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

  const startMeeting = useMutation(api.closer.meetingActions.startMeeting);
  const [isStarting, setIsStarting] = useState(false);
  const { canStart, reason, windowOpen } = useMeetingStartWindow(
    meeting,
    allowOutOfWindowMeetingStart,
  );

  const isScheduled = meeting.status === "scheduled";
  const isInProgress = opportunity.status === "in_progress";
```

After:
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

  const startMeeting = useMutation(api.closer.meetingActions.startMeeting);
  const [isStarting, setIsStarting] = useState(false);
  const [showNoShowDialog, setShowNoShowDialog] = useState(false);
  const { canStart, reason, windowOpen } = useMeetingStartWindow(
    meeting,
    allowOutOfWindowMeetingStart,
  );

  const isScheduled = meeting.status === "scheduled";
  const isInProgress = opportunity.status === "in_progress";
```

**Step 4: Split `isCanceledOrNoShow` into separate conditions and update the return-null guard**

Before (lines 132-136):
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

  const isCanceledOrNoShow =
    opportunity.status === "canceled" || opportunity.status === "no_show";

  // No actions for terminal statuses (payment_received, lost, follow_up_scheduled)
  if (!isScheduled && !isInProgress && !isCanceledOrNoShow) return null;
```

After:
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

  const isCanceled = opportunity.status === "canceled";
  const isNoShow = opportunity.status === "no_show";

  // No-show status is handled by NoShowActionBar (Phase 3) — return null here
  if (isNoShow) return null;

  // No actions for terminal statuses (payment_received, lost, follow_up_scheduled)
  if (!isScheduled && !isInProgress && !isCanceled) return null;
```

**Step 5: Replace the `isInProgress` and `isCanceledOrNoShow` JSX blocks**

Before (lines 162-185):
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

        {/* Log Payment — Phase 7D */}
        {isInProgress && (
          <PaymentFormDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Schedule Follow-up — Phase 7E */}
        {isInProgress && (
          <FollowUpDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Schedule Follow-up for canceled/no-show opportunities */}
        {isCanceledOrNoShow && (
          <FollowUpDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Mark as Lost — when in_progress */}
        {isInProgress && (
          <MarkLostDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}
```

After:
```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

        {/* Log Payment — Phase 7D */}
        {isInProgress && (
          <PaymentFormDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Schedule Follow-up — Phase 7E */}
        {isInProgress && (
          <FollowUpDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Mark No-Show — when in_progress (Feature B Phase 2) */}
        {isInProgress && (
          <>
            <Button
              variant="outline"
              size="lg"
              onClick={() => setShowNoShowDialog(true)}
            >
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

        {/* Schedule Follow-up for canceled opportunities */}
        {isCanceled && (
          <FollowUpDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Mark as Lost — when in_progress */}
        {isInProgress && (
          <MarkLostDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}
```

**Step 6: Verify `meeting.startedAt` is accessible on the `Doc<"meetings">` type**

The `meeting` prop is typed as `Doc<"meetings">`, which includes `startedAt?: number` after Phase 1's schema deployment. The `startedAt` field is `v.optional(v.number())` in the schema, so TypeScript sees it as `number | undefined` -- which matches the `MarkNoShowDialog`'s `startedAt: number | undefined` prop.

**Key implementation notes:**
- **`isNoShow` returns `null` early** -- before the main render. This ensures zero visual output for no-show status. The `NoShowActionBar` (Phase 3) will be a separate component mounted by the meeting detail page, not nested inside `OutcomeActionBar`.
- **Button order**: "Log Payment" -> "Schedule Follow-up" -> "Mark No-Show" -> "Mark as Lost". The no-show button uses `variant="outline"` (not `"destructive"`) because it opens a confirmation dialog rather than executing a destructive action directly. "Mark as Lost" stays last as the most terminal action.
- **Dynamic import pattern** matches the existing `MarkLostDialog`, `PaymentFormDialog`, and `FollowUpDialog` -- all use `.then((m) => ({ default: m.ComponentName }))` for named export resolution.
- **`meeting.startedAt` as prop** -- passed through to the dialog so it can compute the live-ticking wait time. This is always defined for `in_progress` meetings (set by `startMeeting` in Phase 1), but typed as `number | undefined` for safety.
- **`isCanceled` renders only `FollowUpDialog`** -- previously `isCanceledOrNoShow` rendered the same. Now that `no_show` is handled separately (returns null), canceled only needs the follow-up option.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | Split no-show handling, add Mark No-Show button + dialog, update conditional rendering |

---

### 2D -- Integration Test Prep

**Type:** Manual
**Parallelizable:** No -- depends on 2A, 2B, and 2C all being complete. This is the final verification step.

**What:** Verify the full UX flow end-to-end in the browser: start a meeting -> click "Mark No-Show" -> dialog opens with live-ticking wait time -> select a reason -> confirm -> meeting and opportunity transition to `no_show` -> `OutcomeActionBar` disappears (returns null for no-show). Use the `expect` skill for browser verification.

**Why:** The three prior subphases each work in isolation, but the full flow involves Convex reactivity pushing status updates that cause re-renders. This step verifies that the reactivity chain works seamlessly: mutation success -> Convex pushes new status -> `useQuery` re-fires -> `OutcomeActionBar` re-renders with `isNoShow = true` -> returns null.

**Where:**
- No files created or modified -- this is a verification step.

**How:**

**Step 1: Seed test data**

Ensure there is a meeting in `scheduled` status with an opportunity assigned to the test closer. The meeting should have a `scheduledAt` within the start window (or use the non-production `allowOutOfWindowMeetingStart` flag).

**Step 2: Start the meeting**

Navigate to the meeting detail page. Click "Start Meeting". Verify:
- Meeting status transitions to `in_progress`
- Opportunity status transitions to `in_progress`
- The `OutcomeActionBar` now shows: "Log Payment", "Schedule Follow-up", "Mark No-Show", "Mark as Lost"

**Step 3: Open the Mark No-Show dialog**

Click "Mark No-Show". Verify:
- The `AlertDialog` opens
- The title shows "Mark as No-Show" with the `UserXIcon`
- A wait time display shows "You waited X min Y sec" and ticks every second
- The "Reason" select dropdown shows 4 options
- The "Note (optional)" textarea is empty
- "Cancel" and "Confirm No-Show" buttons are in the footer

**Step 4: Submit without selecting a reason**

Click "Confirm No-Show" without selecting a reason. Verify:
- Zod validation prevents submission
- An error message appears below the reason field

**Step 5: Complete the form and submit**

Select "Lead didn't show up (no communication)" from the reason dropdown. Optionally type a note. Click "Confirm No-Show". Verify:
- The button shows a spinner with "Marking..."
- A success toast appears: "Meeting marked as no-show"
- The dialog closes
- The `OutcomeActionBar` disappears (returns null for `no_show` status)
- In the Convex dashboard: meeting has `status: "no_show"`, `noShowReason: "no_response"`, `noShowSource: "closer"`, `noShowMarkedAt` and `noShowWaitDurationMs` are populated
- In PostHog: a `meeting_marked_no_show` event was captured with the correct properties

**Step 6: Verify edge cases**

- **Stale meeting**: Open a second browser tab, start a meeting there, then try to mark no-show on a meeting that was already completed. Verify the mutation throws and a toast error appears.
- **Wrong closer**: If possible, attempt to mark no-show on a meeting assigned to a different closer. Verify "Not your meeting" error.
- **Dialog cancel**: Open the dialog, select a reason, type a note, then click "Cancel". Re-open the dialog. Verify the form is reset (no pre-selected reason, empty note).

**Step 7: Run the `expect` skill for automated verification**

Invoke the `expect` skill to run accessibility, performance, and console error checks on:
- The meeting detail page with `in_progress` status (Mark No-Show button visible)
- The Mark No-Show dialog (focus trap, keyboard navigation, screen reader labels)
- The meeting detail page after marking no-show (OutcomeActionBar gone)

Verify across 4 viewports: desktop (1280x720), tablet landscape (1024x768), tablet portrait (768x1024), mobile (375x812).

**Key implementation notes:**
- The `expect` skill must be invoked (not just described) -- per AGENTS.md, no completion claims without browser evidence.
- Data seeding requires at least 3 meetings in various states to test the full matrix.
- The live-ticking timer should be visually confirmed by watching the seconds counter increment in the dialog.
- After marking no-show, the page should NOT navigate away -- Convex reactivity handles the re-render in place.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | _(verification only)_ | Browser-based end-to-end flow verification |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/noShowActions.ts` | Create | 2A |
| `app/workspace/closer/meetings/_components/mark-no-show-dialog.tsx` | Create | 2B |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | 2C |
