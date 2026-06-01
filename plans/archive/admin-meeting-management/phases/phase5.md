# Phase 5: Admin Meeting Actions (Backend)

> Create new Convex mutations that allow admins to perform meeting actions on behalf of closers.

## Dependencies

- Phase 3 (admin meeting detail page exists)
- Read `convex/_generated/ai/guidelines.md` before starting

---

## New file

```
convex/admin/meetingActions.ts
```

All mutations require `tenant_master` or `tenant_admin` role. None perform ownership checks (admins can act on any meeting in their tenant).

---

## Mutation 1: `adminEditMeeting`

Edit meeting metadata (time, duration, status, outcome, notes).

```ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { updateOpportunityMeetingRefs } from "../lib/opportunityMeetingRefs";

const meetingOutcomeValidator = v.union(
  v.literal("interested"),
  v.literal("needs_more_info"),
  v.literal("price_objection"),
  v.literal("not_qualified"),
  v.literal("ready_to_buy"),
);

const meetingStatusValidator = v.union(
  v.literal("scheduled"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("no_show"),
);

export const adminEditMeeting = mutation({
  args: {
    meetingId: v.id("meetings"),
    scheduledAt: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
    status: v.optional(meetingStatusValidator),
    meetingOutcome: v.optional(meetingOutcomeValidator),
    clearOutcome: v.optional(v.boolean()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    const patch: Record<string, unknown> = {};
    let hasChanges = false;

    // Time changes
    if (args.scheduledAt !== undefined && args.scheduledAt !== meeting.scheduledAt) {
      patch.scheduledAt = args.scheduledAt;
      hasChanges = true;
    }
    if (args.durationMinutes !== undefined && args.durationMinutes !== meeting.durationMinutes) {
      if (args.durationMinutes < 1 || args.durationMinutes > 480) {
        throw new Error("Duration must be between 1 and 480 minutes");
      }
      patch.durationMinutes = args.durationMinutes;
      hasChanges = true;
    }

    // Outcome
    if (args.clearOutcome) {
      patch.meetingOutcome = undefined;
      hasChanges = true;
    } else if (args.meetingOutcome !== undefined && args.meetingOutcome !== meeting.meetingOutcome) {
      patch.meetingOutcome = args.meetingOutcome;
      hasChanges = true;
    }

    // Notes
    if (args.notes !== undefined && args.notes !== meeting.notes) {
      patch.notes = args.notes;
      hasChanges = true;
    }

    // Status change
    if (args.status !== undefined && args.status !== meeting.status) {
      patch.status = args.status;
      hasChanges = true;

      // Side effects of status transitions
      if (args.status === "completed") {
        if (!meeting.completedAt) patch.completedAt = Date.now();
        if (!meeting.stoppedAt) patch.stoppedAt = Date.now();
      }
      if (args.status === "in_progress") {
        if (!meeting.startedAt) {
          patch.startedAt = args.scheduledAt ?? meeting.scheduledAt;
        }
      }
      if (args.status === "canceled") {
        if (!meeting.canceledAt) patch.canceledAt = Date.now();
      }
      if (args.status === "no_show") {
        if (!meeting.noShowMarkedAt) {
          patch.noShowMarkedAt = Date.now();
          patch.noShowMarkedByUserId = userId;
          patch.noShowSource = "closer"; // admin acting on behalf
        }
      }
    }

    if (!hasChanges) return { updated: false };

    console.log("[Admin:MeetingActions] adminEditMeeting", {
      meetingId: args.meetingId,
      changes: Object.keys(patch),
      adminUserId: userId,
    });

    await ctx.db.patch(args.meetingId, patch);

    // Update denormalized refs if time or status changed
    if (patch.scheduledAt !== undefined || patch.status !== undefined) {
      await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
    }

    return { updated: true };
  },
});
```

---

## Mutation 2: `adminMarkAsLost`

Mark an opportunity as lost on behalf of a closer.

