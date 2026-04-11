# Meeting Detail Enhancements — Testing Strategy

> **Status**: Ready for QA
> **Feature Scope**: Meeting detail page UI enhancements for displaying deal outcomes, payment records, booking attribution, and meeting outcome classification
> **Data Flow**: Meeting + Payments + Opportunity → Meeting Detail Page UI

---

## Overview

The Meeting Detail Enhancements feature adds three new UI sections to the meeting detail page (`/workspace/closer/meetings/[id]`):

1. **Deal Won Card** — Displays payment records when opportunity status is `payment_received`
   - Shows: amount, currency, provider, reference code, recorded timestamp, recorded by, status badge, proof file (image thumbnail + lightbox or PDF download)

2. **Attribution Card** — Displays UTM source tracking and booking type classification
   - Shows: UTM parameters (source, medium, campaign, term, content) from opportunity's first booking
   - Shows: Booking type badge (Organic / Follow-Up / Reschedule) inferred from meeting history
   - Shows: "View original" link to predecessor meeting for Follow-Up/Reschedule

3. **Meeting Outcome Select** — Dropdown for classifying meeting outcomes
   - Options: Interested, Needs more info, Price objection, Not qualified, Ready to buy
   - Auto-saves on selection, shows spinner while saving, reverts on error

---

## Test Data Setup

### Required: 3 meetings with different statuses and states

You need **3 real test bookings** to exercise all card states. Use the internal Convex CLI helpers so the bookings are created programmatically through Calendly's Scheduling API while still producing normal webhooks.

### One-time discovery

```bash
# Find the connected tenant id
npx convex data tenants

# List event types and select the test event type URI
npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'

# Inspect exact custom question names before booking
npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'
```

### Scheduling Constraint: Book at the Current Time

All meetings **must be scheduled into the earliest available slot window**. This is required because:

- The **Deal Won Card** test (Phase 5) requires recording a payment through the closer's OutcomeActionBar — the closer must be able to interact with the meeting immediately.
- **Meeting Outcome Select** (Phase 3) and **Meeting Notes** tests require the meeting detail page to be fully interactive.
- Status transitions (scheduled → payment_received) happen through closer UI actions, not backend-only operations.

Since Calendly uses **round-robin scheduling across 2 closers**, try to schedule at least **2 meetings in the same narrow window** — one goes to closer1, the other to closer2. The 3rd booking goes to whichever closer is next in rotation. This gives both closers active meetings to test, and validates data isolation between closer accounts.

| Lead # | Email                          | Time Slot | UTM Parameters                       | Purpose                          |
| ------ | ------------------------------ | --------- | ----------------------------------- | -------------------------------- |
| 4      | vas.claudio15+lead4@icloud.com | **Now (earliest)** | ?utm_source=google&utm_medium=cpc   | Test Attribution Card (organic) |
| 5      | vas.claudio15+lead5@icloud.com | **Now (earliest)** | ?utm_source=fb&utm_medium=social    | Test Attribution + Outcome      |
| 6      | vas.claudio15+lead6@icloud.com | **Now (earliest)** | ?utm_source=email&utm_medium=direct | Test Deal Won + Payment Flow    |

> **Round-robin expectation:** Bookings 4 and 5 land on different closers. Booking 6 goes to whichever closer is next. After all 3 bookings, confirm the distribution via CLI by checking `assignedCloserId` on each opportunity. Both closers should have at least 1 meeting.

**Before booking**, check leads don't exist:

```bash
npx convex data leads
# Scan for any rows with email "vas.claudio15+lead4@icloud.com"
# If found, increment to lead7, lead8, lead9, etc.
```

### Programmatic booking commands

Lead 4:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead4@icloud.com",
  "inviteeName":"Test Lead 4",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005550004",
  "questionAnswers":{
    "Instagram Handle":"lead4_ig",
    "Phone Number":"+15005550004",
    "Message":"Meeting detail QA 4"
  },
  "tracking":{
    "utm_source":"google",
    "utm_medium":"cpc"
  },
  "windowDays":2
}'
```

Lead 5:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead5@icloud.com",
  "inviteeName":"Test Lead 5",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005550005",
  "questionAnswers":{
    "Instagram Handle":"lead5_ig",
    "Phone Number":"+15005550005",
    "Message":"Meeting detail QA 5"
  },
  "tracking":{
    "utm_source":"fb",
    "utm_medium":"social"
  },
  "windowDays":2
}'
```

