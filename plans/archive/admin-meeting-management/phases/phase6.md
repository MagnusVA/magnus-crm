# Phase 6: Admin Action Bar (Frontend)

> Wire all admin backend actions into a contextual action bar on the admin meeting detail page.

## Dependencies

- Phase 3 (admin meeting detail page)
- Phase 5 (all admin mutations exist)

---

## New files

```
app/workspace/pipeline/meetings/_components/
├── admin-action-bar.tsx
├── admin-follow-up-dialog.tsx
└── admin-mark-lost-dialog.tsx
```

---

## Step 1: Admin Action Bar

**File**: `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx`

The action bar renders contextual buttons based on opportunity status. Unlike the closer's `OutcomeActionBar`, it does NOT include "Start Meeting" (that's closer-only).

### Actions by status

```
scheduled          → Edit Meeting
in_progress        → Log Payment, Schedule Follow-up, Mark as Lost, Edit Meeting
no_show            → Generate Reschedule Link, Schedule Follow-up, Edit Meeting
canceled           → Schedule Follow-up, Edit Meeting
follow_up_scheduled → Edit Meeting
reschedule_link_sent → Edit Meeting
payment_received   → (view only)
lost               → (view only)
```

### Component

```tsx
"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  PencilIcon,
  CreditCardIcon,
  CalendarIcon,
  LinkIcon,
  XCircleIcon,
} from "lucide-react";
import { toast } from "sonner";
import type { Doc, Id } from "@/convex/_generated/dataModel";

// Lazy-load dialogs
const PaymentFormDialog = dynamic(() =>
  import("@/app/workspace/closer/meetings/_components/payment-form-dialog")
    .then((m) => ({ default: m.PaymentFormDialog })),
);
const AdminFollowUpDialog = dynamic(() =>
  import("./admin-follow-up-dialog").then((m) => ({ default: m.AdminFollowUpDialog })),
);
const AdminMarkLostDialog = dynamic(() =>
  import("./admin-mark-lost-dialog").then((m) => ({ default: m.AdminMarkLostDialog })),
);

interface AdminActionBarProps {
  meeting: Doc<"meetings">;
  opportunity: Doc<"opportunities">;
  payments: Doc<"paymentRecords">[];
  onStatusChanged?: () => Promise<void>;
  onRescheduleLinkCreated?: (url: string) => void;
}

export function AdminActionBar({
  meeting,
  opportunity,
  onStatusChanged,
  onRescheduleLinkCreated,
}: AdminActionBarProps) {
  const createRescheduleLink = useMutation(api.admin.meetingActions.adminCreateRescheduleLink);
  const [isCreatingReschedule, setIsCreatingReschedule] = useState(false);

  const isInProgress = opportunity.status === "in_progress";
  const isNoShow = opportunity.status === "no_show";
  const isCanceled = opportunity.status === "canceled";
  const isTerminal = opportunity.status === "payment_received" || opportunity.status === "lost";

  if (isTerminal) return null;

  const handleCreateRescheduleLink = async () => {
    setIsCreatingReschedule(true);
    try {
      const result = await createRescheduleLink({
        opportunityId: opportunity._id,
        meetingId: meeting._id,
      });
      onRescheduleLinkCreated?.(result.schedulingLinkUrl);
      toast.success("Reschedule link generated");
      await onStatusChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create reschedule link");
    } finally {
      setIsCreatingReschedule(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div className="flex flex-wrap items-center gap-3">
        {/* Edit Meeting — always available for non-terminal */}
        <Button variant="outline" size="lg" asChild>
          <Link href={`/workspace/pipeline/meetings/${meeting._id}/edit`}>
            <PencilIcon data-icon="inline-start" />
            Edit Meeting
          </Link>
        </Button>

        {/* Log Payment — when in_progress */}
        {isInProgress && (
          <PaymentFormDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Schedule Follow-up — when in_progress, no_show, or canceled */}
        {(isInProgress || isNoShow || isCanceled) && (
          <AdminFollowUpDialog
            opportunityId={opportunity._id}
            meetingId={meeting._id}
            onSuccess={onStatusChanged}
          />
        )}

        {/* Generate Reschedule Link — when no_show */}
        {isNoShow && (
          <Button
            variant="outline"
            size="lg"
            onClick={handleCreateRescheduleLink}
            disabled={isCreatingReschedule}
          >
            {isCreatingReschedule ? (
              <>
                <Spinner data-icon="inline-start" />
                Generating...
              </>
            ) : (
              <>
                <LinkIcon data-icon="inline-start" />
                Request Reschedule
              </>
            )}
          </Button>
        )}

        {/* Mark as Lost — when in_progress */}
        {isInProgress && (
          <AdminMarkLostDialog
            opportunityId={opportunity._id}
            onSuccess={onStatusChanged}
          />
        )}
      </div>
    </div>
  );
}
```

