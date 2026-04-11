# Event Type Field Mappings — Testing Strategy

> **Status**: Ready for QA
> **Feature Scope**: Admin settings UI for mapping custom Calendly form fields (social handles, phone) to CRM identity fields
> **Data Flow**: Booking → Custom Questions & Answers → Event Type Config (stored mappings) → Feature E (Lead Identity Resolution, future)

---

## Overview

The Event Type Field Mappings feature allows admins to:

1. View discovered custom form fields from Calendly bookings
2. Configure which booking form question maps to which CRM identity field (social handle, phone)
3. Select social platform type (Instagram, TikTok, Twitter, Other)
4. Save mappings to `eventTypeConfigs` table

**Validation gates:**
- Mapped fields must exist in discovered fields
- Social handle type required when social handle field selected
- Same field cannot map to both social handle and phone
- Admin-only access (tenant_master, tenant_admin)

---

## Test Data Setup

### Required: 3 bookings with distinct field patterns

You need **3 real test bookings** via Calendly to establish diverse field discovery. Use the internal Convex CLI helpers so the bookings are created programmatically through Calendly's Scheduling API while still producing normal webhooks.

### One-time discovery

```bash
# Find the connected tenant id
npx convex data tenants

# List event types for that tenant and pick the test event type URI
npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'

# Inspect exact question names before booking
npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'
```

### Scheduling Constraint: Book at the Current Time

All meetings **must be scheduled into the earliest available slot window**. Meetings scheduled far in the future sit idle and can't be fully tested through the UI — closers need to interact with them (view detail pages, record payments, set outcomes, etc.) immediately after booking.

Since Calendly uses **round-robin scheduling across 2 closers**, try to schedule at least **2 meetings in the same narrow window** — one should go to closer1 and the other to closer2. The 3rd booking will go to whichever closer is next in rotation.

| Lead # | Email                          | Time Slot | Custom Field 1       | Custom Field 2      | Custom Field 3         | Purpose                           |
| ------ | ------------------------------ | --------- | -------------------- | ------------------- | ---------------------- | --------------------------------- |
| 1      | vas.claudio15+lead1@icloud.com | **Now (earliest)** | Instagram Handle     | Phone Number        | Message (any)          | Social + phone discovered         |
| 2      | vas.claudio15+lead2@icloud.com | **Now (earliest)** | TikTok Account       | (skip phone)         | Question (any)         | Social only (different platform) |
| 3      | vas.claudio15+lead3@icloud.com | **Now (earliest)** | X Handle             | Emergency Phone     | (any)                  | Another social variant            |

> **Round-robin expectation:** Bookings 1 and 2 land on different closers. Booking 3 goes to whichever closer is next. After all 3 bookings, confirm the distribution via CLI by checking `assignedCloserId` on each opportunity.

**Important**: Check that these leads don't already exist before booking:

```bash
npx convex data leads
# Scan the output for any rows with email "vas.claudio15+lead1@icloud.com"
# If found, increment to lead4, lead5, etc.
```

### Programmatic booking commands

Use `testing/calendly:bookTestInvitee` three times with the same `tenantId` and `eventTypeUri`, changing the invitee data and custom answers each time.

Lead 1:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead1@icloud.com",
  "inviteeName":"Test Lead 1",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005550001",
  "questionAnswers":{
    "Instagram Handle":"lead1_ig",
    "Phone Number":"+15005550001",
    "Message":"Field mapping QA 1"
  },
  "windowDays":2
}'
```

Lead 2:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead2@icloud.com",
  "inviteeName":"Test Lead 2",
  "inviteeTimezone":"America/Tegucigalpa",
  "questionAnswers":{
    "TikTok Account":"lead2_tt",
    "Question":"Field mapping QA 2"
  },
  "windowDays":2
}'
```