Lead 6:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead6@icloud.com",
  "inviteeName":"Test Lead 6",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005550006",
  "questionAnswers":{
    "Instagram Handle":"lead6_ig",
    "Phone Number":"+15005550006",
    "Message":"Meeting detail QA 6"
  },
  "tracking":{
    "utm_source":"email",
    "utm_medium":"direct"
  },
  "windowDays":2
}'
```

If Calendly returns `Missing Calendly scope`, reconnect the tenant once so its OAuth grant includes `availability:read` and `scheduled_events:write`.

---

## Phase 1: Backend Webhook Validation (CLI — Mandatory First)

> **All backend checks use `npx convex run testing/calendly:*` for booking helpers and `npx convex data <table>` for table reads.** Auth-guarded exported queries are not part of this QA flow.

### 1a. Verify Webhooks Arrived with UTM in Payload

After each of the 3 bookings, run:

```bash
npx convex data rawWebhookEvents
# Look at the most recent rows — find the one matching the booking you just made
```

**Check**:
- `eventType: "invitee.created"` ✓
- `processed: true` ✓
- `payload.questions_and_answers` includes any custom form responses ✓
- `payload.tracking` contains UTM params (if UTM was appended to booking URL):
  ```json
  { "utm_source": "google", "utm_medium": "cpc" }
  ```
  ✓

### 1b. Verify Leads Created

```bash
npx convex data leads
# Find the row with email "vas.claudio15+lead4@icloud.com"
```

**Check**:
- Lead record exists ✓
- Has a full name, email, optional phone ✓

### 1c. Verify Opportunities Created with UTM

```bash
npx convex data opportunities
# Find the row whose leadId matches the lead _id from step 1b
```

**Check**:
- Opportunity exists with `status: "scheduled"` ✓
- `utmParams` field is populated (if UTM was in booking URL):
  ```json
  {
    "utm_source": "google",
    "utm_medium": "cpc"
  }
  ```
  ✓
- Note the `_id` and `assignedCloserId` for later steps

### 1d. Verify Meetings Created

```bash
npx convex data meetings
# Find the row whose opportunityId matches the opportunity _id from step 1c
```

**Check**:
- Meeting exists with `status: "scheduled"` ✓
- `scheduledAt` and `durationMinutes` are set ✓
- `utmParams` may be present at meeting level (fallback if opportunity doesn't have it) ✓
- Note the `_id` for use in browser URL: `/workspace/closer/meetings/<meetingId>`

### 1e. Check for Processing Errors

```bash
npx convex logs --history 100
```

**Check**:
- No `[Pipeline]` or `[Calendly]` errors ✓

---

## Phase 2: Meeting Detail Page — Basic Render (Browser)

### 2a. Sign In and Navigate to Closer Dashboard

1. Start dev server: `npm run dev`
2. Visit `http://localhost:3000/sign-in`
3. Sign in as a closer: `vas.claudio15+closer1@icloud.com` + password
4. You should land on closer dashboard (`http://localhost:3000/workspace/closer`)
5. You should see the 3 new meetings listed (created in Phase 1)

**Expected**:
- Dashboard shows "My Pipeline" section with ≥ 3 meetings ✓
- Each meeting shows lead name, status badge, scheduled time ✓

### 2b. Open First Meeting Detail Page (Lead 4 — Organic, with UTM)

1. Click on the first meeting in the pipeline list
2. Navigate to: `http://localhost:3000/workspace/closer/meetings/<meetingId_1>`

**Expected page loads**:
- Lead info panel (name, email, phone) ✓
- Meeting info panel (time, duration, Zoom link if applicable) ✓
- Booking answers card (custom form fields, if any) ✓
- **NEW: Attribution Card** (should be visible) ✓
- **NEW: Meeting Outcome Select** (should be visible) ✓
- Deal Won Card should NOT render (status is `scheduled`, no payments yet) ✓

