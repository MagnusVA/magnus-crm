# Phase 4: Admin Meeting Edit Page

> Build a dedicated edit screen where admins can modify meeting time, duration, status, and outcome.

## Dependencies

- Phase 3 (meeting detail page exists, Edit button links here)
- Phase 5 (backend mutation `adminEditMeeting`) — can develop in parallel with a stub

---

## New files to create

```
app/workspace/pipeline/meetings/[meetingId]/edit/
├── page.tsx
└── _components/
    └── edit-meeting-page-client.tsx
```

---

## Step 1: Create the edit page RSC

**File**: `app/workspace/pipeline/meetings/[meetingId]/edit/page.tsx`

```tsx
import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { preloadQuery } from "convex/nextjs";
import { requireRole } from "@/lib/auth";
import { EditMeetingPageClient } from "./_components/edit-meeting-page-client";

export const unstable_instant = false;

export default async function EditMeetingPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const [session, { meetingId }] = await Promise.all([
    requireRole(["tenant_master", "tenant_admin"]),
    params,
  ]);

  const preloaded = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: meetingId as Id<"meetings"> },
    { token: session.session.accessToken },
  );

  return <EditMeetingPageClient preloadedDetail={preloaded} meetingId={meetingId} />;
}
```

---

## Step 2: Create the edit form client component

**File**: `app/workspace/pipeline/meetings/[meetingId]/edit/_components/edit-meeting-page-client.tsx`

### Form schema (Zod v4)

```tsx
import { z } from "zod";

const editMeetingSchema = z.object({
  date: z.string().min(1, "Date is required"),        // "YYYY-MM-DD"
  startTime: z.string().min(1, "Start time is required"), // "HH:mm"
  endTime: z.string().min(1, "End time is required"),     // "HH:mm"
  meetingOutcome: z.enum([
    "interested",
    "needs_more_info",
    "price_objection",
    "not_qualified",
    "ready_to_buy",
    "",  // empty = clear outcome
  ]).optional(),
  status: z.enum([
    "scheduled",
    "in_progress",
    "completed",
    "canceled",
    "no_show",
  ]),
  notes: z.string().optional(),
}).refine(
  (data) => {
    if (!data.date || !data.startTime || !data.endTime) return true;
    const start = new Date(`${data.date}T${data.startTime}`);
    const end = new Date(`${data.date}T${data.endTime}`);
    return end > start;
  },
  { message: "End time must be after start time", path: ["endTime"] },
);

type EditMeetingFormValues = z.infer<typeof editMeetingSchema>;
```

