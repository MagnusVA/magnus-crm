# Testing Guidelines — ptdom-crm

> **This app integrates Calendly, Convex, and WorkOS.** End-to-end testing is done **manually** and requires creating _real_ Calendly meetings, preferably via the Convex CLI test helpers in `convex/testing/calendly.ts`, then validating the processed data through the web app.
>
> This document is the authoritative reference for running manual QA on ptdom-crm.

> **MANDATORY: Use the Convex CLI (terminal only) to validate all backend data.**
> Every testing workflow **must** include Convex CLI verification against the **test deployment** before moving to browser validation. Use `npx convex run` and `npx convex logs` in the terminal — these are the single source of truth for confirming that webhooks arrived, were processed, and produced the correct records. You cannot skip this step — browser-only validation is insufficient because the UI may cache stale data or hide backend errors. Always run CLI checks first, then validate the UI.
>
> **Do NOT rely solely on `npx convex dashboard` output in screenshots.** Use terminal CLI commands (`npx convex run` to query tables, `npx convex logs` to check function execution logs) as the source of truth for all backend data inspection.

---

## Table of Contents

1. [Testing Architecture](#testing-architecture)
2. [Calendly: Programmatic Test Meetings](#calendly-programmatic-test-meetings)
3. [Webhook Data Flow](#webhook-data-flow)
4. [Test User Accounts](#test-user-accounts)
5. [App Routes by Role](#app-routes-by-role)
6. [End-to-End Testing Workflow](#end-to-end-testing-workflow)
7. [Validation Checklist](#validation-checklist)
8. [Manual Browser QA](#manual-browser-qa)
9. [Convex CLI — Test Environment Validation](#convex-cli--test-environment-validation)
10. [Common Scenarios](#common-scenarios)
11. [Quick Reference](#quick-reference)

---

## Testing Architecture

```
Calendly Scheduling API        Convex Backend (test deployment)          Web App (Next.js)
──────────────────────         ────────────────────────────────          ─────────────────
npx convex run testing/        Uses tenant Calendly OAuth token
calendly:bookTestInvitee ─────► POST /invitees + webhook flow ───────────► rawWebhookEvents table
                                        │
                                        ▼
                                  pipeline processor
                                        │
                            ┌───────────┼───────────┐
                            ▼           ▼           ▼
                         leads    opportunities  meetings
                            │           │           │
                            ▼           ▼           ▼
                     ┌─ Convex CLI: validate all records (MANDATORY) ─┐
                     │  npx convex run <function> → query tables      │
                     │  npx convex logs → check for errors            │
                     └────────────────────────────────────────────────┘
                                        │
                                   THEN and only then
                                        │
                                        ▼
                          Login as closer/admin ──► Validate in UI
```

**Three systems, one flow — CLI validation is the bridge:**

1. **Calendly** — generates real webhook events from the Scheduling API
2. **Convex (test deployment)** — processes webhooks and stores lead, opportunity, and meeting records; **validated via the Convex CLI before touching the browser**
3. **Web app** — displays the data; where you do final manual UI validation _after_ CLI confirms the data is correct

---

## Calendly: Programmatic Test Meetings

### Preferred Flow: Convex CLI Test Helpers

Use these internal Convex actions from the terminal:

- `testing/calendly:listEventTypes`
- `testing/calendly:getEventTypeDetailsForTesting`
- `testing/calendly:listAvailableSlots`
- `testing/calendly:bookTestInvitee`

These actions use the tenant's existing Calendly OAuth tokens, call Calendly's API directly, and still produce normal `invitee.created` webhook traffic for the pipeline.

### Discover Tenant and Event Type

```bash
# 1. Find the tenant id for the test workspace
npx convex data tenants

# 2. List available event types for that tenant
npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'

# 3. Inspect the event type's custom questions and exact question names
npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'
```

### Custom Form Fields

The test event type has custom questions beyond the standard Calendly fields. These responses are captured in the webhook's `questions_and_answers` array and stored in `leads.customFields` as key-value pairs.

**To identify the exact custom fields currently configured:**

1. Run `testing/calendly:getEventTypeDetailsForTesting` and read `customQuestions`
2. Or inspect existing webhook data via `npx convex data rawWebhookEvents`

**Provide exact question names.** `testing/calendly:bookTestInvitee` maps your `questionAnswers` object onto Calendly's `questions_and_answers` payload by exact question text and position. Missing or blank answers are omitted.

### Standard Fields (Always Present)

These come from Calendly's built-in invitee fields, not the custom form:

| Calendly Field             | Maps to          | Notes                     |
| -------------------------- | ---------------- | ------------------------- |
| Invitee name               | `leads.fullName` | Free text                 |
| Invitee email              | `leads.email`    | Lowercased on storage     |
| Text reminder phone number | `leads.phone`    | Optional; Calendly format |

### Lead Email Addresses

Use this pattern for test leads:

```
vas.claudio15+lead1@icloud.com
vas.claudio15+lead2@icloud.com
vas.claudio15+lead3@icloud.com
...
vas.claudio15+leadN@icloud.com
```

**Before using an email, check if it already exists** — duplicate emails cause the system to _update_ the existing lead rather than create a new one (this is by design, but can confuse test results if you expect a fresh record).

**Use the Convex CLI to check** (not the browser — the CLI queries the test deployment directly):

```bash
# Query the leads table directly
npx convex data leads | rg 'vas\.claudio15\+lead3@icloud\.com'
# If it returns a row, the email is taken — increment to the next number
```

If the email exists and you need a clean slate, increment to the next number (`+lead4`, `+lead5`, etc.).

### Phone Numbers

Use a **fresh random phone number for each "new lead" test booking**.

Phone numbers participate in lead identity resolution, so reusing a phone number can cause the pipeline to attach the booking to an existing lead even when the email is new. Formatting differences do not help here: values such as `+504 8842-3064` and `+50488423064` normalize to the same identifier.

This applies to both:

- the standard Calendly `textReminderNumber` field
- any custom question mapped to phone (for this event type, `Phone Number`)

We are **not using SMS automations** in this environment, so it is safe to use random test numbers.

**Use the Convex CLI to check**:

```bash
# Check whether a phone number has already been used for a lead
npx convex data leadIdentifiers | rg '\+15005550006'
# If it returns a row, the phone is taken — use a different random number
```

### Round-Robin Assignment

Calendly is configured with **round-robin scheduling** across two closers. When a meeting is booked:

- Calendly automatically assigns it to **closer1** or **closer2** based on availability and rotation
- You **cannot control** which closer receives the meeting
- The assigned closer is identified by `scheduled_event.event_memberships[0].user_email` in the webhook payload
- After booking, use `npx convex data opportunities` to inspect `assignedCloserId`

---

## Webhook Data Flow

When a meeting is scheduled on Calendly, this is what happens:

### 1. Webhook arrives (`convex/webhooks/calendly.ts`)

- HMAC-SHA256 signature verified from the `Calendly-Webhook-Signature` header
- Raw event stored in `rawWebhookEvents` table with `processed: false`
- Async processing scheduled via `ctx.scheduler.runAfter(0, ...)`

### 2. Pipeline processor routes the event (`convex/pipeline/processor.ts`)

Dispatches based on `eventType`:

| Event Type                | Handler                         | Action                               |
| ------------------------- | ------------------------------- | ------------------------------------ |
| `invitee.created`         | `inviteeCreated.ts`             | Creates lead + opportunity + meeting |
| `invitee.canceled`        | Updates status to `canceled`    | Extracts cancellation reason         |
| `invitee_no_show.created` | Updates status to `no_show`     | Marks meeting + opportunity          |
| `invitee_no_show.deleted` | Reverts `no_show` → `scheduled` | Undoes no-show marking               |

### 3. Records created (`invitee.created` flow)

**Lead** (`leads` table):

- `email` (lowercased), `fullName`, `phone`
- `customFields` — key-value map from `questions_and_answers`
- If lead exists (same email + tenant): merges data (new values overwrite old, custom fields are merged)

**Opportunity** (`opportunities` table):

- Links to the lead via `leadId`
- `hostCalendlyUserUri`, `hostCalendlyEmail`, `hostCalendlyName` from event memberships
- `assignedCloserId` — resolved by matching the Calendly host URI to a CRM user
- `status: "scheduled"`
- Denormalized refs: `latestMeetingId/At`, `nextMeetingId/At`

**Meeting** (`meetings` table):

- Links to opportunity via `opportunityId`
- `calendlyEventUri`, `calendlyInviteeUri`
- `scheduledAt`, `durationMinutes` (computed from start/end)
- `zoomJoinUrl` (if video meeting)
- `leadName` (denormalized)
- `status: "scheduled"`

---

## Test User Accounts

### Credentials

| Email                                  | CRM Role        | Workspace Access                                |
| -------------------------------------- | --------------- | ----------------------------------------------- |
| `vas.claudio15+tenantowner@icloud.com` | `tenant_master` | Full admin: dashboard, pipeline, team, settings |
| `vas.claudio15+closer1@icloud.com`     | `closer`        | Closer views: dashboard, my pipeline, meetings  |
| `vas.claudio15+closer2@icloud.com`     | `closer`        | Closer views: dashboard, my pipeline, meetings  |

### Password

All test users share the same password. Retrieve it from the environment:

```bash
grep TEST_USERS_PASSWORD .env.local
```

The variable is `TEST_USERS_PASSWORD` in `.env.local`. **Never hardcode the password in code, tests, or documentation.**

### Sign-In URL

```
http://localhost:3000/sign-in
```

After signing in, the app routes you based on your role (see next section).

---

## App Routes by Role

### Tenant Master (Admin)

| Route                                      | What it shows                              |
| ------------------------------------------ | ------------------------------------------ |
| `http://localhost:3000/workspace`          | Admin dashboard (stats, recent activity)   |
| `http://localhost:3000/workspace/pipeline` | All opportunities across all closers       |
| `http://localhost:3000/workspace/team`     | Team members, invite flow, role management |
| `http://localhost:3000/workspace/settings` | Tenant settings, Calendly connection       |
| `http://localhost:3000/workspace/profile`  | User profile                               |

### Closer

| Route                                                  | What it shows                         |
| ------------------------------------------------------ | ------------------------------------- |
| `http://localhost:3000/workspace/closer`               | Closer dashboard (my stats, my leads) |
| `http://localhost:3000/workspace/closer/pipeline`      | My assigned opportunities             |
| `http://localhost:3000/workspace/closer/meetings/[id]` | Individual meeting detail + actions   |
| `http://localhost:3000/workspace/profile`              | User profile                          |

### Meeting Detail Page (Closer)

This is the primary page for validating that Calendly data flowed correctly. It shows:

- Lead name, email, phone
- Meeting time, duration, Zoom link
- **Booking answers** (custom form fields) — rendered in a `BookingAnswersCard`
- Status and available actions (mark lost, record payment, schedule follow-up)

---

## End-to-End Testing Workflow

### Phase 1: Generate Test Data

1. **Pick an unused lead email and a fresh random phone number** — check both before booking
2. **Find the event type and questions**:
    ```bash
    npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'
    npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'
    ```
3. **Book the earliest available slot**:
    ```bash
    npx convex run testing/calendly:bookTestInvitee '{
      "tenantId":"<tenantId>",
      "eventTypeUri":"<eventTypeUri>",
      "inviteeEmail":"vas.claudio15+lead4@icloud.com",
      "inviteeName":"Test Lead 4",
      "inviteeTimezone":"America/Tegucigalpa",
      "textReminderNumber":"+15005550006",
      "questionAnswers":{
        "Instagram Handle":"testlead4",
        "Phone Number":"+15005550006",
        "Message":"QA booking"
      }
    }'
    ```
    Use a phone number that has not appeared in prior test bookings when you anticipate a brand-new lead.
4. **Optional: attach attribution UTMs** by passing `tracking`:
    ```bash
    "tracking":{
      "utm_source":"google",
      "utm_medium":"cpc"
    }
    ```

### Phase 2: Verify Webhook Processing via Convex CLI

> **This phase is mandatory and must use the Convex CLI against the test deployment.** Do not skip to browser validation. The CLI is the only way to confirm the webhook was received, processed without errors, and produced the correct database records.

5. **Run Convex CLI commands in the terminal to verify the full data chain.** Use `npx convex data` to inspect each table:

    ```bash
    # Step 5a: Check that the webhook event arrived and was processed
    npx convex data rawWebhookEvents --limit 5
    # Confirm: eventType = "invitee.created", processed = true, payload contains form data

    # Step 5b: Verify the lead was created/updated
    npx convex data leads
    # Confirm: fullName, phone, customFields match what you entered in the Calendly form

    # Step 5c: Verify the opportunity was created
    npx convex data opportunities
    # Confirm: status = "scheduled", assignedCloserId is set, latestMeetingId is populated

    # Step 5d: Verify the meeting was created
    npx convex data meetings
    # Confirm: status = "scheduled", scheduledAt matches, leadName is set, durationMinutes is correct
    ```

6. **Check for processing errors:**

    ```bash
    # Look at the Convex function logs for any errors during processing
    npx convex logs --history 100
    # Filter for [Pipeline] or [Calendly] tagged messages
    # Any errors here mean the webhook was received but processing failed
    ```

7. **If any check fails, stop here.** Do not proceed to browser validation until the CLI confirms all records exist and are correct. Common issues are documented in [Debugging Failed Webhooks](#debugging-failed-webhooks).

### Phase 3: Validate in the Web App (Manual)

> Only proceed here after the Convex CLI confirms all records exist (Phase 2).

8. **Determine which closer was assigned** (from Phase 2's `assignedCloserId` or `hostCalendlyEmail` in the opportunity record)
9. **Sign in** at `http://localhost:3000/sign-in` as that closer
10. **Navigate to closer dashboard** → the new meeting should appear
11. **Open the meeting detail page** → verify:
    - Lead info matches (name, email, phone)
    - Booking answers card shows all custom fields
    - Scheduled time is correct
    - Available actions work (mark lost, payment, follow-up)

### Phase 4 (Optional): Test as Admin

12. **Sign out and sign in as tenant owner**
13. **Check admin dashboard** → new lead/opportunity should appear in stats
14. **Check admin pipeline** → opportunity visible with correct status and closer assignment

---

## Validation Checklist

Use this after every test meeting is scheduled.

### Convex Backend (CLI terminal only — mandatory, always first)

> **All backend checks must be performed via `npx convex data`, `npx convex run testing/calendly:*`, and `npx convex logs` in the terminal.**

- [ ] `rawWebhookEvents` — `npx convex data rawWebhookEvents --limit 5` → event received, `processed: true`, no errors in payload
- [ ] `leads` — `npx convex data leads` → record exists with correct `email`, `fullName`, `phone`, `customFields`
- [ ] `opportunities` — `npx convex data opportunities` → record exists with `status: "scheduled"`, valid `assignedCloserId`, `latestMeetingId` populated
- [ ] `meetings` — `npx convex data meetings` → record exists with `status: "scheduled"`, correct `scheduledAt`, `durationMinutes`, `leadName`
- [ ] Denormalized fields — `opportunities.latestMeetingAt`, `nextMeetingId/At` correctly set (visible in the opportunity query output)
- [ ] Function logs — `npx convex logs --history 100` → no `[Pipeline]` or `[Calendly]` errors related to this event

### Web App (Closer View)

- [ ] Meeting appears on closer dashboard
- [ ] Meeting appears in closer pipeline
- [ ] Meeting detail page loads with all lead data
- [ ] Booking answers card shows custom form responses
- [ ] Status actions work (mark lost dialog, payment form, follow-up dialog)
- [ ] State transitions are valid (scheduled → in_progress → completed/lost/etc.)

### Web App (Admin View)

- [ ] New opportunity visible in admin pipeline
- [ ] Dashboard stats updated (if applicable)
- [ ] Correct closer shown as assignee

---

## Manual Browser QA

After CLI validation passes, perform manual browser QA to confirm the UI renders correctly.

### Prerequisites

Before running through browser QA, you **must** have real data in the system:

- **Minimum 3 meetings** created through the CLI test helpers (so dashboards, pipelines, and lists render real content)
- **Both closers** should have at least 1 meeting assigned (test round-robin)
- Empty-state screenshots are **not valid tests**
- **Backend data verified via CLI first** — run `npx convex data` table inspections to confirm all records exist before opening the browser

### Manual QA Checklist

Walk through each of the following in a real browser (Chrome / Safari / Firefox) after signing in as the appropriate test user:

1. **Functional smoke tests**
    - Sign in with each test user and confirm the correct landing route for their role
    - Exercise the changed page(s): click primary CTAs, open dialogs, submit forms, verify success toasts
    - Confirm real-time updates — changes made in one tab should reflect in a second tab without a refresh

2. **State transitions** — where applicable, run the meeting lifecycle (scheduled → in progress → completed / lost / payment received / follow-up scheduled) and confirm the status actions behave correctly

3. **Console & network**
    - Open DevTools → Console — no red error entries during the flow
    - DevTools → Network — no 4xx/5xx responses, no CORS errors, no failed asset loads

4. **Responsive design** — resize the window or use DevTools device toolbar to verify at least these viewports:
    - 375 px (mobile)
    - 768 px (tablet)
    - 1280 px (laptop)
    - 1440 px (desktop)

5. **Accessibility spot check**
    - Tab through the page — focus order is logical, focus ring is visible
    - All interactive elements are reachable via keyboard
    - Dialogs trap focus and close on `Esc`
    - Form fields have visible labels; error messages are announced (use VoiceOver / NVDA if changes are significant)

6. **Dark mode** — toggle the theme and confirm colors, contrast, and icons render correctly in both light and dark modes

### When to Re-Test

Re-run the relevant manual checks whenever you:

- Modify a page, route, dialog, form, or shared layout component
- Change a Convex query/mutation touched by a UI surface
- Update shared UI primitives (`components/ui/*`) or the workspace shell
- Adjust styles, tokens, or theme variables

---

## Convex CLI — Test Environment Validation

> **The Convex CLI is the only tool for backend validation.** All commands below run in the terminal and target the test deployment configured in your `.env.local`.

### Essential Commands

```bash
# Start the dev server (watches files, syncs schema to the test deployment)
npx convex dev

# Discover available event types
npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'

# Inspect an event type's custom questions
npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'

# Preview earliest available slots
npx convex run testing/calendly:listAvailableSlots '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>","windowDays":2,"limit":5}'

# Book a real Calendly meeting programmatically
npx convex run testing/calendly:bookTestInvitee '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>","inviteeEmail":"vas.claudio15+lead1@icloud.com","inviteeName":"Test Lead 1","inviteeTimezone":"America/Tegucigalpa"}'

# Inspect resulting tables directly
npx convex data rawWebhookEvents --limit 5
npx convex data leads
npx convex data opportunities
npx convex data meetings

# Stream real-time function logs (watch for webhook processing in real time)
npx convex logs
# Look for [Pipeline], [Calendly], [Auth] tagged messages

# Check recent error logs (non-streaming, for after-the-fact debugging)
npx convex logs --history 100
```

### When to Use Each Command

| Task                           | Command                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------- |
| Discover event types           | `npx convex run testing/calendly:listEventTypes '{"tenantId":"..."}'`                                              |
| Inspect exact custom questions | `npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"...","eventTypeUri":"..."}'`          |
| Preview open slots             | `npx convex run testing/calendly:listAvailableSlots '{"tenantId":"...","eventTypeUri":"..."}'`                     |
| Book a real test meeting       | `npx convex run testing/calendly:bookTestInvitee '{...}'`                                                          |
| Verify webhook arrived         | `npx convex data rawWebhookEvents --limit 5`                                                                       |
| Verify lead created            | `npx convex data leads`                                                                                            |
| Verify opportunity created     | `npx convex data opportunities`                                                                                    |
| Verify meeting created         | `npx convex data meetings`                                                                                         |
| Check closer assignment        | Read `assignedCloserId` from the opportunity query output                                                          |
| Inspect custom form fields     | Read `customQuestions` from the helper output, or `payload.questions_and_answers` / `customFields` from table data |
| Debug processing failure       | `npx convex logs` or `npx convex logs --history 100`                                                               |
| Verify email doesn't exist yet | `npx convex data leads                                                                                             | rg '<email>'` |

### Tables & What to Look For

| Table              | CLI command                        | Key fields to check                                     |
| ------------------ | ---------------------------------- | ------------------------------------------------------- |
| `rawWebhookEvents` | `npx convex data rawWebhookEvents` | `eventType`, `processed`, `payload` contents            |
| `leads`            | `npx convex data leads`            | `email`, `fullName`, `phone`, `customFields`            |
| `opportunities`    | `npx convex data opportunities`    | `status`, `assignedCloserId`, `latestMeetingId/At`      |
| `meetings`         | `npx convex data meetings`         | `status`, `scheduledAt`, `calendlyEventUri`, `leadName` |
| `users`            | `npx convex data users`            | Roles, `calendlyUserUri` (for closer matching)          |

### Debugging Failed Webhooks

```bash
# 1. Check if the event arrived at all
npx convex data rawWebhookEvents --limit 5
# If no event exists: the webhook never reached Convex (check Calendly webhook config, network)
# If processed = false: the pipeline processor errored before completing

# 2. Check the function logs for the error
npx convex logs --history 100
# Look for [Pipeline] or [Calendly] tagged errors with the event's calendlyEventUri

# 3. Trace the data chain — query each table in sequence
npx convex data leads
npx convex data opportunities
npx convex data meetings
# If leads exists but opportunities doesn't → error is in inviteeCreated.ts
# If opportunities exists but meetings doesn't → error is in meeting creation
```

Common failures:

- **Signature mismatch** — webhook signing key doesn't match env var
- **Missing host URI match** — `event_memberships[0].user` doesn't match any `users.calendlyUserUri`
- **Status transition violation** — attempting an invalid state change (check `convex/lib/statusTransitions.ts`)
- **Duplicate event** — same `calendlyEventUri` already processed (idempotency guard)

---

## Common Scenarios

### Scenario 1: Fresh Meeting (Happy Path)

1. Schedule with unused email (e.g., `+lead5`)
2. **CLI**: `npx convex logs` — watch for `[Pipeline] inviteeCreated` success message
3. **CLI**: `npx convex data rawWebhookEvents --limit 5` → confirm `processed: true`
4. **CLI**: `npx convex data leads` → verify lead record
5. **CLI**: `npx convex data opportunities` → note `assignedCloserId` to know which closer to log in as
6. **Browser**: Login as assigned closer → meeting visible → detail page correct
7. **Browser**: Login as admin → opportunity in pipeline, stats updated

### Scenario 2: Returning Lead (Same Email, New Meeting)

1. **CLI**: `npx convex data leads` — confirm the lead already exists, note current `customFields`
2. Schedule with that same email (e.g., `+lead1`)
3. **CLI**: Query lead again — verify the _existing_ lead was updated (not duplicated), `customFields` merged
4. **CLI**: Verify new opportunity + meeting created, linked to same lead
5. **Browser**: Confirm the closer sees the new meeting under the existing lead

### Scenario 3: Round-Robin Distribution

1. Schedule 4+ meetings with different lead emails and different phone numbers
2. **CLI**: Inspect `npx convex data leads` and `npx convex data opportunities` — `assignedCloserId` should alternate between closer1 and closer2
3. **Browser**: Login as each closer — each should see only their assigned meetings

### Scenario 4: Meeting Lifecycle

1. Schedule a meeting (status: `scheduled`)
2. As closer, open meeting detail
3. Test each action:
    - **Mark as Lost** — opens dialog, requires reason → status becomes `lost`
    - **Record Payment** — opens payment form dialog → status becomes `payment_received`
    - **Schedule Follow-Up** — opens follow-up dialog
4. Verify status transitions are enforced (can't go backward)

### Scenario 5: Cancellation via Calendly

1. Schedule a meeting
2. **CLI**: `npx convex data rawWebhookEvents --limit 5` — confirm the `invitee.created` event was processed first
3. Cancel it through Calendly (from the confirmation email or Calendly dashboard)
4. **CLI**: `npx convex logs` — watch for the `invitee.canceled` event processing
5. **CLI**: `npx convex data rawWebhookEvents --limit 5` — verify `invitee.canceled` event, `processed: true`
6. **CLI**: `npx convex data meetings` — status should be `"canceled"`
7. **CLI**: `npx convex data opportunities` — status should be `"canceled"`, cancellation reason captured
8. **Browser**: Login as closer → meeting should show canceled status in UI

---

## Quick Reference

### Convex CLI (terminal only — use FIRST, before browser)

| What                         | Command                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Start dev server             | `npx convex dev`                                                        |
| List event types             | `npx convex run testing/calendly:listEventTypes '{"tenantId":"..."}'`   |
| Inspect custom questions     | `npx convex run testing/calendly:getEventTypeDetailsForTesting '{...}'` |
| Preview open slots           | `npx convex run testing/calendly:listAvailableSlots '{...}'`            |
| Book a real Calendly meeting | `npx convex run testing/calendly:bookTestInvitee '{...}'`               |
| Inspect webhook events       | `npx convex data rawWebhookEvents --limit 5`                            |
| Inspect leads                | `npx convex data leads`                                                 |
| Inspect opportunities        | `npx convex data opportunities`                                         |
| Inspect meetings             | `npx convex data meetings`                                              |
| Stream live function logs    | `npx convex logs`                                                       |
| Check recent history         | `npx convex logs --history 100`                                         |
| Inspect custom form fields   | Read `customFields` from lead query or `payload` from raw event query   |

### Calendly & App

| What                    | Where / How                                                 |
| ----------------------- | ----------------------------------------------------------- |
| Schedule a test meeting | `npx convex run testing/calendly:bookTestInvitee '{...}'`   |
| Lead email pattern      | `vas.claudio15+lead{N}@icloud.com`                          |
| Lead phone pattern      | Use a fresh random E.164-like number for each new-lead test |
| Test password           | `grep TEST_USERS_PASSWORD .env.local`                       |
| Sign in                 | `http://localhost:3000/sign-in`                             |
| Admin dashboard         | `http://localhost:3000/workspace`                           |
| Closer dashboard        | `http://localhost:3000/workspace/closer`                    |
| Meeting detail          | `http://localhost:3000/workspace/closer/meetings/[id]`      |

### Code References

| What                 | File                                |
| -------------------- | ----------------------------------- |
| Webhook handler code | `convex/pipeline/inviteeCreated.ts` |
| Status state machine | `convex/lib/statusTransitions.ts`   |
| RBAC permissions     | `convex/lib/permissions.ts`         |
