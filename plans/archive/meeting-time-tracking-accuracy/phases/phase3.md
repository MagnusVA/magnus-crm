# Phase 3 — Admin Manual Time Entry During Overran Review

**Goal:** After this phase, when an admin resolves a `forgot_to_press` overran review, they **must** supply the actual meeting start and end timestamps (verified against the Fathom recording), entered via a dedicated Sheet drawer on the review detail page. The backend extends `resolveReview` to validate the supplied times, patch the meeting with `startedAt`, `stoppedAt`, `completedAt`, `startedAtSource: "admin_manual"`, `stoppedAtSource: "admin_manual"`, and recomputed `lateStartDurationMs` / `exceededScheduledDurationMs`; the review record persists `manualStartedAt`, `manualStoppedAt`, `timesSetByUserId`, `timesSetAt` for audit; and a new `meeting.times_manually_set` domain event fires alongside the existing `meeting.overran_review_resolved` event. The review detail page surfaces an "Admin-entered meeting times" card whenever manual times are present.

**Prerequisite:** Phase 1 complete. Specifically:
- Schema fields `meetingReviews.manualStartedAt`, `manualStoppedAt`, `timesSetByUserId`, `timesSetAt` deployed (from 1A).
- Schema fields `meetings.startedAtSource`, `stoppedAtSource` deployed (from 1A).
- Generated types reflect all new optional columns.

**Runs in PARALLEL with:** **Phase 2**. Zero shared files:
- Phase 3 touches `convex/reviews/mutations.ts`, `convex/lib/manualMeetingTimes.ts` (new), `app/workspace/reviews/[reviewId]/_components/*`.
- Phase 2 touches `convex/closer/meetingActions.ts`, `app/workspace/closer/meetings/[meetingId]/_components/*`.

**Skills to invoke:**
- `shadcn` — verify `Sheet`, `Form`, `Input`, `Textarea`, `Button` primitives exist in the registry (all standard shadcn components, already in `components.json`).
- `frontend-design` — layout the Sheet with clear info hierarchy: Fathom link prominent → two datetime-local inputs → optional note → Save/Cancel footer.
- `web-design-guidelines` — WCAG audit for Sheet focus trap, datetime-local keyboard usability, form error association.
- `next-best-practices` — confirm the Sheet component is a pure client boundary with no unnecessary hydration.
- `vercel-react-best-practices` — verify `useMutation` hoisted correctly; RHF `watch()` does not cause storms; the Sheet uses `onOpenChange` rather than internal open state to support external control.
- `expect` — browser verification for the manual-time-entry happy path + validation error surfacing + roundtrip across time zones.
- `convex-performance-audit` — post-implementation spot-check on `resolveReview`'s manual-times branch (should add <50ms; writes 2 docs + 2 events).

**Acceptance Criteria:**
1. Opening `/workspace/reviews/{reviewId}` for a `forgot_to_press` review shows an "Acknowledge" button that, when clicked, opens a Sheet (not a Dialog).
2. Opening `/workspace/reviews/{reviewId}` for a `did_not_attend` review shows the original Dialog path for Acknowledge (Sheet does NOT open).
3. The Sheet's datetime-local inputs default to `meeting.scheduledAt` (start) and `meeting.scheduledAt + durationMinutes * 60000` (end), formatted in the admin's local time zone.
4. The Sheet displays the Fathom recording link as a prominent `target="_blank"` anchor near the top, when `meeting.fathomLink` is set.
5. Submitting the Sheet with valid times (start < end, within ceiling) patches the meeting: `startedAt = manualStartedAt`, `stoppedAt = manualStoppedAt`, `completedAt = manualStoppedAt`, `startedAtSource = "admin_manual"`, `stoppedAtSource = "admin_manual"`, `status = "completed"`, plus recomputed `lateStartDurationMs` and `exceededScheduledDurationMs`.
6. The review record patches: `status = "resolved"`, `resolvedAt = now`, `resolvedByUserId = admin.userId`, `resolutionAction = "acknowledged"`, `manualStartedAt`, `manualStoppedAt`, `timesSetByUserId = admin.userId`, `timesSetAt = now`.
7. Attempting to submit with `manualStoppedAt <= manualStartedAt` surfaces an inline field error ("End time must be after start time") and does NOT invoke the mutation.
8. Attempting to submit with duration > 8 hours surfaces an inline field error ("Duration cannot exceed 8 hours") and does NOT invoke the mutation.
9. A backend-only attempt to send `resolutionAction: "acknowledged"` on a `forgot_to_press` review WITHOUT `manualStartedAt`/`manualStoppedAt` throws `"Manual start and end times are required when acknowledging a 'forgot_to_press' review."` — verified via Convex dashboard direct call.
10. After a successful Sheet submission, reopening the review detail page shows the "Admin-entered meeting times" card with the saved start, end, duration (in minutes), and resolver name.
11. A `meeting.times_manually_set` domain event is emitted with the metadata `{ reviewId, startedAt, stoppedAt, lateStartDurationMs, exceededScheduledDurationMs, previousMeetingStatus }` — verified by querying the `domainEvents` table post-submission.
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (validateManualTimes helper) ─────┐
                                     │