---

## Step 2: Admin Follow-Up Dialog

**File**: `app/workspace/pipeline/meetings/_components/admin-follow-up-dialog.tsx`

This mirrors the closer's `FollowUpDialog` but calls admin mutations. The two-step scheduling link flow (create → confirm) is the same.

### Key differences from closer dialog

1. Calls `api.admin.meetingActions.adminCreateFollowUp` instead of `api.closer.followUpMutations.createSchedulingLinkFollowUp`
2. Calls `api.admin.meetingActions.adminConfirmFollowUp` instead of `api.closer.followUpMutations.confirmFollowUpScheduled`
3. Calls `api.admin.meetingActions.adminCreateManualReminder` instead of `api.closer.followUpMutations.createManualReminderFollowUpPublic`
4. No ownership validation needed (admin can act on any opportunity)

### Structure

Follow the same two-path UX:
1. **Send Scheduling Link** — generates URL, shows "Confirm Sent" button
2. **Set Reminder** — date, time, contact method (call/text), optional note

Reuse the same visual layout as the closer dialog. The dialog structure (Sheet with two-step flow) stays the same.

---

## Step 3: Admin Mark Lost Dialog

**File**: `app/workspace/pipeline/meetings/_components/admin-mark-lost-dialog.tsx`

This mirrors the closer's `MarkLostDialog` but calls the admin mutation.

```tsx
"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Form, FormField, FormItem, FormLabel, FormControl, FormMessage,
} from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { XCircleIcon } from "lucide-react";
import { toast } from "sonner";

const markLostSchema = z.object({
  lostReason: z.string().max(500).optional(),
});

interface AdminMarkLostDialogProps {
  opportunityId: Id<"opportunities">;
  onSuccess?: () => Promise<void>;
}

export function AdminMarkLostDialog({
  opportunityId,
  onSuccess,
}: AdminMarkLostDialogProps) {
  const [open, setOpen] = useState(false);
  const adminMarkAsLost = useMutation(api.admin.meetingActions.adminMarkAsLost);

  const form = useForm({
    resolver: standardSchemaResolver(markLostSchema),
    defaultValues: { lostReason: "" },
  });

  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (values: z.infer<typeof markLostSchema>) => {
    try {
      await adminMarkAsLost({
        opportunityId,
        lostReason: values.lostReason || undefined,
      });
      toast.success("Opportunity marked as lost");
      setOpen(false);
      await onSuccess?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to mark as lost");
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="lg">
          <XCircleIcon data-icon="inline-start" />
          Mark as Lost
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Mark as Lost?</AlertDialogTitle>
          <AlertDialogDescription>
            This will mark the opportunity as lost. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="lostReason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reason (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={3}
                      maxLength={500}
                      placeholder="Why was this deal lost?"
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel disabled={isSubmitting}>Cancel</AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Marking...
                  </>
                ) : (
                  "Mark as Lost"
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

---

## Step 4: Wire AdminActionBar into the detail page

**File**: `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx`

Replace the Phase 3 placeholder with the real action bar:

```tsx
import { AdminActionBar } from "../../_components/admin-action-bar";

// In the render:
<AdminActionBar
  meeting={meeting}
  opportunity={opportunity}
  payments={payments}
  onStatusChanged={refreshDetail}
  onRescheduleLinkCreated={(url) => setRescheduleLinkUrl(url)}
/>
```

---

## Step 5: Verify

### Action bar rendering
- [ ] "Edit Meeting" button appears for all non-terminal statuses
- [ ] "Log Payment" appears only for in_progress opportunities
- [ ] "Schedule Follow-up" appears for in_progress, no_show, and canceled
- [ ] "Request Reschedule" appears only for no_show
- [ ] "Mark as Lost" appears only for in_progress
- [ ] No actions for payment_received or lost (terminal)

### Payment flow
- [ ] PaymentFormDialog opens and submits correctly (already admin-compatible)
- [ ] Opportunity transitions to payment_received after payment

### Follow-up flow
- [ ] Scheduling link path generates correct URL with UTMs
- [ ] Two-step confirm flow works (create → copy link → confirm sent)
- [ ] Manual reminder path creates follow-up record
- [ ] Opportunity transitions to follow_up_scheduled

### Reschedule flow
- [ ] Reschedule link generates with noshow_resched UTMs
- [ ] Link displays in RescheduleLinkDisplay component
- [ ] Opportunity transitions to reschedule_link_sent

### Mark lost flow
- [ ] Confirmation dialog shows with optional reason
- [ ] Opportunity transitions to lost (terminal)
- [ ] Tenant stats update correctly

### General
- [ ] All toast messages appear correctly
- [ ] Error handling works for all mutations
- [ ] Loading states (spinners) show during mutations
- [ ] Page refreshes correctly after status changes
