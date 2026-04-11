# Frontend Implementation Plan — Phases 1–4
## Closer Unavailability & Workload Redistribution

**Status:** Planning for implementation  
**Backend Status:** ✅ Complete (Phases 1–4 backend scaffold deployed)  
**Frontend Status:** 🚧 Ready for implementation  
**Prerequisite:** Backend foundation stable; `npx convex dev --once` passes; no breaking changes expected to API shapes  

---

## Overview

The backend is complete with all tables, permissions, queries, and mutations in place. Frontend implementation must be completed in phase order because later phases depend on earlier query/mutation shapes and UI components.

**Frontend Dependency Graph:**
```
Phase 2A (Availability Mark Dialog) ──┐
                                        ├── Phase 2B (Query affected meetings)
                                        │
Phase 2C (Create unavailability mutation) ──┤
                                        │
Phase 2D (Deploy & verify) ────────────┘

Phase 3A (Available Closers query UI) ──┐
                                        ├── Phase 3B (Auto-distribution UI)
                                        │
Phase 3C (Redistribution mutations UI) ──┤
                                        │
Phase 3D (Deploy & verify) ──────────────┘

Phase 4A (Meeting detail enrichment) ──┐
                                        ├── Phase 4B (Featured meeting badge)
                                        │
Phase 4C (Admin audit table) ──────────┤
                                        │
Phase 4D (Deploy & verify) ──────────────┘
```

---

## Phase 2 — Mark Unavailable Flow (Frontend)

### 2A — Mark Unavailable Dialog Component

**File:** `app/workspace/team/_components/mark-unavailable-dialog.tsx` (new)

**What:** Create a dialog that allows admins to mark a closer as unavailable. The dialog collects:
- Date picker (single day)
- Radio group: Full day / Partial time range
- If partial: Start time + end time pickers
- Reason dropdown: "sick" | "emergency" | "personal" | "other"
- Optional text note
- Submit button that calls the backend mutation

**Why:** This is the user-facing entry point for the feature. The dialog captures all the data needed to create a `closerUnavailability` record and immediately fetch affected meetings.

**Dependencies:**
- Dialog UI from shadcn
- Date picker from shadcn (calendar)
- Radio group, select, textarea from shadcn
- Zod schema for validation
- React Hook Form for state management
- `api.unavailability.mutations.createCloserUnavailability` (backend mutation already exists)

**Implementation notes:**
- The dialog should be controlled from the parent (TeamPage or TeamMembersTable) via `open` + `onOpenChange` props
- Pass `closerId` as a prop; do NOT accept it as a user input
- Use `useState` for local UI state (dialog open/close)
- Form validation: date must be today or in future; if partial, endTime > startTime
- On successful submission, return `{ unavailabilityId, affectedMeetings }` to parent via callback
- Use Zod schema for client-side validation; backend will re-validate

**Acceptance Criteria:**
1. Dialog renders with all fields (date, full/partial toggle, times, reason, note)
2. Clicking the reason dropdown shows all 4 options with no broken icons/text
3. Partial time range only shows time pickers when "Partial" is selected
4. Form submission calls `createCloserUnavailability` mutation with correct args
5. On success, parent receives callback with unavailability ID and affected meetings count
6. TypeScript compiles without errors

---

### 2B — Affected Meetings Query in Dialog

**File:** `app/workspace/team/_components/mark-unavailable-dialog.tsx` (extend from 2A)

**What:** After the user submits the dialog, query and display the affected meetings within an Alert or collapsible section. Show a summary: "X meetings will be affected on [date]."

**Why:** The user needs confirmation of impact before proceeding. The list is also the input for Phase 3's redistribution wizard.

**Dependencies:**
- `api.unavailability.queries.getUnavailabilityWithMeetings` (already exists)
- Alert/Collapsible UI from shadcn
- Suspend display until query returns

**Implementation notes:**
- Fetch `getUnavailabilityWithMeetings(unavailabilityId)` on successful mutation return
- Display meeting count prominently; optionally show a list (lead name, scheduled time, duration)
- If no affected meetings, show a success message without requiring further action

**Acceptance Criteria:**
1. After form submission, affected meetings are fetched and displayed
2. Meeting list shows: lead name, scheduled time, duration
3. Empty state (no affected meetings) is handled gracefully

---

### 2C — Mark Unavailable Dialog Integration in Team Page

**File:** `app/workspace/team/_components/team-page-client.tsx` (modify)