3C (AcknowledgeWithTimesSheet) ──────┤    (these three are file-independent)
                                     │
3E (detail-page manual-times card) ──┘

3A complete ──┐
              ├── 3B (resolveReview extension — needs helper + Phase 1 schema)
              │
3C complete ──┴── 3D (review-resolution-bar integration — imports Sheet)

3B + 3D complete ──→ 3F (browser verification)
```

**Optimal execution:**
1. Start 3A, 3C, and 3E in parallel. All touch different files; no runtime imports between them.
2. Once 3A exists on disk, start 3B (imports `validateManualTimes`).
3. Once 3C exists on disk, start 3D (imports `AcknowledgeWithTimesSheet`).
4. Once 3B + 3D are green, run 3F — browser verification with `expect`.

**Estimated time:** 1.5–2 days

---

## Subphases

### 3A — Backend: `validateManualTimes` Helper

**Type:** Backend
**Parallelizable:** Yes — pure new file with no imports from other subphases. Only depends on the constants it defines.

**What:** Create `convex/lib/manualMeetingTimes.ts` exporting `validateManualTimes(params)` plus two constants (`MAX_MEETING_DURATION_MS = 8 hours`, `MIN_START_BEFORE_SCHEDULED_MS = 60 min`). The function throws typed errors; 3B and 3C share the same rules (frontend Zod schema mirrors the constants).

**Why:** Centralises the validation rules so they stay aligned between (a) the frontend Zod schema in the Sheet and (b) the backend mutation enforcement. Splitting into its own file keeps `convex/reviews/mutations.ts` focused on resolution logic, and makes the rules unit-testable.

**Where:**
- `convex/lib/manualMeetingTimes.ts` (new)

**How:**

**Step 1: Create the helper file.**

```typescript
// Path: convex/lib/manualMeetingTimes.ts

/**
 * Validation helper for admin-entered meeting start / end times
 * during overran-review resolution.
 *
 * Keeps backend and frontend rules in lockstep — the frontend Zod
 * schema in AcknowledgeWithTimesSheet uses the same MAX / MIN constants.
 *
 * See plans/meeting-time-tracking-accuracy/...-design.md §6.1 for the
 * rationale behind each rule.
 */

export const MAX_MEETING_DURATION_MS = 8 * 60 * 60 * 1000;   // 8 hours
export const MIN_START_BEFORE_SCHEDULED_MS = 60 * 60 * 1000; // 60 minutes

type ValidateManualTimesParams = {
  scheduledAt: number;        // Unix ms — meeting.scheduledAt
  manualStartedAt: number;    // Unix ms — admin input
  manualStoppedAt: number;    // Unix ms — admin input
  now: number;                // Unix ms — Date.now() at call site
};

/**
 * Throws a descriptive Error if any rule is violated. Returns void on success.
 *
 * Rules (see design §6.1):
 *   1. manualStartedAt < manualStoppedAt (strict).
 *   2. manualStartedAt >= scheduledAt - MIN_START_BEFORE_SCHEDULED_MS.
 *   3. manualStoppedAt <= now.
 *   4. manualStoppedAt - manualStartedAt <= MAX_MEETING_DURATION_MS.
 */
export function validateManualTimes(params: ValidateManualTimesParams): void {
  const { scheduledAt, manualStartedAt, manualStoppedAt, now } = params;

  if (manualStartedAt >= manualStoppedAt) {
    throw new Error("Start time must be before end time.");
  }

  if (manualStartedAt < scheduledAt - MIN_START_BEFORE_SCHEDULED_MS) {
    throw new Error(
      "Start time cannot be more than 60 minutes before the scheduled time.",
    );
  }

  if (manualStoppedAt > now) {
    throw new Error("End time cannot be in the future.");
  }

  if (manualStoppedAt - manualStartedAt > MAX_MEETING_DURATION_MS) {
    throw new Error("Meeting duration cannot exceed 8 hours.");
  }
}
```

**Step 2: Typecheck.**

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**
- **No Convex `ctx` dependency.** The helper is pure — it only does math on numbers. This means it's safe to import from anywhere, including future Node-runtime actions if needed.
- **Why "fail loud" via throw, not a `{ ok, error }` tuple?** Consistent with the rest of the Convex codebase — `requireTenantUser` throws, `validateTransition` warns-and-returns-false but is paired with `if (!valid) throw`, etc. Throwing surfaces in Convex's error envelope and reaches the client's `toast.error(err.message)`.
- **Constants are exported** so the frontend Zod schema can use the same numeric ceiling (`MAX_MEETING_DURATION_MS`). Sharing prevents drift where backend says 8 hours but frontend silently allows 10.
- **No Zod schema for the helper itself** — input shape is enforced by the TypeScript type. The caller (`resolveReview`) already has `v.optional(v.number())` validators on the mutation args; by the time `validateManualTimes` runs, the values are guaranteed numeric.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/manualMeetingTimes.ts` | Create | Pure validation helper + constants. |

