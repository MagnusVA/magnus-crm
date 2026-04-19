# Phase 5 — Frontend: Closer Experience

**Goal:** Build the complete closer-facing UI for interacting with flagged meetings. After this phase, closers can: (1) see a prominent "Meeting Overran" banner on flagged meeting detail pages, (2) provide context via a dialog ("I forgot to press start" or "I didn't attend"), (3) schedule a follow-up on flagged meetings, (4) see flagged meetings highlighted in their dashboard and pipeline views. The Start Meeting button correctly branches between the normal start flow and the context dialog based on meeting status.

**Prerequisite:** Phase 1 complete (schema + status renames deployed). Phase 3 complete (closer backend mutations: `respondToOverranReview`, `scheduleFollowUpFromOverran`, `meetingReview` enrichment in `getMeetingDetail`).

**Runs in PARALLEL with:** Phase 6 (Admin Review Pipeline). Phase 5 modifies closer-facing components (`app/workspace/closer/`). Phase 6 creates admin-facing routes (`app/workspace/reviews/`) and modifies the workspace shell (`workspace-shell-client.tsx`). The only potential overlap is the workspace shell — Phase 6 adds the "Reviews" nav item, Phase 5 does NOT modify the shell.

**Skills to invoke:**
- `frontend-design` — Creating the context dialog and overran banner with high design quality.
- `shadcn` — Using Dialog, Select, Textarea, Button, Alert, Badge components.
- `vercel-react-best-practices` — Component optimization, form handling patterns.
- `expect` — Browser verification of the overran flow end-to-end.

**Acceptance Criteria:**
1. On a meeting detail page where `opportunity.status === "meeting_overran"`, the "Meeting Overran" banner renders prominently with: detection timestamp, closer response status, and action buttons.
2. The "Provide Context" button opens the context dialog with two options: "I forgot to press start" and "I didn't attend."
3. Selecting "I forgot to press start" reveals required fields: stated outcome (select), estimated duration (select), and note (textarea). All three are required.
4. Selecting "I didn't attend" reveals only the note field (required).
5. Submitting "forgot to press start" calls `respondToOverranReview` and shows a confirmation alert: "Contact your supervisor. This meeting is flagged for admin review."
6. Submitting "didn't attend" calls `respondToOverranReview` and shows a success toast.
7. The "Schedule Follow-Up" button calls `scheduleFollowUpFromOverran` with a required note and transitions the opportunity reactively via Convex's real-time updates.
8. After the closer responds, the "Provide Context" button disappears and the banner shows the closer's response summary.
9. The normal `OutcomeActionBar` returns `null` when `opportunity.status === "meeting_overran"` — replaced by the overran banner.
10. The Start Meeting button on the outcome action bar opens the context dialog when `meeting.status === "meeting_overran"`, instead of calling `startMeeting`.
11. The closer dashboard pipeline strip shows "Meeting Overran" count with amber styling.
12. The closer pipeline page filter includes `meeting_overran` as a filterable status.
13. All form validation uses React Hook Form + Zod + `standardSchemaResolver` per AGENTS.md form patterns.
14. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (Context dialog component) ────────────────────────────────────────┐
                                                                       │
5B (Meeting overran banner) ──────────────────────────────────────────┤
                                                                       │
5A + 5B complete ────┬── 5C (Outcome action bar updates)              │
                     │                                                 │
                     └── 5D (Meeting detail page integration)          │
                                                                       │
5E (Closer dashboard + pipeline updates) ─────────────────────────────┘
                                                                       │
5D complete ──────────────────────────────────────────────────────────┘
```

**Optimal execution:**
1. Start 5A, 5B, and 5E in parallel (different files, no overlap).
2. Once 5A and 5B complete → start 5C and 5D (they consume the dialog and banner components).
3. 5E is fully independent and can run at any time.

**Estimated time:** 2–3 days

---

## Subphases

### 5A — Meeting Overran Context Dialog

**Type:** Frontend
**Parallelizable:** Yes — creates a new component. No file overlap with other subphases.

**What:** Create the `MeetingOverranContextDialog` component — a dialog that lets closers provide context on a flagged meeting. Two options: "I forgot to press start" (with stated outcome, estimated duration, note) or "I didn't attend" (with note only). Includes confirmation alert for "forgot to press start" submissions.

**Why:** This is the closer's primary interaction point with the review system. The dialog captures structured context that helps the admin make informed resolution decisions. Without it, the admin reviews have no closer input.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` (new)

