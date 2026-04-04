# Phase 6 — Meeting Detail Page & Outcome Actions

**Goal:** Build the meeting detail page — the Closer's workspace for individual meetings. It shows lead information, meeting details with Zoom link, real-time editable notes, payment links from event type config, and an outcome action bar (Start Meeting, Log Payment, Schedule Follow-up, Mark as Lost). After this phase, Closers can manage meetings end-to-end from a single page.

**Prerequisite:** Phase 5 (Closer dashboard and pipeline — provides the navigation paths to meeting detail) and Phase 1 (schema, auth guard, status transitions).

**Acceptance Criteria:**
1. Navigating to `/workspace/closer/meetings/[meetingId]` renders the full meeting detail page.
2. Lead info panel shows name, email, phone, and meeting history (all meetings for this lead).
3. Meeting info panel shows date/time, duration, Zoom join link, event type name, and status badge.
4. Notes text area auto-saves via debounced Convex mutation and reflects real-time across devices.
5. Payment links panel shows links from the event type config (if configured).
6. "Start Meeting" button opens Zoom in a new tab and transitions meeting + opportunity to `in_progress`.
7. "Mark as Lost" button shows a confirmation dialog with optional reason, then transitions opportunity to `lost`.
8. Admins can view any meeting detail page (not just their own assignments).
9. Invalid `meetingId` or unauthorized access shows an appropriate error screen.

---

## Subphases

### 6A — Meeting Detail Query

**Type:** Backend
**Parallelizable:** Yes — independent of 6B. After Phase 1 complete.

**What:** Create the `getMeetingDetail` query that returns all data needed for the meeting detail page: meeting, opportunity, lead (with meeting history), payment links from event type config, and payment records.

**Why:** The meeting detail page (6C) needs a rich, deeply-joined data set. A single query provides everything the page needs, avoiding waterfall fetches on the client. Convex's real-time subscriptions ensure the page updates live when data changes.

**Where:** `convex/closer/meetingDetail.ts` (new file)

**How:**

```typescript
// convex/closer/meetingDetail.ts
import { v } from "convex/values";
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

/**
 * Get all data for the meeting detail page.
 *
 * Returns:
 * - meeting: The meeting record
 * - opportunity: The parent opportunity
 * - lead: The lead with full profile
 * - meetingHistory: All meetings for this lead across all opportunities
 * - paymentLinks: From the event type config (if configured)
 * - payments: Payment records for this opportunity
 *
 * Authorization:
 * - Closers can only view meetings for their assigned opportunities
 * - Admins (tenant_master, tenant_admin) can view any meeting in the tenant
 */
export const getMeetingDetail = query({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    // Load the meeting
    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    // Load the parent opportunity
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity) {
      throw new Error("Opportunity not found");
    }

    // Authorization: Closers can only see their own meetings
    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Load the lead
    const lead = await ctx.db.get(opportunity.leadId);

    // Load lead's full meeting history (all meetings across all opportunities for this lead)
    const leadOpps = await ctx.db
      .query("opportunities")
      .withIndex("by_tenantId_and_leadId", (q) =>
        q.eq("tenantId", tenantId).eq("leadId", opportunity.leadId)
      )
      .collect();

    const allMeetings = [];
    for (const opp of leadOpps) {
      const oppMeetings = await ctx.db
        .query("meetings")
        .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opp._id))
        .collect();
      for (const m of oppMeetings) {
        allMeetings.push({
          ...m,
          opportunityStatus: opp.status,
          isCurrentMeeting: m._id === meetingId,
        });
      }
    }

    // Sort meeting history by scheduledAt descending (most recent first)
    allMeetings.sort((a, b) => b.scheduledAt - a.scheduledAt);

    // Load payment links from event type config
    let paymentLinks = null;
    if (opportunity.eventTypeConfigId) {
      const config = await ctx.db.get(opportunity.eventTypeConfigId);
      paymentLinks = config?.paymentLinks ?? null;
    }

    // Load payment records for this opportunity
    const payments = await ctx.db
      .query("paymentRecords")
      .withIndex("by_opportunityId", (q) => q.eq("opportunityId", opportunity._id))
      .collect();

    // Load assigned closer info (for admin view)
    const assignedCloser = opportunity.assignedCloserId
      ? await ctx.db.get(opportunity.assignedCloserId)
      : null;

    return {
      meeting,
      opportunity,
      lead,
      assignedCloser: assignedCloser
        ? { fullName: assignedCloser.fullName, email: assignedCloser.email }
        : null,
      meetingHistory: allMeetings,
      paymentLinks,
      payments,
    };
  },
});
```