---

### 3B — Backend: `resolveReview` Accepts Manual Times

**Type:** Backend
**Parallelizable:** No — depends on 3A (imports `validateManualTimes`) and Phase 1A schema.

**What:** Extend the `resolveReview` mutation in `convex/reviews/mutations.ts` to accept two new optional args (`manualStartedAt`, `manualStoppedAt`) and, when the action is `"acknowledged"`, enforce:
- If `closerResponse === "forgot_to_press"` → manual times are **required**.
- If manual times are provided with a non-acknowledged action → reject.
- If manual times are provided → run `validateManualTimes`, patch the meeting (status, startedAt, stoppedAt, completedAt, source fields, recomputed durations), patch the review (manualStartedAt, manualStoppedAt, timesSetByUserId, timesSetAt), emit a `meeting.times_manually_set` domain event.

**Why:** This is the backend of the entire phase. It enforces the contract at the API layer (defense-in-depth: the Sheet form already validates, but the backend is authoritative). Without this, the Sheet can't write its values anywhere. It also fixes the long-standing bug in the `acknowledged` false-positive branch where `completedAt = now` records the resolution time instead of the true meeting end.

**Where:**
- `convex/reviews/mutations.ts` (modify)

**How:**

**Step 1: Import the helper.** Add to the existing imports block at the top of `convex/reviews/mutations.ts`:

```typescript
// Path: convex/reviews/mutations.ts
import { validateManualTimes } from "../lib/manualMeetingTimes";
```

**Step 2: Add the two new args to the mutation's arg validator.** The args object currently covers `reviewId`, `resolutionAction`, `resolutionNote`, `paymentData`, `lostReason`, `noShowReason`. Add below:

```typescript
// Path: convex/reviews/mutations.ts — inside resolveReview's args
args: {
  reviewId: v.id("meetingReviews"),
  resolutionAction: v.union(/* existing literals */),
  resolutionNote: v.optional(v.string()),
  paymentData: v.optional(/* existing */),
  lostReason: v.optional(v.string()),
  noShowReason: v.optional(/* existing union */),

  // NEW — Phase 3B: admin-entered actual meeting times.
  // Required when resolutionAction === "acknowledged" AND
  // review.closerResponse === "forgot_to_press". Rejected for any
  // other resolutionAction. Both must be provided together (never one-sided).
  manualStartedAt: v.optional(v.number()),
  manualStoppedAt: v.optional(v.number()),
},
```

**Step 3: Add the guards immediately after the existing review/meeting/opportunity fetches** (before the existing `closerAlreadyActed` check block):

```typescript
// Path: convex/reviews/mutations.ts — near top of handler, after fetches
const isAcknowledged = args.resolutionAction === "acknowledged";
const closerForgot = review.closerResponse === "forgot_to_press";
const hasManualTimes =
  args.manualStartedAt !== undefined && args.manualStoppedAt !== undefined;

// Guard: forgot_to_press acknowledged → must have manual times.
if (isAcknowledged && closerForgot && !hasManualTimes) {
  throw new Error(
    "Manual start and end times are required when acknowledging a 'forgot_to_press' review. Verify actual times in the Fathom recording.",
  );
}

// Guard: manual times are only valid with acknowledged.
if (hasManualTimes && !isAcknowledged) {
  throw new Error(
    "Manual times can only be supplied with the 'acknowledged' resolution action.",
  );
}

// Guard: if manual times present, validate them.
if (hasManualTimes) {
  validateManualTimes({
    scheduledAt: meeting.scheduledAt,
    manualStartedAt: args.manualStartedAt!,
    manualStoppedAt: args.manualStoppedAt!,
    now: Date.now(),
  });
}
```

**Step 4: Replace the `"acknowledged"` branch** (currently lines 130–157). The existing version sets `review.status = "resolved"` and emits the event but does NOT patch the meeting. The new version does.

