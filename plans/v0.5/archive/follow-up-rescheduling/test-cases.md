# Follow-Up & Rescheduling — Test Cases

**Feature:** v0.5 Follow-Up & Rescheduling Overhaul
**Date:** 2026-04-10
**Method:** Convex CLI backend validation + Expect browser verification
**Prerequisite:** All 5 phases deployed, `npx convex dev` and `pnpm dev` running

> **Mandatory workflow per TESTING.MD:** Convex CLI validation FIRST (terminal only), THEN browser verification via Expect. Never skip CLI checks. Never use `npx convex dashboard`.

---

## Table of Contents

1. [Test Data Setup](#1-test-data-setup)
2. [Backend Validation (Convex CLI)](#2-backend-validation-convex-cli)
3. [TC-A: Follow-Up Dialog — Path Selection](#3-tc-a-follow-up-dialog--path-selection)
4. [TC-B: Follow-Up Dialog — Scheduling Link Path](#4-tc-b-follow-up-dialog--scheduling-link-path)
5. [TC-C: Follow-Up Dialog — Manual Reminder Path](#5-tc-c-follow-up-dialog--manual-reminder-path)
6. [TC-D: Reminders Dashboard Section](#6-tc-d-reminders-dashboard-section)
7. [TC-E: Personal Event Type Assignment (Admin)](#7-tc-e-personal-event-type-assignment-admin)
8. [TC-F: Pipeline UTM Intelligence](#8-tc-f-pipeline-utm-intelligence)
9. [TC-G: Authorization & Role Guards](#9-tc-g-authorization--role-guards)
10. [TC-H: Responsive Design](#10-tc-h-responsive-design)
11. [TC-I: Accessibility Audit](#11-tc-i-accessibility-audit)
12. [TC-J: Performance Metrics](#12-tc-j-performance-metrics)
13. [Completion Checklist](#13-completion-checklist)

---

## 1. Test Data Setup

### 1.1 Known State

The following is already configured in the test deployment and does **not** need to be set up:

| User | Email | `personalEventTypeUri` |
|---|---|---|
| Closer 1 | `vas.claudio15+closer1@icloud.com` | `https://calendly.com/vas-claudio15-closer1/closer-1-meeting` ✓ |
| Closer 2 | `vas.claudio15+closer2@icloud.com` | *(not assigned)* |
| Admin | `vas.claudio15+tenantowner@icloud.com` | n/a |

Password: `grep TEST_USERS_PASSWORD .env.local`

> **Do not assign a `personalEventTypeUri` to closer2 before running TC-B3**, which requires closer2 to have none. TC-E2 assigns one to closer2 — run it after TC-B3.

### 1.2 Verify Known State via CLI

Before running any tests, confirm the known state is intact:

```bash
# Verify closer1 has personalEventTypeUri, closer2 does not
npx convex data users
# Expected for closer1: personalEventTypeUri = "https://calendly.com/vas-claudio15-closer1/closer-1-meeting"
# Expected for closer2: personalEventTypeUri field absent or undefined
```

### 1.3 Seed Meetings via Convex CLI

Minimum 3 meetings are required — at least one assigned to **each closer** — so both scheduling link and no-event-type paths can be tested.

```bash
# 1. Find tenant ID
npx convex data tenants

# 2. Find event type
npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'

# 3. Book 3+ meetings with unused lead emails
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead10@icloud.com",
  "inviteeName":"Follow-Up Test Lead A",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005550010",
  "questionAnswers":{"Phone Number":"+15005550010"}
}'

# Repeat with +lead11 and +lead12 to cover both closers (round-robin assignment)
```

After booking, check which closer each meeting was assigned to:

```bash
npx convex data opportunities
# Read assignedCloserId — cross-reference with npx convex data users to map to closer1/closer2
```

Book additional meetings until **both** closers have at least one.

### 1.4 Prepare Opportunity Statuses

The follow-up dialog only appears for opportunities in `in_progress`, `canceled`, or `no_show`. After meetings are booked (`status: "scheduled"`), transition at least:

- **1 opportunity assigned to closer1** → `in_progress` (for TC-B: scheduling link happy path)
- **1 opportunity assigned to closer2** → `in_progress` or `canceled` (for TC-B3 and TC-C: reminder path + no-event-type error)

Do this by signing into the app as each closer, opening the meeting detail page, and using the meeting outcome controls to transition.

---

## 2. Backend Validation (Convex CLI)

> **Run ALL checks below in the terminal before any browser testing.**

### 2.1 Schema Verification

```bash
# Verify followUps table has new fields
npx convex data followUps --limit 5
# Expected: type, contactMethod, reminderScheduledAt, reminderNote, completedAt
#   fields exist (may be undefined on pre-feature records — that is correct)

# Verify users table has personalEventTypeUri
npx convex data users
# Expected: closer1 has personalEventTypeUri set; closer2 does not
```

### 2.2 Permissions Verification

Grep the source — these are code checks, not CLI:

- `team:assign-event-type` in `convex/lib/permissions.ts`
- `follow-up:create` in `convex/lib/permissions.ts`
- `follow-up:complete` in `convex/lib/permissions.ts`

### 2.3 Function Availability

```bash
# Each call should fail with an auth error — NOT "function not found"
npx convex run closer/followUpMutations:createSchedulingLinkFollowUp '{"opportunityId":"placeholder"}'
npx convex run closer/followUpMutations:createManualReminderFollowUpPublic '{"opportunityId":"placeholder","contactMethod":"call","reminderScheduledAt":9999999999999}'
npx convex run closer/followUpMutations:markReminderComplete '{"followUpId":"placeholder"}'
npx convex run closer/followUpQueries:getActiveReminders '{}'
```

---

## 3. TC-A: Follow-Up Dialog — Path Selection

**Goal:** Verify the dialog opens with the two-card selection UI and navigates correctly between paths.

**Sign in as:** Either closer — use whichever has an eligible (`in_progress`, `canceled`, or `no_show`) opportunity available.

### TC-A1: Dialog Opens with Path Selection

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to a meeting detail page where the opportunity is `in_progress` | Page loads; "Schedule Follow-up" button visible in the OutcomeActionBar |
| 2 | Click "Schedule Follow-up" | Dialog opens with title "Schedule Follow-up" |
| 3 | Take ARIA snapshot | Two cards visible: "Send Link" and "Set Reminder" |
| 4 | Verify "Send Link" card | Title: "Send Link" · Description: "Generate a scheduling link for the lead to book their next appointment." |
| 5 | Verify "Set Reminder" card | Title: "Set Reminder" · Description: "Set a reminder to call or text the lead at a specific time." |

### TC-A2: Path Navigation — Forward and Back

| Step | Action | Expected Result |
|---|---|---|
| 1 | Click "Send Link" card | Dialog title changes to "Send Scheduling Link"; "Back" button appears |
| 2 | Click "Back" | Returns to path selection; title reverts to "Schedule Follow-up" |
| 3 | Click "Set Reminder" card | Dialog title changes to "Set a Reminder"; "Back" button appears |
| 4 | Click "Back" | Returns to path selection |

### TC-A3: Dialog Resets on Close/Reopen

| Step | Action | Expected Result |
|---|---|---|
| 1 | Click "Set Reminder" card | Reminder form shown |
| 2 | Close dialog (click overlay or press Escape) | Dialog closes |
| 3 | Reopen dialog by clicking "Schedule Follow-up" | Dialog opens at path selection — not the previously selected path |

### TC-A4: Keyboard Accessibility on Path Selection Cards

| Step | Action | Expected Result |
|---|---|---|
| 1 | Open the follow-up dialog | Path selection cards visible |
| 2 | Tab to the "Send Link" card | Card receives a visible focus ring |
| 3 | Press Enter | Navigates to scheduling link form |
| 4 | Click "Back" | Returns to path selection |
| 5 | Tab to the "Set Reminder" card | Card receives a visible focus ring |
| 6 | Press Space | Navigates to reminder form |

---

## 4. TC-B: Follow-Up Dialog — Scheduling Link Path

**Goal:** Verify the scheduling link generation flow — happy path, URL correctness, copy, and error state when no event type is configured.

### TC-B1: Scheduling Link — Happy Path

**Sign in as: closer1** (`vas.claudio15+closer1@icloud.com`) — the only closer with a `personalEventTypeUri`.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to a meeting detail page where closer1's opportunity is `in_progress` | "Schedule Follow-up" button visible |
| 2 | Click "Schedule Follow-up", then "Send Link" card | "Send Scheduling Link" view with description: "Generate a personal scheduling link for this lead. Copy and share it via WhatsApp, SMS, or email." |
| 3 | Click "Generate Scheduling Link" | Loading state: spinner + "Creating scheduling link..." text |
| 4 | Wait for mutation to complete | Success state: Alert "Scheduling link generated. Copy and send to the lead." + read-only input with URL + "Copy" button + "Done" button |
| 5 | Verify URL base | URL starts with `https://calendly.com/vas-claudio15-closer1/closer-1-meeting?` |
| 6 | Verify UTM params present | URL contains all of: `utm_source=ptdom`, `utm_medium=follow_up`, `utm_campaign=<opportunityId>`, `utm_content=<followUpId>`, `utm_term=<userId>` |
| 7 | Click "Copy" button | Button icon changes to checkmark; toast "Scheduling link copied to clipboard" appears |
| 8 | Click "Done" | Dialog closes |

### TC-B2: Scheduling Link — Backend State Verification (CLI)

Run immediately after TC-B1:

```bash
npx convex data followUps --limit 3
# Expected: New record with:
#   type = "scheduling_link"
#   status = "pending"
#   schedulingLinkUrl starts with "https://calendly.com/vas-claudio15-closer1/closer-1-meeting?"
#   schedulingLinkUrl contains utm_source=ptdom

npx convex data opportunities
# Expected: The opportunity used in TC-B1 now has status = "follow_up_scheduled"
```

### TC-B3: Scheduling Link — No Personal Event Type Error

**Sign in as: closer2** (`vas.claudio15+closer2@icloud.com`) — no `personalEventTypeUri` assigned.

> **Run this before TC-E2**, which assigns a URL to closer2. Once TC-E2 runs, this test can no longer be reproduced without removing the URL.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to a meeting detail page where closer2's opportunity is eligible (`in_progress`, `canceled`, or `no_show`) | "Schedule Follow-up" button visible |
| 2 | Click "Schedule Follow-up", then "Send Link" card | Scheduling link form shown |
| 3 | Click "Generate Scheduling Link" | Mutation fires; returns error |
| 4 | Error state renders | Destructive Alert with message: "No personal calendar configured. Ask your admin to assign one in Team settings." |
| 5 | Verify "Try Again" and "Cancel" buttons visible | Both buttons present |
| 6 | Click "Cancel" | Dialog closes |
| 7 | Verify opportunity status unchanged (CLI) | `npx convex data opportunities` — status is still `in_progress`, not `follow_up_scheduled` |

### TC-B4: Scheduling Link — Button Hidden When Already in Follow-Up

**Precondition:** Use the opportunity from TC-B1, which is now in `follow_up_scheduled` status.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to the meeting detail page from TC-B1 | Page loads |
| 2 | Inspect the OutcomeActionBar | "Schedule Follow-up" button is NOT visible (follow-up already created; status is `follow_up_scheduled`) |

---

## 5. TC-C: Follow-Up Dialog — Manual Reminder Path

**Goal:** Verify the reminder creation form — validation, submission, and toggle behaviour.

**Sign in as: closer2** — use an eligible opportunity (`in_progress`, `canceled`, or `no_show`). Closer2's opportunity works here because the reminder path does not require `personalEventTypeUri`.

### TC-C1: Manual Reminder — Happy Path

| Step | Action | Expected Result |
|---|---|---|
| 1 | Open follow-up dialog on an eligible opportunity, click "Set Reminder" | Reminder form visible: Contact Method toggle (Call selected by default), Date input, Time input, Note textarea |
| 2 | Verify "Contact Method *" label and default | ToggleGroup shows "Call" (PhoneIcon) and "Text" (MessageSquareIcon); "Call" is active |
| 3 | Click "Text" | "Text" becomes active |
| 4 | Enter a future date in "Date *" | Accepted (input `min` prevents past dates) |
| 5 | Enter a time in "Time *" | Accepted |
| 6 | Enter "Ask about scheduling availability" in "Note (optional)" | Text entered |
| 7 | Click "Set Reminder" | Button shows "Creating..."; on success: toast "Reminder created" appears; dialog closes |

### TC-C2: Manual Reminder — Backend State Verification (CLI)

Run immediately after TC-C1:

```bash
npx convex data followUps --limit 3
# Expected: New record with:
#   type = "manual_reminder"
#   status = "pending"
#   contactMethod = "text"
#   reminderScheduledAt = <Unix ms of the date/time entered>
#   reminderNote = "Ask about scheduling availability"

npx convex data opportunities
# Expected: The opportunity used in TC-C1 now has status = "follow_up_scheduled"
```

### TC-C3: Manual Reminder — Validation Errors

| Step | Action | Expected Result |
|---|---|---|
| 1 | Open reminder form | Form fields visible |
| 2 | Leave "Date *" empty, click "Set Reminder" | Inline error: "Date is required" below the Date field |
| 3 | Fill in a date but leave "Time *" empty, click "Set Reminder" | Inline error: "Time is required" below the Time field |
| 4 | Enter today's date and a time in the past, click "Set Reminder" | Error: "Reminder time must be in the future." shown as destructive Alert |

### TC-C4: Manual Reminder — Contact Method Toggle Behaviour

| Step | Action | Expected Result |
|---|---|---|
| 1 | Open reminder form | "Call" is active by default |
| 2 | Click "Text" | "Text" becomes active; "Call" deselects |
| 3 | Click "Call" | "Call" reselects; "Text" deselects |
| 4 | Click the already-active option | Stays active — cannot deselect both (`onValueChange` guard) |

---

## 6. TC-D: Reminders Dashboard Section

**Goal:** Verify the reminders section appears on the closer dashboard, cards display correctly, urgency escalates in real time, and "Mark Complete" works.

**Sign in as: closer2** (has reminders from TC-C1). For urgency state testing, seed 3 reminders with varying `reminderScheduledAt` values: one future, one at approximately now, one past.

### TC-D1: Reminders Section — Renders When Reminders Exist

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to closer dashboard (`/workspace/closer`) | Dashboard loads |
| 2 | Locate "Reminders" section — it should appear between the Featured Meeting Card and the Pipeline Strip | Section visible with BellIcon, "Reminders" heading, and count Badge |
| 3 | Verify count badge value | Badge shows the number of active reminders (e.g., "1" or "3") |
| 4 | Verify card grid is present | One or more reminder cards rendered |

### TC-D2: Reminder Card — Content Verification

Inspect the card created in TC-C1 ("Ask about scheduling availability", method: Text):

| Step | Action | Expected Result |
|---|---|---|
| 1 | Identify the card by lead name | CardTitle shows the lead's name |
| 2 | Inspect the badge | Shows "Text" with MessageSquareIcon + separator " · " + urgency label ("Due" / "Now" / "Overdue") |
| 3 | Verify phone number | Phone number displayed prominently as a `tel:` link (font-semibold, text-primary color) |
| 4 | Verify scheduled time | Formatted date/time (e.g., "Apr 12, 2026, 2:30 PM") |
| 5 | Verify note | "Ask about scheduling availability" visible, clamped to 2 lines |
| 6 | Verify button | "Mark Complete" button with CheckCircleIcon |

### TC-D3: Urgency Visual Escalation

Requires 3 reminders with different `reminderScheduledAt` values. Seed directly in the Convex dashboard or via the dialog multiple times:

| Reminder State | Expected Card Border + Background | Expected Badge Variant + Label |
|---|---|---|
| `reminderScheduledAt` > now (future) | Default border only (`border-border`, no background tint) | `secondary` · "Call · Due" or "Text · Due" |
| `reminderScheduledAt` within ≤60s of now | Amber border + amber background tint (`border-amber-500 bg-amber-50`, `dark:bg-amber-950/20`) | `outline` · "Call · Now" or "Text · Now" |
| `reminderScheduledAt` > 60s in the past | Red border + red background tint (`border-red-500 bg-red-50`, `dark:bg-red-950/20`) | `destructive` · "Call · Overdue" or "Text · Overdue" |

> Urgency recalculates on a 30-second client-side tick. To observe the amber → red transition live: set `reminderScheduledAt` to ~30 seconds from now, reload, then wait without refreshing. The card border should shift from amber to red within 90 seconds.

### TC-D4: Mark Complete — Happy Path

| Step | Action | Expected Result |
|---|---|---|
| 1 | Click "Mark Complete" on a reminder card | Button becomes disabled and shows "Completing..." |
| 2 | Wait for mutation to complete | Toast "Reminder marked as complete" appears |
| 3 | Card disappears from the grid | Convex subscription auto-removes it (no page refresh needed) |
| 4 | Count badge decrements | Badge reflects the new count |
| 5 | If that was the last reminder | "Reminders" section disappears entirely |

### TC-D5: Mark Complete — Backend Verification (CLI)

```bash
npx convex data followUps --limit 5
# Expected: The completed follow-up record has:
#   status = "completed"
#   completedAt = <Unix ms timestamp>
```

### TC-D6: Reminders Section — Hidden When Empty

**Sign in as: closer1** — who has no manual reminders (all their follow-ups are scheduling links).

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to closer1's dashboard (`/workspace/closer`) | Dashboard loads normally |
| 2 | Verify no "Reminders" section | No "Reminders" heading, no BellIcon, no reminder cards — section returns null |
| 3 | Verify no CLS | Pipeline Strip renders immediately after Featured Meeting Card; no layout shift where the section would be |

---

## 7. TC-E: Personal Event Type Assignment (Admin)

**Goal:** Verify admin can see, assign, and change personal event type URLs for closers via the Team page.

**Sign in as:** `vas.claudio15+tenantowner@icloud.com` (tenant_master)

> **Run TC-B3 before TC-E2.** TC-E2 assigns a URL to closer2, which would prevent TC-B3 from testing the no-event-type error path.

### TC-E1: Team Table — Column Shows Known State

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to Team page (`/workspace/team`) | Team members table loads |
| 2 | Verify "Personal Event Type" column header | Column present after "Calendly Status" |
| 3 | Closer1 row | Cell shows `https://calendly.com/vas-claudio15-closer1/closer-1-meeting` (truncated to 200px max-width) |
| 4 | Closer2 row | Cell shows "Not assigned" in amber text |
| 5 | Admin/owner row | Cell shows "—" |

### TC-E2: Assign Event Type to Closer2

> **Precondition:** TC-B3 has already been run. Closer2 currently has no `personalEventTypeUri`.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Click the Actions dropdown on closer2's row | Dropdown opens |
| 2 | Verify menu item text | "Assign Event Type" (not "Change") |
| 3 | Click "Assign Event Type" | Dialog opens with title "Assign Personal Event Type" |
| 4 | Verify dialog description | "Enter the Calendly booking page URL for [closer2's name]. This URL will be used to generate scheduling links for follow-ups." |
| 5 | Verify input label and placeholder | Label: "Calendly Booking URL *" · Placeholder: "https://calendly.com/john-doe/30min" |
| 6 | Enter `https://calendly.com/vas-claudio15-closer2/closer-2-meeting` | Input accepts the value |
| 7 | Click "Assign Event Type" | Button shows "Assigning..."; on success: toast "Event type assigned to [closer2's name]" |
| 8 | Verify table column updates | Closer2's cell now shows the URL instead of "Not assigned" |

### TC-E2 Backend Verification (CLI):

```bash
npx convex data users
# Expected: closer2's document now has:
#   personalEventTypeUri = "https://calendly.com/vas-claudio15-closer2/closer-2-meeting"
```

### TC-E3: Change Event Type for Closer1

Closer1 already has `personalEventTypeUri = "https://calendly.com/vas-claudio15-closer1/closer-1-meeting"`. Verify the change flow pre-fills the current value.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Click the Actions dropdown on closer1's row | Dropdown opens |
| 2 | Verify menu item text | "Change Event Type" (not "Assign") |
| 3 | Click "Change Event Type" | Dialog opens with title "Change Personal Event Type" |
| 4 | Verify input is pre-filled | Input value = `https://calendly.com/vas-claudio15-closer1/closer-1-meeting` |
| 5 | Verify submit button text | "Update Event Type" |
| 6 | Change URL to `https://calendly.com/vas-claudio15-closer1/closer-1-meeting-updated` | Input updated |
| 7 | Click "Update Event Type" | Success toast; dialog closes; column shows new URL |
| 8 | **Restore original URL** — reopen dialog, enter `https://calendly.com/vas-claudio15-closer1/closer-1-meeting`, submit | Column reverts to original URL (keeps TC-F test data valid) |

### TC-E4: Assignment Dialog — Validation Errors

Open the assign dialog for any closer:

| Step | Input | Expected Inline Error |
|---|---|---|
| Submit empty | *(empty)* | "Event type URL is required" |
| Submit plain text | `not-a-url` | "Must be a valid URL" |
| Submit non-Calendly URL | `https://google.com/calendar` | "Must be a Calendly booking page URL (e.g., https://calendly.com/your-name/30min)" |
| Submit valid Calendly URL | `https://calendly.com/someone/30min` | No error — mutation called |

### TC-E5: Non-Closer Rows — No Assignment Action

| Step | Action | Expected Result |
|---|---|---|
| 1 | Open Actions dropdown on the tenant_master row | Dropdown opens |
| 2 | Scan for "Assign Event Type" or "Change Event Type" | Item is absent — action only appears for `role: "closer"` rows |

---

## 8. TC-F: Pipeline UTM Intelligence

**Goal:** Verify that a booking through a scheduling link generated by closer1 correctly relinks to the existing opportunity (no duplicate) and marks the follow-up as `booked`.

**Precondition:** TC-B1 was completed — an opportunity is in `follow_up_scheduled` status with a scheduling link URL containing UTM params, and closer1's `personalEventTypeUri` is restored to `https://calendly.com/vas-claudio15-closer1/closer-1-meeting`.

### TC-F1: Setup — Note the UTM Params

From TC-B2's CLI output, record:
- The `opportunityId` (= `utm_campaign` value in the scheduling link URL)
- The `followUpId` (= `utm_content` value)

```bash
npx convex data followUps --limit 3
# Read: opportunityId, _id (= followUpId), schedulingLinkUrl
```

### TC-F2: Simulate UTM-Linked Booking via CLI

Use the test booking helper with `tracking` params that match the scheduling link:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<closer1EventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead13@icloud.com",
  "inviteeName":"UTM Test Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "tracking":{
    "utm_source":"ptdom",
    "utm_medium":"follow_up",
    "utm_campaign":"<opportunityId>",
    "utm_content":"<followUpId>",
    "utm_term":"<closer1UserId>"
  }
}'
```

### TC-F3: Backend Verification — Deterministic Linking (CLI)

```bash
# 1. Check pipeline logs for Feature A branch execution
npx convex logs --history 50
# Expected sequence:
#   [Pipeline:invitee.created] [Feature A] UTM deterministic linking | opportunityId=<id> ...
#   [Pipeline:invitee.created] [Feature A] Opportunity relinked | ... status=follow_up_scheduled->scheduled
#   [Pipeline:invitee.created] [Feature A] Follow-up marked booked | followUpId=<id>
#   [Pipeline:invitee.created] [Feature A] Deterministic linking complete | meetingId=<id> ...

# 2. Verify opportunity status reverted to "scheduled" (not a new duplicate)
npx convex data opportunities
# Expected: The target opportunity status = "scheduled"
# Expected: NO new duplicate opportunity for the same lead

# 3. Verify follow-up record is now booked
npx convex data followUps --limit 3
# Expected: status = "booked", calendlyEventUri set

# 4. Verify the new meeting is linked to the EXISTING opportunity
npx convex data meetings --limit 3
# Expected: New meeting with opportunityId = <the original opportunityId>, not a new one
```

### TC-F4: UI Verification — Meeting Visible Under Same Opportunity

| Step | Action | Expected Result |
|---|---|---|
| 1 | Sign in as closer1, navigate to closer pipeline | The opportunity from TC-B1 is visible with status "scheduled" (reverted from `follow_up_scheduled`) |
| 2 | Open the opportunity's latest meeting detail page | New meeting linked to the same lead and opportunity — no duplicate opportunity |
| 3 | Verify no extra opportunity was created | Only 1 opportunity for this lead exists |

### TC-F5: UTM Fallback — Invalid Target

```bash
# Book a meeting with utm_source=ptdom but a nonexistent opportunityId
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead14@icloud.com",
  "inviteeName":"UTM Fallback Test",
  "inviteeTimezone":"America/Tegucigalpa",
  "tracking":{
    "utm_source":"ptdom",
    "utm_campaign":"invalidOpportunityId000000000000"
  }
}'

npx convex logs --history 50
# Expected: Warning log:
#   [Pipeline:invitee.created] [Feature A] UTM target invalid | opportunityExists=false ...
# Expected: Normal flow creates a NEW opportunity (not a crash, not silent failure)

npx convex data opportunities
# Expected: New opportunity created for lead14 via normal flow
```

---

## 9. TC-G: Authorization & Role Guards

**Goal:** Verify that each role can only perform actions they are permitted to perform.

### TC-G1: Closer Cannot Assign Event Types

**Sign in as: closer1**

| Step | Action | Expected Result |
|---|---|---|
| 1 | Navigate to `/workspace/team` | Redirected away (closers don't have access to team settings) or page loads but actions are restricted |
| 2 | If the team page renders, open the Actions dropdown on any row | "Assign Event Type" and "Change Event Type" are NOT visible |

### TC-G2: Closer Sees Only Own Reminders

**Requires:** Both closer1 and closer2 have at least 1 active manual reminder each.

| Step | Action | Expected Result |
|---|---|---|
| 1 | Sign in as closer1, navigate to dashboard | Reminders section shows only closer1's reminders |
| 2 | Sign out; sign in as closer2, navigate to dashboard | Reminders section shows only closer2's reminders — not closer1's |

### TC-G3: Closer Cannot Create Follow-Up on Another Closer's Opportunity

**Sign in as: closer1**

| Step | Action | Expected Result |
|---|---|---|
| 1 | Attempt to navigate to a meeting detail page for a meeting assigned to closer2 | Meeting is not visible in closer1's pipeline; if URL is accessed directly, the page either shows an access error or the "Schedule Follow-up" button is absent |
| 2 | If the dialog can be triggered, click "Generate Scheduling Link" | Mutation throws "Not your opportunity"; error Alert shown in dialog |

### TC-G4: Closer Cannot Complete Another Closer's Reminder (CLI)

```bash
# Find a followUpId belonging to closer2
npx convex data followUps --limit 5
# Note a manual_reminder record whose closerId = closer2's userId

# Attempt to mark it complete as closer1 (auth context will be wrong — this is a backend test)
# In practice this is validated by the mutation's closerId check
# Confirm: followUp.closerId !== userId → throws "Not your follow-up"
```

---

## 10. TC-H: Responsive Design

**Goal:** Verify all new UI elements render correctly at 4 viewports.

Viewports: **375×812** (mobile), **768×1024** (tablet), **1280×800** (laptop), **1440×900** (desktop)

### TC-H1: Follow-Up Dialog — Path Selection Cards

| Viewport | Expected |
|---|---|
| 375px | Cards stack vertically (1 column); dialog fits without horizontal overflow |
| 768px+ | Cards side by side (2 columns via `sm:grid-cols-2`); date/time fields side by side in reminder form |

Steps at each viewport:
1. Open dialog → screenshot path selection
2. Click "Set Reminder" → screenshot form layout
3. Verify no horizontal scroll bar

### TC-H2: Reminders Section — Grid Layout

| Viewport | Expected Grid |
|---|---|
| 375px | 1 column (`grid-cols-1`) |
| 768px | 2 columns (`sm:grid-cols-2`) |
| 1280px+ | 3 columns (`lg:grid-cols-3`) |

Steps at each viewport:
1. Navigate to closer dashboard with reminders present
2. Screenshot the reminders section
3. Count columns; verify phone number text is not truncated or overflowing

### TC-H3: Team Table — Event Type Column

| Viewport | Expected |
|---|---|
| 375px | Table may scroll horizontally; "Personal Event Type" column visible when scrolled |
| 768px+ | Column visible without scrolling; URL text truncated at `max-w-[200px]` with ellipsis |

### TC-H4: Event Type Assignment Dialog

| Viewport | Expected |
|---|---|
| 375px | Dialog fills viewport width; input and button stack correctly; no overflow |
| 768px+ | Dialog constrained to `sm:max-w-md`; input takes full dialog width |

---

## 11. TC-I: Accessibility Audit

**Goal:** Zero critical or serious WCAG violations on all affected pages.

### TC-I1: Pages to Audit

| Page | URL / State | Key Elements |
|---|---|---|
| Meeting Detail (follow-up trigger) | `/workspace/closer/meetings/[id]` | "Schedule Follow-up" button accessible |
| Follow-Up Dialog — Path Selection | Dialog open on meeting detail | Cards have `role="button"`, `tabIndex={0}`, focus rings |
| Follow-Up Dialog — Scheduling Link Form | After clicking "Send Link" | Labels, alerts have ARIA roles |
| Follow-Up Dialog — Reminder Form | After clicking "Set Reminder" | All fields labelled, required fields indicated, ToggleGroup accessible |
| Closer Dashboard — Reminders Section | `/workspace/closer` | Heading hierarchy, `tel:` links, badge not color-only |
| Team Page — Event Type Column | `/workspace/team` | Table headers, amber "Not assigned" readable without color |
| Event Type Assignment Dialog | Dialog open on team page | Label association, error announcements, focus management |

### TC-I2: Specific Element Checks

| Element | Check | Pass Condition |
|---|---|---|
| Path selection cards | `role="button"` | Announced as interactive buttons |
| Path selection cards | `tabIndex={0}` | Reachable by Tab key |
| Path selection cards | Focus ring on `:focus` | Visible outline; not hidden by CSS |
| Urgency badge | Text label alongside color | "Due" / "Now" / "Overdue" conveyed in text, not color alone |
| Phone `tel:` link | Link text = phone number | Screen reader reads the actual number |
| "Mark Complete" button | Accessible name | "Mark Complete" or "Completing..." announced correctly |
| ToggleGroup (Call/Text) | `aria-label` on items | "Call" and "Text" announced by name |
| Date / Time inputs | Labels associated | `<FormLabel>` linked via htmlFor |

---

## 12. TC-J: Performance Metrics

**Goal:** No Core Web Vital rated "poor" on any affected page.

### TC-J1: Pages to Measure

| Page | URL | Key Concern |
|---|---|---|
| Closer Dashboard | `/workspace/closer` | `useQuery` subscription + 30s `setInterval` from RemindersSection — verify no LCP/INP regression |
| Meeting Detail | `/workspace/closer/meetings/[id]` | Follow-up button render — verify no CLS |
| Team Page | `/workspace/team` | Extra "Personal Event Type" column — verify no layout shift or horizontal overflow at 1440px |

### TC-J2: Acceptable Thresholds

| Metric | Good | Needs Improvement | Poor (Failure) |
|---|---|---|---|
| FCP | ≤ 1.8s | ≤ 3.0s | > 3.0s |
| LCP | ≤ 2.5s | ≤ 4.0s | > 4.0s |
| CLS | ≤ 0.1 | ≤ 0.25 | > 0.25 |
| INP | ≤ 200ms | ≤ 500ms | > 500ms |
| TTFB | ≤ 800ms | ≤ 1800ms | > 1800ms |

Any "Poor" rating is a hard failure — investigate and fix before marking the suite as passed.

### TC-J3: Specific Concerns

| Concern | How to Verify |
|---|---|
| 30s `setInterval` in RemindersSection | `performance_metrics` — check for Long Animation Frames (LoAF) with `blockingDuration > 150ms` triggered by the urgency tick |
| Dialog path switching | Toggle between "Send Link" and "Set Reminder" paths — CLS should remain 0 |
| Team table extra column | At 1440px viewport — no horizontal scrollbar; CLS on column load ≤ 0.1 |

---

## 13. Completion Checklist

> All gates must pass before the feature is considered tested.

### Backend Validation (Convex CLI)

- [ ] Schema deployed: new fields present on `followUps` and `users` tables
- [ ] `by_tenantId_and_closerId_and_status` index visible
- [ ] Permissions registered (`team:assign-event-type`, `follow-up:create`, `follow-up:complete`)
- [ ] All 4 new functions callable (auth errors, not "not found")
- [ ] Scheduling link follow-up record created correctly (TC-B2)
- [ ] Manual reminder follow-up record created correctly (TC-C2)
- [ ] Opportunity status transitions verified for both paths
- [ ] Mark complete transitions follow-up to `completed` with `completedAt` set (TC-D5)
- [ ] UTM linking logs confirmed; no duplicate opportunity created (TC-F3)

### Browser — Follow-Up Dialog (TC-A, TC-B, TC-C)

- [ ] TC-A1: Two-card path selection renders
- [ ] TC-A2: Forward/back navigation
- [ ] TC-A3: Dialog resets on close/reopen
- [ ] TC-A4: Keyboard accessible cards (Enter + Space)
- [ ] TC-B1: closer1 — scheduling link happy path (URL starts with `https://calendly.com/vas-claudio15-closer1/closer-1-meeting?`, all UTM params present, copy works)
- [ ] TC-B3: closer2 — "No personal calendar configured" error on scheduling link path
- [ ] TC-B4: "Schedule Follow-up" button absent when opportunity is `follow_up_scheduled`
- [ ] TC-C1: closer2 — reminder happy path (method toggle, date/time, note, toast)
- [ ] TC-C3: Validation errors (empty fields, past date)
- [ ] TC-C4: Contact method toggle cannot be fully deselected

### Browser — Reminders Dashboard (TC-D)

- [ ] TC-D1: Section renders with heading, count badge, card grid
- [ ] TC-D2: Card shows lead name, phone `tel:` link, method badge, time, note, button
- [ ] TC-D3: Urgency styles correct for future / amber / red states
- [ ] TC-D4: Mark Complete — loading state, toast, card removal, badge decrement
- [ ] TC-D5: Backend confirms `status="completed"` and `completedAt` set
- [ ] TC-D6: Section absent for closer with no active reminders

### Browser — Personal Event Type (TC-E)

- [ ] TC-E1: closer1 shows assigned URL; closer2 shows "Not assigned"; admin shows "—"
- [ ] TC-E2: Assign to closer2 — dialog, validation, toast, column update (run after TC-B3)
- [ ] TC-E3: Change for closer1 — pre-fills current URL, button says "Update Event Type", original URL restored after test
- [ ] TC-E4: Validation errors (empty, invalid URL, non-Calendly)
- [ ] TC-E5: Admin/owner row has no assign action in dropdown

### Pipeline UTM (TC-F)

- [ ] TC-F3: Deterministic linking logs appear; opportunity back to "scheduled"; follow-up "booked"; no duplicate opportunity
- [ ] TC-F4: UI shows meeting under original opportunity
- [ ] TC-F5: Invalid UTM target falls through gracefully; new opportunity created by normal flow

### Authorization (TC-G)

- [ ] TC-G1: Closer cannot see event type assign action on team page
- [ ] TC-G2: Each closer sees only their own reminders
- [ ] TC-G3: Closer cannot create follow-up on another closer's opportunity

### Responsive Design (TC-H)

- [ ] TC-H1: Follow-up dialog at 375px and 768px+
- [ ] TC-H2: Reminder grid 1 col / 2 col / 3 col at correct breakpoints
- [ ] TC-H3: Team table event type column at 375px and 768px+
- [ ] TC-H4: Assignment dialog at 375px and 768px+

### Quality Gates (Required Before Done)

- [ ] `accessibility_audit` — zero critical/serious violations on all 7 pages listed in TC-I1
- [ ] `performance_metrics` — no Core Web Vital rated "poor" on dashboard, meeting detail, and team page
- [ ] `console_logs(type='error')` — zero console errors on all affected pages
- [ ] Screenshots at all 4 viewports: 375, 768, 1280, 1440
- [ ] Dark mode verified: urgency tints, amber "Not assigned" text, dialog backgrounds
- [ ] `close` called to flush session recordings

---

## Execution Notes

### Mandatory Test Order

```
1.  CLI: Verify known state (§2) — closer1 has URL, closer2 does not
2.  CLI: Seed meetings (§1.3) — 3+ meetings, both closers assigned
3.  CLI: Verify seeding (npx convex data opportunities + meetings)
4.  Transition opportunities to in_progress (browser, 1 per closer)
5.  Sign in as closer2 → TC-A (path selection — works on either closer)
6.  Sign in as closer2 → TC-B3 (no event type error — must be before TC-E2)
7.  Sign in as closer2 → TC-C (reminder creation)
8.  Sign in as closer2 → TC-D (reminders dashboard — uses reminders from TC-C)
9.  Sign in as closer1 → TC-B (scheduling link — requires personalEventTypeUri)
10. Sign in as admin  → TC-E (event type assignment — TC-E2 assigns to closer2; TC-E3 changes+restores closer1)
11. CLI: TC-F (UTM pipeline — book with tracking params, verify logs)
12. Sign in as closer1 → TC-F4 (UI verification of UTM relinking)
13. TC-G (authorization — sign in as various roles)
14. TC-H (responsive — 4 viewports for all dialogs/sections)
15. TC-I (accessibility audit — 7 pages)
16. TC-J (performance metrics — 3 pages)
17. Dark mode pass
18. `close` session
```

### Critical Ordering Dependencies

| Constraint | Reason |
|---|---|
| TC-B3 before TC-E2 | TC-B3 requires closer2 to have no `personalEventTypeUri`; TC-E2 assigns one |
| TC-C before TC-D | TC-D needs active reminders to be present; TC-C creates them |
| TC-B1 before TC-F | TC-F uses the follow-up record and opportunity created in TC-B1 |
| TC-E3 restores URL | If not restored, TC-F and subsequent scheduling link tests for closer1 use a wrong URL |
| TC-D4 runs last in TC-D | Mark Complete removes the reminder card; run other TC-D checks first |