### Component structure

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { usePreloadedQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { format, parse } from "date-fns";
import { toast } from "sonner";
import {
  Form, FormField, FormItem, FormLabel, FormControl, FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { ArrowLeftIcon, SaveIcon } from "lucide-react";

export function EditMeetingPageClient({ preloadedDetail, meetingId }) {
  const router = useRouter();
  const detail = usePreloadedQuery(preloadedDetail);
  const editMeeting = useMutation(api.admin.meetingActions.adminEditMeeting);

  // Derive initial values from meeting data
  const meeting = detail?.meeting;
  const meetingDate = meeting ? format(new Date(meeting.scheduledAt), "yyyy-MM-dd") : "";
  const meetingStartTime = meeting ? format(new Date(meeting.scheduledAt), "HH:mm") : "";
  const meetingEndTime = meeting
    ? format(new Date(meeting.scheduledAt + meeting.durationMinutes * 60_000), "HH:mm")
    : "";

  const form = useForm({
    resolver: standardSchemaResolver(editMeetingSchema),
    defaultValues: {
      date: meetingDate,
      startTime: meetingStartTime,
      endTime: meetingEndTime,
      meetingOutcome: meeting?.meetingOutcome ?? "",
      status: meeting?.status ?? "scheduled",
      notes: meeting?.notes ?? "",
    },
  });

  const [submitError, setSubmitError] = useState<string | null>(null);
  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (values: EditMeetingFormValues) => {
    setSubmitError(null);
    try {
      // Compute scheduledAt and durationMinutes from date + times
      const startDateTime = new Date(`${values.date}T${values.startTime}`);
      const endDateTime = new Date(`${values.date}T${values.endTime}`);
      const scheduledAt = startDateTime.getTime();
      const durationMinutes = Math.round((endDateTime.getTime() - scheduledAt) / 60_000);

      await editMeeting({
        meetingId: meetingId as Id<"meetings">,
        scheduledAt,
        durationMinutes,
        status: values.status,
        meetingOutcome: values.meetingOutcome || undefined,
        notes: values.notes,
      });

      toast.success("Meeting updated");
      router.push(`/workspace/pipeline/meetings/${meetingId}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Failed to update meeting");
    }
  };

  if (!detail) return null; // loading handled by loading.tsx

  return (
    <div className="mx-auto max-w-2xl">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(`/workspace/pipeline/meetings/${meetingId}`)}
        className="mb-4"
      >
        <ArrowLeftIcon data-icon="inline-start" />
        Back to Meeting
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>Edit Meeting</CardTitle>
          <CardDescription>
            {detail.lead.fullName ?? detail.lead.email} — {detail.eventTypeName ?? "Meeting"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
              {submitError && (
                <Alert variant="destructive">
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              {/* Date */}
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date <span className="text-destructive">*</span></FormLabel>
                    <FormControl>
                      <Input type="date" {...field} disabled={isSubmitting} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Start/End Time — side by side */}
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Start Time <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input type="time" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="endTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>End Time <span className="text-destructive">*</span></FormLabel>
                      <FormControl>
                        <Input type="time" {...field} disabled={isSubmitting} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Computed duration display */}
              {form.watch("startTime") && form.watch("endTime") && form.watch("date") && (() => {
                const start = new Date(`${form.watch("date")}T${form.watch("startTime")}`);
                const end = new Date(`${form.watch("date")}T${form.watch("endTime")}`);
                const mins = Math.round((end.getTime() - start.getTime()) / 60_000);
                if (mins > 0) {
                  return (
                    <p className="text-sm text-muted-foreground">
                      Duration: {mins} minute{mins !== 1 ? "s" : ""}
                    </p>
                  );
                }
                return null;
              })()}

              {/* Meeting Status */}
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Meeting Status</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select status" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="scheduled">Scheduled</SelectItem>
                        <SelectItem value="in_progress">In Progress</SelectItem>
                        <SelectItem value="completed">Completed</SelectItem>
                        <SelectItem value="canceled">Canceled</SelectItem>
                        <SelectItem value="no_show">No Show</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Meeting Outcome */}
              <FormField
                control={form.control}
                name="meetingOutcome"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Meeting Outcome</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                      disabled={isSubmitting}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Not classified" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">Not classified</SelectItem>
                        <SelectItem value="interested">Interested</SelectItem>
                        <SelectItem value="needs_more_info">Needs More Info</SelectItem>
                        <SelectItem value="price_objection">Price Objection</SelectItem>
                        <SelectItem value="not_qualified">Not Qualified</SelectItem>
                        <SelectItem value="ready_to_buy">Ready to Buy</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Notes */}
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        rows={4}
                        placeholder="Meeting notes..."
                        disabled={isSubmitting}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Actions */}
              <div className="flex justify-end gap-3 border-t pt-4">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => router.push(`/workspace/pipeline/meetings/${meetingId}`)}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting ? (
                    <>
                      <Spinner data-icon="inline-start" />
                      Saving...
                    </>
                  ) : (
                    <>
                      <SaveIcon data-icon="inline-start" />
                      Save Changes
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
```

---

## Step 3: Status transition warnings

When the admin changes the meeting status, show contextual warnings:

- **To "completed"**: "This will mark the meeting as completed. If no startedAt exists, it will be set to the scheduled time."
- **To "in_progress"**: "This will mark the meeting as in-progress. The closer can then log payment or follow-up actions."
- **To "no_show"**: "This will mark the meeting as a no-show."
- **To "canceled"**: "This will mark the meeting as canceled."

Use a simple `{statusWarnings[watchedStatus]}` alert below the status select.

---

## Step 4: Verify

- [ ] Edit page loads with current meeting data pre-filled
- [ ] Date and time pickers work correctly
- [ ] Duration is computed and displayed dynamically
- [ ] End time before start time shows validation error
- [ ] Status select shows all 5 meeting statuses
- [ ] Outcome select shows all 5 outcomes + "Not classified"
- [ ] Notes textarea shows current notes
- [ ] Saving calls the mutation and redirects to meeting detail
- [ ] Cancel navigates back without saving
- [ ] Server errors display in alert
- [ ] Loading state shows spinner on Save button
- [ ] Non-admin users are redirected (requireRole)

---

## Notes

- The date/time approach uses native HTML `<input type="date">` and `<input type="time">` for simplicity. These are well-supported in modern browsers and match the app's minimal styling approach. If a richer picker is needed later, swap for `shadcn` date picker.
- Timezone handling: `new Date("YYYY-MM-DDThh:mm")` without a timezone suffix parses in the browser's local timezone. This matches Calendly's behavior (times are local to the user). The resulting `getTime()` gives a UTC epoch ms, which is what `scheduledAt` stores.