```ts
export const adminMarkAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    lostReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Validate transition
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(`Cannot mark as lost from status: ${opportunity.status}`);
    }

    await ctx.db.patch(args.opportunityId, {
      status: "lost",
      lostAt: Date.now(),
      lostByUserId: userId,
      lostReason: args.lostReason,
      updatedAt: Date.now(),
    });

    // Update tenant stats
    const tenant = await ctx.db.get(tenantId);
    if (tenant) {
      // ... decrement active, increment lost (follow existing pattern from closer markAsLost)
    }

    console.log("[Admin:MeetingActions] adminMarkAsLost", {
      opportunityId: args.opportunityId,
      adminUserId: userId,
    });
  },
});
```

---

## Mutation 3: `adminCreateFollowUp`

Create a scheduling link follow-up using the assigned closer's Calendly.

```ts
export const adminCreateFollowUp = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    // Get the assigned closer
    if (!opportunity.assignedCloserId) {
      throw new Error("No closer assigned to this opportunity");
    }
    const closer = await ctx.db.get(opportunity.assignedCloserId);
    if (!closer || !closer.personalEventTypeUri) {
      throw new Error("Assigned closer does not have a personal event type configured");
    }

    // Build the scheduling URL with UTM params (same pattern as closer mutation)
    const schedulingUrl = new URL(closer.personalEventTypeUri);
    schedulingUrl.searchParams.set("utm_source", "ptdom");
    schedulingUrl.searchParams.set("utm_medium", "follow_up");
    schedulingUrl.searchParams.set("utm_campaign", args.opportunityId);
    schedulingUrl.searchParams.set("utm_content", args.meetingId);
    schedulingUrl.searchParams.set("utm_term", userId); // admin's user ID

    // Create follow-up record
    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      type: "scheduling_link",
      schedulingLinkUrl: schedulingUrl.toString(),
      createdByUserId: userId,
      createdAt: Date.now(),
      status: "pending",
    });

    console.log("[Admin:MeetingActions] adminCreateFollowUp", {
      followUpId,
      opportunityId: args.opportunityId,
      closerUri: closer.personalEventTypeUri,
      adminUserId: userId,
    });

    return { schedulingLinkUrl: schedulingUrl.toString(), followUpId };
  },
});
```

---

## Mutation 4: `adminConfirmFollowUp`

Confirm the follow-up and transition opportunity status.

```ts
export const adminConfirmFollowUp = mutation({
  args: {
    followUpId: v.id("followUps"),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const followUp = await ctx.db.get(args.followUpId);
    if (!followUp || followUp.tenantId !== tenantId) {
      throw new Error("Follow-up not found");
    }

    const opportunity = await ctx.db.get(followUp.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (!validateTransition(opportunity.status, "follow_up_scheduled")) {
      throw new Error(`Cannot transition to follow_up_scheduled from: ${opportunity.status}`);
    }

    await ctx.db.patch(followUp.opportunityId, {
      status: "follow_up_scheduled",
      updatedAt: Date.now(),
    });

    await ctx.db.patch(args.followUpId, {
      status: "sent",
    });

    console.log("[Admin:MeetingActions] adminConfirmFollowUp", {
      followUpId: args.followUpId,
      opportunityId: followUp.opportunityId,
      adminUserId: userId,
    });
  },
});
```

---

## Mutation 5: `adminCreateManualReminder`

Create a manual reminder follow-up.

```ts
export const adminCreateManualReminder = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
    reminderDate: v.number(),      // epoch ms
    contactMethod: v.union(v.literal("call"), v.literal("text")),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      type: "manual_reminder",
      reminderDate: args.reminderDate,
      contactMethod: args.contactMethod,
      note: args.note,
      createdByUserId: userId,
      createdAt: Date.now(),
      status: "pending",
    });

    // Transition opportunity
    if (validateTransition(opportunity.status, "follow_up_scheduled")) {
      await ctx.db.patch(args.opportunityId, {
        status: "follow_up_scheduled",
        updatedAt: Date.now(),
      });
    }

    console.log("[Admin:MeetingActions] adminCreateManualReminder", {
      followUpId,
      opportunityId: args.opportunityId,
      adminUserId: userId,
    });

    return { followUpId };
  },
});
```