Lead 3:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+lead3@icloud.com",
  "inviteeName":"Test Lead 3",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005550003",
  "questionAnswers":{
    "X Handle":"lead3_x",
    "Emergency Phone":"+15005550003",
    "Message":"Field mapping QA 3"
  },
  "windowDays":2
}'
```

If Calendly returns `Missing Calendly scope`, reconnect the tenant once so its OAuth grant includes `availability:read` and `scheduled_events:write`.

---

## Phase 1: Backend Webhook Validation (CLI — Mandatory First)

> **All backend checks use `npx convex run testing/calendly:*` for booking helpers and `npx convex data <table>` for table reads.** Auth-guarded exported queries are not part of this QA flow.

### 1a. Verify Raw Webhook Arrival

After each of the 3 bookings, run:

```bash
npx convex data rawWebhookEvents
# Look at the most recent rows — find the one matching the booking you just made
```

**Check**:
- `eventType: "invitee.created"` ✓
- `processed: true` ✓
- `payload.questions_and_answers` contains the custom form responses you entered ✓

Example payload structure (you should see):

```json
{
  "questions_and_answers": [
    { "question": "Instagram Handle", "answer": "somealias123" },
    { "question": "Phone Number", "answer": "+1-555-1234" }
  ]
}
```

### 1b. Verify Lead Created with Custom Fields

For each booking, run:

```bash
npx convex data leads
# Find the row matching email "vas.claudio15+lead1@icloud.com"
```

**Check**:
- Lead record exists ✓
- `customFields` is a key-value object ✓
- Keys match the form field names you filled (e.g., `"Instagram Handle": "somealias123"`) ✓

Example output:

```json
{
  "_id": "...",
  "email": "vas.claudio15+lead1@icloud.com",
  "fullName": "Test Lead 1",
  "customFields": {
    "Instagram Handle": "somealias123",
    "Phone Number": "+1-555-1234",
    "Message": "..."
  }
}
```

### 1c. Verify Opportunity Created with EventTypeConfigId

For each lead, find the linked opportunity:

```bash
npx convex data opportunities
# Find the row whose leadId matches the lead _id from step 1b
```

**Check**:
- Opportunity exists ✓
- `eventTypeConfigId` field is populated (not null/undefined) ✓

This confirms the pipeline linked the booking to an `eventTypeConfigs` record.

### 1d. Verify EventTypeConfig Created with Discovered Fields

The pipeline auto-creates `eventTypeConfigs` records:

```bash
npx convex data eventTypeConfigs
```

**Check**:
- At least 1 config exists (from first booking) ✓
- `knownCustomFieldKeys` is a non-empty array ✓
- Array contains field names you saw in step 1a: `["Instagram Handle", "Phone Number", "Message", "Question", ...]` ✓
- Multiple bookings do NOT create duplicate configs (same `calendlyEventTypeUri` should reuse the same config) ✓

### 1e. Check for Processing Errors

```bash
npx convex logs --history 100
```

**Check**:
- No `[Pipeline]` or `[EventTypeConfig]` errors ✓
- If any error found, note it and move to troubleshooting section

---

## Phase 2: Admin Settings UI (Browser)

### 2a. Navigate to Settings Tab

1. Start dev server: `npm run dev`
2. Visit `http://localhost:3000/sign-in`
3. Sign in as tenant owner: `vas.claudio15+tenantowner@icloud.com` + password from `grep TEST_USERS_PASSWORD .env.local`
4. Navigate to `http://localhost:3000/workspace/settings`
5. Find and click the **Field Mappings** tab

**Expected**:
- Tab renders without errors ✓
- Shows a card for each event type with:
  - Event type display name ✓
  - Booking count (≥ 3, one per booking) ✓
  - Field count (total discovered custom fields across all bookings) ✓
  - "Last booking" timestamp ✓
  - Status badges showing existing mappings (if any, all empty on first visit) ✓

### 2b. Open Field Mapping Dialog for Event Type 1

Click the **Configure** button on the first event type card.

**Expected dialog opens**:
- Title: `"Configure Field Mappings for [Display Name]"`
- Form fields for:
  - **Social Handle Field** (dropdown, initially empty) ✓
  - **Social Platform** (dropdown, visible only after social field selected) ✓
  - **Phone Field** (dropdown, initially empty) ✓

### 2c. Test Field Discovery in Dropdowns

1. Click **Social Handle Field** dropdown
2. **Expected**: All form field names appear (e.g., "Instagram Handle", "TikTok Account", "X Handle", "Phone Number", "Message", etc.) ✓
3. Click **Phone Field** dropdown
4. **Expected**: Same field names available ✓

### 2d. Test Mapping — Social Handle Only

1. In Social Handle Field, select `"Instagram Handle"`
2. **Expected**: Social Platform dropdown appears, becomes required ✓
3. In Social Platform, select `"Instagram"` ✓
4. Leave Phone Field empty
5. Click **Save**