**What:** Add a "Mark Unavailable" button to each closer row in the TeamMembersTable, triggering the dialog from 2A. The button should only be visible to admins with the `team:manage-availability` permission.

**Why:** Admins need a direct path from the team list to the unavailability flow without navigating elsewhere.

**Dependencies:**
- `TeamMembersTable` component (already exists)
- Mark Unavailable Dialog from 2A
- `useRole()` hook for permission check
- Dialog state management (useState)

**Implementation notes:**
- Add a button cell to the table (or an action column with dropdown menu)
- Button label: "Mark Unavailable"
- Permission gate: `useRole().hasPermission("team:manage-availability")`
- On click, open dialog; pass `closerId` and closer's `fullName` for context
- After successful submission, optionally refresh the team list (or rely on real-time Convex updates)

**Acceptance Criteria:**
1. "Mark Unavailable" button appears in TeamMembersTable for each closer
2. Button is only visible if user has `team:manage-availability` permission
3. Clicking button opens the dialog and focuses the date input
4. Dialog closes and team list updates after successful submission

---

### 2D — Phase 2 Deployment & Verification

**What:** Run `pnpm tsc --noEmit` to verify no type errors, then manually test the flow in a browser.

**Why:** Type safety ensures the integration is correct; browser testing confirms the UI works end-to-end.

**Testing checklist:**
- [ ] Mark Unavailable button renders in team table
- [ ] Dialog opens and all form fields are visible
- [ ] Date picker works (today and future dates selectable)
- [ ] Full-day and Partial toggle switches time picker visibility correctly
- [ ] Reason dropdown shows all 4 options
- [ ] Form validation shows error for invalid time range
- [ ] Submission calls backend mutation and returns affected meetings
- [ ] Affected meetings displayed in a readable format
- [ ] Dialog closes and page remains stable

---

## Phase 3 — Redistribution Wizard (Frontend)

### 3A — Available Closers Query & Display

**File:** `app/workspace/team/_components/redistribution-wizard.tsx` (new)

**What:** After the user marks a closer unavailable and sees affected meetings, query the list of available closers and their workload stats. Display this in a card or table showing: closer name, current workload (meeting count), capacity indicator (e.g., "Low" / "Medium" / "High").

**Why:** The admin needs to see who is available and their capacity before deciding whether to auto-distribute or manually assign.

**Dependencies:**
- `api.unavailability.queries.getAvailableClosersForDate` (already exists)
- Card/Table UI from shadcn
- Workload visualization (optional: progress bar or color-coded badge)

**Implementation notes:**
- Fetch available closers immediately when the dialog/wizard opens
- Filter out the original unavailable closer from the list
- Sort by workload (ascending) — lowest workload first
- Show a skeleton while loading

**Acceptance Criteria:**
1. Available closers list fetches and displays with names and workload
2. Original closer is excluded from the list
3. Workload is visually clear (text label + optional indicator)
4. Skeleton renders while data is loading

---

### 3B — Auto-Distribution UI & Submission

**File:** `app/workspace/team/_components/redistribution-wizard.tsx` (extend from 3A)

**What:** Add a button to "Auto-Distribute Meetings" that calls the backend auto-distribution mutation. Show the result: X meetings assigned, Y unassigned. Display unassigned meetings in a separate list for manual resolution.

**Why:** Most meetings should auto-assign; unassigned ones need manual intervention. The user should see the outcome clearly.

**Dependencies:**
- `api.unavailability.mutations.autoDistributeMeetings` (already exists)
- Alert/Badge components for status display
- Table or list view for unassigned meetings