---

## Mutation 6: `adminCreateRescheduleLink`

Generate a reschedule link for no-show meetings.

```ts
export const adminCreateRescheduleLink = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const opportunity = await ctx.db.get(args.opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (opportunity.status !== "no_show") {
      throw new Error("Can only create reschedule links for no-show opportunities");
    }

    // Get the assigned closer's scheduling link
    if (!opportunity.assignedCloserId) {
      throw new Error("No closer assigned");
    }
    const closer = await ctx.db.get(opportunity.assignedCloserId);
    if (!closer || !closer.personalEventTypeUri) {
      throw new Error("Assigned closer does not have a personal event type configured");
    }

    const schedulingUrl = new URL(closer.personalEventTypeUri);
    schedulingUrl.searchParams.set("utm_source", "ptdom");
    schedulingUrl.searchParams.set("utm_medium", "noshow_resched");
    schedulingUrl.searchParams.set("utm_campaign", args.opportunityId);
    schedulingUrl.searchParams.set("utm_content", args.meetingId);
    schedulingUrl.searchParams.set("utm_term", userId);

    const followUpId = await ctx.db.insert("followUps", {
      tenantId,
      opportunityId: args.opportunityId,
      meetingId: args.meetingId,
      type: "scheduling_link",
      schedulingLinkUrl: schedulingUrl.toString(),
      createdByUserId: userId,
      createdAt: Date.now(),
      status: "pending",
    });

    // Transition to reschedule_link_sent
    if (validateTransition(opportunity.status, "reschedule_link_sent")) {
      await ctx.db.patch(args.opportunityId, {
        status: "reschedule_link_sent",
        updatedAt: Date.now(),
      });
    }

    console.log("[Admin:MeetingActions] adminCreateRescheduleLink", {
      followUpId,
      opportunityId: args.opportunityId,
      adminUserId: userId,
    });

    return { schedulingLinkUrl: schedulingUrl.toString(), followUpId };
  },
});
```

---

## Important implementation notes

1. **Always read `convex/_generated/ai/guidelines.md`** before implementing. The code above is pseudocode — adapt to match the actual Convex patterns in this codebase.

2. **Check the `followUps` table schema** before inserting. The field names above are approximations based on the existing follow-up mutations. Match the actual schema exactly.

3. **Domain events**: The existing closer mutations emit domain events via `ctx.scheduler.runAfter`. The admin mutations should do the same, with `source: "admin"` in the event metadata.

4. **Tenant stats updates**: The existing `markAsLost` mutation updates tenant stats (activeOpportunities, lostDeals). The admin version must do the same.

5. **Import `validateTransition`** from `convex/lib/statusTransitions.ts` for all status changes.

6. **Import `updateOpportunityMeetingRefs`** from `convex/lib/opportunityMeetingRefs.ts` for time/status changes.

---

## Verify

- [ ] `adminEditMeeting` updates scheduledAt and durationMinutes correctly
- [ ] `adminEditMeeting` handles status transitions with appropriate side effects
- [ ] `adminEditMeeting` updates opportunity meeting refs when time changes
- [ ] `adminMarkAsLost` validates transition and updates tenant stats
- [ ] `adminCreateFollowUp` generates correct UTM-tagged scheduling URL
- [ ] `adminConfirmFollowUp` transitions opportunity to follow_up_scheduled
- [ ] `adminCreateManualReminder` creates follow-up record and transitions
- [ ] `adminCreateRescheduleLink` only works for no-show opportunities
- [ ] All mutations reject non-admin roles
- [ ] All mutations validate tenant isolation
- [ ] All mutations log with `[Admin:MeetingActions]` tag