**Expected**:
- Toast message: `"Field mappings saved"` ✓
- Dialog closes ✓
- Event type card now shows badge: `"Instagram mapped"` ✓

### 2e. Test Mapping — Add Phone Field

1. Click Configure again on the same event type
2. Dialog opens with previous mappings populated:
   - Social Handle Field: `"Instagram Handle"` ✓
   - Social Platform: `"Instagram"` ✓
   - Phone Field: (empty) ✓
3. In Phone Field, select `"Phone Number"` (or another field that differs from social handle)
4. Click **Save**

**Expected**:
- Toast: `"Field mappings saved"` ✓
- Dialog closes ✓
- Event type card now shows TWO badges: `"Instagram mapped"` + `"Phone mapped"` ✓

---

## Phase 3: Validation & Error Cases (UI)

### 3a. Test Validation — Same Field for Both

1. Click Configure on the event type again
2. In Social Handle Field, select `"Phone Number"`
3. In Phone Field, also select `"Phone Number"`
4. Click **Save**

**Expected error**:
- Toast error: `"Social handle field and phone field cannot be the same question"` ✓
- Dialog stays open ✓
- Config NOT saved (verified by closing and reopening dialog) ✓

### 3b. Test Validation — Social Handle Without Platform

1. In Social Handle Field, select any field (e.g., `"Instagram Handle"`)
2. In Social Platform, click to clear it (don't select anything)
3. Click **Save**

**Expected error**:
- Toast error: `"Social handle platform type is required when a social handle field is selected"` ✓
- Dialog stays open ✓

### 3c. Test Clearing Mappings

1. From the Configure dialog with existing mappings:
2. In Social Handle Field, click the X or clear button to deselect
3. **Expected**: Social Platform dropdown disappears ✓
4. Click **Save**

**Expected**:
- Toast: `"Field mappings saved"` ✓
- Event type card badge for social handle is gone; phone badge remains (if set) ✓

### 3d. Test Unknown Field Selection (Edge Case)

> This validates that the backend rejects fields not in `knownCustomFieldKeys`.

1. Temporarily edit `field-mapping-dialog.tsx` to add a fake field name to the dropdown (just for testing):
   - Add `"Fake Field Name"` to the list rendered in the social handle dropdown
2. Select it and click Save
3. **Expected error** from backend:
   - Toast error: `"...is not a known form field for this event type"` ✓

(Revert this edit after test.)

---

## Phase 4: Multi-Event-Type Scenario (Advanced)

If your Calendly account has multiple event types (or we create a test one):

1. Complete Phase 1 with bookings to a **different event type** on Calendly
2. Return to Field Mappings UI — you should now see **2 separate event type cards**
3. Configure mappings independently for each:
   - Event Type 1: Instagram + Phone mapped
   - Event Type 2: Only phone mapped
4. Verify each card shows the correct badge combinations ✓
5. Verify mappings do NOT cross over (editing one event type doesn't affect the other) ✓

---

## Phase 5: Admin-Only Access (Authorization)

### 5a. Test Closer Cannot Access Settings

1. Sign out
2. Sign in as: `vas.claudio15+closer1@icloud.com`
3. Navigate to `http://localhost:3000/workspace/settings`

**Expected**:
- Redirect to closer dashboard or access denied page ✓
- Cannot see Field Mappings tab ✓

### 5b. Test Closer Cannot Call Mutation Directly

(Advanced, Convex CLI only):

```bash
# Get a closer's Convex token (not documented in CLI — this is a manual/internal test)
# Or run in the browser console: console.log(localStorage.getItem("convex-token"))

# Try to call updateCustomFieldMappings as a closer (will fail with auth error)
npx convex run eventTypeConfigs/mutations:updateCustomFieldMappings '{...}'
```

**Expected**:
- Error: `"Insufficient permissions"` or auth guard rejection ✓

---

## Phase 6: Data Persistence (Backend)

### 6a. Verify Mappings Stored in DB

After Phase 2e (both social + phone mapped):

```bash
npx convex data eventTypeConfigs
# Find the config for your test event type
```

**Check output — the config should contain**:

```json
{
  "_id": "...",
  "calendlyEventTypeUri": "https://calendly.com/...",
  "displayName": "Test Meeting for CRM",
  "customFieldMappings": {
    "socialHandleField": "Instagram Handle",
    "socialHandleType": "instagram",
    "phoneField": "Phone Number"
  },
  "knownCustomFieldKeys": [
    "Instagram Handle",
    "Phone Number",
    "Message",
    ...
  ],
  ...
}
```

**Check**:
- `customFieldMappings` exactly matches what you configured in UI ✓
- `knownCustomFieldKeys` includes all discovered field names ✓

### 6b. Verify Mappings Survive Refresh

1. Keep the UI open to Field Mappings tab
2. Refresh the page: `Cmd+R` (or F5)
3. Event type cards re-render with the same configuration ✓
4. Badges still show the mappings ✓

(This tests that the query `getEventTypeConfigsWithStats` correctly loads persisted data.)

---

## Phase 7: Feature E Integration Prep (Data Structure Validation)

> Feature E (Lead Identity Resolution) will read these mappings during pipeline processing.
> This phase validates the data is in the correct shape for Feature E to consume.

### 7a. Verify Mapping Structure for Feature E

Run `npx convex data eventTypeConfigs` again and inspect `customFieldMappings`:

```json
{
  "socialHandleField": "Instagram Handle",      // ← feature E reads this
  "socialHandleType": "instagram",              // ← feature E reads this
  "phoneField": "Phone Number"                  // ← feature E reads this
}
```

**Check**:
- All three fields present (or omitted if empty, as per normalization) ✓
- Field values match discovered field names from `knownCustomFieldKeys` ✓
- No extra/unexpected fields in the structure ✓

---

## Rollback & Cleanup

### If tests fail:

1. **Identify failure point** (Phase number)
2. **Check Convex logs** for backend errors: `npx convex logs --history 100`
3. **Fix code** if needed
4. **Clear test data** (optional; not required if reusing emails with increments):
   ```bash
   # Delete test leads manually via terminal (not recommended)
   # OR just use new emails: lead4, lead5, lead6, etc.
   ```

### Final cleanup:

- Delete temporary edits (Phase 3d fake field test)
- Confirm production Calendly account still functional
- Note any auth/permission issues for Phase 6

---

## Completion Checklist

- [ ] **Phase 1 (Backend)**: All 3 webhooks arrived, leads created, eventTypeConfigs auto-generated, no errors in logs
- [ ] **Phase 2a (UI Load)**: Field Mappings tab renders with event type cards
- [ ] **Phase 2b-2c (Field Discovery)**: Dropdowns populate with discovered field names
- [ ] **Phase 2d (Social Mapping)**: Save social handle + platform, badges appear
- [ ] **Phase 2e (Phone Mapping)**: Add phone field, both badges show
- [ ] **Phase 3a-3d (Validation)**: All error cases caught and friendly messages shown
- [ ] **Phase 4 (Multi-Type)**: If multiple event types exist, each configured independently
- [ ] **Phase 5 (Authorization)**: Closers cannot access settings tab
- [ ] **Phase 6 (Data Persistence)**: Mappings stored correctly in DB and survive refresh
- [ ] **Phase 7 (Feature E Prep)**: Data structure validated for future Feature E consumption

---

## CLI Quick Reference

> **Use `npx convex run testing/calendly:*` for booking helpers and `npx convex data <table>` for table reads.**

```bash
# List all tables
npx convex data

# Read table contents directly (bypasses auth guards)
npx convex data rawWebhookEvents    # Verify raw webhooks arrived
npx convex data leads               # Verify leads + customFields
npx convex data opportunities       # Verify opportunities + eventTypeConfigId
npx convex data meetings            # Verify meetings
npx convex data eventTypeConfigs    # Verify configs + knownCustomFieldKeys + customFieldMappings

# Logs (no auth required)
npx convex logs --history 100       # Check recent processing history
npx convex logs                     # Stream live function logs
```

---

## Known Limitations & Future Work

1. **Field discovery is passive**: New custom fields only surface when a new booking arrives. No way to manually add fields. (By design — reduces admin burden.)
2. **No field validation UI**: Admin cannot see field type (text, email, number, etc.) — only the field name. This is OK for v0.5. (Future: expose Calendly API field metadata.)
3. **No mapping preview**: Admin cannot preview how a discovered field will be used before saving. (Future: "Test mapping" button to simulate a booking.)
4. **Feature E not yet integrated**: Mappings are stored but not yet used during pipeline processing. This test validates the data shape for Feature E to consume in v0.5.2.
