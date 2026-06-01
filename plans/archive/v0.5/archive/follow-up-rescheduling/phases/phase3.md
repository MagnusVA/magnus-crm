# Phase 3 — Follow-Up Dialog Redesign

**Goal:** Replace the single-purpose follow-up dialog (currently: generates a Calendly single-use scheduling link via an action) with a two-path selection dialog. Path 1 ("Send Scheduling Link") generates a URL from the closer's personal Calendly event type with UTM params. Path 2 ("Set a Reminder") creates an in-app reminder record. After this phase, closers can choose between both follow-up methods from a single dialog.

**Prerequisite:** Phase 1 complete (schema deployed, `createSchedulingLinkFollowUp` and `createManualReminderFollowUpPublic` mutations available).

**Runs in PARALLEL with:** Phase 2 (Pipeline UTM Intelligence), Phase 4 (Reminders Dashboard), Phase 5 (Personal Event Type Assignment) — zero shared files.

**Skills to invoke:**
- `shadcn` — Building the two-card selection UI, form fields, toggle group for contact method.
- `frontend-design` — Production-grade dialog with smooth path transitions, accessible card selection.
- `web-design-guidelines` — WCAG compliance for dialog accessibility, focus management, keyboard navigation on path selection cards.
- `vercel-react-best-practices` — Optimized React patterns for dialog state management.
- `next-best-practices` — Client component patterns, form handling conventions.

**Acceptance Criteria:**
1. The follow-up dialog opens with a two-card selection UI: "Send Scheduling Link" and "Set a Reminder".
2. Selecting "Send Scheduling Link" transitions the dialog to the scheduling link form; clicking "Generate Link" calls `createSchedulingLinkFollowUp` and displays a copy-friendly link on success.
3. Selecting "Set a Reminder" transitions the dialog to the reminder form with: contact method (Call/Text toggle), date, time, and optional note fields.
4. Submitting the reminder form calls `createManualReminderFollowUpPublic` and closes the dialog on success.
5. A "Back" button in both path views returns to the selection screen.
6. The dialog resets to the selection screen when closed and reopened.
7. If the closer has no `personalEventTypeUri`, the scheduling link path shows an error: "No personal calendar configured. Ask your admin to assign one in Team settings."
8. The reminder form validates that the scheduled date/time is in the future (client-side).
9. PostHog events `follow_up_scheduling_link_created` and `follow_up_reminder_created` are tracked.
10. Path selection cards are keyboard-accessible (Enter/Space triggers selection, visible focus ring).
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
3A (Path selection UI) ──────────────────────���─────────────────┐
                                                                ├── 3C (Wire to dialog trigger — depends on 3A, 3B)
3B (Scheduling link form + Reminder form) ────────────────────┘

3C complete ──→ 3D (Verify & polish)
```

**Optimal execution:**
1. Start 3A (path selection skeleton) and 3B (form sub-components) in parallel — they're sub-components of the same file.
2. Once 3A and 3B are done → 3C (assemble the full dialog, wire to existing trigger).
3. Once 3C is done → 3D (visual polish, a11y check).

**Estimated time:** 1-2 days

---

## Subphases

### 3A — Dialog Shell & Path Selection UI

**Type:** Frontend
**Parallelizable:** Yes — can be built as a standalone component before the forms exist.

**What:** Rewrite `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` with the new dialog shell: state machine (`"selection" | "scheduling_link" | "manual_reminder"`), path selection cards, back button, and title switching.

**Why:** The dialog is the entry point for both follow-up paths. The path selection UI must be accessible (keyboard navigation, focus management) and visually clear (two distinct cards).

**Where:**
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (modify — full rewrite)

**How:**

**Step 1: Define the dialog state machine and shell**

```tsx
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx
"use client";

import { useState } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  CalendarPlusIcon,
  LinkIcon,
  BellIcon,
  ArrowLeftIcon,
} from "lucide-react";

type FollowUpDialogProps = {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
};

type DialogPath = "selection" | "scheduling_link" | "manual_reminder";