**Implementation notes:**
- Button is disabled while auto-distribution is in progress
- On success, show a success toast + update the UI to show counts
- Unassigned meetings list shows: lead name, scheduled time, workload reason (why it couldn't be assigned)
- If all meetings auto-assigned, show success message and offer to close the wizard

**Acceptance Criteria:**
1. "Auto-Distribute" button is visible and clickable
2. Mutation is called with correct arguments (unavailabilityId, meeting IDs, available closer IDs)
3. Result shows assigned count and unassigned count
4. Unassigned meetings are listed with reason why they weren't assigned
5. Button is disabled during submission to prevent double-click

---

### 3C — Manual Reassignment UI (Force-Assign)

**File:** `app/workspace/team/_components/redistribution-wizard.tsx` (extend from 3B)

**What:** For unassigned meetings, allow the admin to manually select a target closer and force-assign the meeting. Show a warning if the target closer has a time conflict (overlap), and allow proceeding anyway.

**Why:** Unassignable meetings need resolution; force-assign with overlap warning is better than cancellation in most cases.

**Dependencies:**
- `api.unavailability.mutations.manuallyReassignMeeting` (already exists)
- Dialog or inline form for selecting target closer
- Alert for overlap warnings
- Loading state during submission

**Implementation notes:**
- For each unassigned meeting, show a row with: lead name, time, and a "Reassign" button
- Clicking "Reassign" opens a dropdown to select the target closer
- On selection, check if the target closer has a conflicting meeting (this check is backend-side, but might need a separate query for the warning)
- Show an Alert with: "Warning: {closer} has a meeting at {time}. Proceed anyway?"
- "Confirm" button calls `manuallyReassignMeeting`
- On success, remove the meeting from the unassigned list

**Acceptance Criteria:**
1. Unassigned meetings have a "Reassign" button
2. Clicking "Reassign" opens a dropdown of all closers (including the overloaded ones)
3. Selecting a closer shows a warning if there's a time conflict
4. "Confirm" button calls the backend mutation
5. On success, meeting is removed from unassigned list
6. All unassigned meetings can be resolved before closing the wizard

---

### 3D — Redistribution Wizard Modal & Flow Integration

**File:** `app/workspace/team/_components/mark-unavailable-dialog.tsx` (extend)  
**File:** `app/workspace/team/_components/redistribution-wizard.tsx` (integration point)

**What:** After a closer is marked unavailable and affected meetings are fetched, open a full-page modal or drawer showing the redistribution wizard (3A + 3B + 3C). The wizard guides the admin through: 1) Review available closers, 2) Auto-distribute, 3) Manually resolve unassigned.

**Why:** This is the critical UX flow; it must be clear and guided.

**Implementation notes:**
- The wizard can be a multi-step flow or a single-page view with collapsible sections
- Use a Dialog or Drawer component from shadcn for modal presentation
- Steps: 1) Summary + Available Closers, 2) Auto-Distribute & Unassigned, 3) Manual Resolution, 4) Confirmation
- At the end, show a "Complete" button that closes the wizard and returns to team page
- Use Convex subscriptions (`useQuery` with live updates) if the workload scores change in real-time during the wizard

**Acceptance Criteria:**
1. After marking unavailable, wizard auto-opens
2. All 3 sub-phases are visible and interactive
3. User can proceed through the flow without errors
4. Final confirmation shows summary of all reassignments made
5. Closing wizard returns to team page with updated state

---

### 3E — Phase 3 Deployment & Verification

**Testing checklist:**
- [ ] Wizard opens after marking closer unavailable
- [ ] Available closers list displays correctly
- [ ] Auto-distribute button works and shows correct counts
- [ ] Manual reassignment works for each unassigned meeting
- [ ] Overlap warnings display for time conflicts
- [ ] Completion closes wizard and team page reflects changes
- [ ] No TypeScript errors

---

## Phase 4 — Reassignment Display & Audit Trail (Frontend)

### 4A — Reassigned Badge on Featured Meeting Card

**File:** `app/workspace/closer/_components/featured-meeting-card.tsx` (modify)

**What:** Add a "Reassigned" badge to the FeaturedMeetingCard that appears when the meeting's `reassignedFromCloserId` is set. The badge includes a ShuffleIcon and uses a secondary variant.

**Why:** Reassigned closers need an immediate visual signal on their dashboard that a meeting was transferred to them.

**Implementation notes:**
- The query already returns `meeting.reassignedFromCloserId` (from Phase 4A backend)
- Add badge to the card header, after the meeting time
- Badge should use `variant="secondary"` for a subtle look
- Icon: `ShuffleIcon` from lucide-react
- No action on badge click; purely informational

**Acceptance Criteria:**
1. Badge renders when `reassignedFromCloserId` is set
2. Badge does not render for meetings that were never reassigned
3. Badge shows "Reassigned" label with ShuffleIcon
4. TypeScript compiles without errors

---

### 4B — Reassignment Alert on Meeting Detail Page

**File:** `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` (modify)

**What:** Add an Alert to the meeting detail page header that shows: "This meeting was reassigned to you from {originalCloserName} on {date} — {reason}." The alert only displays when `reassignmentInfo` is present.

**Why:** When a closer views a reassigned meeting, they need full context: who originally owned it, when it was transferred, and why.