### 2c. Verify Attribution Card Content — Organic Booking

**Expected Attribution Card shows**:

1. **UTM Parameters section**:
   - Source: `"google"` ✓
   - Medium: `"cpc"` ✓
   - Campaign, Term, Content: (empty, not shown) ✓

2. **Booking Type section**:
   - Badge: `"Organic"` (blue) ✓
   - No "View original" link (this is the first booking for this lead) ✓

### 2d. Verify Meeting Outcome Select

**Expected**:

- Label: `"Outcome"` ✓
- Dropdown shows placeholder: `"Select outcome"` ✓
- Clicking dropdown shows 5 options:
  - Interested ✓
  - Needs more info ✓
  - Price objection ✓
  - Not qualified ✓
  - Ready to buy ✓

---

## Phase 3: Meeting Outcome Select — Interaction & Persistence (UI)

### 3a. Select an Outcome

1. In the Meeting Outcome Select dropdown, select `"Interested"`

**Expected**:
- Spinner appears briefly: `"Saving..."` ✓
- Toast notification: `"Meeting outcome updated"` ✓
- Dropdown value changes to show `"Interested"` badge ✓
- PostHog event captured: `meeting_outcome_set` (check browser console or PostHog dashboard) ✓

### 3b. Change Outcome

1. Click dropdown again, select a different option: `"Price objection"`

**Expected**:
- Spinner appears
- Toast: `"Meeting outcome updated"` ✓
- Dropdown now shows `"Price objection"` badge ✓

### 3c. Test Error Handling