**Key implementation notes:**
- Allows both closers and admins to view meeting details. Closers are restricted to their own assigned meetings; admins can view any meeting in the tenant.
- `meetingHistory` includes ALL meetings for the lead (across all opportunities). This gives the closer full context on the lead's engagement history.
- `isCurrentMeeting` flag in the history helps the UI highlight which meeting in the history timeline is currently being viewed.
- `paymentLinks` comes from the event type config — these are the payment URLs the closer shares with the lead during the meeting.
- The query returns everything the page needs in a single subscription. Changes to any related record (meeting notes, payment logged, status change) trigger an automatic re-render.

**Files touched:** `convex/closer/meetingDetail.ts` (create)

---

### 6B — Meeting Actions (Notes, Start, Mark Lost)

**Type:** Backend
**Parallelizable:** Yes — independent of 6A. After Phase 1 complete.

**What:** Create mutations for meeting actions: `updateMeetingNotes` (auto-save notes), `startMeeting` (transition to in_progress, return Zoom URL), and `markAsLost` (transition opportunity to lost with optional reason).

**Why:** These mutations are triggered by the meeting detail page's action buttons and auto-saving notes field. They enforce the opportunity status state machine and ensure only authorized users can perform actions.

**Where:** `convex/closer/meetingActions.ts` (new file)

**How:**

```typescript
// convex/closer/meetingActions.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { validateTransition } from "../lib/statusTransitions";

/**
 * Update meeting notes.
 *
 * Called by the auto-saving notes textarea on the meeting detail page.
 * Debounced on the client side (typically 500ms–1s).
 *
 * Accessible by closers (own meetings) and admins (any meeting).
 */
export const updateMeetingNotes = mutation({
  args: {
    meetingId: v.id("meetings"),
    notes: v.string(),
  },
  handler: async (ctx, { meetingId, notes }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    // Closer authorization: only own meetings
    if (role === "closer") {
      const opportunity = await ctx.db.get(meeting.opportunityId);
      if (!opportunity || opportunity.assignedCloserId !== userId) {
        throw new Error("Not your meeting");
      }
    }

    await ctx.db.patch(meetingId, { notes });
  },
});

/**
 * Start a meeting.
 *
 * Transitions the meeting and opportunity to "in_progress".
 * Returns the Zoom join URL so the frontend can open it in a new tab.
 *
 * Only closers can start meetings (on their own assignments).
 */
export const startMeeting = mutation({
  args: { meetingId: v.id("meetings") },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      throw new Error("Meeting not found");
    }

    // Verify this is the closer's meeting
    const opportunity = await ctx.db.get(meeting.opportunityId);
    if (!opportunity || opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    // Validate status transitions
    if (meeting.status !== "scheduled") {
      throw new Error(`Cannot start a meeting with status "${meeting.status}"`);
    }

    if (opportunity.status === "scheduled") {
      if (!validateTransition("scheduled", "in_progress")) {
        throw new Error("Invalid opportunity status transition");
      }
      await ctx.db.patch(opportunity._id, {
        status: "in_progress",
        updatedAt: Date.now(),
      });
    }

    await ctx.db.patch(meetingId, { status: "in_progress" });

    return { zoomJoinUrl: meeting.zoomJoinUrl };
  },
});

/**
 * Mark an opportunity as lost.
 *
 * Transitions the opportunity to "lost" status with an optional reason.
 * This is a terminal state — no further transitions allowed.
 *
 * Only closers can mark their own opportunities as lost.
 */
export const markAsLost = mutation({
  args: {
    opportunityId: v.id("opportunities"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { opportunityId, reason }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, ["closer"]);

    const opportunity = await ctx.db.get(opportunityId);
    if (!opportunity || opportunity.tenantId !== tenantId) {
      throw new Error("Opportunity not found");
    }

    if (opportunity.assignedCloserId !== userId) {
      throw new Error("Not your opportunity");
    }

    // Validate the transition
    if (!validateTransition(opportunity.status, "lost")) {
      throw new Error(
        `Cannot mark as lost from status "${opportunity.status}". ` +
        `Only "in_progress" opportunities can be marked as lost.`
      );
    }

    await ctx.db.patch(opportunityId, {
      status: "lost",
      lostReason: reason ?? null,
      updatedAt: Date.now(),
    });
  },
});
```