**Implementation notes:**
- The query already returns `reassignmentInfo` (from Phase 4A backend)
- Alert should be placed at the top of the page, before the main content
- Use `ShuffleIcon` for visual consistency
- Format date as "MMM d, h:mm a" (e.g., "Apr 10, 2:30 PM")
- Alert is purely informational; no action needed

**Acceptance Criteria:**
1. Alert renders when `reassignmentInfo` is present
2. Alert does not render for meetings that were never reassigned
3. Alert displays all fields: original closer name, reassignment date, reason
4. Date is formatted consistently
5. TypeScript compiles without errors

---

### 4C — Recent Reassignments Audit Table (Admin)

**File:** `app/workspace/team/_components/recent-reassignments.tsx` (new)  
**File:** `app/workspace/team/_components/team-page-client.tsx` (modify)

**What:** Add a "Recent Reassignments" section to the team page that displays a table of the 20 most recent reassignment audit records. Columns: Date, From, To, Lead, Reason, Reassigned By.

**Why:** Admins need visibility into the reassignment history across the team for compliance and troubleshooting.

**Implementation notes:**
- Query: `api.unavailability.queries.getRecentReassignments` (already exists)
- Table from shadcn with sorting/filtering if time permits (optional in v0.5)
- Return `null` if no reassignments exist (don't render empty table)
- Show a loading skeleton while data is fetching
- Reason field can use a Badge component for visual distinction

**Acceptance Criteria:**
1. RecentReassignments component renders in team page
2. Table displays up to 20 reassignment records
3. All columns render: date, from, to, lead, reason, reassigned by
4. Empty state (no reassignments) does not render the component
5. Loading skeleton displays while fetching
6. TypeScript compiles without errors

---

### 4D — Phase 4 Deployment & Verification

**Testing checklist:**
- [ ] Featured meeting card shows "Reassigned" badge for reassigned meetings
- [ ] Badge does not appear for non-reassigned meetings
- [ ] Meeting detail page shows reassignment alert for reassigned meetings
- [ ] Alert does not appear for non-reassigned meetings
- [ ] Admin team page shows recent reassignments table
- [ ] Table displays correct data with all columns
- [ ] Empty state is handled (no table if no reassignments)
- [ ] No TypeScript errors
- [ ] No console errors

---

## Implementation Order & Parallelization

**Recommended execution path:**

1. **Phase 2A + 2C in parallel** — Dialog component and team table integration (independent)
2. **Phase 2B after 2A** — Query integration (depends on dialog submission)
3. **Phase 2D** — Verify Phase 2 end-to-end
4. **Phase 3A** — Available closers UI (can start anytime, independent)
5. **Phase 3B + 3C in parallel** — Auto-distribution and manual reassignment (work on same wizard)
6. **Phase 3E** — Verify Phase 3 end-to-end (depends on 3A, 3B, 3C complete)
7. **Phase 4A + 4B in parallel** — Dashboard badge and meeting detail alert (both depend on backend queries, independent of each other)
8. **Phase 4C** — Admin audit table (independent, can start anytime)
9. **Phase 4D** — Verify Phase 4 end-to-end

**Estimated timeline:** 2–3 days for a single developer; parallelizable to 1–2 days with two developers.

---

## Technical Checklist Before Starting

- [ ] Backend Phase 1–4 is stable and tested (`npx convex dev --once` passes)
- [ ] All new tables exist in Convex dashboard: `closerUnavailability`, `meetingReassignments`
- [ ] Permissions are registered: `team:manage-availability`, `reassignment:execute`, `reassignment:view-all`
- [ ] All mutations and queries are deployed and accessible via `api.*`
- [ ] TypeScript generation is up-to-date: `pnpm tsc --noEmit` passes

---

## QA Strategy (Deferred to Later Step)

Frontend browser validation will be deferred to a later manual step using the `expect` skill:

- Component rendering in different viewports
- Form validation edge cases
- Permission gating behavior
- Real-time Convex subscription updates
- Accessibility (WCAG audit)
- Performance (Core Web Vitals, INP)

---

## Notes

- This plan assumes the backend is stable and no mutations to query shapes are needed
- If backend APIs change, all client-side types will auto-update from `convex/_generated/api`
- Use standard form patterns (React Hook Form + Zod) for all dialogs and forms
- All shadcn components should follow the existing style preset (radix-nova, mist colors)
- Icons: use lucide-react exclusively; ShuffleIcon is used for reassignment visuals throughout