(You'll need to trigger a backend error for this test — optional if mutation reliability is high)

To simulate an error:
1. Open browser DevTools → Network tab
2. Select an outcome (this will trigger the mutation)
3. While the request is in-flight, go offline or block the request
4. The mutation should fail

**Expected**:
- Toast error: `"Failed to update outcome"` (or Convex-specific error message) ✓
- Dropdown reverts to previous value (Convex reactivity) ✓

### 3d. Verify Outcome Persists After Page Refresh

1. Select an outcome (e.g., `"Ready to buy"`)
2. Wait for success toast
3. Refresh the page: `Cmd+R`
4. Page reloads, meeting detail rendered again

**Expected**:
- Dropdown shows the previously selected outcome: `"Ready to buy"` ✓
- Data loaded from backend, not lost ✓

---

## Phase 4: Attribution Card — Follow-Up & Reschedule Scenarios (Advanced)

> This phase tests the booking type inference logic and "View original" link.

### 4a. Create Follow-Up Meeting (Same Lead as Phase 2)

1. Sign out and sign in as admin: `vas.claudio15+tenantowner@icloud.com`
2. Go to admin pipeline: `http://localhost:3000/workspace/pipeline`
3. Find the Lead 4 opportunity (from Phase 2b)
4. Open it (or note the opportunity ID)

Now, create a follow-up meeting for this lead **via Calendly** (not by closing the first meeting):

5. Schedule another booking for **the same lead email** (`vas.claudio15+lead4@icloud.com`) on the same event type
6. Back-end will:
   - Find the existing lead by email (merge mode)
   - Create a new opportunity (linked to same lead)
   - Create a new meeting

**Back-end verification**:

```bash
npx convex data leads
# Find the row with email "vas.claudio15+lead4@icloud.com" — note the _id

npx convex data opportunities
# Find all rows whose leadId matches — should now show 2 opportunities (or 1 with updated meeting refs)

npx convex data meetings
# Find all rows linked to those opportunity _ids — should show 2 meetings
```

### 4b. Open New Meeting (Follow-Up) in Closer View

1. Sign out and sign in as closer: `vas.claudio15+closer1@icloud.com` (or the assigned closer)
2. Dashboard should now show 2+ meetings
3. Open the **new** meeting (the follow-up)

**Expected Attribution Card**:

1. **Booking Type**:
   - Badge: `"Follow-Up"` (violet) ✓
   - "View original" link present ✓

2. **UTM Parameters**:
   - Should show UTM from this new booking (if you appended UTM to the second booking URL) ✓
   - OR fallback to opportunity-level UTM (first booking) if the second booking didn't have UTM ✓

### 4c. Click "View original" Link

1. In the follow-up meeting's Attribution Card, click the "View original" link

**Expected**:
- Navigate to the first meeting's detail page ✓
- URL changes to: `/workspace/closer/meetings/<originalMeetingId>` ✓
- First meeting loads with `"Organic"` booking type badge ✓
- You can navigate back via browser back button ✓

### 4d. Test Reschedule Scenario (Optional)

To test the Reschedule booking type:

1. Go back to the first meeting (original)
2. Simulate marking it as "no_show" or "canceled" (if UI supports it, or skip this test for now since it's not the focus of Phase 2)
3. Create another follow-up booking for the same lead
4. The new meeting should show Attribution Card with:
   - Booking Type: `"Reschedule"` (orange) ✓
   - "View original" link points to the canceled/no_show meeting ✓

---

## Phase 5: Deal Won Card — Payment Recording Workflow (Advanced)

> This phase tests the Deal Won Card and payment proof file handling.

### 5a. Record a Payment on Lead 6's Meeting

1. Sign in as closer: `vas.claudio15+closer1@icloud.com` or the assigned closer
2. Open Lead 6's meeting detail page (created in Phase 1)
3. Find the **Payment Form** (should be an action button or link; may say "Record Payment" or similar)
4. Click it to open the payment form dialog

**Expected**:
- Dialog opens with form fields:
  - Amount (number input) ✓
  - Currency (dropdown, e.g., USD, EUR) ✓
  - Provider (text input, e.g., "Stripe", "Square") ✓
  - Reference Code (optional text input) ✓
  - Proof of Payment (file input) ✓

### 5b. Fill and Submit Payment Form

1. Amount: `1500`
2. Currency: `USD`
3. Provider: `Stripe`
4. Reference Code: `ch_test_12345` (or any string)
5. Proof of Payment: Upload an image file (PNG, JPG) or PDF
6. Click **Save**

**Expected**:
- Form validates and submits ✓
- Toast: `"Payment recorded"` (or success message) ✓
- Dialog closes ✓
- Meeting detail page reloads ✓

### 5c. Verify Deal Won Card Appears

**Expected Deal Won Card renders**:

1. **Card title**: `"Deal Won"` with trophy icon ✓
2. **Payment details grid**:
   - Amount: `$1,500.00` (formatted currency) ✓
   - Provider: `Stripe` ✓
   - Reference: `ch_test_12345` ✓
   - Recorded: timestamp (e.g., `"Apr 10, 2026 at 3:45 PM"`) ✓
   - Recorded By: closer's name ✓
   - Status: `"Recorded"` badge (blue) ✓

3. **Proof of Payment section**:
   - If image was uploaded:
     - Thumbnail image displayed ✓
     - Button: `"Open"` (opens image in lightbox) ✓
   - If PDF was uploaded:
     - File icon displayed ✓
     - Label: `"PDF proof"` ✓
     - Button: `"Download"` (links to file download) ✓

### 5d. Test Image Lightbox

1. Click the proof image thumbnail to open the lightbox

**Expected**:
- Modal dialog opens with full-size image ✓
- Image fills the modal ✓
- Click outside the modal or close button to dismiss ✓

### 5e. Record Multiple Payments (Same Opportunity)

(Advanced: test if the card handles multiple payments correctly)

1. Open the payment form again
2. Record a second payment with different details (e.g., amount `500`, provider `PayPal`)
3. Submit

**Expected**:
- Deal Won Card now shows **2 payment sections** ✓
- Each separated by a horizontal line ✓
- All details (amount, provider, proof) display correctly for each ✓
- Lightbox/download works for each proof file independently ✓

### 5f. Verify Opportunity Status Changed

**Back-end verification**:

```bash
npx convex data opportunities
# Find the row for Lead 6's opportunity (match by leadId)
```

**Check**:
- `status: "payment_received"` ✓ (or the status after payment is recorded)

```bash
npx convex data paymentRecords
# Find payment rows linked to this opportunity
```

**Check**:
- Payment record(s) exist with correct `amount`, `currency`, `provider`, `referenceCode`, `status: "recorded"` ✓

---

## Phase 6: Deal Won Card — Edge Cases (Advanced)

### 6a. Test Card Renders Correctly with No Proof File

1. Record a payment (via API or form) without uploading a proof file
2. Open the meeting detail page

**Expected**:
- Deal Won Card renders all payment fields ✓
- Proof of Payment section is NOT shown (guard: `if (payment.proofFileUrl && ...)`) ✓
- No errors in console ✓

### 6b. Test Card with Large File Size

1. Record a payment with a large proof file (e.g., 5 MB image)
2. Open the meeting detail page

**Expected**:
- File size displayed correctly (e.g., `"4.8 MB"`) ✓
- Thumbnail/icon loads without errors ✓
- Download button works ✓

### 6c. Test Card with Unsupported Currency Code

(Edge case: malformed currency in database)

1. Manually insert a payment with an invalid currency code (e.g., `"ZZZ"`) — requires direct DB access (skip if not feasible)
2. Open the meeting detail page

**Expected**:
- Card still renders ✓
- Fallback currency format: `"ZZZ 1500.00"` (instead of throwing error) ✓

---

## Phase 7: Authorization & Access Control (Advanced)

### 7a. Test Closer Can Only See Their Meetings

1. Sign in as closer1: `vas.claudio15+closer1@icloud.com`
2. Dashboard shows only meetings assigned to closer1 ✓
3. Try to directly navigate to a meeting assigned to closer2:
   - `http://localhost:3000/workspace/closer/meetings/<closer2_meetingId>`

**Expected**:
- Access denied or redirect to closer1's dashboard ✓
- Cannot view closer2's meeting details ✓

### 7b. Test Admin Can See All Meetings

1. Sign in as admin: `vas.claudio15+tenantowner@icloud.com`
2. Navigate to admin pipeline or a specific meeting

**Expected**:
- Can view all meetings across all closers ✓
- All cards render (Attribution, Deal Won, Outcome Select) ✓

### 7c. Test Closer Cannot Modify Other Closer's Data

1. Sign in as closer1
2. Open a meeting assigned to closer2 (if you can navigate to it)
3. Try to change the meeting outcome

**Expected**:
- Mutation fails with auth error ✓
- Toast error message ✓

---

## Phase 8: Responsive Design (Browser)

Test the three new cards at multiple viewport widths:

### 8a. Mobile (375px)

1. Open browser DevTools
2. Set viewport to 375px width
3. Navigate to meeting detail page

**Expected**:
- Attribution Card wraps properly (grid layout adapts) ✓
- Deal Won Card payment details stack vertically ✓
- Meeting Outcome Select fits on-screen ✓
- No horizontal scrolling ✓

### 8b. Tablet (768px)

1. Set viewport to 768px

**Expected**:
- Cards display in a single column (or two-column grid if layout supports it) ✓
- All text readable ✓
- Buttons accessible ✓

### 8c. Desktop (1440px)

1. Set viewport to 1440px

**Expected**:
- Cards display side-by-side if layout supports it ✓
- Full information visible without scrolling (if not too much content) ✓

---

## Phase 9: Performance & Accessibility Audits (Expect Skill)

> Use the Expect MCP tool to run automated checks.

### 9a. Run Accessibility Audit

Invoke the Expect skill or run manually:

```bash
# Using Expect MCP (if available)
# screenshot → accessibility_audit
```

**Check**:
- No critical WCAG violations ✓
- Color contrast ratios meet AA standard ✓
- All interactive elements have proper ARIA labels ✓
- Lightbox dialog has proper focus management ✓

### 9b. Run Performance Metrics

```bash
# Using Expect MCP
# performance_metrics
```

**Check**:
- Core Web Vitals all "good" (LCP < 2.5s, CLS < 0.1, INP < 200ms) ✓
- No Long Animation Frames during interactions ✓

### 9c. Check Console Errors

```bash
# Using Expect MCP
# console_logs type='error'
```

**Check**:
- No errors logged ✓
- No console warnings from React (missing keys, strict mode issues) ✓

---

## Phase 10: Data Persistence & Refresh (Backend)

### 10a. Verify Meeting Outcome Saved

After Phase 3d (selecting and persisting an outcome):

```bash
npx convex data meetings
# Find the meeting row by _id
```

**Check**:
- Meeting record has `meetingOutcome` field set ✓
- Value matches what was selected in UI ✓

### 10b. Verify Payment Saved

After Phase 5c (recording a payment):

```bash
npx convex data paymentRecords
# Find the payment row linked to the opportunity
```

**Check**:
- Payment record includes: `amount`, `currency`, `provider`, `referenceCode`, `status: "recorded"`, `recordedAt`, `proofFileStorageId` ✓

```bash
npx convex data opportunities
# Find Lead 6's opportunity row
```

**Check**:
- `status: "payment_received"` ✓

---

## Rollback & Cleanup

### If tests fail:

1. **Identify failure phase**
2. **Check Convex logs** for backend errors: `npx convex logs --history 100`
3. **Fix code** if needed
4. **Clear test data** (optional):
   - Use new test lead emails (lead7, lead8, etc.)
   - Or manually delete records (not recommended unless familiar with Convex CLI)

### Final cleanup:

- Confirm all 3 new meetings still visible on closer dashboard
- Verify no console errors on meeting detail page
- Note any auth/permission issues for future work

---

## Completion Checklist

- [ ] **Phase 1 (Backend)**: 3 webhooks arrived, leads/opportunities/meetings created, UTM captured, no errors
- [ ] **Phase 2a (Dashboard)**: 3+ meetings visible in closer pipeline
- [ ] **Phase 2b-2c (Attribution Card Organic)**: Card renders with UTM and "Organic" booking type
- [ ] **Phase 2d (Meeting Outcome Select)**: Dropdown renders with 5 options
- [ ] **Phase 3a-3d (Outcome Interaction)**: Select, change, persist, and refresh outcomes
- [ ] **Phase 4a-4d (Follow-Up/Reschedule)**: Create follow-up meeting, view original link works
- [ ] **Phase 5a-5f (Deal Won Card)**: Record payment, card renders, proof image/PDF display
- [ ] **Phase 6a-6c (Edge Cases)**: No proof file, large files, unsupported currency handled gracefully
- [ ] **Phase 7a-7c (Authorization)**: Closers see only their data, admins see all, mutations re-validated
- [ ] **Phase 8a-8c (Responsive)**: Cards adapt to 375px, 768px, 1440px viewports
- [ ] **Phase 9a-9c (Accessibility & Performance)**: No WCAG violations, Core Web Vitals good, no console errors
- [ ] **Phase 10a-10b (Data Persistence)**: Outcomes and payments persist after refresh, stored correctly in DB

---

## CLI Quick Reference

> **Use `npx convex run testing/calendly:*` for booking helpers and `npx convex data <table>` for table reads.**

```bash
# List all tables
npx convex data

# Read table contents directly (bypasses auth guards)
npx convex data rawWebhookEvents    # Verify raw webhooks arrived + payload
npx convex data leads               # Verify leads + customFields
npx convex data opportunities       # Verify opportunities + utmParams + status
npx convex data meetings            # Verify meetings + meetingOutcome + utmParams
npx convex data paymentRecords      # Verify payment records
npx convex data eventTypeConfigs    # Verify event type configs

# Logs (no auth required)
npx convex logs --history 100       # Check recent processing history
npx convex logs                     # Stream live function logs
```

---

## Known Limitations & Future Work

1. **No payment status workflow**: Payments default to `"recorded"`. Manual status change to `"verified"` or `"disputed"` not yet implemented. (Future: admin workflow for payment reconciliation.)
2. **No follow-up schedule UI**: Outcome select is for classification only. No way to set next meeting date from the card. (Future: schedule follow-up dialog.)
3. **No meeting rescheduling via UI**: Reschedule is inferred from meeting history but no UI action to reschedule. (Future: reschedule action via Calendly API.)
4. **Attribution UTM inference is client-side only**: Heavy meeting history loads could impact performance if a lead has 100+ meetings. (Future: paginate meeting history or cache attribution client-side.)
5. **Payment proof file limits**: No file size validation on upload. Assumes backend enforces limits. (Future: client-side validation for UX.)