**Key implementation notes:**
- `updateMeetingNotes` is called frequently (debounced auto-save). It does minimal validation for performance.
- `startMeeting` validates that both the meeting and opportunity are in `scheduled` status. It returns the `zoomJoinUrl` so the frontend can open it in `window.open()`.
- `markAsLost` uses `validateTransition` from `convex/lib/statusTransitions.ts` to enforce the state machine. Only `in_progress` can transition to `lost`.
- All mutations use `requireTenantUser` for authorization. Closers are restricted to their own assignments.
- These mutations pair with the `logPayment` (Phase 7A) and `createFollowUp` (Phase 7B) mutations to complete the full set of outcome actions.

**Files touched:** `convex/closer/meetingActions.ts` (create)

---

### 6C — Meeting Detail Page UI

**Type:** Frontend
**Parallelizable:** Depends on 6A (meeting detail query). Can start layout with mock data.

**What:** Build the meeting detail page with panels for lead info, meeting info, notes, payment links, and an outcome action bar.

**Why:** This is the Closer's workspace during and after a meeting. Everything they need is on one screen: the lead's profile and history, meeting timing and Zoom link, a notes area for real-time capture, payment links to share, and action buttons to log the outcome.

**Where:** `app/workspace/closer/meetings/[meetingId]/page.tsx`, `app/workspace/closer/meetings/_components/` (new component files)

**How:**

**Page layout:**
```
┌──────────────────────────────────────────────────────────────┐
│ ← Back to Dashboard          Meeting Detail       Status: 🟦│
├──────────────────────────┬───────────────────────────────────┤
│                          │                                   │
│  Lead Info Panel         │  Meeting Info Panel               │
│  ─────────────────       │  ─────────────────                │
│  Name: John Smith        │  Date: Apr 2, 2026 at 2:30 PM   │
│  Email: john@acme.com    │  Duration: 30 minutes             │
│  Phone: +1 555-0123      │  Event Type: Sales Call           │
│                          │  Zoom: [Join Meeting]             │
│  Meeting History         │                                   │
│  ─────────────────       │  Payment Links                    │
│  🟩 Mar 28 - Won        │  ─────────────────                │
│  🟥 Mar 15 - Canceled   │  [Copy Stripe Link]               │
│  → 🟦 Apr 2 - Scheduled │  [Copy PayPal Link]               │
│                          │                                   │
├──────────────────────────┴───────────────────────────────────┤
│                                                              │
│  Notes                                                       │
│  ──────────────────────────────────────────────────────────  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Meeting went well. Lead is interested in the pro     │   │
│  │ plan. Needs to discuss with partner before commit... │   │
│  │                                                      │   │
│  │ (auto-saves)                                         │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Outcome Actions                                             │
│  ┌──────────┐ ┌───────────┐ ┌────────────────┐ ┌─────────┐ │
│  │▶ Start   │ │💰 Log     │ │📅 Schedule     │ │❌ Mark  │ │
│  │ Meeting  │ │  Payment  │ │  Follow-up     │ │  as Lost│ │
│  └──────────┘ └───────────┘ └────────────────┘ └─────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Component structure:**
```
app/workspace/closer/meetings/
├── [meetingId]/
│   └── page.tsx                    ← Meeting detail page (composition)
└── _components/
    ├── lead-info-panel.tsx         ← Lead profile + meeting history timeline
    ├── meeting-info-panel.tsx      ← Date, duration, Zoom link, event type, status
    ├── meeting-notes.tsx           ← Auto-saving textarea with debounce
    ├── payment-links-panel.tsx     ← Copyable payment URLs from event type config
    ├── outcome-action-bar.tsx      ← Start Meeting, Log Payment, Follow-up, Mark Lost
    ├── mark-lost-dialog.tsx        ← Confirmation dialog with optional reason
    └── meeting-history-timeline.tsx ← Vertical timeline of lead's past meetings
```

```typescript
// app/workspace/closer/meetings/[meetingId]/page.tsx
"use client";

import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { LeadInfoPanel } from "../_components/lead-info-panel";
import { MeetingInfoPanel } from "../_components/meeting-info-panel";
import { MeetingNotes } from "../_components/meeting-notes";
import { PaymentLinksPanel } from "../_components/payment-links-panel";
import { OutcomeActionBar } from "../_components/outcome-action-bar";