```typescript
// Path: convex/reviews/mutations.ts — replace the "acknowledged" branch

if (args.resolutionAction === "acknowledged") {
  const now = Date.now();
  const reviewPatch: Partial<Doc<"meetingReviews">> = {
    status: "resolved",
    resolvedAt: now,
    resolvedByUserId: userId,
    resolutionAction: "acknowledged",
    ...(resolutionNote ? { resolutionNote } : {}),
  };

  if (hasManualTimes) {
    const startedAt = args.manualStartedAt!;
    const stoppedAt = args.manualStoppedAt!;
    const scheduledEndMs =
      meeting.scheduledAt + meeting.durationMinutes * 60_000;
    const lateStartDurationMs = Math.max(0, startedAt - meeting.scheduledAt);
    const exceededScheduledDurationMs = Math.max(0, stoppedAt - scheduledEndMs);

    // Enforce the meeting state machine — same as the existing false-positive path.
    if (!validateMeetingTransition(meeting.status, "completed")) {
      throw new Error(
        `Cannot transition meeting from "${meeting.status}" to "completed"`,
      );
    }

    await ctx.db.patch(review.meetingId, {
      status: "completed",
      startedAt,
      startedAtSource: "admin_manual" as const,
      stoppedAt,
      stoppedAtSource: "admin_manual" as const,
      completedAt: stoppedAt,                      // pin to actual end, not now
      lateStartDurationMs,
      exceededScheduledDurationMs,
    });
    await replaceMeetingAggregate(ctx, meeting, review.meetingId);

    // Persist admin-entered times on the review for audit.
    reviewPatch.manualStartedAt = startedAt;
    reviewPatch.manualStoppedAt = stoppedAt;
    reviewPatch.timesSetByUserId = userId;
    reviewPatch.timesSetAt = now;

    // Dedicated domain event so reporting sees the correction explicitly.
    await emitDomainEvent(ctx, {
      tenantId,
      entityType: "meeting",
      entityId: review.meetingId,
      eventType: "meeting.times_manually_set",
      source: "admin",
      actorUserId: userId,
      occurredAt: now,
      metadata: {
        reviewId: args.reviewId,
        startedAt,
        stoppedAt,
        lateStartDurationMs,
        exceededScheduledDurationMs,
        previousMeetingStatus: meeting.status,
      },
    });
  }

  await ctx.db.patch(args.reviewId, reviewPatch);

  await emitDomainEvent(ctx, {
    tenantId,
    entityType: "meeting",
    entityId: review.meetingId,
    eventType: "meeting.overran_review_resolved",
    source: "admin",
    actorUserId: userId,
    occurredAt: now,
    metadata: {
      reviewId: args.reviewId,
      resolutionAction: "acknowledged",
      closerResponse: review.closerResponse,
      manualTimesApplied: hasManualTimes,
    },
  });

  console.log("[Review] acknowledged", {
    reviewId: args.reviewId,
    manualTimesApplied: hasManualTimes,
  });
  return;
}
```

**Step 5: Remove the old false-positive `completedAt = now` patch.** The existing block around lines 403–416 does:

```typescript
// Path: convex/reviews/mutations.ts — DELETE this block (now redundant for acknowledged)
const falsePositiveCorrected =
  isFalsePositiveCorrection && meeting.status === "meeting_overran";
if (falsePositiveCorrected) {
  if (!validateMeetingTransition(meeting.status, "completed")) { /* ... */ }
  await ctx.db.patch(review.meetingId, {
    status: "completed",
    completedAt: now,
  });
  await replaceMeetingAggregate(ctx, meeting, review.meetingId);
}
```

This block fires inside the **other** resolution branches (`log_payment`, `schedule_follow_up`, `mark_no_show`, `mark_lost`), not `acknowledged` (which now exits via early-return in Step 4). Keep this block in place — it's still correct for the "closer responded forgot_to_press, admin overrode with a different outcome" case. **But** review it: if the admin is overriding with `log_payment` and the closer said forgot-to-press, we previously stamped `completedAt = now` here too. For the MVP of Phase 3, we leave that behaviour unchanged (those other branches don't get manual-time UI; only `acknowledged` does). Document this limitation as Open Question §13.8 (new) — "Should `log_payment` / `mark_lost` / `mark_no_show` admin overrides on `forgot_to_press` reviews also accept manual times?" Current answer: no, because if the admin is taking the outcome themselves, the exact meeting-end-time is less meaningful (the opportunity has a terminal outcome timestamp anyway). Revisit post-MVP.

**Step 6: Typecheck + sanity test.**

```bash
pnpm tsc --noEmit
```

**Step 7: Backend smoke test via Convex dashboard.**
1. Find a `forgot_to_press` pending review.
2. Run `resolveReview({ reviewId, resolutionAction: "acknowledged" })` — expect it to throw.
3. Run `resolveReview({ reviewId, resolutionAction: "acknowledged", manualStartedAt: meeting.scheduledAt, manualStoppedAt: meeting.scheduledAt + 30*60*1000 })` — expect success.
4. Refresh the meeting: `status === "completed"`, `startedAt === manualStartedAt`, `stoppedAtSource === "admin_manual"`.
5. Query the `domainEvents` table filtered by `eventType: "meeting.times_manually_set"` — expect one new row.