**How:**

**Step 1: Create the component file with Zod schema and form**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

// ── Zod Schema ────────────────────────────────────────────────────────
const contextSchema = z
  .object({
    closerResponse: z.enum(["forgot_to_press", "did_not_attend"]),
    closerNote: z.string().min(1, "A note is required"),
    closerStatedOutcome: z.enum([
      "sale_made",
      "follow_up_needed",
      "lead_not_interested",
      "lead_no_show",
      "other",
    ]).optional(),
    estimatedMeetingDurationMinutes: z.coerce
      .number()
      .min(1, "Duration must be at least 1 minute")
      .max(480, "Duration cannot exceed 480 minutes")
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.closerResponse === "forgot_to_press") {
      if (!data.closerStatedOutcome) {
        ctx.addIssue({
          code: "custom",
          path: ["closerStatedOutcome"],
          message: "Stated outcome is required when you forgot to press start",
        });
      }
      if (!data.estimatedMeetingDurationMinutes) {
        ctx.addIssue({
          code: "custom",
          path: ["estimatedMeetingDurationMinutes"],
          message: "Estimated duration is required",
        });
      }
    }
  });

type ContextFormValues = z.infer<typeof contextSchema>;

// ── Options ───────────────────────────────────────────────────────────
const STATED_OUTCOME_OPTIONS = [
  { value: "sale_made", label: "Sale was made — payment needs to be logged" },
  { value: "follow_up_needed", label: "Lead wants to think about it — needs follow-up" },
  { value: "lead_not_interested", label: "Lead is not interested — deal is lost" },
  { value: "lead_no_show", label: "Lead didn't show up" },
  { value: "other", label: "Other (describe in note)" },
] as const;

const DURATION_OPTIONS = [
  { value: 5, label: "~5 minutes" },
  { value: 10, label: "~10 minutes" },
  { value: 15, label: "~15 minutes" },
  { value: 20, label: "~20 minutes" },
  { value: 25, label: "~25 minutes" },
  { value: 30, label: "~30 minutes" },
  { value: 45, label: "~45 minutes" },
  { value: 60, label: "~60 minutes" },
  { value: 90, label: "~90 minutes" },
  { value: 120, label: "~2 hours" },
] as const;

// ── Component ─────────────────────────────────────────────────────────
type MeetingOverranContextDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reviewId: Id<"meetingReviews">;
};

