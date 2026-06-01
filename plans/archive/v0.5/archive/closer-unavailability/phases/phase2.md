# Phase 2 — Mark Unavailable Flow

**Goal:** Enable admins to mark a closer as unavailable from the team management page. After this phase, an admin can open a dialog from the team members table, fill in the date/reason/duration, submit, and the system creates an unavailability record while identifying all affected meetings. If affected meetings exist, the user is redirected to the redistribution wizard (Phase 3).

**Prerequisite:** Phase 1 complete (schema deployed with `closerUnavailability` and `meetingReassignments` tables, permissions registered, validation helpers available).

**Runs in PARALLEL with:** Nothing — Phase 3 depends on the mutations and queries created here.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3 → Phase 4).

**Skills to invoke:**
- `shadcn` — Building the Mark Unavailable dialog with Form, Select, Switch, Textarea, and date/time inputs
- `web-design-guidelines` — WCAG compliance for the dialog (focus management, keyboard navigation, ARIA labels)
- `frontend-design` — Production-grade dialog following the established RHF + Zod pattern
- `expect` — Browser-based QA for dialog interactions, form validation, conditional fields

**Acceptance Criteria:**
1. The team members table dropdown shows a "Mark Unavailable" item for users with `role === "closer"` only, gated behind `team:manage-availability` permission.
2. Clicking "Mark Unavailable" opens a dialog pre-filled with today's date, with fields for reason (required select), optional note, full-day toggle, and conditional start/end time inputs.
3. Toggling "Full Day" off reveals start time and end time fields; toggling back on hides them.
4. Submitting the form with a partial day but no start/end times shows inline validation errors on the time fields.
5. Submitting a valid full-day form creates a `closerUnavailability` record in Convex and returns `{ unavailabilityId, affectedMeetings }`.
6. If `affectedMeetings.length > 0`, the dialog closes and the browser navigates to `/workspace/team/redistribute/{unavailabilityId}`.
7. If `affectedMeetings.length === 0`, the dialog closes with no navigation (the closer simply has no meetings that day).
8. Attempting to mark the same closer unavailable on the same date a second time shows a descriptive error in the dialog.
9. The `getUnavailabilityWithMeetings` query returns the unavailability record with enriched closer name, creator name, and affected meetings list with `alreadyReassigned` flag.
10. The `getAvailableClosersForDate` query returns all closers except the unavailable one, with `isAvailable` flag and `meetingsToday` count.
11. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (Backend mutations) ─────────────────────────┐
                                                  ├── 2D (Team page integration + dialog wiring)
2B (Backend queries) ────────────────────────────┤
                                                  │
2C (Mark Unavailable dialog component) ──────────┘
```

**Optimal execution:**
1. Start 2A, 2B, 2C all in parallel (different files, no imports between them except shared types).
2. Once all three are done → 2D (wire the dialog into the team page, connect mutations/queries).

**Estimated time:** 1-2 days

---

## Subphases

### 2A — Create Unavailability Mutation

**Type:** Backend
**Parallelizable:** Yes — independent file, no overlap with 2B or 2C.

**What:** Create `convex/unavailability/mutations.ts` with the `createCloserUnavailability` mutation that validates input, creates the unavailability record, identifies affected meetings, and returns both the record ID and the affected meetings list.

**Why:** This is the core backend operation for the Mark Unavailable flow. The mutation both persists the unavailability and provides the meeting list in a single atomic transaction — the client doesn't need a separate query round-trip to discover affected meetings.

**Where:**
- `convex/unavailability/mutations.ts` (new)

**How:**

**Step 1: Create the unavailability directory and mutation file**

```bash
mkdir -p convex/unavailability
```

**Step 2: Implement the mutation**

```typescript
// Path: convex/unavailability/mutations.ts

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import {
  getEffectiveRange,
  validateCloser,
} from "../lib/unavailabilityValidation";