**Key implementation notes:**
- **Order of operations inside `acknowledged`:** (1) build reviewPatch, (2) if manual times → patch meeting + aggregate + emit times_manually_set, (3) patch review, (4) emit overran_review_resolved. This order ensures that if any step fails, we haven't left inconsistent state (Convex mutations are transactional, so actually any failure rolls back the entire thing, but ordering still matters for readability).
- **`replaceMeetingAggregate` timing.** Must be called AFTER the `ctx.db.patch(review.meetingId, { ... })` so the aggregate reads the new state. If we called it before, the aggregate would be rewritten with the old values.
- **`as const` assertions on source fields.** Required for the same reason as Phase 2A (union validator vs. string widening).
- **Why not extend the `disputed` branch too?** `disputed` reverts outcomes and puts the meeting back into `meeting_overran`. If admin disputes a closer-recorded payment because the Fathom recording shows the closer's times were wrong, the correct flow is: dispute → then (in a future phase) re-open a review or directly edit times. MVP scope: no.
- **`Partial<Doc<"meetingReviews">>` typing.** The `reviewPatch` object is built conditionally; the Convex-generated patch arg accepts optionals cleanly. Avoid casting to `any`.
- **Log line.** The existing `console.log("[Review] acknowledged", ...)` should include `manualTimesApplied` so grepping the logs during an incident quickly shows which acknowledges used manual times.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reviews/mutations.ts` | Modify | Add manualStartedAt/manualStoppedAt args; guards; replace `acknowledged` branch body; emit `meeting.times_manually_set`. |

---

### 3C — Frontend: `AcknowledgeWithTimesSheet` Component

**Type:** Frontend
**Parallelizable:** Yes with 3A, 3B, 3E. Pure new file; imports nothing from the other subphases.

**What:** Create `app/workspace/reviews/[reviewId]/_components/acknowledge-with-times-sheet.tsx`, a React Hook Form + Zod form rendered in a shadcn Sheet. Two `<Input type="datetime-local">` fields (start / end), optional `<Textarea>` note, Save/Cancel footer. On submit, calls `useMutation(api.reviews.mutations.resolveReview)` with `manualStartedAt` / `manualStoppedAt` in Unix ms.

**Why:** This is the admin's affordance for entering actual times. Design §6.1 specifies a Sheet (not Dialog) for vertical space; it uses RHF + Zod per AGENTS.md form conventions. The Fathom link renders prominently so the admin can open the recording in a new tab while filling out the form.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/acknowledge-with-times-sheet.tsx` (new)

**How:**

**Step 1: Create the component.**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/acknowledge-with-times-sheet.tsx
"use client";

import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useEffect } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const MAX_DURATION_MS = 8 * 60 * 60 * 1000;          // mirrors backend
const MIN_START_BEFORE_SCHEDULED_MS = 60 * 60 * 1000; // mirrors backend

// datetime-local string (YYYY-MM-DDTHH:mm) → Unix ms (browser local TZ)
function parseLocalDateTime(value: string): number {
  return new Date(value).valueOf();
}

// Unix ms → datetime-local string in the admin's local TZ
function formatForInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

type AcknowledgeWithTimesSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewId: Id<"meetingReviews">;
  meetingId: Id<"meetings">;
  scheduledAt: number;
  durationMinutes: number;
  fathomLink?: string;
};