export function MeetingOverranContextDialog({
  open,
  onOpenChange,
  reviewId,
}: MeetingOverranContextDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const respondToReview = useMutation(
    api.closer.meetingOverrun.respondToOverranReview,
  );

  const form = useForm({
    resolver: standardSchemaResolver(contextSchema),
    defaultValues: {
      closerResponse: undefined as "forgot_to_press" | "did_not_attend" | undefined,
      closerNote: "",
      closerStatedOutcome: undefined,
      estimatedMeetingDurationMinutes: undefined,
    },
  });

  const selectedResponse = form.watch("closerResponse");

  const onSubmit = async (data: ContextFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      await respondToReview({
        reviewId,
        closerResponse: data.closerResponse,
        closerNote: data.closerNote,
        closerStatedOutcome:
          data.closerResponse === "forgot_to_press"
            ? data.closerStatedOutcome
            : undefined,
        estimatedMeetingDurationMinutes:
          data.closerResponse === "forgot_to_press"
            ? data.estimatedMeetingDurationMinutes
            : undefined,
      });

      if (data.closerResponse === "forgot_to_press") {
        onOpenChange(false);
        setShowConfirmation(true);
      } else {
        onOpenChange(false);
        toast.success("Response recorded");
      }

      form.reset();
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Failed to submit response",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Meeting Overran — Provide Context</DialogTitle>
            <DialogDescription>
              The system detected that this meeting's scheduled time passed with
              no activity. Please explain what happened.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
            >
              {submitError && (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              {/* Response type selection */}
              <FormField
                control={form.control}
                name="closerResponse"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      What happened?{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select what happened..." />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="forgot_to_press">
                          I forgot to press start — I actually attended
                        </SelectItem>
                        <SelectItem value="did_not_attend">
                          I didn't attend this meeting
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Conditional fields for "forgot to press start" */}
              {selectedResponse === "forgot_to_press" && (
                <>
                  <FormField
                    control={form.control}
                    name="closerStatedOutcome"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          What was the outcome?{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select outcome..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {STATED_OUTCOME_OPTIONS.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="estimatedMeetingDurationMinutes"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          Estimated meeting duration{" "}
                          <span className="text-destructive">*</span>
                        </FormLabel>
                        <Select
                          onValueChange={(val) =>
                            field.onChange(Number(val))
                          }
                          value={field.value?.toString()}
                          disabled={isSubmitting}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Select duration..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {DURATION_OPTIONS.map((opt) => (
                              <SelectItem
                                key={opt.value}
                                value={opt.value.toString()}
                              >
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              {/* Note field — always visible when a response is selected */}
              {selectedResponse && (
                <FormField
                  control={form.control}
                  name="closerNote"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        {selectedResponse === "forgot_to_press"
                          ? "Describe what happened during the meeting"
                          : "Why didn't you attend?"}{" "}
                        <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          placeholder={
                            selectedResponse === "forgot_to_press"
                              ? "E.g., Had a great call, lead is interested in the premium plan..."
                              : "E.g., Had a scheduling conflict, emergency came up..."
                          }
                          rows={3}
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting || !selectedResponse}>
                  {isSubmitting ? (
                    <>
                      <Loader2Icon className="animate-spin" data-icon="inline-start" />
                      Submitting...
                    </>
                  ) : (
                    "Submit Response"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Confirmation dialog — shown after "forgot to press start" submission */}
      <AlertDialog open={showConfirmation} onOpenChange={setShowConfirmation}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangleIcon className="size-5 text-amber-500" />
              Meeting Flagged for Review
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your response has been recorded. This meeting is flagged for admin
              review. Please contact your supervisor or admin to notify them so
              they can process the outcome.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction>Understood</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

**Key implementation notes:**
- Uses `standardSchemaResolver` (not `zodResolver`) per AGENTS.md form patterns.
- `.superRefine()` with targeted `ctx.addIssue({ path: [...] })` validates conditional required fields — errors appear on the specific field, not at the form level.
- `z.coerce.number()` handles the select value → number conversion for `estimatedMeetingDurationMinutes`.
- The form resets after successful submission via `form.reset()`.
- The confirmation `AlertDialog` is outside the main `Dialog` — it opens after the main dialog closes, preventing nested dialogs.
- `form.watch("closerResponse")` triggers re-renders to show/hide conditional fields.
- The dialog does NOT change meeting or opportunity status — it only submits context to the review.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | Create | Context dialog with RHF + Zod form |

---

### 5B — Meeting Overran Banner

**Type:** Frontend
**Parallelizable:** Yes — creates a new component. No file overlap with 5A.

**What:** Create the `MeetingOverranBanner` component — a prominent banner that replaces the normal `OutcomeActionBar` when an opportunity is in `meeting_overran` status. Shows detection info, closer response (if any), and action buttons ("Provide Context" and "Schedule Follow-Up").

**Why:** The banner is the closer's primary visual indicator that something needs attention. It provides immediate context (when was it flagged, what did they say) and clear action paths. Without it, the closer has no way to know a meeting is flagged or interact with the review.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` (new)

**How:**

**Step 1: Create the banner component**

```tsx
// Path: app/workspace/closer/meetings/_components/meeting-overran-banner.tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  TimerIcon,
  MessageSquareIcon,
  CalendarPlusIcon,
  Loader2Icon,
  CheckCircle2Icon,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { MeetingOverranContextDialog } from "./meeting-overran-context-dialog";

// ── Follow-up note schema ─────────────────────────────────────────────
const followUpSchema = z.object({
  note: z.string().min(1, "A note describing your follow-up plan is required"),
});

// ── Closer response labels ────────────────────────────────────────────
const CLOSER_RESPONSE_LABELS: Record<string, string> = {
  forgot_to_press: "I forgot to press start — I actually attended",
  did_not_attend: "I didn't attend this meeting",
};

const STATED_OUTCOME_LABELS: Record<string, string> = {
  sale_made: "Sale was made — payment needs to be logged",
  follow_up_needed: "Lead wants to think about it — needs follow-up",
  lead_not_interested: "Lead is not interested — deal is lost",
  lead_no_show: "Lead didn't show up",
  other: "Other",
};

// ── Component ─────────────────────────────────────────────────────────
type MeetingOverranBannerProps = {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  meetingReview: Doc<"meetingReviews"> | null;
};

export function MeetingOverranBanner({
  meeting,
  opportunity,
  meetingReview,
}: MeetingOverranBannerProps) {
  const [showContextDialog, setShowContextDialog] = useState(false);
  const [showFollowUpForm, setShowFollowUpForm] = useState(false);
  const [isSchedulingFollowUp, setIsSchedulingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  const scheduleFollowUp = useMutation(
    api.closer.meetingOverrun.scheduleFollowUpFromOverran,
  );

  const followUpForm = useForm({
    resolver: standardSchemaResolver(followUpSchema),
    defaultValues: { note: "" },
  });

  const hasResponded = !!meetingReview?.closerResponse;
  const canProvideContext =
    meetingReview && !hasResponded && meetingReview.status !== "resolved";
  const canScheduleFollowUp = opportunity.status === "meeting_overran";

  const handleScheduleFollowUp = async (data: { note: string }) => {
    setIsSchedulingFollowUp(true);
    setFollowUpError(null);
    try {
      await scheduleFollowUp({
        opportunityId: opportunity._id,
        note: data.note,
      });
      toast.success("Follow-up scheduled");
      setShowFollowUpForm(false);
      followUpForm.reset();
    } catch (error) {
      setFollowUpError(
        error instanceof Error ? error.message : "Failed to schedule follow-up",
      );
    } finally {
      setIsSchedulingFollowUp(false);
    }
  };

  return (
    <>
      <div
        role="region"
        aria-label="Meeting overran notification"
        className="flex flex-col gap-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800/40 dark:bg-amber-950/20"
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <TimerIcon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <p className="font-medium text-amber-900 dark:text-amber-100">
                Meeting Overran — Closer Did Not Attend
              </p>
              <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-400 dark:border-amber-700">
                Needs Attention
              </Badge>
            </div>
            <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">
              The system detected that no activity occurred for this meeting
              before its scheduled end time.
              {meeting.overranDetectedAt && (
                <>
                  {" "}
                  Detected:{" "}
                  {format(new Date(meeting.overranDetectedAt), "MMM d, yyyy 'at' h:mm a")}
                </>
              )}
            </p>
          </div>
        </div>

        {/* Closer response summary (if already responded) */}
        {hasResponded && meetingReview && (
          <div className="rounded-md border border-amber-200/60 bg-white/50 p-3 dark:border-amber-800/30 dark:bg-amber-950/30">
            <div className="flex items-center gap-2 text-sm">
              <CheckCircle2Icon className="size-4 text-amber-600 dark:text-amber-400" />
              <span className="font-medium text-amber-800 dark:text-amber-200">
                Your Response:
              </span>
              <span className="text-amber-700 dark:text-amber-300">
                {CLOSER_RESPONSE_LABELS[meetingReview.closerResponse!] ?? meetingReview.closerResponse}
              </span>
            </div>
            {meetingReview.closerStatedOutcome && (
              <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">
                Stated Outcome:{" "}
                {STATED_OUTCOME_LABELS[meetingReview.closerStatedOutcome] ?? meetingReview.closerStatedOutcome}
              </p>
            )}
            {meetingReview.estimatedMeetingDurationMinutes && (
              <p className="mt-0.5 text-sm text-amber-600 dark:text-amber-400">
                Estimated Duration: ~{meetingReview.estimatedMeetingDurationMinutes} minutes
              </p>
            )}
            {meetingReview.closerNote && (
              <p className="mt-1 text-sm italic text-amber-600 dark:text-amber-400">
                "{meetingReview.closerNote}"
              </p>
            )}
            {meetingReview.closerRespondedAt && (
              <p className="mt-1 text-xs text-amber-500 dark:text-amber-500">
                Responded: {format(new Date(meetingReview.closerRespondedAt), "MMM d 'at' h:mm a")}
              </p>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {canProvideContext && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowContextDialog(true)}
              className="border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
            >
              <MessageSquareIcon data-icon="inline-start" />
              Provide Context
            </Button>
          )}

          {canScheduleFollowUp && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFollowUpForm(!showFollowUpForm)}
              className="border-amber-300 text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
            >
              <CalendarPlusIcon data-icon="inline-start" />
              Schedule Follow-Up
            </Button>
          )}
        </div>

        {/* Inline follow-up form */}
        {showFollowUpForm && canScheduleFollowUp && (
          <Form {...followUpForm}>
            <form
              onSubmit={followUpForm.handleSubmit(handleScheduleFollowUp)}
              className="space-y-3 rounded-md border border-amber-200/60 bg-white/50 p-3 dark:border-amber-800/30 dark:bg-amber-950/30"
            >
              {followUpError && (
                <Alert variant="destructive">
                  <AlertDescription>{followUpError}</AlertDescription>
                </Alert>
              )}

              <FormField
                control={followUpForm.control}
                name="note"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Follow-up plan{" "}
                      <span className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Describe your plan to reach out to the lead..."
                        rows={2}
                        disabled={isSchedulingFollowUp}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={isSchedulingFollowUp}
                >
                  {isSchedulingFollowUp ? (
                    <>
                      <Loader2Icon className="animate-spin" data-icon="inline-start" />
                      Scheduling...
                    </>
                  ) : (
                    "Schedule Follow-Up"
                  )}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowFollowUpForm(false);
                    followUpForm.reset();
                  }}
                  disabled={isSchedulingFollowUp}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Form>
        )}

        {/* Review resolved notification */}
        {meetingReview?.status === "resolved" && (
          <div className="rounded-md border border-green-200 bg-green-50 p-3 dark:border-green-800/40 dark:bg-green-950/20">
            <p className="text-sm font-medium text-green-800 dark:text-green-200">
              ✓ This review has been resolved by an admin.
            </p>
          </div>
        )}
      </div>

      {/* Context dialog */}
      {meetingReview && (
        <MeetingOverranContextDialog
          open={showContextDialog}
          onOpenChange={setShowContextDialog}
          reviewId={meetingReview._id}
        />
      )}
    </>
  );
}
```

**Key implementation notes:**
- The banner is self-contained — it manages its own state for the follow-up form and context dialog.
- The `canProvideContext` flag checks: review exists, closer hasn't responded yet, and review isn't resolved. Once any condition fails, the "Provide Context" button hides.
- The `canScheduleFollowUp` flag checks only `opportunity.status === "meeting_overran"`. If the closer already scheduled a follow-up (opportunity → `follow_up_scheduled`), this hides reactively via Convex's real-time updates.
- The follow-up form is inline (not a dialog) to reduce friction — the closer shouldn't have to open two layers of modals.
- When the review is resolved (admin acted), a green notification appears at the bottom. This updates in real-time via `usePreloadedQuery`.
- Amber color scheme matches the `meeting_overran` status styling from `lib/status-config.ts`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | Create | Banner component with context dialog trigger + inline follow-up form |

---

### 5C — Outcome Action Bar Updates

**Type:** Frontend
**Parallelizable:** No — depends on 5A (imports `MeetingOverranContextDialog`). Must run after 5A.

**What:** Update the `OutcomeActionBar` to: (1) return `null` when `opportunity.status === "meeting_overran"` (replaced by the banner), (2) handle the "Start Meeting" button opening the context dialog when `meeting.status === "meeting_overran"`.

**Why:** The outcome action bar must not show normal outcome options for flagged meetings — the review system controls the resolution. The Start Meeting button must correctly branch to the context dialog instead of calling `startMeeting` on flagged meetings.

**Where:**
- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (modify)

**How:**

**Step 1: Add early return for `meeting_overran` opportunity status**

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

// At the top of the component body, BEFORE any other rendering logic:

// Meeting overran: handled by MeetingOverranBanner — no normal actions
if (opportunity.status === "meeting_overran") return null;
```

**Step 2: Update "Start Meeting" handler for `meeting_overran` meeting status**

The Phase 1 cleanup (1E) removed the old `LateStartReasonDialog` references. Now add the new branching:

```tsx
// Path: app/workspace/closer/meetings/_components/outcome-action-bar.tsx

// The handleStartMeeting function should branch:
const handleStartMeeting = async () => {
  if (meeting.status === "meeting_overran") {
    // Meeting is flagged — the MeetingOverranBanner handles this
    // This code path shouldn't be reachable since the action bar returns null
    // for meeting_overran opportunities, but as a safety net:
    return;
  }

  if (windowStatus === "outside_window") {
    // Window has passed — show error toast
    toast.error("Meeting window has passed. Wait for the system to flag it for review.");
    return;
  }

  // Normal start flow
  try {
    await startMeeting({ meetingId: meeting._id });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Failed to start meeting");
  }
};
```

**Step 3: Remove old late-start dialog state and imports (if not done in Phase 1)**

Verify that all references to `LateStartReasonDialog`, `showLateStartDialog`, `setShowLateStartDialog` are removed. Phase 1E should have handled this, but confirm.

**Key implementation notes:**
- The early return `if (opportunity.status === "meeting_overran") return null` is the simplest and most correct approach. The `MeetingOverranBanner` component (rendered in the meeting detail page layout) replaces the entire action bar.
- The `handleStartMeeting` branching for `meeting.status === "meeting_overran"` is technically dead code (the action bar returns null before reaching the button), but provides defense-in-depth.
- When the window has passed but the meeting isn't flagged yet (between window close and scheduler fire), show a toast explaining the situation. The closer waits for the system to flag it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | Add meeting_overran early return, update start handler |

---

### 5D — Meeting Detail Page Integration

**Type:** Frontend
**Parallelizable:** No — depends on 5B (imports `MeetingOverranBanner`).

**What:** Integrate the `MeetingOverranBanner` into the meeting detail page client component. When the meeting has a review, show the banner in the appropriate position (below the header, above the meeting info panels).

**Why:** The banner must be visible prominently on the page — it's the closer's primary interaction point for flagged meetings. Placing it between the header and the info panels ensures the closer sees it immediately without scrolling.

**Where:**
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**How:**

**Step 1: Import the banner component**

```tsx
// Path: app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx

import { MeetingOverranBanner } from "../../_components/meeting-overran-banner";
```

**Step 2: Extract `meetingReview` from the preloaded data**

```tsx
// Inside the component body, after loading detail:
const meetingReview = detail.meetingReview ?? null;
```

**Step 3: Render the banner conditionally**

```tsx
// Path: meeting-detail-page-client.tsx — insert in the JSX after the header/breadcrumb
// and BEFORE the info panels

{/* Meeting Overran Banner — shown when opportunity is meeting_overran */}
{opportunity.status === "meeting_overran" && (
  <MeetingOverranBanner
    meeting={meeting}
    opportunity={opportunity}
    meetingReview={meetingReview}
  />
)}
```

**Step 4: Also show the banner when meeting is `meeting_overran` but opportunity has moved**

```tsx
// Even if the closer already scheduled a follow-up (opportunity → follow_up_scheduled),
// the banner should still show (with the response summary but without action buttons).
// Update the condition:

{(opportunity.status === "meeting_overran" || meeting.status === "meeting_overran") && meetingReview && (
  <MeetingOverranBanner
    meeting={meeting}
    opportunity={opportunity}
    meetingReview={meetingReview}
  />
)}
```

**Step 5: Update the type definition for `MeetingDetailData`**

Ensure the type includes `meetingReview`:

```tsx
// Update the MeetingDetailData type to include:
meetingReview: Doc<"meetingReviews"> | null;
```

**Key implementation notes:**
- The banner renders based on `meeting.status === "meeting_overran"` OR `opportunity.status === "meeting_overran"`. This covers both cases: (1) meeting is flagged and opportunity is meeting_overran (fresh flag), (2) meeting is flagged but opportunity has moved on (closer scheduled follow-up).
- The `OutcomeActionBar` already returns `null` for `meeting_overran` opportunities (5C), so there's no conflict.
- The `meetingReview` data comes from the preloaded query enriched in Phase 3 (3C).
- The banner is placed after any header/breadcrumb elements but before the main content grid — it's a prominent alert that demands immediate attention.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | Add MeetingOverranBanner integration + type update |

---

### 5E — Closer Dashboard & Pipeline Updates

**Type:** Frontend
**Parallelizable:** Yes — touches different files from 5A-5D. Can run in parallel with everything.

**What:** Update the closer dashboard pipeline strip and closer pipeline page to display `meeting_overran` as a visible, filterable status with amber styling. This requires no new components — the status config updates (Phase 1D) handle the styling. This subphase ensures the closer's views correctly display the new status.

**Why:** The closer needs to see flagged meetings in their pipeline overview and be able to filter for them. Without this, `meeting_overran` opportunities are invisible in the closer's pipeline views even though the data model supports them.

**Where:**
- `app/workspace/closer/_components/closer-dashboard-page-client.tsx` (verify — may need no changes)
- `app/workspace/closer/_components/pipeline-strip.tsx` (verify — may need no changes)
- `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` (verify — may need no changes)

**How:**

**Step 1: Verify pipeline strip renders `meeting_overran`**

The `PipelineStrip` component maps through `PIPELINE_DISPLAY_ORDER` from `lib/status-config.ts`. Since Phase 1D already updated this array to include `meeting_overran`, the strip should render it automatically with the amber styling.

Verify that:
1. The `getPipelineSummary` query in `convex/closer/dashboard.ts` includes `meeting_overran` in its `PIPELINE_STATUSES` array and `counts` object (done in Phase 1C).
2. The `PipelineStrip` component doesn't hardcode status names — it should use `PIPELINE_DISPLAY_ORDER` dynamically.

**Step 2: Verify closer pipeline page filter**

The closer pipeline page (`/workspace/closer/pipeline`) allows filtering by status. Verify that:
1. The `listMyOpportunities` query in `convex/closer/pipeline.ts` accepts `meeting_overran` in its `statusFilter` validator (done in Phase 1C).
2. The pipeline filter UI renders `meeting_overran` as an option.

**Step 3: If the closer dashboard has a "flagged meetings" section**

If the design calls for a dedicated "Flagged — Needs Attention" section on the closer dashboard (see design Section 10.4), this would be a new section. For MVP, the pipeline strip's `meeting_overran` count serves this purpose. A dedicated section can be added post-MVP.

**Key implementation notes:**
- This subphase is mostly verification — the Phase 1 status renames should have propagated the `meeting_overran` status through the existing component architecture. The pipeline strip dynamically renders whatever statuses are in `PIPELINE_DISPLAY_ORDER`.
- If any component hardcodes status lists instead of using the shared config, update those hardcoded lists.
- The closer pipeline page's status filter dropdown derives its options from either the query args validator or a shared config. Verify the options include `meeting_overran`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Verify | Should work with Phase 1 changes |
| `app/workspace/closer/_components/pipeline-strip.tsx` | Verify | Should render meeting_overran from PIPELINE_DISPLAY_ORDER |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Verify | Filter should include meeting_overran |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | Create | 5A |
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | Create | 5B |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Modify | 5C |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | Modify | 5D |
| `app/workspace/closer/_components/closer-dashboard-page-client.tsx` | Verify | 5E |
| `app/workspace/closer/_components/pipeline-strip.tsx` | Verify | 5E |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Verify | 5E |