export const createCloserUnavailability = mutation({
  args: {
    closerId: v.id("users"),
    date: v.number(),
    reason: v.union(
      v.literal("sick"),
      v.literal("emergency"),
      v.literal("personal"),
      v.literal("other"),
    ),
    note: v.optional(v.string()),
    isFullDay: v.boolean(),
    startTime: v.optional(v.number()),
    endTime: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    console.log("[Unavailability] createCloserUnavailability called", {
      closerId: args.closerId,
      date: args.date,
      reason: args.reason,
      isFullDay: args.isFullDay,
    });

    const { userId, tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Validate the target closer exists and belongs to this tenant
    await validateCloser(ctx, args.closerId, tenantId);

    // Validate partial-day fields
    if (!args.isFullDay) {
      if (!args.startTime || !args.endTime) {
        throw new Error(
          "Partial-day unavailability requires both startTime and endTime",
        );
      }
      if (args.startTime >= args.endTime) {
        throw new Error("startTime must be before endTime");
      }
    }

    // Check for duplicate unavailability on the same date
    const existing = await ctx.db
      .query("closerUnavailability")
      .withIndex("by_closerId_and_date", (q) =>
        q.eq("closerId", args.closerId).eq("date", args.date),
      )
      .first();

    if (existing) {
      throw new Error(
        "An unavailability record already exists for this closer on this date",
      );
    }

    const now = Date.now();
    const unavailabilityId = await ctx.db.insert("closerUnavailability", {
      tenantId,
      closerId: args.closerId,
      date: args.date,
      startTime: args.isFullDay ? undefined : args.startTime,
      endTime: args.isFullDay ? undefined : args.endTime,
      isFullDay: args.isFullDay,
      reason: args.reason,
      note: args.note,
      createdByUserId: userId,
      createdAt: now,
    });

    console.log("[Unavailability] Record created", { unavailabilityId });

    // Identify affected meetings
    const { rangeStart, rangeEnd } = getEffectiveRange({
      date: args.date,
      isFullDay: args.isFullDay,
      startTime: args.startTime,
      endTime: args.endTime,
    });

    // Find the closer's active opportunities
    const closerOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q.eq("tenantId", tenantId).eq("assignedCloserId", args.closerId),
      )
      .collect();

    const activeOppIds = new Set(
      closerOpps
        .filter(
          (opp) =>
            opp.status === "scheduled" || opp.status === "in_progress",
        )
        .map((opp) => opp._id),
    );

    // Scan meetings in the date range
    const affectedMeetings: Array<{
      meetingId: string;
      scheduledAt: number;
      durationMinutes: number;
      leadName: string | undefined;
      status: string;
    }> = [];

    const meetingsInRange = ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", rangeStart),
      );

    for await (const meeting of meetingsInRange) {
      // Stop scanning past the range end
      if (meeting.scheduledAt >= rangeEnd) break;

      // Only include meetings for this closer's active opportunities
      if (!activeOppIds.has(meeting.opportunityId)) continue;

      // Only include scheduled meetings (not completed, canceled, etc.)
      if (meeting.status !== "scheduled") continue;

      affectedMeetings.push({
        meetingId: meeting._id,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        leadName: meeting.leadName,
        status: meeting.status,
      });
    }

    // Sort by scheduled time
    affectedMeetings.sort((a, b) => a.scheduledAt - b.scheduledAt);

    console.log("[Unavailability] Affected meetings identified", {
      unavailabilityId,
      affectedCount: affectedMeetings.length,
      rangeStart: new Date(rangeStart).toISOString(),
      rangeEnd: new Date(rangeEnd).toISOString(),
    });

    return {
      unavailabilityId,
      affectedMeetings,
    };
  },
});
```

**Key implementation notes:**
- The mutation uses `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])` — only admins can mark closers unavailable.
- `validateCloser` ensures the target user exists, belongs to the same tenant, and has the `"closer"` role — preventing admins from marking other admins unavailable.
- Duplicate detection uses the `by_closerId_and_date` index — efficient O(1) lookup.
- Meeting scan uses `by_tenantId_and_scheduledAt` with a range query and early `break` — avoids scanning the entire meetings table.
- The `activeOppIds` filter ensures only meetings from active opportunities are flagged (not completed/lost/canceled ones).
- Results are sorted chronologically for display in the redistribution wizard.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/unavailability/mutations.ts` | Create | `createCloserUnavailability` mutation |