export function FollowUpDialog({
  opportunityId,
  onSuccess,
}: FollowUpDialogProps) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<DialogPath>("selection");

  const handleClose = () => {
    setOpen(false);
    // Reset to selection after close animation completes
    setTimeout(() => setPath("selection"), 200);
  };

  return (
    <Dialog open={open} onOpenChange={(value) => {
      setOpen(value);
      if (!value) {
        setTimeout(() => setPath("selection"), 200);
      }
    }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg">
          <CalendarPlusIcon data-icon="inline-start" />
          Schedule Follow-up
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {path === "selection" && "Schedule Follow-up"}
            {path === "scheduling_link" && "Send Scheduling Link"}
            {path === "manual_reminder" && "Set a Reminder"}
          </DialogTitle>
        </DialogHeader>

        {path !== "selection" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPath("selection")}
            className="self-start"
          >
            <ArrowLeftIcon data-icon="inline-start" />
            Back
          </Button>
        )}

        {path === "selection" && (
          <PathSelectionCards onSelect={setPath} />
        )}

        {path === "scheduling_link" && (
          <SchedulingLinkForm
            opportunityId={opportunityId}
            onSuccess={onSuccess}
            onClose={handleClose}
          />
        )}

        {path === "manual_reminder" && (
          <ManualReminderForm
            opportunityId={opportunityId}
            onSuccess={onSuccess}
            onClose={handleClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
```

**Step 2: Build the path selection cards**

```tsx
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx (continued)

function PathSelectionCards({
  onSelect,
}: {
  onSelect: (path: DialogPath) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Card
        className="cursor-pointer transition-colors hover:bg-accent"
        onClick={() => onSelect("scheduling_link")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect("scheduling_link");
          }
        }}
      >
        <CardHeader className="pb-2">
          <LinkIcon className="size-8 text-primary" />
          <CardTitle className="text-base">Send Link</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Generate a scheduling link for the lead to book their next
            appointment.
          </p>
        </CardContent>
      </Card>

      <Card
        className="cursor-pointer transition-colors hover:bg-accent"
        onClick={() => onSelect("manual_reminder")}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect("manual_reminder");
          }
        }}
      >
        <CardHeader className="pb-2">
          <BellIcon className="size-8 text-primary" />
          <CardTitle className="text-base">Set Reminder</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Set a reminder to call or text the lead at a specific time.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
```

**Key implementation notes:**
- Cards use `role="button"` + `tabIndex={0}` + `onKeyDown` for keyboard accessibility (WCAG 2.1 AA).
- The `setTimeout` on close ensures the visual reset happens after the dialog animation completes.
- The `DialogPath` type enforces valid states — no invalid transitions possible.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modify | Replace entire dialog with new shell + path selection |

---

### 3B — Scheduling Link Form & Manual Reminder Form

**Type:** Frontend
**Parallelizable:** Yes — co-located in the same dialog file, but independent of 3A's path selection logic.

**What:** Implement `SchedulingLinkForm` (calls `createSchedulingLinkFollowUp`, shows copy-friendly URL on success) and `ManualReminderForm` (uses React Hook Form + Zod, calls `createManualReminderFollowUpPublic`).

**Why:** These are the two content views the dialog switches between. The scheduling link form replaces the old single-action dialog. The reminder form is entirely new.

**Where:**
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (modify — append components)

**How:**

**Step 1: Implement `SchedulingLinkForm`**

```tsx
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx (continued)
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon, CopyIcon, CheckIcon } from "lucide-react";
import { toast } from "sonner";
import posthog from "posthog-js";

