# Admin Meeting Management — Design Document

> **Problem**: Closers sometimes forget to click "Start Meeting" before conducting a call, then make a sale but have no way to record the payment. The admin/owner currently has no way to view individual meeting details or perform corrective actions on behalf of closers.

> **Solution**: Give tenant admins and owners the ability to (1) find specific meetings via pipeline date filtering, (2) view individual meeting details, (3) edit meeting metadata, and (4) perform corrective actions (log payment, create follow-up, generate reschedule) on behalf of closers.

---

## Table of Contents

1. [User Stories](#user-stories)
2. [Architecture Decisions](#architecture-decisions)
3. [Phase Overview](#phase-overview)
4. [Phase 1: Pipeline Date Filtering](#phase-1-pipeline-date-filtering)
5. [Phase 2: Pipeline-to-Meeting Navigation](#phase-2-pipeline-to-meeting-navigation)
6. [Phase 3: Admin Meeting Detail Page](#phase-3-admin-meeting-detail-page)
7. [Phase 4: Admin Meeting Edit Page](#phase-4-admin-meeting-edit-page)
8. [Phase 5: Admin Meeting Actions (Backend)](#phase-5-admin-meeting-actions-backend)
9. [Phase 6: Admin Action Bar (Frontend)](#phase-6-admin-action-bar-frontend)
10. [Component Reuse Map](#component-reuse-map)
11. [Schema & Index Changes](#schema--index-changes)
12. [Mutation Access Matrix](#mutation-access-matrix)

---

## User Stories

| # | As a... | I want to... | So that... |
|---|---------|-------------|-----------|
| 1 | Tenant admin/owner | Filter the pipeline by day/week/month | I can quickly narrow down to recent meetings |
| 2 | Tenant admin/owner | Click on a pipeline row to view the meeting detail | I can see the full meeting context |
| 3 | Tenant admin/owner | View all the same info a closer sees (lead, booking answers, notes, payments, history) | I have full context when reviewing a meeting |
| 4 | Tenant admin/owner | Edit a meeting's start/end time and outcome | I can correct meetings where the closer forgot to press "Start" |
| 5 | Tenant admin/owner | Log a payment on behalf of a closer | I can record sales the closer couldn't log themselves |
| 6 | Tenant admin/owner | Generate a follow-up scheduling link or set a reminder | I can keep the pipeline moving when a closer drops the ball |
| 7 | Tenant admin/owner | Generate a reschedule link for no-show meetings | I can manage recovery from no-shows across the team |

---

## Architecture Decisions

### AD-1: Route placement

**Decision**: `/workspace/pipeline/meetings/[meetingId]` (nested under pipeline)

**Rationale**: Admins navigate to meetings from the pipeline table. Nesting under `/pipeline` keeps breadcrumbs intuitive: Pipeline > Meeting Detail. The edit page lives at `.../[meetingId]/edit`.

### AD-2: Component reuse strategy

**Decision**: Import existing closer meeting components directly from `app/workspace/closer/meetings/_components/`.

**Rationale**: These are `"use client"` components with no closer-specific auth logic (auth is handled by the Convex query). Cross-importing is fine because both routes live under `app/workspace/`. No need to extract to a shared directory yet — if reuse grows, we can refactor later.

**Reusable as-is**: `LeadInfoPanel`, `MeetingInfoPanel`, `BookingAnswersCard`, `DealWonCard`, `AttributionCard`, `MeetingNotes`, `PaymentLinksPanel`, `PotentialDuplicateBanner`, `RescheduleChainBanner`, `RescheduleLinkDisplay`, `RescheduleLinkSentBanner`, `PaymentFormDialog`.

**NOT reusable (closer-specific)**: `OutcomeActionBar` (handles Start Meeting flow), `FollowUpDialog` (calls closer-only mutations), `MarkLostDialog` (calls closer-only mutation), `MarkNoShowDialog` (calls closer-only mutation), `NoShowActionBar` (calls closer-only mutations).

### AD-3: Pipeline date filtering approach

**Decision**: Filter by `createdAt` on opportunities using existing indexes, with 2 new composite indexes added for the closer+date combinations.

**Rationale**: The opportunity `createdAt` closely correlates with meeting booking time. We already have `by_tenantId_and_createdAt` and `by_tenantId_and_status_and_createdAt` indexes. Adding 2 more indexes for closer+date combinations gives us full coverage for paginated queries across all 8 filter combinations.

**Reuse**: The `TimePeriodFilter` component (Day/Week/Month toggle) from the admin dashboard is reused directly.

### AD-4: Meeting edit as a separate page (not dialog)

**Decision**: Edit lives at `/workspace/pipeline/meetings/[meetingId]/edit` as a full page.

**Rationale**: Per user requirement ("click edit in a different screen"). The edit page is a focused form with clear save/cancel actions.

### AD-5: Admin mutations strategy

**Decision**: Create new admin-specific mutations in `convex/admin/meetingActions.ts` rather than widening the existing closer mutations.

**Rationale**: The closer mutations have deliberate ownership checks and role restrictions. Rather than adding conditional logic that could introduce security regressions, we create separate admin mutations that call the same internal helpers where applicable. This keeps the security boundary clear.

---

## Phase Overview

| Phase | Focus | Key Deliverables | Dependencies |
|-------|-------|-----------------|-------------|
| **1** | Pipeline date filtering | TimePeriodFilter on pipeline, updated Convex query, 2 new indexes | None |
| **2** | Pipeline-to-meeting navigation | "View" button links to admin meeting detail, opportunity rows show latest meeting ID | Phase 1 (optional, can parallelize) |
| **3** | Admin meeting detail page | New route, reused display components, admin-adapted layout | Phase 2 |
| **4** | Admin meeting edit page | Edit form for scheduledAt/durationMinutes/outcome, new Convex mutation | Phase 3 |
| **5** | Admin meeting actions (backend) | Admin mutations for follow-up, reschedule, mark-lost, edit time | Phase 3 |
| **6** | Admin action bar (frontend) | AdminActionBar component wiring all backend actions | Phase 4 + 5 |

**Parallelization**: Phases 1 and 2 are independent. Phases 4 and 5 can run in parallel (backend + frontend skeleton).

---

## Phase 1: Pipeline Date Filtering

### Files to modify

| File | Change |
|------|--------|
| `convex/schema.ts` | Add 2 new indexes on `opportunities` |
| `convex/opportunities/queries.ts` | Add `periodStart`/`periodEnd` args, expand query branches |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Add `TimePeriodFilter`, wire date range to query args |
| `app/workspace/pipeline/_components/pipeline-filters.tsx` | Add period filter alongside status/closer filters |

### New indexes needed

```ts
// convex/schema.ts — add to opportunities table
.index("by_tenantId_and_assignedCloserId_and_createdAt", [
  "tenantId", "assignedCloserId", "createdAt",
])
.index("by_tenantId_and_assignedCloserId_and_status_and_createdAt", [
  "tenantId", "assignedCloserId", "status", "createdAt",
])
```

### Query update strategy

The `listOpportunitiesForAdmin` query currently handles 4 filter combinations. With date ranges, it expands to 8:

| Status | Closer | Date | Index |
|--------|--------|------|-------|
| - | - | - | `by_tenantId` |
| Y | - | - | `by_tenantId_and_status` |
| - | Y | - | `by_tenantId_and_assignedCloserId` |
| Y | Y | - | `by_tenantId_and_assignedCloserId_and_status` |
| - | - | Y | `by_tenantId_and_createdAt` |
| Y | - | Y | `by_tenantId_and_status_and_createdAt` |
| - | Y | Y | `by_tenantId_and_assignedCloserId_and_createdAt` **(NEW)** |
| Y | Y | Y | `by_tenantId_and_assignedCloserId_and_status_and_createdAt` **(NEW)** |

**Code structure**: Extract a helper function `buildPaginatedQuery(ctx, tenantId, filters)` to avoid deeply nested ternaries.

### Frontend changes

```tsx
// In pipeline-filters.tsx — add period filter
<TimePeriodFilter value={period} onValueChange={onPeriodChange} />
```

The period is stored in URL search params (`?period=today|this_week|this_month`). When "all time" (no period filter), omit the param and omit date args from the query.

Add an "All time" option to allow clearing the date filter (the existing `TimePeriodFilter` doesn't have this — we'll add a small wrapper or extend it).

### Pagination implications

- When a date range is active, `paginate()` operates within the date-bounded index range
- Cursor-based pagination works correctly because each index path returns a contiguous ordered slice
- The `desc` ordering is maintained (newest first within the date window)
- Load-more continues to work as normal

---

## Phase 2: Pipeline-to-Meeting Navigation

### Files to modify

| File | Change |
|------|--------|
| `app/workspace/pipeline/_components/opportunities-table.tsx` | Make "View" button a `<Link>` to admin meeting detail |

### Linking logic

Each opportunity row already has `latestMeetingId` and `nextMeetingId` from the enriched query result. The "View" button should link to the most relevant meeting:

```ts
const targetMeetingId = opp.nextMeetingId ?? opp.latestMeetingId;
const href = targetMeetingId
  ? `/workspace/pipeline/meetings/${targetMeetingId}`
  : null; // disable button if no meeting exists
```

If the opportunity has no meeting (edge case — shouldn't happen in normal flow), disable the button.

---

## Phase 3: Admin Meeting Detail Page

### New files

```
app/workspace/pipeline/meetings/[meetingId]/
├── page.tsx                          # RSC wrapper (requireRole)
├── loading.tsx                       # Skeleton
└── _components/
    └── admin-meeting-detail-client.tsx  # Client component
```

### Page structure

```tsx
// page.tsx — follows established three-layer pattern
export const unstable_instant = false;

export default async function AdminMeetingDetailPage({
  params,
}: { params: Promise<{ meetingId: string }> }) {
  await requireRole(["tenant_master", "tenant_admin"]);
  const { meetingId } = await params;
  const session = await verifySession();
  
  const preloaded = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: meetingId as Id<"meetings"> },
    { token: session.accessToken },
  );
  
  return <AdminMeetingDetailClient preloadedDetail={preloaded} />;
}
```

### Client component layout

Similar to the closer detail page but with admin-specific differences:

1. **Back button** → navigates to `/workspace/pipeline` (not closer dashboard)
2. **Same display panels**: LeadInfoPanel, MeetingInfoPanel, BookingAnswersCard, DealWonCard, AttributionCard, MeetingNotes, PaymentLinksPanel
3. **Same banners**: PotentialDuplicateBanner, RescheduleChainBanner, Reassignment alert
4. **Different action bar**: `AdminActionBar` (Phase 6) replaces `OutcomeActionBar`
5. **Edit button**: Link to `/workspace/pipeline/meetings/[meetingId]/edit`
6. **No "Start Meeting" flow**: Admins don't start meetings — that's closer-only
7. **Assigned closer prominently shown**: Admin needs to know whose meeting this is

### Component imports

```tsx
// Cross-importing from closer meeting components
import { LeadInfoPanel } from "@/app/workspace/closer/meetings/_components/lead-info-panel";
import { MeetingInfoPanel } from "@/app/workspace/closer/meetings/_components/meeting-info-panel";
// ... etc
```

---

## Phase 4: Admin Meeting Edit Page

### New files

```
app/workspace/pipeline/meetings/[meetingId]/edit/
├── page.tsx
└── _components/
    └── edit-meeting-page-client.tsx
```

### Edit form fields

| Field | Type | Mapping | Notes |
|-------|------|---------|-------|
| Meeting Date | DatePicker | `scheduledAt` | Calendar date portion |
| Start Time | TimePicker | `scheduledAt` | Time portion (combined with date → epoch ms) |
| End Time | TimePicker | computed | `scheduledAt + durationMinutes * 60_000` |
| Duration | Display only | auto-computed | Shows computed duration from start/end time |
| Meeting Outcome | Select | `meetingOutcome` | Same 5 options as closer view |
| Meeting Status | Select | `status` | Admin can manually transition status (with validation) |
| Notes | Textarea | `notes` | Same auto-save as closer view (or explicit save here) |

### Validation rules

- End time must be after start time
- Duration must be positive and reasonable (1–480 minutes)
- Status transitions must follow the valid transition map
- Changes emit domain events for audit trail

### UX pattern

- RHF + Zod form (established pattern)
- `standardSchemaResolver` (not `zodResolver`)
- Save button + Cancel button (not auto-save — this is an intentional edit)
- Success: toast + redirect back to meeting detail
- Error: inline `<FormMessage />` per field + `<Alert>` for server errors

### New Convex mutation

```ts
// convex/admin/meetingActions.ts
export const adminEditMeeting = mutation({
  args: {
    meetingId: v.id("meetings"),
    scheduledAt: v.optional(v.number()),
    durationMinutes: v.optional(v.number()),
    meetingOutcome: v.optional(v.union(
      v.literal("interested"),
      v.literal("needs_more_info"),
      v.literal("price_objection"),
      v.literal("not_qualified"),
      v.literal("ready_to_buy"),
    )),
    status: v.optional(v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("canceled"),
      v.literal("no_show"),
    )),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { tenantId, userId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    
    const meeting = await ctx.db.get(args.meetingId);
    if (!meeting || meeting.tenantId !== tenantId) throw new Error("Meeting not found");
    
    const patch: Partial<Doc<"meetings">> = {};
    
    if (args.scheduledAt !== undefined) patch.scheduledAt = args.scheduledAt;
    if (args.durationMinutes !== undefined) patch.durationMinutes = args.durationMinutes;
    if (args.meetingOutcome !== undefined) patch.meetingOutcome = args.meetingOutcome;
    if (args.notes !== undefined) patch.notes = args.notes;
    
    // Status change requires transition validation
    if (args.status !== undefined && args.status !== meeting.status) {
      // Admin can force-transition — but still validate basic sanity
      // Log the override for audit
      patch.status = args.status;
      if (args.status === "completed" && !meeting.completedAt) {
        patch.completedAt = Date.now();
      }
      if (args.status === "in_progress" && !meeting.startedAt) {
        patch.startedAt = args.scheduledAt ?? meeting.scheduledAt;
      }
    }
    
    await ctx.db.patch(args.meetingId, patch);
    
    // Update denormalized meeting refs on opportunity
    await updateOpportunityMeetingRefs(ctx, meeting.opportunityId);
    
    // Emit domain event
    // ... (admin.meeting_edited event)
  },
});
```

---

## Phase 5: Admin Meeting Actions (Backend)

### New file: `convex/admin/meetingActions.ts`

| Mutation | Purpose | Based on |
|----------|---------|----------|
| `adminEditMeeting` | Edit scheduledAt, durationMinutes, status, outcome, notes | New |
| `adminMarkAsLost` | Mark opportunity as lost on behalf of closer | `closer.meetingActions.markAsLost` |
| `adminCreateFollowUp` | Create scheduling link follow-up using closer's Calendly | `closer.followUpMutations.createSchedulingLinkFollowUp` |
| `adminConfirmFollowUp` | Confirm follow-up status transition | `closer.followUpMutations.confirmFollowUpScheduled` |
| `adminCreateManualReminder` | Create manual reminder follow-up | `closer.followUpMutations.createManualReminderFollowUpPublic` |
| `adminCreateRescheduleLink` | Generate reschedule link for no-show meetings | `closer.noShowActions.createNoShowRescheduleLink` |

### Key difference from closer mutations

- **Auth**: `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])` — no ownership check
- **Closer resolution**: Instead of using `userId` (which is the admin), look up `opportunity.assignedCloserId` to find the closer
- **Follow-up links**: Use the assigned closer's `personalEventTypeUri` for Calendly scheduling links
- **Domain events**: Source tagged as `"admin"` instead of `"closer"` for audit trail
- **logPayment**: Already supports admin access — no changes needed

### Existing mutations that already work for admins (no changes needed)

- `closer.payments.logPayment` ✅
- `closer.payments.generateUploadUrl` ✅
- `closer.meetingActions.updateMeetingNotes` ✅
- `closer.meetingActions.updateMeetingOutcome` ✅
- `closer.meetingActions.stopMeeting` ✅

---

## Phase 6: Admin Action Bar (Frontend)

### New file: `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx`

### Actions by opportunity status

| Opportunity Status | Available Actions |
|-------------------|-------------------|
| `scheduled` | Edit Meeting |
| `in_progress` | Log Payment, Schedule Follow-up, Mark No-Show*, Mark as Lost, Edit Meeting |
| `no_show` | Generate Reschedule Link, Schedule Follow-up, Edit Meeting |
| `canceled` | Schedule Follow-up, Edit Meeting |
| `follow_up_scheduled` | Edit Meeting |
| `reschedule_link_sent` | Edit Meeting |
| `payment_received` | (view only — terminal) |
| `lost` | (view only — terminal) |

*Mark No-Show is debatable for admins — they weren't in the meeting. Include but may remove based on user feedback.

### Admin-specific dialogs needed

| Dialog | Based on | Key differences |
|--------|----------|----------------|
| `AdminFollowUpDialog` | `FollowUpDialog` | Calls admin mutations, uses assigned closer's Calendly URI |
| `AdminMarkLostDialog` | `MarkLostDialog` | Calls `adminMarkAsLost` instead of `markAsLost` |

The `PaymentFormDialog` already works for admins (no changes needed — it calls `logPayment` which accepts admin roles).

---

## Component Reuse Map

```
Closer Meeting Detail                    Admin Meeting Detail
========================                 ========================
LeadInfoPanel            ──────────────► LeadInfoPanel (same)
MeetingInfoPanel         ──────────────► MeetingInfoPanel (same)
BookingAnswersCard       ──────────────► BookingAnswersCard (same)
DealWonCard              ──────────────► DealWonCard (same)
AttributionCard          ──────────────► AttributionCard (same)
MeetingNotes             ──────────────► MeetingNotes (same)
PaymentLinksPanel        ──────────────► PaymentLinksPanel (same)
PotentialDuplicateBanner ──────────────► PotentialDuplicateBanner (same)
RescheduleChainBanner    ──────────────► RescheduleChainBanner (same)
RescheduleLinkDisplay    ──────────────► RescheduleLinkDisplay (same)
RescheduleLinkSentBanner ──────────────► RescheduleLinkSentBanner (same)
PaymentFormDialog        ──────────────► PaymentFormDialog (same)
OutcomeActionBar         ──── X ────── AdminActionBar (new)
FollowUpDialog           ──── X ────── AdminFollowUpDialog (new)
MarkLostDialog           ──── X ────── AdminMarkLostDialog (new)
MarkNoShowDialog         ──── X ────── (excluded or new)
NoShowActionBar          ──── X ────── (integrated into AdminActionBar)
LateStartReasonDialog    ──── X ────── (excluded — admin doesn't start meetings)
```

---

## Schema & Index Changes

### New indexes (Phase 1)

```ts
// On opportunities table
.index("by_tenantId_and_assignedCloserId_and_createdAt", [
  "tenantId", "assignedCloserId", "createdAt",
])
.index("by_tenantId_and_assignedCloserId_and_status_and_createdAt", [
  "tenantId", "assignedCloserId", "status", "createdAt",
])
```

### No schema field changes

No new fields are added to any table. The admin edit mutation patches existing fields.

---

## Mutation Access Matrix (Current + Planned)

| Mutation | Closer | Admin | Notes |
|----------|--------|-------|-------|
| `startMeeting` | Own | - | Closer-only, window-gated |
| `stopMeeting` | Own | Any | Already hybrid |
| `updateMeetingNotes` | Own | Any | Already hybrid |
| `updateMeetingOutcome` | Own | Any | Already hybrid |
| `markAsLost` | Own | - | Closer-only |
| `logPayment` | Own | Any | Already hybrid |
| `generateUploadUrl` | Any | Any | Already hybrid |
| `createSchedulingLinkFollowUp` | Own | - | Closer-only |
| `confirmFollowUpScheduled` | Own | - | Closer-only |
| `createManualReminderFollowUpPublic` | Own | - | Closer-only |
| `markNoShow` | Own | - | Closer-only |
| `createNoShowRescheduleLink` | Own | - | Closer-only |
| **`adminEditMeeting`** | - | **Any** | **NEW** |
| **`adminMarkAsLost`** | - | **Any** | **NEW** |
| **`adminCreateFollowUp`** | - | **Any** | **NEW** |
| **`adminConfirmFollowUp`** | - | **Any** | **NEW** |
| **`adminCreateManualReminder`** | - | **Any** | **NEW** |
| **`adminCreateRescheduleLink`** | - | **Any** | **NEW** |

---

## Estimated Effort

| Phase | Scope | Estimate |
|-------|-------|----------|
| 1 | Pipeline date filtering (2 indexes + query + UI) | Medium |
| 2 | View button linking | Small |
| 3 | Admin meeting detail page (reuse-heavy) | Medium |
| 4 | Admin meeting edit page + mutation | Medium |
| 5 | Admin backend mutations (6 new) | Medium-Large |
| 6 | Admin action bar + dialogs | Medium |

**Total**: ~4-5 focused implementation sessions

---

## Open Questions

1. **Should admins be able to mark no-show?** They weren't in the meeting, so it's unclear if this is their responsibility. For now, excluded from admin actions — closers mark no-shows, admins handle the aftermath.
2. **Should the meeting edit allow status transitions to/from terminal states?** E.g., should an admin be able to un-lose a meeting? For now, prevent transitions FROM terminal states (`payment_received`, `lost`). Allow transitions TO terminal states with appropriate side effects.
3. **Should we add a search/filter by lead name on the pipeline?** Not in scope for this plan, but would complement the date filtering for findability.