export default function MeetingDetailPage() {
  const params = useParams();
  const meetingId = params.meetingId as Id<"meetings">;

  const detail = useQuery(api.closer.meetingDetail.getMeetingDetail, {
    meetingId,
  });

  if (detail === undefined) return <MeetingDetailSkeleton />;
  if (detail === null) return <MeetingNotFound />;

  const { meeting, opportunity, lead, meetingHistory, paymentLinks, payments } = detail;

  return (
    <div className="space-y-6">
      {/* Header with back nav and status */}
      <MeetingDetailHeader meeting={meeting} opportunity={opportunity} />

      {/* Two-column layout: Lead info | Meeting info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <LeadInfoPanel lead={lead} meetingHistory={meetingHistory} />
        <MeetingInfoPanel
          meeting={meeting}
          paymentLinks={paymentLinks}
        />
      </div>

      {/* Notes section */}
      <MeetingNotes meetingId={meeting._id} initialNotes={meeting.notes ?? ""} />

      {/* Outcome action bar */}
      <OutcomeActionBar
        meeting={meeting}
        opportunity={opportunity}
        payments={payments}
      />
    </div>
  );
}
```

**Notes auto-save implementation:**

```typescript
// app/workspace/closer/meetings/_components/meeting-notes.tsx
"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { Textarea } from "@/components/ui/textarea";

const DEBOUNCE_MS = 800;

export function MeetingNotes({
  meetingId,
  initialNotes,
}: {
  meetingId: Id<"meetings">;
  initialNotes: string;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [isSaving, setIsSaving] = useState(false);
  const updateNotes = useMutation(api.closer.meetingActions.updateMeetingNotes);
  const timeoutRef = useRef<NodeJS.Timeout>();

  // Debounced auto-save
  const handleChange = useCallback(
    (value: string) => {
      setNotes(value);

      if (timeoutRef.current) clearTimeout(timeoutRef.current);

      timeoutRef.current = setTimeout(async () => {
        setIsSaving(true);
        try {
          await updateNotes({ meetingId, notes: value });
        } finally {
          setIsSaving(false);
        }
      }, DEBOUNCE_MS);
    },
    [meetingId, updateNotes]
  );

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Notes</h3>
        {isSaving && (
          <span className="text-xs text-muted-foreground">Saving...</span>
        )}
      </div>
      <Textarea
        value={notes}
        onChange={(e) => handleChange(e.target.value)}
        placeholder="Add meeting notes here..."
        className="min-h-[150px]"
        aria-label="Meeting notes"
      />
    </div>
  );
}
```

**Frontend design guidelines to follow:**
- Use a two-column responsive layout: side-by-side on desktop (`md:grid-cols-2`), stacked on mobile.
- **Lead Info Panel**: shadcn `Card` with lead profile at top, followed by a vertical timeline of past meetings (use a custom timeline component with left-side dots/lines).
- **Meeting Info Panel**: shadcn `Card` with meeting details and a prominent "Join Zoom" button.
- **Payment Links**: Each link as a row with a "Copy" button (uses `navigator.clipboard.writeText`). Show toast on copy success.
- **Notes Textarea**: shadcn `Textarea` with auto-resize capability. "Saving..." indicator appears during debounce flush.
- **Outcome Action Bar**: Fixed at the bottom of the page or as a sticky section. Buttons are contextual:
  - "Start Meeting" shows only if status is `scheduled`
  - "Log Payment" and "Schedule Follow-up" show only if status is `in_progress`
  - "Mark as Lost" shows if status is `in_progress`
- Follow `vercel-react-best-practices`: notes debounce prevents excessive mutations. The meeting detail query is a single subscription that updates all panels.
- Follow `web-design-guidelines`: "Mark as Lost" should require a confirmation dialog (shadcn `AlertDialog`) to prevent accidental clicks. Zoom link should be accessible via keyboard. Meeting history timeline should use `<ol>` with `aria-label`.

**Files touched:** `app/workspace/closer/meetings/[meetingId]/page.tsx` (create), `app/workspace/closer/meetings/_components/lead-info-panel.tsx` (create), `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` (create), `app/workspace/closer/meetings/_components/meeting-notes.tsx` (create), `app/workspace/closer/meetings/_components/payment-links-panel.tsx` (create), `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (create), `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` (create), `app/workspace/closer/meetings/_components/meeting-history-timeline.tsx` (create)