---

### 2B — Unavailability Queries

**Type:** Backend
**Parallelizable:** Yes — independent file, no overlap with 2A or 2C.

**What:** Create `convex/unavailability/queries.ts` with two queries: `getUnavailabilityWithMeetings` (used by the redistribution wizard page) and `getAvailableClosersForDate` (used by the wizard's distribute step).

**Why:** The redistribution wizard (Phase 3) needs reactive queries to display affected meetings and candidate closers. These queries are separate from the mutation because Convex reactivity only works with queries — the wizard needs live updates as meetings get reassigned or canceled.

**Where:**
- `convex/unavailability/queries.ts` (new)

**How:**

**Step 1: Create the queries file**

```typescript
// Path: convex/unavailability/queries.ts

import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { getEffectiveRange } from "../lib/unavailabilityValidation";

/**
 * Get full details of an unavailability record with affected meetings.
 * Used by the redistribution wizard page.
 */
export const getUnavailabilityWithMeetings = query({
  args: { unavailabilityId: v.id("closerUnavailability") },
  handler: async (ctx, { unavailabilityId }) => {
    console.log("[Unavailability] getUnavailabilityWithMeetings called", {
      unavailabilityId,
    });

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const unavailability = await ctx.db.get(unavailabilityId);
    if (!unavailability || unavailability.tenantId !== tenantId) {
      throw new Error("Unavailability record not found");
    }

    // Get the closer's name
    const closer = await ctx.db.get(unavailability.closerId);
    const closerName = closer?.fullName ?? closer?.email ?? "Unknown";

    // Get the admin who created this record
    const createdBy = await ctx.db.get(unavailability.createdByUserId);
    const createdByName =
      createdBy?.fullName ?? createdBy?.email ?? "Unknown";

    // Identify affected meetings (re-queried for Convex reactivity)
    const { rangeStart, rangeEnd } = getEffectiveRange(unavailability);

    const closerOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_assignedCloserId", (q) =>
        q
          .eq("tenantId", tenantId)
          .eq("assignedCloserId", unavailability.closerId),
      )
      .collect();

    const activeOppIds = new Set(
      closerOpps
        .filter(
          (opp) =>
            opp.status === "scheduled" || opp.status === "in_progress",
        )
        .map((opp) => opp._id),
    );

    const affectedMeetings: Array<{
      meetingId: string;
      opportunityId: string;
      scheduledAt: number;
      durationMinutes: number;
      leadName: string | undefined;
      meetingJoinUrl: string | undefined;
      status: string;
    }> = [];

    const meetingsInRange = ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId).gte("scheduledAt", rangeStart),
      );

    for await (const meeting of meetingsInRange) {
      if (meeting.scheduledAt >= rangeEnd) break;
      if (!activeOppIds.has(meeting.opportunityId)) continue;
      if (meeting.status !== "scheduled") continue;

      affectedMeetings.push({
        meetingId: meeting._id,
        opportunityId: meeting.opportunityId,
        scheduledAt: meeting.scheduledAt,
        durationMinutes: meeting.durationMinutes,
        leadName: meeting.leadName,
        meetingJoinUrl: meeting.meetingJoinUrl,
        status: meeting.status,
      });
    }

    affectedMeetings.sort((a, b) => a.scheduledAt - b.scheduledAt);

    // Check existing reassignments for these meetings
    const reassignmentsByMeeting = new Map<string, boolean>();
    for (const meeting of affectedMeetings) {
      const reassignment = await ctx.db
        .query("meetingReassignments")
        .withIndex("by_meetingId", (q) =>
          q.eq("meetingId", meeting.meetingId as any),
        )
        .first();
      reassignmentsByMeeting.set(meeting.meetingId, !!reassignment);
    }

    console.log("[Unavailability] getUnavailabilityWithMeetings completed", {
      unavailabilityId,
      affectedCount: affectedMeetings.length,
      closerName,
    });

    return {
      unavailability: {
        ...unavailability,
        closerName,
        createdByName,
      },
      affectedMeetings: affectedMeetings.map((m) => ({
        ...m,
        alreadyReassigned:
          reassignmentsByMeeting.get(m.meetingId) ?? false,
      })),
      rangeStart,
      rangeEnd,
    };
  },
});

/**
 * Get available closers for a given date with their workload stats.
 * Used by the redistribution wizard to show candidate closers.
 */
export const getAvailableClosersForDate = query({
  args: {
    date: v.number(), // Start-of-day timestamp
    excludeCloserId: v.id("users"), // The unavailable closer to exclude
  },
  handler: async (ctx, { date, excludeCloserId }) => {
    console.log("[Unavailability] getAvailableClosersForDate called", {
      date,
      excludeCloserId,
    });

    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    // Get all closers in this tenant (excluding the unavailable one)
    const allUsers = await ctx.db
      .query("users")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .collect();

    const closers = allUsers.filter(
      (u) => u.role === "closer" && u._id !== excludeCloserId,
    );

    // For each closer, compute their meeting load for the target date
    const dayStart = date;
    const dayEnd = date + 24 * 60 * 60 * 1000;

    const closerStats = await Promise.all(
      closers.map(async (closer) => {
        // Check if this closer is also marked unavailable on this date
        const unavailability = await ctx.db
          .query("closerUnavailability")
          .withIndex("by_closerId_and_date", (q) =>
            q.eq("closerId", closer._id).eq("date", date),
          )
          .first();

        if (unavailability) {
          return {
            closerId: closer._id,
            closerName: closer.fullName ?? closer.email,
            isAvailable: false,
            unavailabilityReason: unavailability.reason,
            meetingsToday: 0,
            meetings: [] as Array<{
              scheduledAt: number;
              durationMinutes: number;
            }>,
          };
        }

        // Get this closer's meetings for the day
        const closerOpps = await ctx.db
          .query("opportunities")
          .withIndex("by_tenantId_and_assignedCloserId", (q) =>
            q
              .eq("tenantId", tenantId)
              .eq("assignedCloserId", closer._id),
          )
          .collect();

        const activeOppIds = new Set(
          closerOpps
            .filter(
              (opp) =>
                opp.status === "scheduled" ||
                opp.status === "in_progress",
            )
            .map((opp) => opp._id),
        );

        const meetings: Array<{
          scheduledAt: number;
          durationMinutes: number;
        }> = [];

        const dayMeetings = ctx.db
          .query("meetings")
          .withIndex("by_tenantId_and_scheduledAt", (q) =>
            q.eq("tenantId", tenantId).gte("scheduledAt", dayStart),
          );

        for await (const meeting of dayMeetings) {
          if (meeting.scheduledAt >= dayEnd) break;
          if (!activeOppIds.has(meeting.opportunityId)) continue;
          if (meeting.status !== "scheduled") continue;

          meetings.push({
            scheduledAt: meeting.scheduledAt,
            durationMinutes: meeting.durationMinutes,
          });
        }

        return {
          closerId: closer._id,
          closerName: closer.fullName ?? closer.email,
          isAvailable: true,
          unavailabilityReason: null,
          meetingsToday: meetings.length,
          meetings,
        };
      }),
    );

    console.log("[Unavailability] getAvailableClosersForDate completed", {
      totalClosers: closers.length,
      availableCount: closerStats.filter((s) => s.isAvailable).length,
    });

    return closerStats;
  },
});
```

**Key implementation notes:**
- `getUnavailabilityWithMeetings` re-queries affected meetings rather than storing them — this ensures Convex reactivity shows real-time changes (e.g., if a lead cancels during the redistribution flow).
- `alreadyReassigned` flag prevents double-reassignment when two admins work the same unavailability record concurrently.
- `getAvailableClosersForDate` checks each candidate closer against the `closerUnavailability` table — a closer marked unavailable on the same date is returned with `isAvailable: false`.
- The `meetings` array in each closer stat is returned for the scoring algorithm in Phase 3 — the client doesn't use it directly but passes it to the auto-distribute mutation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/unavailability/queries.ts` | Create | `getUnavailabilityWithMeetings`, `getAvailableClosersForDate` queries |

---

### 2C — Mark Unavailable Dialog Component

**Type:** Frontend
**Parallelizable:** Yes — creates a new component file. Can be built against type stubs while 2A/2B are in progress.

**What:** Create `app/workspace/team/_components/mark-unavailable-dialog.tsx` — a form dialog following the established React Hook Form + Zod pattern with date, reason, full-day toggle, conditional time range, and optional note fields.

**Why:** This is the admin-facing entry point for the entire unavailability flow. It must follow the codebase's established form patterns (RHF + standardSchemaResolver + Zod v4) and dialog patterns (controlled open/onOpenChange, submission-level error alerts).

**Where:**
- `app/workspace/team/_components/mark-unavailable-dialog.tsx` (new)

**How:**

**Step 1: Create the dialog component**

```tsx
// Path: app/workspace/team/_components/mark-unavailable-dialog.tsx

"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangleIcon } from "lucide-react";
import { format } from "date-fns";
import type { Id } from "@/convex/_generated/dataModel";

const unavailabilitySchema = z
  .object({
    date: z.string().min(1, "Date is required"),
    reason: z.enum(["sick", "emergency", "personal", "other"]),
    note: z.string().optional(),
    isFullDay: z.boolean(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.isFullDay) {
      if (!data.startTime) {
        ctx.addIssue({
          code: "custom",
          message:
            "Start time is required for partial-day unavailability",
          path: ["startTime"],
        });
      }
      if (!data.endTime) {
        ctx.addIssue({
          code: "custom",
          message:
            "End time is required for partial-day unavailability",
          path: ["endTime"],
        });
      }
      if (
        data.startTime &&
        data.endTime &&
        data.startTime >= data.endTime
      ) {
        ctx.addIssue({
          code: "custom",
          message: "End time must be after start time",
          path: ["endTime"],
        });
      }
    }
  });

type UnavailabilityFormValues = z.infer<typeof unavailabilitySchema>;

interface MarkUnavailableDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  closerId: Id<"users">;
  closerName: string;
  onRedistribute?: (unavailabilityId: string) => void;
}

export function MarkUnavailableDialog({
  open,
  onOpenChange,
  closerId,
  closerName,
  onRedistribute,
}: MarkUnavailableDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const createUnavailability = useMutation(
    api.unavailability.mutations.createCloserUnavailability,
  );

  const form = useForm({
    resolver: standardSchemaResolver(unavailabilitySchema),
    defaultValues: {
      date: format(new Date(), "yyyy-MM-dd"),
      reason: undefined as
        | "sick"
        | "emergency"
        | "personal"
        | "other"
        | undefined,
      note: "",
      isFullDay: true,
      startTime: "",
      endTime: "",
    },
  });

  const isFullDay = form.watch("isFullDay");

  // Reset form when dialog opens/closes
  useEffect(() => {
    if (open) {
      form.reset({
        date: format(new Date(), "yyyy-MM-dd"),
        reason: undefined,
        note: "",
        isFullDay: true,
        startTime: "",
        endTime: "",
      });
      setSubmitError(null);
    }
  }, [open, form]);

  async function onSubmit(values: UnavailabilityFormValues) {
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      // Convert date string to start-of-day timestamp
      const dateTimestamp = new Date(
        values.date + "T00:00:00",
      ).getTime();

      // Convert time strings to full timestamps if partial day
      let startTime: number | undefined;
      let endTime: number | undefined;
      if (
        !values.isFullDay &&
        values.startTime &&
        values.endTime
      ) {
        startTime = new Date(
          values.date + "T" + values.startTime,
        ).getTime();
        endTime = new Date(
          values.date + "T" + values.endTime,
        ).getTime();
      }

      const result = await createUnavailability({
        closerId,
        date: dateTimestamp,
        reason: values.reason,
        note: values.note || undefined,
        isFullDay: values.isFullDay,
        startTime,
        endTime,
      });

      // Navigate to redistribution wizard if there are affected meetings
      if (result.affectedMeetings.length > 0) {
        onOpenChange(false);
        if (onRedistribute) {
          onRedistribute(result.unavailabilityId);
        } else {
          window.location.href = `/workspace/team/redistribute/${result.unavailabilityId}`;
        }
      } else {
        onOpenChange(false);
      }
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Failed to mark unavailable",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark {closerName} Unavailable</DialogTitle>
          <DialogDescription>
            This will identify meetings that need to be redistributed.
          </DialogDescription>
        </DialogHeader>

        {submitError && (
          <Alert variant="destructive">
            <AlertTriangleIcon className="size-4" />
            <AlertDescription>{submitError}</AlertDescription>
          </Alert>
        )}

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
          >
            {/* Date field */}
            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Date <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="date"
                      {...field}
                      disabled={isSubmitting}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Reason dropdown */}
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Reason <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a reason" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="sick">Sick</SelectItem>
                      <SelectItem value="emergency">
                        Emergency
                      </SelectItem>
                      <SelectItem value="personal">
                        Personal
                      </SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Optional note */}
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Additional details..."
                      disabled={isSubmitting}
                      rows={2}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Full day toggle */}
            <FormField
              control={form.control}
              name="isFullDay"
              render={({ field }) => (
                <FormItem className="flex items-center justify-between rounded-lg border p-3">
                  <div>
                    <FormLabel>Full Day</FormLabel>
                    <p className="text-sm text-muted-foreground">
                      Toggle off to specify a time range
                    </p>
                  </div>
                  <FormControl>
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={isSubmitting}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            {/* Conditional time range fields */}
            {!isFullDay && (
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="startTime"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Start Time{" "}
                        <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="time"
                          {...field}
                          disabled={isSubmitting}
                        />
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
                      <FormLabel>
                        End Time{" "}
                        <span className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="time"
                          {...field}
                          disabled={isSubmitting}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
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
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? "Processing..." : "Mark Unavailable"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

**Key implementation notes:**
- Uses `standardSchemaResolver` (not `zodResolver`) per codebase convention with Zod v4.
- `superRefine` with `path: ["startTime"]` / `path: ["endTime"]` targets validation errors to specific fields, consistent with the Invite User Dialog pattern.
- `form.watch("isFullDay")` controls conditional rendering of time fields.
- `useEffect` resets form state when `open` changes — same pattern as Role Edit Dialog.
- `onRedistribute` callback allows the parent to handle navigation (useful for testing or alternative flows).
- Date string → timestamp conversion uses `new Date(dateStr + "T00:00:00")` for local timezone interpretation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/mark-unavailable-dialog.tsx` | Create | RHF + Zod form dialog for marking closer unavailable |

---

### 2D — Team Page Integration

**Type:** Full-Stack
**Parallelizable:** No — depends on 2A (mutation), 2B (queries), 2C (dialog component) being complete.

**What:** Wire the Mark Unavailable dialog into the team page by extending the `DialogState` discriminated union, adding the "Mark Unavailable" dropdown menu item to the team members table, and rendering the dialog conditionally.

**Why:** This connects all the pieces: the new dropdown action triggers the dialog, the dialog calls the mutation, and the mutation result drives navigation to the redistribution wizard.

**Where:**
- `app/workspace/team/_components/team-page-client.tsx` (modify)
- `app/workspace/team/_components/team-members-table.tsx` (modify)

**How:**

**Step 1: Extend DialogState in team-page-client.tsx**

Add the new `"unavailable"` variant to the discriminated union:

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx

// BEFORE:
type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string };

