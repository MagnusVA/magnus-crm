# Testing Guidelines — ptdom-crm

> **This app integrates Calendly, Convex, and WorkOS.** End-to-end testing requires scheduling _real_ Calendly meetings to generate webhook events, then validating the processed data through the web app.
>
> This document is the authoritative reference for AI agents running QA via the **Expect** skill.

> **MANDATORY: Use the Convex CLI (terminal only) to validate all backend data.**
> Every testing workflow **must** include Convex CLI verification against the **test deployment** before moving to browser validation. Use `npx convex run` and `npx convex logs` in the terminal — these are the single source of truth for confirming that webhooks arrived, were processed, and produced the correct records. You cannot skip this step — browser-only validation is insufficient because the UI may cache stale data or hide backend errors. Always run CLI checks first, then validate the UI.
>
> **Do NOT use `npx convex dashboard`.** The dashboard opens a browser UI — the Expect agent's browser must only be used for the actual application (`localhost:3000`). All backend data inspection must happen through terminal CLI commands: `npx convex run <function>` to query tables, and `npx convex logs` to check function execution logs.

---

## Table of Contents

1. [Testing Architecture](#testing-architecture)
2. [Calendly: Scheduling Test Meetings](#calendly-scheduling-test-meetings)
3. [Webhook Data Flow](#webhook-data-flow)
4. [Test User Accounts](#test-user-accounts)
5. [App Routes by Role](#app-routes-by-role)
6. [End-to-End Testing Workflow](#end-to-end-testing-workflow)
7. [Validation Checklist](#validation-checklist)
8. [Using the Expect Skill](#using-the-expect-skill)
9. [Convex CLI — Test Environment Validation](#convex-cli--test-environment-validation)
10. [Common Scenarios](#common-scenarios)
11. [Quick Reference](#quick-reference)

---

## Testing Architecture

```
Calendly Booking Form          Convex Backend (test deployment)          Web App (Next.js)
─────────────────────          ────────────────────────────────          ─────────────────
Schedule a meeting   ──webhook──►  rawWebhookEvents table
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
                     │  (terminal only — NOT npx convex dashboard)    │
                     └────────────────────────────────────────────────┘
                                        │
                                   THEN and only then
                                        │
                                        ▼
                          Login as closer/admin ──► Validate in UI
```

**Three systems, one flow — CLI validation is the bridge:**

1. **Calendly** — generates real webhook events from a test scheduling link
2. **Convex (test deployment)** — processes webhooks and stores lead, opportunity, and meeting records; **validated via the Convex CLI before touching the browser**
3. **Web app** — displays the data; where you do final UI validation _after_ CLI confirms the data is correct

---

## Calendly: Scheduling Test Meetings

### Test Scheduling Link

```
https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm
```

This link points to a test event type on our Calendly account. It includes a **custom booking form** whose fields feed directly into the webhook payload.

### Custom Form Fields

The booking form has custom questions beyond the standard Calendly fields (name, email). These custom responses are captured in the webhook's `questions_and_answers` array and stored in `leads.customFields` as key-value pairs.

**To identify the exact custom fields currently configured:**

1. **Visit the scheduling link** in a browser and note every form field
2. **Or inspect existing webhook data** via the Convex CLI:
    ```bash
    # Query a recent raw webhook event to see the questions_and_answers array
    npx convex run rawWebhookEvents:getLatest
    # Look at payload.questions_and_answers — each entry has a "question" (field label) and "answer" (response)
    ```

**Fill every custom field accurately.** The webhook handler (`convex/pipeline/inviteeCreated.ts`) extracts all `questions_and_answers` entries and maps them to `leads.customFields`. Missing or blank answers mean missing data downstream.

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
# Query the leads table for an existing email
npx convex run leads:getByEmail '{"email": "vas.claudio15+lead3@icloud.com"}'
# If it returns a record, the email is taken — increment to the next number
```

If the email exists and you need a clean slate, increment to the next number (`+lead4`, `+lead5`, etc.).

### Round-Robin Assignment

Calendly is configured with **round-robin scheduling** across two closers. When a meeting is booked:

- Calendly automatically assigns it to **closer1** or **closer2** based on availability and rotation
- You **cannot control** which closer receives the meeting
- The assigned closer is identified by `scheduled_event.event_memberships[0].user_email` in the webhook payload
- After booking, use `npx convex run` to query the `opportunities` table and check which closer was assigned (`assignedCloserId`)

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

1. **Pick an unused lead email** — check via `npx convex run leads:getByEmail` first
2. **Open the Calendly scheduling link:**
    ```
    https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm
    ```
3. **Select a time slot** and fill the form:
    - Name: Use something identifiable (e.g., "Test Lead 4")
    - Email: `vas.claudio15+lead4@icloud.com`
    - Phone: Any valid format
    - **All custom fields**: Fill every one — these map to `leads.customFields`
4. **Submit the booking**

### Phase 2: Verify Webhook Processing via Convex CLI

> **This phase is mandatory and must use the Convex CLI against the test deployment.** Do not skip to browser validation. The CLI is the only way to confirm the webhook was received, processed without errors, and produced the correct database records.

5. **Run Convex CLI commands in the terminal to verify the full data chain.** Use `npx convex run` to query each table — do **not** open the Convex dashboard (it's a browser UI; the agent's browser is reserved for the app only):

    ```bash
    # Step 5a: Check that the webhook event arrived and was processed
    npx convex run rawWebhookEvents:getLatest
    # Confirm: eventType = "invitee.created", processed = true, payload contains form data

    # Step 5b: Verify the lead was created/updated
    npx convex run leads:getByEmail '{"email": "vas.claudio15+lead4@icloud.com"}'
    # Confirm: fullName, phone, customFields match what you entered in the Calendly form

    # Step 5c: Verify the opportunity was created (use the leadId from step 5b)
    npx convex run opportunities:getByLeadId '{"leadId": "<leadId_from_5b>"}'
    # Confirm: status = "scheduled", assignedCloserId is set, latestMeetingId is populated

    # Step 5d: Verify the meeting was created (use the opportunityId from step 5c)
    npx convex run meetings:getByOpportunityId '{"opportunityId": "<opportunityId_from_5c>"}'
    # Confirm: status = "scheduled", scheduledAt matches, leadName is set, durationMinutes is correct
    ```

    > **Note:** If a `npx convex run` function doesn't exist for the query you need, write a temporary query in `convex/` or use `npx convex data` commands. Never fall back to the dashboard browser.

6. **Check for processing errors:**

    ```bash
    # Look at the Convex function logs for any errors during processing
    npx convex logs
    # Filter for [Pipeline] or [Calendly] tagged messages
    # Any errors here mean the webhook was received but processing failed
    ```

7. **If any check fails, stop here.** Do not proceed to browser validation until the CLI confirms all records exist and are correct. Common issues are documented in [Debugging Failed Webhooks](#debugging-failed-webhooks).

### Phase 3: Validate in the Web App

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

> **All backend checks must be performed via `npx convex run` and `npx convex logs` in the terminal.** Do not use `npx convex dashboard` — it opens a browser, and the agent's browser must only be used for the actual app.

- [ ] `rawWebhookEvents` — `npx convex run rawWebhookEvents:getLatest` → event received, `processed: true`, no errors in payload
- [ ] `leads` — `npx convex run leads:getByEmail '{"email": "..."}'` → record exists with correct `email`, `fullName`, `phone`, `customFields`
- [ ] `opportunities` — `npx convex run opportunities:getByLeadId '{"leadId": "..."}'` → record exists with `status: "scheduled"`, valid `assignedCloserId`, `latestMeetingId` populated
- [ ] `meetings` — `npx convex run meetings:getByOpportunityId '{"opportunityId": "..."}'` → record exists with `status: "scheduled"`, correct `scheduledAt`, `durationMinutes`, `leadName`
- [ ] Denormalized fields — `opportunities.latestMeetingAt`, `nextMeetingId/At` correctly set (visible in the opportunity query output)
- [ ] Function logs — `npx convex logs` → no `[Pipeline]` or `[Calendly]` errors related to this event

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

## Using the Expect Skill

**Expect** is the project's browser-based QA tool. It runs a real Playwright browser and validates accessibility, performance, and correctness.

> **Critical: Expect's browser is for the app only.**
> The Expect agent must **never** open `npx convex dashboard` or navigate to `localhost:3210`. The browser is exclusively for testing the application at `localhost:3000`. All backend/database validation must happen through **Convex CLI commands in the terminal** (`npx convex run`, `npx convex logs`) — not through any browser-based dashboard.

### Prerequisites

Before running Expect, you **must** have real data in the system:

- **Minimum 3 meetings** scheduled via Calendly (so dashboards, pipelines, and lists render real content)
- **Both closers** should have at least 1 meeting assigned (test round-robin)
- Empty-state screenshots are **not valid tests**
- **Backend data verified via CLI first** — run `npx convex run` queries to confirm all records exist before opening the browser

### Workflow

1. **Seed data** — schedule meetings on Calendly as described above
2. **Verify data via Convex CLI** — run `npx convex run` and `npx convex logs` in the terminal to confirm webhooks were processed and records are correct (see [Phase 2](#phase-2-verify-webhook-processing-via-convex-cli))
3. **Make your code changes**
4. **Invoke Expect** — the skill auto-generates a test plan from your git diff
5. **Expect opens a browser** (only `localhost:3000`) and runs checks:
    - Signs in with test credentials (use `TEST_USERS_PASSWORD` from `.env.local`)
    - Navigates to affected routes
    - Takes screenshots, runs audits
6. **Review results** — accessibility violations, performance metrics, console errors
7. **Fix and re-run** if any failures

### Completion Gates

Expect enforces these before work can be marked done:

| Gate                | Tool                  | Fail condition                              |
| ------------------- | --------------------- | ------------------------------------------- |
| Accessibility audit | `accessibility_audit` | Any critical or serious WCAG violation      |
| Performance metrics | `performance_metrics` | Any Core Web Vital rated "poor"             |
| Console errors      | `console_logs`        | Any `type='error'` entries                  |
| Responsive design   | `screenshot`          | Must test 4 viewports: 375, 768, 1280, 1440 |
| Session flush       | `close`               | Must be called to save artifacts            |

### Expect MCP Tools Reference

| Tool                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `open`                | Launch browser, navigate to URL                                  |
| `playwright`          | Execute arbitrary Playwright code (click, fill, assert, etc.)    |
| `screenshot`          | Capture page: `snapshot` (ARIA), `screenshot` (PNG), `annotated` |
| `console_logs`        | Get console messages (filter by error/warning/log)               |
| `network_requests`    | Check for failed requests, 4xx/5xx, mixed content                |
| `performance_metrics` | Core Web Vitals, TTFB, Long Animation Frames                     |
| `accessibility_audit` | axe-core + IBM Equal Access WCAG audit                           |
| `close`               | End session, flush recordings to disk                            |

---

## Convex CLI — Test Environment Validation

> **The Convex CLI is the only tool for backend validation.** All commands below run in the terminal and target the test deployment configured in your `.env.local`. **Never use `npx convex dashboard`** — it opens a browser UI, and the Expect agent's browser must only be used for the actual app at `localhost:3000`.

### Essential Commands

```bash
# Start the dev server (watches files, syncs schema to the test deployment)
npx convex dev

# Query a table via an exported function (returns JSON to terminal)
npx convex run leads:getByEmail '{"email": "vas.claudio15+lead1@icloud.com"}'

# Query raw webhook events
npx convex run rawWebhookEvents:getLatest

# Query opportunities by lead
npx convex run opportunities:getByLeadId '{"leadId": "<id>"}'

# Query meetings by opportunity
npx convex run meetings:getByOpportunityId '{"opportunityId": "<id>"}'

# Stream real-time function logs (watch for webhook processing in real time)
npx convex logs
# Look for [Pipeline], [Calendly], [Auth] tagged messages

# Check recent error logs (non-streaming, for after-the-fact debugging)
npx convex logs --error
```

### When to Use Each Command

| Task                           | Command                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Verify webhook arrived         | `npx convex run rawWebhookEvents:getLatest`                                                           |
| Verify lead created            | `npx convex run leads:getByEmail '{"email": "..."}'`                                                  |
| Verify opportunity created     | `npx convex run opportunities:getByLeadId '{"leadId": "..."}'`                                        |
| Verify meeting created         | `npx convex run meetings:getByOpportunityId '{"opportunityId": "..."}'`                               |
| Check closer assignment        | Read `assignedCloserId` from the opportunity query output                                             |
| Inspect custom form fields     | Read `customFields` from the lead query output, or `payload.questions_and_answers` from the raw event |
| Debug processing failure       | `npx convex logs` or `npx convex logs --error`                                                        |
| Verify email doesn't exist yet | `npx convex run leads:getByEmail` — returns null if not found                                         |

### Tables & What to Look For

| Table              | CLI query                                    | Key fields to check                                     |
| ------------------ | -------------------------------------------- | ------------------------------------------------------- |
| `rawWebhookEvents` | `npx convex run rawWebhookEvents:getLatest`  | `eventType`, `processed`, `payload` contents            |
| `leads`            | `npx convex run leads:getByEmail`            | `email`, `fullName`, `phone`, `customFields`            |
| `opportunities`    | `npx convex run opportunities:getByLeadId`   | `status`, `assignedCloserId`, `latestMeetingId/At`      |
| `meetings`         | `npx convex run meetings:getByOpportunityId` | `status`, `scheduledAt`, `calendlyEventUri`, `leadName` |
| `users`            | `npx convex run users:list`                  | Roles, `calendlyUserUri` (for closer matching)          |

> **If a query function doesn't exist** for the check you need, write a temporary exported query in the appropriate `convex/` file. Do not fall back to the dashboard browser.

### Debugging Failed Webhooks

```bash
# 1. Check if the event arrived at all
npx convex run rawWebhookEvents:getLatest
# If no event exists: the webhook never reached Convex (check Calendly webhook config, network)
# If processed = false: the pipeline processor errored before completing

# 2. Check the function logs for the error
npx convex logs --error
# Look for [Pipeline] or [Calendly] tagged errors with the event's calendlyEventUri

# 3. Trace the data chain — query each table in sequence
npx convex run leads:getByEmail '{"email": "..."}'
npx convex run opportunities:getByLeadId '{"leadId": "..."}'
npx convex run meetings:getByOpportunityId '{"opportunityId": "..."}'
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
3. **CLI**: `npx convex run rawWebhookEvents:getLatest` → confirm `processed: true`
4. **CLI**: `npx convex run leads:getByEmail` → verify lead record
5. **CLI**: `npx convex run opportunities:getByLeadId` → note `assignedCloserId` to know which closer to log in as
6. **Browser**: Login as assigned closer → meeting visible → detail page correct
7. **Browser**: Login as admin → opportunity in pipeline, stats updated

### Scenario 2: Returning Lead (Same Email, New Meeting)

1. **CLI**: `npx convex run leads:getByEmail` — confirm the lead already exists, note current `customFields`
2. Schedule with that same email (e.g., `+lead1`)
3. **CLI**: Query lead again — verify the _existing_ lead was updated (not duplicated), `customFields` merged
4. **CLI**: Verify new opportunity + meeting created, linked to same lead
5. **Browser**: Confirm the closer sees the new meeting under the existing lead

### Scenario 3: Round-Robin Distribution

1. Schedule 4+ meetings with different lead emails
2. **CLI**: For each lead, run `npx convex run leads:getByEmail` then `npx convex run opportunities:getByLeadId` — `assignedCloserId` should alternate between closer1 and closer2
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
2. **CLI**: `npx convex run rawWebhookEvents:getLatest` — confirm the `invitee.created` event was processed first
3. Cancel it through Calendly (from the confirmation email or Calendly dashboard)
4. **CLI**: `npx convex logs` — watch for the `invitee.canceled` event processing
5. **CLI**: `npx convex run rawWebhookEvents:getLatest` — verify `invitee.canceled` event, `processed: true`
6. **CLI**: `npx convex run meetings:getByOpportunityId` — status should be `"canceled"`
7. **CLI**: `npx convex run opportunities:getByLeadId` — status should be `"canceled"`, cancellation reason captured
8. **Browser**: Login as closer → meeting should show canceled status in UI

---

## Quick Reference

### Convex CLI (terminal only — use FIRST, before browser)

| What                         | Command                                                                 |
| ---------------------------- | ----------------------------------------------------------------------- |
| Start dev server             | `npx convex dev`                                                        |
| Check webhook events         | `npx convex run rawWebhookEvents:getLatest`                             |
| Query a lead by email        | `npx convex run leads:getByEmail '{"email": "..."}'`                    |
| Query opportunity by lead    | `npx convex run opportunities:getByLeadId '{"leadId": "..."}'`          |
| Query meeting by opportunity | `npx convex run meetings:getByOpportunityId '{"opportunityId": "..."}'` |
| Stream live function logs    | `npx convex logs`                                                       |
| Check for errors             | `npx convex logs --error`                                               |
| Inspect custom form fields   | Read `customFields` from lead query or `payload` from raw event query   |

> **Never use `npx convex dashboard`** — it opens a browser. Use only `npx convex run` and `npx convex logs`.

### Calendly & App

| What                    | Where / How                                                     |
| ----------------------- | --------------------------------------------------------------- |
| Schedule a test meeting | https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm        |
| Lead email pattern      | `vas.claudio15+lead{N}@icloud.com`                              |
| Test password           | `grep TEST_USERS_PASSWORD .env.local`                           |
| Sign in                 | `http://localhost:3000/sign-in`                                 |
| Admin dashboard         | `http://localhost:3000/workspace`                               |
| Closer dashboard        | `http://localhost:3000/workspace/closer`                        |
| Meeting detail          | `http://localhost:3000/workspace/closer/meetings/[id]`          |
| Expect skill            | Invoke via `expect` in Claude Code / mention "test" or "verify" |

### Code References

| What                 | File                                |
| -------------------- | ----------------------------------- |
| Webhook handler code | `convex/pipeline/inviteeCreated.ts` |
| Status state machine | `convex/lib/statusTransitions.ts`   |
| RBAC permissions     | `convex/lib/permissions.ts`         |