---

### 6D — Outcome Action Bar Component

**Type:** Frontend
**Parallelizable:** Depends on 6B (meeting actions mutations). Can start with UI shell.

**What:** Build the outcome action bar component that renders contextual action buttons based on the meeting/opportunity status and calls the appropriate backend mutations.

**Why:** The action bar is the primary interaction point for meeting outcomes. It must show the right buttons at the right time (e.g., "Start Meeting" only when scheduled, "Log Payment" only when in progress) and provide clear feedback on success/failure.

**Where:** `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (extends the component created in 6C)

**How:**

```typescript
// app/workspace/closer/meetings/_components/outcome-action-bar.tsx
"use client";

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { MarkLostDialog } from "./mark-lost-dialog";
import { useRouter } from "next/navigation";

export function OutcomeActionBar({ meeting, opportunity, payments }) {
  const startMeeting = useMutation(api.closer.meetingActions.startMeeting);
  const router = useRouter();

  const isScheduled = meeting.status === "scheduled";
  const isInProgress = opportunity.status === "in_progress";
  const hasPayments = payments.length > 0;

  const handleStartMeeting = async () => {
    try {
      const result = await startMeeting({ meetingId: meeting._id });
      // Open Zoom in new tab
      if (result.zoomJoinUrl) {
        window.open(result.zoomJoinUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      // Show error toast
    }
  };

  return (
    <div className="flex flex-wrap gap-3 border-t pt-4">
      {/* Start Meeting — only when scheduled */}
      {isScheduled && (
        <Button onClick={handleStartMeeting} size="lg">
          ▶ Start Meeting
        </Button>
      )}

      {/* Log Payment — only when in_progress (built in Phase 7) */}
      {isInProgress && (
        <Button variant="outline" size="lg" disabled>
          💰 Log Payment
          <span className="ml-1 text-xs">(Phase 7)</span>
        </Button>
      )}

      {/* Schedule Follow-up — only when in_progress (built in Phase 7) */}
      {isInProgress && (
        <Button variant="outline" size="lg" disabled>
          📅 Schedule Follow-up
          <span className="ml-1 text-xs">(Phase 7)</span>
        </Button>
      )}

      {/* Mark as Lost — when in_progress */}
      {isInProgress && (
        <MarkLostDialog opportunityId={opportunity._id} />
      )}
    </div>
  );
}
```

**Key implementation notes:**
- "Log Payment" and "Schedule Follow-up" buttons are rendered as disabled placeholders in Phase 6. They'll be wired to real mutations in Phase 7.
- "Start Meeting" opens Zoom via `window.open()` with `noopener,noreferrer` for security.
- `MarkLostDialog` is a separate component using shadcn `AlertDialog` for the confirmation UX.
- The action bar adapts to the current status — showing only relevant actions prevents user confusion.

**Files touched:** `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` (create/finalize)

---

## Parallelization Summary

```
Phase 5 Complete
  │
  ├── 6A (meeting detail query) ───────────────────┐
  └── 6B (meeting actions mutations) ──────────────┤  Both run in PARALLEL
                                                    │
  After backend subphases complete:                 │
  ├── 6C (meeting detail page UI) ─────────────────┤
  └── 6D (outcome action bar component) ───────────┘  Both run in PARALLEL
```

**Optimal execution:**
1. Start 6A and 6B in parallel (backend).
2. Once both are done → start 6C and 6D in parallel (frontend).
3. 6D extends the component structure set up in 6C — they can work on separate files simultaneously.

**Estimated time:** 2–3 days

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingDetail.ts` | Created (getMeetingDetail query) | 6A |
| `convex/closer/meetingActions.ts` | Created (updateMeetingNotes, startMeeting, markAsLost) | 6B |
| `app/workspace/closer/meetings/[meetingId]/page.tsx` | Created (meeting detail page) | 6C |
| `app/workspace/closer/meetings/_components/lead-info-panel.tsx` | Created | 6C |
| `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` | Created | 6C |
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | Created | 6C |
| `app/workspace/closer/meetings/_components/payment-links-panel.tsx` | Created | 6C |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | Created | 6C + 6D |
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | Created | 6D |
| `app/workspace/closer/meetings/_components/meeting-history-timeline.tsx` | Created | 6C |

---

*End of Phase 6. Next: Phase 7 (Payment Logging & Follow-Up Scheduling) — the final phase.*