// AFTER:
type DialogState =
  | { type: null }
  | { type: "remove"; userId: Id<"users">; userName: string }
  | { type: "calendly"; userId: Id<"users">; userName: string }
  | { type: "role"; userId: Id<"users">; userName: string; currentRole: string }
  | { type: "unavailable"; userId: Id<"users">; userName: string };
```

**Step 2: Add the import and dialog rendering**

Import the new dialog component and add its conditional render block alongside the existing dialogs:

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx

// Add import at top:
import { MarkUnavailableDialog } from "./mark-unavailable-dialog";

// Add in the dialog rendering section, after the existing dialog blocks:
{dialog.type === "unavailable" && (
  <MarkUnavailableDialog
    open
    onOpenChange={(open) => {
      if (!open) closeDialog();
    }}
    closerId={dialog.userId}
    closerName={dialog.userName}
  />
)}
```

**Step 3: Pass `onMarkUnavailable` callback to table**

Add a new callback prop to the `TeamMembersTable` invocation:

```typescript
// Path: app/workspace/team/_components/team-page-client.tsx

// In the TeamMembersTable render, add the new prop:
<TeamMembersTable
  members={teamMembers}
  onEditRole={(userId, currentRole) => {
    const member = teamMembers.find((m) => m._id === userId);
    if (member) setDialog({ type: "role", userId, userName: member.fullName || member.email, currentRole });
  }}
  onRemoveUser={(userId) => {
    const member = teamMembers.find((m) => m._id === userId);
    if (member) setDialog({ type: "remove", userId, userName: member.fullName || member.email });
  }}
  onRelinkCalendly={(userId) => {
    const member = teamMembers.find((m) => m._id === userId);
    if (member) setDialog({ type: "calendly", userId, userName: member.fullName || member.email });
  }}
  // NEW: Feature H
  onMarkUnavailable={(userId) => {
    const member = teamMembers.find((m) => m._id === userId);
    if (member) setDialog({ type: "unavailable", userId, userName: member.fullName || member.email });
  }}
/>
```