export function AcknowledgeWithTimesSheet({
  open,
  onOpenChange,
  reviewId,
  meetingId: _meetingId,  // parent passes for parity/logging; we call via reviewId
  scheduledAt,
  durationMinutes,
  fathomLink,
}: AcknowledgeWithTimesSheetProps) {
  const resolveReview = useMutation(api.reviews.mutations.resolveReview);

  const schema = z
    .object({
      startedAt: z.string().min(1, "Required"),
      stoppedAt: z.string().min(1, "Required"),
      note: z.string().optional(),
    })
    .superRefine((values, ctx) => {
      const start = parseLocalDateTime(values.startedAt);
      const end = parseLocalDateTime(values.stoppedAt);
      if (Number.isNaN(start) || Number.isNaN(end)) return;
      if (start >= end) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "End time must be after start time.",
        });
      }
      if (end - start > MAX_DURATION_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "Duration cannot exceed 8 hours.",
        });
      }
      if (start < scheduledAt - MIN_START_BEFORE_SCHEDULED_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["startedAt"],
          message: "Start time cannot be more than 60 minutes before scheduled.",
        });
      }
      if (end > Date.now()) {
        ctx.addIssue({
          code: "custom",
          path: ["stoppedAt"],
          message: "End time cannot be in the future.",
        });
      }
    });

  const form = useForm({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      startedAt: formatForInput(scheduledAt),
      stoppedAt: formatForInput(scheduledAt + durationMinutes * 60_000),
      note: "",
    },
  });

  // Reset form state when the Sheet reopens for a fresh review context.
  useEffect(() => {
    if (open) {
      form.reset({
        startedAt: formatForInput(scheduledAt),
        stoppedAt: formatForInput(scheduledAt + durationMinutes * 60_000),
        note: "",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scheduledAt, durationMinutes]);

  const onSubmit = async (values: {
    startedAt: string;
    stoppedAt: string;
    note?: string;
  }) => {
    try {
      await resolveReview({
        reviewId,
        resolutionAction: "acknowledged",
        manualStartedAt: parseLocalDateTime(values.startedAt),
        manualStoppedAt: parseLocalDateTime(values.stoppedAt),
        resolutionNote: values.note?.trim() || undefined,
      });
      toast.success("Meeting times recorded and review acknowledged.");
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not save times";
      toast.error(message);
    }
  };

  const startedAtWatch = form.watch("startedAt");
  const stoppedAtWatch = form.watch("stoppedAt");
  const previewDuration = (() => {
    const start = parseLocalDateTime(startedAtWatch);
    const end = parseLocalDateTime(stoppedAtWatch);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
    return Math.round((end - start) / 60_000);
  })();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[480px] sm:max-w-[520px]">
        <SheetHeader>
          <SheetTitle>Acknowledge with actual times</SheetTitle>
          <SheetDescription>
            Verify the meeting start and end in the Fathom recording, then enter
            them below. These become the authoritative times on the meeting.
          </SheetDescription>
        </SheetHeader>

        {fathomLink && (
          <div className="mt-4">
            <a
              href={fathomLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline underline-offset-2"
            >
              Open Fathom recording →
            </a>
          </div>
        )}

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="mt-6 space-y-4">
            <FormField
              control={form.control}
              name="startedAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Meeting started at <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="stoppedAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Meeting ended at <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {previewDuration !== null && (
              <p className="text-xs text-muted-foreground">
                Duration: {previewDuration} min
              </p>
            )}

            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Resolution note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="e.g., Verified in Fathom — closer forgot to press Start but meeting was clearly legitimate."
                      rows={3}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <SheetFooter className="pt-4">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={form.formState.isSubmitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting
                  ? "Saving…"
                  : "Acknowledge with times"}
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
```

**Step 2: Typecheck.**

```bash
pnpm tsc --noEmit
```

**Key implementation notes:**
- **RHF + `standardSchemaResolver`** per AGENTS.md. Do NOT use `zodResolver` — repository pattern is `standardSchemaResolver(schema)` with `import { z } from "zod"`.
- **`useEffect` form reset on `open` change.** The Sheet may be reused across reviews if the admin closes+reopens with a different context. The reset keeps defaults aligned with the current review's scheduledAt / durationMinutes.
- **Time-zone correctness.** `<Input type="datetime-local">` has no TZ suffix. `new Date(value).valueOf()` interprets in the browser's local TZ. `formatForInput()` produces local-TZ-formatted strings. Roundtrip is identity — the admin sees the same numbers they typed. `Date.now()` on submit → Unix ms UTC, correct as a comparison point against `meeting.scheduledAt` (also Unix ms UTC).
- **`previewDuration` is an inline live preview** under the end-time field. Helps the admin sanity-check that they're not entering a 3-hour meeting when Fathom shows 30 minutes.
- **`meetingId` prop is accepted but unused** in the body — kept for future logging / analytics hooks that may want to include it. Eslint won't complain because the name starts with `_`.
- **Don't use `useState` for `isSubmitting`**. RHF already tracks this via `form.formState.isSubmitting`. Using a second state variable is a common anti-pattern in the codebase (see AGENTS.md > Form Patterns).
- **Backend guard is the ultimate authority.** The form's Zod schema duplicates the rules for fast frontend feedback, but if the admin bypasses the form (dev tools or direct API call), the backend in 3B rejects. Good defense-in-depth.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/acknowledge-with-times-sheet.tsx` | Create | RHF + Zod form in a shadcn Sheet; writes `manualStartedAt`/`manualStoppedAt` via `resolveReview`. |

---

### 3D — Frontend: Integrate Sheet into `review-resolution-bar`

**Type:** Frontend
**Parallelizable:** No — depends on 3C. Does not depend on 3B (the backend change is orthogonal — the bar only cares that the mutation accepts the new args).

**What:** Modify `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` so the "Acknowledge" button opens the new `AcknowledgeWithTimesSheet` when `review.closerResponse === "forgot_to_press"`, and opens the existing simple confirmation Dialog otherwise.

**Why:** The existing bar has a single "Acknowledge" button tied to a confirmation Dialog that just sends `resolutionAction: "acknowledged"` to the backend. For `forgot_to_press` reviews, the backend now requires manual times (3B), so the UI must route those cases to the Sheet.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` (modify)

**How:**

**Step 1: Import the Sheet.** Add to the imports:

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx
import { AcknowledgeWithTimesSheet } from "./acknowledge-with-times-sheet";
```

**Step 2: Add local state for the Sheet.** Alongside the existing `ackDialogOpen` state (or equivalent):

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx
const [ackSheetOpen, setAckSheetOpen] = useState(false);
```

**Step 3: Branch the Acknowledge button's onClick.**

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx — near the Acknowledge button
const acknowledgedNeedsTimes = review.closerResponse === "forgot_to_press";

<Button
  variant="default"
  onClick={() => {
    if (acknowledgedNeedsTimes) {
      setAckSheetOpen(true);
    } else {
      // Existing code path: open the simple confirm Dialog
      setAckDialogOpen(true);
    }
  }}
>
  Acknowledge
</Button>
```

**Step 4: Render the Sheet conditionally.** At the bottom of the component's JSX:

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx — end of return
{acknowledgedNeedsTimes && (
  <AcknowledgeWithTimesSheet
    open={ackSheetOpen}
    onOpenChange={setAckSheetOpen}
    reviewId={review._id}
    meetingId={review.meetingId}
    scheduledAt={meeting.scheduledAt}
    durationMinutes={meeting.durationMinutes}
    fathomLink={meeting.fathomLink}
  />
)}
```

**Step 5: Keep the existing confirmation Dialog untouched** for `did_not_attend` and for `null` (no closer response yet). Those paths don't require manual times.

**Step 6: Verify in browser.**

```bash
pnpm dev
```

Open a `forgot_to_press` review → click Acknowledge → Sheet opens. Open a `did_not_attend` review → click Acknowledge → Dialog opens.

**Key implementation notes:**
- **Read from `review.closerResponse`**, not from a derived `closerResponded` flag. The union value drives both behaviour and UI copy; capturing it directly keeps the code honest.
- **`meeting.fathomLink` might be undefined.** The Sheet handles the `undefined` case gracefully (renders no anchor). Pass the raw value; don't fallback to an empty string.
- **`acknowledgedNeedsTimes` is computed per-render, not memoised.** It's a boolean derived from two small props — memoisation would be over-engineering.
- **Ensure existing Dialog is not double-opened.** If a naive paste keeps both `setAckDialogOpen(true)` and `setAckSheetOpen(true)` in the same click handler, both open. The if/else above prevents that.
- **If the existing bar ALSO has a `ReviewResolutionDialog`** that handles all actions (not just Acknowledge), leave that component alone — the Sheet is additive, for the single narrowly-scoped Acknowledge+forgot_to_press path.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | Modify | Route the Acknowledge button to Sheet when `closerResponse === "forgot_to_press"`. |

---

### 3E — Frontend: "Admin-Entered Meeting Times" Audit Card

**Type:** Frontend
**Parallelizable:** Yes — independent file addition in an existing page component. Touches a different JSX block than 3D.

**What:** In `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx`, add a new card that renders when `review.status === "resolved"` AND `review.manualStartedAt` AND `review.manualStoppedAt` are all set. Shows the saved start, end, computed duration, and resolver name.

**Why:** Without this, admins have no way to see after-the-fact what they (or another admin) entered as the true meeting times. The detail page is the natural place — it's already where admins go to audit review resolutions.

**Where:**
- `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` (modify)

**How:**

**Step 1: Fetch the resolver's name.** If the detail page already resolves a `resolvedByUserId → user.name` mapping (via a `useQuery(api.users.queries.getUser, { userId: review.resolvedByUserId })`), reuse it. If not, add:

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx
const resolver = useQuery(
  api.users.queries.getUserById,
  review.resolvedByUserId ? { userId: review.resolvedByUserId } : "skip",
);
const resolverName = resolver?.name ?? resolver?.email ?? "admin";
```

(Use whatever existing users query the codebase has — `api.users.queries.getCurrentUser` is for self; look for a `getUserById` or equivalent.)

**Step 2: Render the card, guarded on the three fields being present.** Insert in the page's JSX, near the existing "Resolution" or "Audit trail" card:

```tsx
// Path: app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx
{review.status === "resolved" &&
  review.manualStartedAt !== undefined &&
  review.manualStoppedAt !== undefined && (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Admin-entered meeting times</CardTitle>
        <CardDescription>
          Set by {resolverName} on{" "}
          {format(
            new Date(review.timesSetAt ?? review.resolvedAt ?? Date.now()),
            "PPpp",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <div>
          <span className="text-muted-foreground">Started:</span>{" "}
          {format(new Date(review.manualStartedAt), "PPpp")}
        </div>
        <div>
          <span className="text-muted-foreground">Ended:</span>{" "}
          {format(new Date(review.manualStoppedAt), "PPpp")}
        </div>
        <div>
          <span className="text-muted-foreground">Duration:</span>{" "}
          {Math.round(
            (review.manualStoppedAt - review.manualStartedAt) / 60_000,
          )}{" "}
          min
        </div>
      </CardContent>
    </Card>
  )}
```

**Step 3: Import `format` from `date-fns`.** If not already imported:

```tsx
import { format } from "date-fns";
```

**Step 4: Typecheck + visual pass.**

```bash
pnpm tsc --noEmit
pnpm dev
```

Open a review that has already been acknowledged with manual times — confirm the card renders with all three rows.

**Key implementation notes:**
- **Optional chaining on `review.timesSetAt ?? review.resolvedAt ?? Date.now()`.** Handles legacy reviews that were resolved before 1A schema deploy. They'd have `resolvedAt` but not `timesSetAt`. Fall through to `Date.now()` only as the last resort (should never hit in practice if 1A deployed cleanly).
- **Format string `"PPpp"`** is date-fns's long localized format ("Apr 17, 2026, 2:03:00 PM"). Matches the style used elsewhere in the review page.
- **Muted text color for labels.** Consistent with the existing meeting/lead info cards on the same page.
- **No edit affordance.** Once times are set, they're read-only from this card. Editing is Open Question #2 (deferred). If we need an "Edit times" button later, it opens the same Sheet with pre-filled values.
- **The card is additive** — it does not modify or replace any existing card on the detail page. If the existing "Resolution" card already shows `resolutionAction: "acknowledged"`, that's fine; the new card adds time-specific detail.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | Modify | Add "Admin-entered meeting times" card. |

---

### 3F — Browser Verification

**Type:** Manual (browser) — via `expect` MCP tool
**Parallelizable:** No — requires 3A + 3B + 3C + 3D + 3E all green.

**What:** Drive the full admin flow in a real browser:
1. Admin opens a `forgot_to_press` pending review.
2. Clicks Acknowledge → Sheet opens with defaults.
3. Clicks the Fathom link (opens new tab) → returns to Sheet.
4. Enters different times, sees live duration preview update.
5. Submits invalid times (end < start, >8h duration) → inline Zod errors appear.
6. Submits valid times → Sheet closes, toast success, page reactively updates to show the "Admin-entered meeting times" card.
7. Navigates to the meeting detail page → confirms `meeting.status === "completed"`, `startedAtSource === "admin_manual"`.

Also: run accessibility audit on the Sheet (focus trap, keyboard nav through datetime-local → datetime-local → textarea → buttons), performance metrics (no regression), responsive check (480px Sheet width holds at 375px viewport or collapses gracefully).

**Where:**
- Via `expect` MCP tools: `open`, `playwright`, `screenshot`, `console_logs`, `accessibility_audit`, `performance_metrics`, `close`.

**How:**

**Step 1: Seed data.** Ensure the test tenant has at least:
- One `forgot_to_press` pending review with a Fathom link set.
- One `did_not_attend` pending review (to confirm it still uses the Dialog, not the Sheet).
- One already-resolved-with-manual-times review (to confirm the audit card renders).

**Step 2: Drive the happy path.**

| Step | Action | Expectation |
|---|---|---|
| 1 | Open `/workspace/reviews/{forgot_to_press_reviewId}` | Review detail page loads. Acknowledge button visible. |
| 2 | Click Acknowledge | Sheet slides in from right. Fathom link visible. Start default = scheduledAt formatted in local TZ. End default = scheduledAt + durationMinutes. |
| 3 | Change end to 10 min before start | Inline error "End time must be after start time." Submit button stays enabled but form rejects. |
| 4 | Fix end to 1 hour after start | Error clears. "Duration: 60 min" preview appears. |
| 5 | Click "Acknowledge with times" | Toast "Meeting times recorded and review acknowledged." Sheet closes. |
| 6 | Page re-renders | "Admin-entered meeting times" card appears. Times match what was entered. |
| 7 | Navigate to `/workspace/closer/meetings/{meetingId}` (the reviewed meeting) | Meeting shows `completed` status. Time-tracking fields show the admin-entered values. |

**Step 3: Drive the did_not_attend path.** Open a `did_not_attend` review → click Acknowledge → confirm the existing Dialog opens (not the Sheet).

**Step 4: Run audits.**

```
expect.accessibility_audit   → axe-core clean on the Sheet (focus trap, label associations).
expect.performance_metrics   → LCP / CLS / INP within baseline.
expect.console_logs          → zero errors in the happy path.
```

**Step 5: Responsive check.** 1440 / 1024 / 768 / 375px viewports. At 375px, the Sheet either expands to full width or shows a scroll — both acceptable. Critical: inputs must remain tap-targets ≥ 44px.

**Step 6: Report.** Subagent returns: (a) screenshots at each step, (b) audit results, (c) duration in ms for the mutation + re-render, (d) any console errors.

**Key implementation notes:**
- **Delegate to a subagent** (AGENTS.md browser-verification rule).
- **Do not skip the invalid-input step.** It's the most likely source of frontend regressions — RHF + Zod error wiring has subtle failure modes.
- **Verify time-zone roundtrip.** Step 2: admin sees `2026-04-17 14:00` (their local TZ). Step 5: submit. Step 6: re-rendered card shows `Apr 17, 2026, 2:00:00 PM` (same local TZ via `format`). If the card shows a different time, TZ handling is broken.

**Files touched:**

None (verification-only subphase).

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/manualMeetingTimes.ts` | Create | 3A |
| `convex/reviews/mutations.ts` | Modify | 3B |
| `app/workspace/reviews/[reviewId]/_components/acknowledge-with-times-sheet.tsx` | Create | 3C |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | Modify | 3D |
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | Modify | 3E |

**Total files changed:** 5 (1 backend new, 1 backend modify, 1 frontend new, 2 frontend modify).
**New domain event type:** `meeting.times_manually_set`.
**No new tables, no new indexes, no new permissions.**