function SchedulingLinkForm({
  opportunityId,
  onSuccess,
  onClose,
}: {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
  onClose: () => void;
}) {
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [schedulingLinkUrl, setSchedulingLinkUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createFollowUp = useMutation(
    api.closer.followUpMutations.createSchedulingLinkFollowUp,
  );

  const handleGenerate = async () => {
    setState("loading");
    setError(null);
    try {
      const result = await createFollowUp({ opportunityId });
      setSchedulingLinkUrl(result.schedulingLinkUrl);
      await onSuccess?.();
      posthog.capture("follow_up_scheduling_link_created", {
        opportunity_id: opportunityId,
      });
      setState("success");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to create scheduling link.";
      setError(message);
      setState("error");
    }
  };

  const handleCopy = async () => {
    if (schedulingLinkUrl) {
      await navigator.clipboard.writeText(schedulingLinkUrl);
      setCopied(true);
      toast.success("Scheduling link copied to clipboard");
      posthog.capture("follow_up_link_copied", {
        opportunity_id: opportunityId,
      });
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (state === "idle") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Generate a personal scheduling link for this lead. Copy and share it
          via WhatsApp, SMS, or email.
        </p>
        <Button onClick={handleGenerate} className="w-full">
          <LinkIcon data-icon="inline-start" />
          Generate Scheduling Link
        </Button>
      </div>
    );
  }

  if (state === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-4">
        <div className="size-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Creating scheduling link...</p>
      </div>
    );
  }

  if (state === "success" && schedulingLinkUrl) {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <CheckIcon className="size-4" />
          <AlertDescription>
            Scheduling link generated. Copy and send to the lead.
          </AlertDescription>
        </Alert>
        <div className="flex gap-2">
          <Input
            value={schedulingLinkUrl}
            readOnly
            className="font-mono text-xs"
          />
          <Button variant="outline" size="icon" onClick={handleCopy}>
            {copied ? (
              <CheckIcon className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
          </Button>
        </div>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  // Error state
  return (
    <div className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertCircleIcon className="size-4" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setState("idle")} className="flex-1">
          Try Again
        </Button>
        <Button variant="ghost" onClick={onClose} className="flex-1">
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

**Step 2: Implement `ManualReminderForm` with React Hook Form + Zod**

```tsx
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx (continued)
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { PhoneIcon, MessageSquareIcon } from "lucide-react";

const reminderSchema = z.object({
  contactMethod: z.enum(["call", "text"]),
  reminderDate: z.string().min(1, "Date is required"),
  reminderTime: z.string().min(1, "Time is required"),
  note: z.string().optional(),
});
type ReminderFormValues = z.infer<typeof reminderSchema>;

function ManualReminderForm({
  opportunityId,
  onSuccess,
  onClose,
}: {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
  onClose: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createReminder = useMutation(
    api.closer.followUpMutations.createManualReminderFollowUpPublic,
  );

  const form = useForm({
    resolver: standardSchemaResolver(reminderSchema),
    defaultValues: {
      contactMethod: "call" as const,
      reminderDate: "",
      reminderTime: "",
      note: "",
    },
  });

  const onSubmit = async (values: ReminderFormValues) => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // Combine date + time into Unix ms
      const reminderScheduledAt = new Date(
        `${values.reminderDate}T${values.reminderTime}`,
      ).getTime();

      if (isNaN(reminderScheduledAt) || reminderScheduledAt <= Date.now()) {
        setSubmitError("Reminder time must be in the future.");
        setIsSubmitting(false);
        return;
      }

      await createReminder({
        opportunityId,
        contactMethod: values.contactMethod,
        reminderScheduledAt,
        reminderNote: values.note || undefined,
      });

      await onSuccess?.();
      posthog.capture("follow_up_reminder_created", {
        opportunity_id: opportunityId,
        contact_method: values.contactMethod,
      });
      toast.success("Reminder created");
      onClose();
    } catch (err: unknown) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to create reminder.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <FormField
          control={form.control}
          name="contactMethod"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Contact Method <span className="text-destructive">*</span></FormLabel>
              <FormControl>
                <ToggleGroup
                  type="single"
                  value={field.value}
                  onValueChange={(value) => {
                    if (value) field.onChange(value);
                  }}
                  className="justify-start"
                >
                  <ToggleGroupItem value="call" aria-label="Call">
                    <PhoneIcon className="mr-1 size-4" />
                    Call
                  </ToggleGroupItem>
                  <ToggleGroupItem value="text" aria-label="Text">
                    <MessageSquareIcon className="mr-1 size-4" />
                    Text
                  </ToggleGroupItem>
                </ToggleGroup>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-3">
          <FormField
            control={form.control}
            name="reminderDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    {...field}
                    min={new Date().toISOString().split("T")[0]}
                    disabled={isSubmitting}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="reminderTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Time <span className="text-destructive">*</span></FormLabel>
                <FormControl>
                  <Input type="time" {...field} disabled={isSubmitting} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="note"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Note (optional)</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  placeholder="e.g., Ask about scheduling availability..."
                  rows={3}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {submitError && (
          <Alert variant="destructive">
            <AlertCircleIcon className="size-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? "Creating..." : "Set Reminder"}
        </Button>
      </form>
    </Form>
  );
}
```

**Key implementation notes:**
- **Form pattern:** Follows the established RHF + Zod + `standardSchemaResolver` pattern from AGENTS.md. The Zod schema is co-located in the dialog file. `standardSchemaResolver` is used (not `zodResolver`).
- **Date/time inputs:** Separate `date` and `time` inputs combined into a Unix timestamp at submission. This avoids timezone issues from `datetime-local`.
- **Contact method toggle:** Uses `ToggleGroup` from shadcn/ui with `type="single"`. The `onValueChange` guard (`if (value)`) prevents deselecting both options.
- **Error handling:** Zod validation errors show inline via `<FormMessage />`. Submission-level errors (from Convex) show in `<Alert variant="destructive">`.
- **PostHog tracking:** Events fire on both successful link creation and reminder creation.
- The scheduling link form uses a state machine (`idle → loading → success | error`) rather than RHF because there are no form fields — just a single action button.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modify | Add `SchedulingLinkForm` and `ManualReminderForm` components |

---

### 3C — Wire Dialog Trigger & Remove Old Action

**Type:** Frontend
**Parallelizable:** No — depends on 3A and 3B being complete.

**What:** Ensure the `FollowUpDialog` is correctly exported and used wherever the old dialog was triggered. Remove or deprecate the old `useAction(api.closer.followUp.createFollowUp)` import from the dialog.

**Why:** The old dialog used a Convex action that called the Calendly API. The new dialog uses a mutation that constructs the URL locally. The old action import must be removed to avoid confusion.

**Where:**
- `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` (modify — cleanup)

**How:**

**Step 1: Remove old imports**

Remove any imports referencing the old action:

```tsx
// REMOVE these imports if present:
// import { useAction } from "convex/react";
// import { api } from "@/convex/_generated/api"; // (keep this — still used by useMutation)
```

The new dialog uses `useMutation` (not `useAction`) for both paths. Ensure no references to `api.closer.followUp.createFollowUp` remain.

**Step 2: Verify the export matches existing usage**

The component must export `FollowUpDialog` with the same props interface as before:

```tsx
// Path: app/workspace/closer/meetings/_components/follow-up-dialog.tsx
export function FollowUpDialog({
  opportunityId,
  onSuccess,
}: FollowUpDialogProps) { ... }
```

Search the codebase for all import sites of `FollowUpDialog` and confirm they pass `opportunityId` and optionally `onSuccess`. The props interface is unchanged, so no call sites need updating.

**Step 3: Verify all shadcn/ui components are installed**

Check that `ToggleGroup` is available:

```bash
pnpm dlx shadcn@latest add toggle-group
```

If already installed, this is a no-op. If not, it adds the component to `components/ui/toggle-group.tsx`.

**Key implementation notes:**
- The old `convex/closer/followUp.ts` action file is NOT deleted — it may be used by other code paths (e.g., the pipeline's cancellation/no-show follow-up). It's simply no longer called from the dialog.
- The `FollowUpDialog` export name and props are unchanged, so all existing call sites work without modification.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modify | Remove old action imports, verify exports |
| `components/ui/toggle-group.tsx` | Create (if needed) | shadcn/ui toggle-group component |

---

### 3D — Verify & Polish

**Type:** Frontend
**Parallelizable:** No — final verification step.

**What:** Visual and functional verification of the full dialog flow.

**Why:** The dialog is the primary user interaction for follow-ups. Must be polished and accessible.

**Where:**
- No file changes — verification only.

**How:**

**Step 1: Verify both paths work**

1. Open the follow-up dialog from a meeting detail page.
2. Verify the two-card selection UI renders correctly.
3. Select "Send Scheduling Link" → verify the link generation flow (idle → loading → success with copy button).
4. Go back → select "Set a Reminder" → fill the form → submit → verify success toast.
5. Reopen the dialog → verify it resets to the selection screen.

**Step 2: Verify keyboard accessibility**

1. Tab to the first card → press Enter → verify it navigates to scheduling link form.
2. Tab to the "Back" button → press Enter → verify return to selection.
3. Tab to the second card → press Space → verify it navigates to reminder form.

**Step 3: Verify error states**

1. If closer has no `personalEventTypeUri`, select "Send Link" → "Generate" → verify the error alert appears.
2. Submit the reminder form with a past date → verify validation error.

**Step 4: TypeScript compilation**

```bash
pnpm tsc --noEmit
```

**Files touched:**

| File | Action | Notes |
|---|---|---|
| _(none)_ | — | Verification only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` | Modify (rewrite) | 3A, 3B, 3C |
| `components/ui/toggle-group.tsx` | Create (if needed) | 3C |

---

**Next Phase:** Phase 3 is independent of Phases 4 and 5. However, the scheduling link path works end-to-end only after Phase 5 (admin assigns `personalEventTypeUri`). The reminder path works immediately.