**Step 4: Add dropdown menu item in team-members-table.tsx**

Add the `onMarkUnavailable` prop to the component's interface and add the menu item:

```typescript
// Path: app/workspace/team/_components/team-members-table.tsx

// Add to props interface:
onMarkUnavailable?: (userId: Id<"users">) => void;

// Add to action visibility conditions (alongside canEditRole, canRemove, etc.):
const canMarkUnavailable =
  member.role === "closer" && onMarkUnavailable;

// Update hasAnyAction:
const hasAnyAction = canEditRole || canRemove || canRelinkCalendly || canMarkUnavailable;

// Add to DropdownMenuContent, inside the first DropdownMenuGroup, after the Re-link Calendly item:
<RequirePermission permission="team:manage-availability">
  {canMarkUnavailable && (
    <DropdownMenuItem
      onClick={() => onMarkUnavailable(member._id)}
    >
      <UserXIcon data-icon="inline-start" />
      Mark Unavailable
    </DropdownMenuItem>
  )}
</RequirePermission>
```

**Step 5: Add UserXIcon import**

```typescript
// Path: app/workspace/team/_components/team-members-table.tsx

// Add UserXIcon to the lucide-react import:
import { ..., UserXIcon } from "lucide-react";
```

**Key implementation notes:**
- The `RequirePermission` component wraps the menu item with `team:manage-availability` — this is a UI-only gate; the backend re-validates in the mutation.
- `member.role === "closer"` condition ensures the menu item only shows for closers, not admins — you can't mark an admin unavailable.
- The `onMarkUnavailable` prop follows the same optional callback pattern as the existing `onEditRole`, `onRemoveUser`, `onRelinkCalendly` props.
- The dialog renders with `open` (always true when dialog state matches) and `onOpenChange` calls `closeDialog()` to reset state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/team/_components/team-page-client.tsx` | Modify | Extend DialogState, add dialog render, pass callback |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | Add dropdown menu item, UserXIcon import |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/unavailability/mutations.ts` | Create | 2A |
| `convex/unavailability/queries.ts` | Create | 2B |
| `app/workspace/team/_components/mark-unavailable-dialog.tsx` | Create | 2C |
| `app/workspace/team/_components/team-page-client.tsx` | Modify | 2D |
| `app/workspace/team/_components/team-members-table.tsx` | Modify | 2D |
