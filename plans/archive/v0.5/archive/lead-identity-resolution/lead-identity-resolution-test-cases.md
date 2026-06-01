# Lead Identity Resolution - Test Cases

**Feature:** v0.5 Lead Identity Resolution
**Date:** 2026-04-10
**Method:** Convex CLI backend validation first, then Expect browser verification
**Prerequisite:** `npx convex dev` and `pnpm dev` are running, and the test deployment is connected to Calendly

> Follow `TESTING.MD` exactly: validate the backend through the Convex CLI before opening the browser, and use the Expect skill for all UI verification.

---

## Table of Contents

1. [Scope](#1-scope)
2. [Implementation Notes That Affect Testing](#2-implementation-notes-that-affect-testing)
3. [Observed Test Deployment State](#3-observed-test-deployment-state)
4. [Global Setup](#4-global-setup)
5. [TC-A: Field Mappings UI](#5-tc-a-field-mappings-ui)
6. [TC-B: Exact Email Match](#6-tc-b-exact-email-match)
7. [TC-C: Exact Social Handle Match](#7-tc-c-exact-social-handle-match)
8. [TC-D: Exact Phone Match Via Custom Field Override](#8-tc-d-exact-phone-match-via-custom-field-override)
9. [TC-E: Potential Duplicate Positive](#9-tc-e-potential-duplicate-positive)
10. [TC-F: Potential Duplicate Negative For Public Domains](#10-tc-f-potential-duplicate-negative-for-public-domains)
11. [TC-G: Cross-Case Regression Checks](#11-tc-g-cross-case-regression-checks)
12. [TC-H: Non-Functional Expect Gates](#12-tc-h-non-functional-expect-gates)
13. [Completion Checklist](#13-completion-checklist)

---

## 1. Scope

This suite covers the implemented behavior in:

- `convex/pipeline/inviteeCreated.ts`
- `convex/lib/normalization.ts`
- `convex/schema.ts`
- `convex/closer/meetingDetail.ts`
- `app/workspace/settings/_components/field-mappings-tab.tsx`
- `app/workspace/settings/_components/field-mapping-dialog.tsx`
- `app/workspace/closer/meetings/_components/potential-duplicate-banner.tsx`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx`

The suite is intended to prove:

- field mappings can be configured through the existing Settings UI
- exact email matches reuse the same lead
- exact social handle matches reuse the same lead when the mapping is configured
- exact phone matches reuse the same lead when the phone override mapping is configured
- fuzzy duplicate detection flags a potential duplicate for non-public domains
- fuzzy duplicate detection does not flag public domains like `icloud.com`

---

## 2. Implementation Notes That Affect Testing

These are important so the tester does not report correct behavior as a failure:

- The meeting detail route is currently closer-only at the page level via `requireRole(["closer"])` in `app/workspace/closer/meetings/[meetingId]/page.tsx`. Use the assigned closer account for meeting-detail UI verification, not the tenant owner.
- On social-handle and phone matches, the existing lead is reused, but `leads.email` stays on the original lead row. New emails are stored as additional `leadIdentifiers`, not by rewriting the lead's primary email.
- `lead.fullName`, `lead.phone`, and `lead.customFields` are lead-level fields. Later bookings for the same lead overwrite or merge those values.
- `Booking Answers` on the meeting detail page renders `lead.customFields`, not a meeting-specific snapshot.
- The duplicate banner is informational only. There is no merge or dismiss action in this feature.
- Public domains are intentionally excluded from fuzzy duplicate detection. The current exclusion set includes `icloud.com`, `gmail.com`, `yahoo.com`, `hotmail.com`, `outlook.com`, and similar providers.

---

## 3. Observed Test Deployment State

Observed via read-only Convex CLI on 2026-04-10:

- test tenant exists and is active
- the useful Calendly event type is `Test meeting for CRM`
- its currently discovered custom questions are:
  - `Instagram Handle`
  - `Phone Number`
  - `Random question`
- the current `eventTypeConfigs` row for that event type already exists
- current saved mappings appear to include `phoneField: "Phone Number"` only
- `leads`, `opportunities`, `meetings`, and `leadIdentifiers` were empty at the time of inspection

Treat this as helpful context, not a hard assumption. Re-check before running the suite.

---

## 4. Global Setup

### 4.1 One-Time Discovery

```bash
# 1. Find the active tenant
npx convex data tenants

# 2. List event types for that tenant
npx convex run testing/calendly:listEventTypes '{"tenantId":"<tenantId>"}'

# 3. Inspect the exact custom question names
npx convex run testing/calendly:getEventTypeDetailsForTesting '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'

# 4. Verify current event type config state
npx convex data eventTypeConfigs

# 5. Verify test users and closer IDs
npx convex data users
```

Use the event type whose display name is `Test meeting for CRM`.

As of this analysis, the expected custom question names are:

- `Instagram Handle`
- `Phone Number`
- `Random question`

If Calendly question text changes, update every `questionAnswers` object and every UI assertion in this document to use the exact names returned by `testing/calendly:getEventTypeDetailsForTesting`.

### 4.1.1 Fallback discovery booking

Use this only if the `Test meeting for CRM` config is missing or `knownCustomFieldKeys` is empty:

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-seed-01@icloud.com",
  "inviteeName":"EIR Seed Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Instagram Handle":"eir_seed_handle",
    "Phone Number":"+15005551000",
    "Random question":"EIR_SEED"
  }
}'
```

Then re-run:

```bash
npx convex data eventTypeConfigs
```

Expected:

- the event type config exists
- `knownCustomFieldKeys` is populated
- the `Configure` button in the Field Mappings UI is enabled

### 4.2 Password and Sign-In

```bash
grep TEST_USERS_PASSWORD .env.local
```

UI routes used in this suite:

- `http://localhost:3000/sign-in`
- `http://localhost:3000/workspace/settings`
- `http://localhost:3000/workspace/closer/meetings/<meetingId>`

### 4.3 Booking Workflow Rule

For every booked meeting:

1. Run the booking command.
2. Copy the returned `eventUri`.
3. Use CLI to confirm the webhook processed and to find the `meetingId`, `opportunityId`, `leadId`, and `assignedCloserId`.
4. Cross-reference `assignedCloserId` in `npx convex data users`.
5. Only then open the browser with the matching closer account.

### 4.4 Tracking Worksheet

Record these values as you go:

| Alias | Booking purpose | eventUri | meetingId | opportunityId | leadId | assignedCloserEmail |
| --- | --- | --- | --- | --- | --- | --- |
| `E1` | email case first booking |  |  |  |  |  |
| `E2` | email case second booking |  |  |  |  |  |
| `S1` | social case first booking |  |  |  |  |  |
| `S2` | social case second booking |  |  |  |  |  |
| `P1` | phone case first booking |  |  |  |  |  |
| `P2` | phone case second booking |  |  |  |  |  |
| `D1` | duplicate positive first booking |  |  |  |  |  |
| `D2` | duplicate positive second booking |  |  |  |  |  |
| `N1` | duplicate negative first booking |  |  |  |  |  |
| `N2` | duplicate negative second booking |  |  |  |  |  |

### 4.5 Common CLI Checks After Every Booking

```bash
# Raw webhook received and processed
npx convex data rawWebhookEvents

# Record creation
npx convex data leads
npx convex data opportunities
npx convex data meetings
npx convex data leadIdentifiers

# Recent processing logs
npx convex logs --history 200
```

Useful lookup pattern once you have the returned `eventUri`:

```bash
npx convex data rawWebhookEvents | rg '<eventUri>'
npx convex data opportunities | rg '<eventUri>'
npx convex data meetings | rg '<eventUri>'
```

Minimum assertions for every booking:

- `rawWebhookEvents` contains an `invitee.created` row for that booking
- `processed` is `true`
- no uncaught `[Pipeline]`, `[Pipeline:Identity]`, or `[EventTypeConfig]` errors appear in recent logs

---

## 5. TC-A: Field Mappings UI

**Goal:** Verify the admin can configure the mappings that Feature E reads during webhook processing.

**Role for UI:** `vas.claudio15+tenantowner@icloud.com`

### TC-A1: Verify the Field Mappings tab loads

CLI pre-check:

```bash
npx convex data eventTypeConfigs
```

Expected:

- `Test meeting for CRM` exists
- `knownCustomFieldKeys` includes `Instagram Handle`, `Phone Number`, and `Random question`

Expect verification:

1. Sign in as the tenant owner.
2. Open `/workspace/settings`.
3. Open the `Field Mappings` tab.
4. Verify there is a card for `Test meeting for CRM`.
5. Verify the card shows booking count and field count.
6. Click `Configure`.
7. Verify the dialog title is `Configure Field Mappings`.
8. Verify the description references `Test meeting for CRM`.
9. Verify the dropdown options include:
   - `Instagram Handle`
   - `Phone Number`
   - `Random question`

### TC-A2: Inline validation in the dialog

Expect verification:

1. In `Social Handle Field`, select `Instagram Handle`.
2. Leave `Social Platform` at `(none)`.
3. Click `Save Mappings`.
4. Verify the inline validation message: `Select a platform when a social handle field is mapped.`
5. Select `Phone Number` for both `Social Handle Field` and `Phone Field (Override)`.
6. Click `Save Mappings`.
7. Verify the inline validation message: `Cannot use the same field for both social handle and phone.`

### TC-A3: Save the mappings used by the rest of this suite

Expect verification:

1. Re-open the dialog if needed.
2. Set:
   - `Social Handle Field` -> `Instagram Handle`
   - `Social Platform` -> `Instagram`
   - `Phone Field (Override)` -> `Phone Number`
3. Click `Save Mappings`.
4. Verify the toast: `Field mappings saved`.
5. Verify the event type card shows both badges:
   - `Instagram mapped`
   - `Phone mapped`
6. Refresh the page.
7. Re-open the dialog.
8. Verify the same values persist.

CLI post-check:

```bash
npx convex data eventTypeConfigs
```

Expected:

- `customFieldMappings.socialHandleField` is `Instagram Handle`
- `customFieldMappings.socialHandleType` is `instagram`
- `customFieldMappings.phoneField` is `Phone Number`

### TC-A4: Authorization

**Role for UI:** `vas.claudio15+closer1@icloud.com`

Expect verification:

1. Sign in as `closer1`.
2. Open `/workspace/settings`.
3. Verify the app redirects away from Settings to the closer workspace.
4. Verify the `Field Mappings` tab is not available to the closer.

---

## 6. TC-B: Exact Email Match

**Goal:** Verify the same email reuses the same lead and does not create duplicate email identifiers.

Use the same email for both bookings:

- `vas.claudio15+eir-email-01@icloud.com`

### TC-B1: First booking

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-email-01@icloud.com",
  "inviteeName":"EIR Email Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005551001",
  "windowDays":2,
  "questionAnswers":{
    "Random question":"EIR_EMAIL_1"
  }
}'
```

### TC-B2: Second booking with the same email

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-email-01@icloud.com",
  "inviteeName":"EIR Email Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "textReminderNumber":"+15005551001",
  "windowDays":2,
  "questionAnswers":{
    "Random question":"EIR_EMAIL_2"
  }
}'
```

CLI validation:

1. Capture the returned `eventUri` values for `E1` and `E2`.
2. Find the lead row for `vas.claudio15+eir-email-01@icloud.com`.
3. Verify:
   - exactly one lead row exists for that email
   - both opportunities use the same `leadId`
   - both meetings exist
   - `leadIdentifiers` contains one `email` identifier for that email, not two
   - there is no `potentialDuplicateLeadId` on either opportunity

Expect verification:

1. Sign in as the closer assigned to `E2`.
2. Open `/workspace/closer/meetings/<E2 meetingId>`.
3. Verify `Lead Information` shows `vas.claudio15+eir-email-01@icloud.com`.
4. Verify `Meeting History` shows two entries.
5. Verify the current meeting is marked `Current`.
6. Verify there is no `Potential Duplicate Lead` banner.
7. Verify `Booking Answers` includes `Random question` with `EIR_EMAIL_2`.

---

## 7. TC-C: Exact Social Handle Match

**Goal:** Verify a mapped social handle resolves an existing lead even when the booking email changes.

Important expected behavior:

- the second booking should reuse the first lead
- `leads.email` should remain the first email
- the second email should be stored as an additional `leadIdentifier`

### TC-C1: First booking with raw Instagram handle

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-social-01@icloud.com",
  "inviteeName":"EIR Social Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Instagram Handle":"eir_social_match",
    "Random question":"EIR_SOCIAL_1"
  }
}'
```

### TC-C2: Second booking with a different email but the same Instagram account as a URL

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-social-02@icloud.com",
  "inviteeName":"EIR Social Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Instagram Handle":"https://www.instagram.com/eir_social_match/",
    "Random question":"EIR_SOCIAL_2"
  }
}'
```

CLI validation:

1. Capture the returned `eventUri` values for `S1` and `S2`.
2. Verify:
   - only one lead row exists across the two social-case bookings
   - the surviving lead's primary `email` is `vas.claudio15+eir-social-01@icloud.com`
   - there is no separate lead row whose primary email is `vas.claudio15+eir-social-02@icloud.com`
   - `leadIdentifiers` contains:
     - one `instagram` identifier with value `eir_social_match` and confidence `inferred`
     - one `email` identifier for `...social-01...`
     - one `email` identifier for `...social-02...`
   - the lead's `socialHandles` array includes `instagram / eir_social_match`
   - both opportunities point to the same `leadId`
   - neither opportunity has `potentialDuplicateLeadId`

Expect verification:

1. Sign in as the closer assigned to `S2`.
2. Open `/workspace/closer/meetings/<S2 meetingId>`.
3. Verify `Lead Information` shows the first email, `vas.claudio15+eir-social-01@icloud.com`.
4. Verify `Meeting History` shows two entries.
5. Verify there is no `Potential Duplicate Lead` banner.
6. Verify `Booking Answers` still renders and includes `Instagram Handle`.

---

## 8. TC-D: Exact Phone Match Via Custom Field Override

**Goal:** Verify the mapped `Phone Number` custom field participates in identity resolution even when the built-in Calendly phone field is not used.

Important expected behavior:

- the pipeline should use `customFieldMappings.phoneField`
- phone matching should work across different raw formats that normalize to the same E.164 value
- the lead's displayed phone is the latest raw booking value, not the normalized identifier value

### TC-D1: First booking with a custom phone value only

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-phone-01@icloud.com",
  "inviteeName":"EIR Phone Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Phone Number":"(500) 555-0121",
    "Random question":"EIR_PHONE_1"
  }
}'
```

### TC-D2: Second booking with a different email and a differently formatted version of the same number

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-phone-02@icloud.com",
  "inviteeName":"EIR Phone Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Phone Number":"+1 500 555 0121",
    "Random question":"EIR_PHONE_2"
  }
}'
```

CLI validation:

1. Capture the returned `eventUri` values for `P1` and `P2`.
2. Verify:
   - only one lead row exists across the two phone-case bookings
   - the lead's primary email remains `vas.claudio15+eir-phone-01@icloud.com`
   - `leadIdentifiers` contains exactly one `phone` identifier with normalized value `+15005550121` and confidence `verified`
   - that same lead also has both email identifiers
   - both opportunities point to the same `leadId`
   - no `potentialDuplicateLeadId` was set

Expect verification:

1. Sign in as the closer assigned to `P2`.
2. Open `/workspace/closer/meetings/<P2 meetingId>`.
3. Verify `Lead Information` shows the latest raw phone value: `+1 500 555 0121`.
4. Verify `Meeting History` shows two entries.
5. Verify there is no `Potential Duplicate Lead` banner.
6. Verify `Booking Answers` includes `Phone Number`.

---

## 9. TC-E: Potential Duplicate Positive

**Goal:** Verify fuzzy duplicate detection creates a new lead but flags the opportunity when the names are similar and the email domain is non-public.

Do not provide a social handle or phone in this case.

### TC-E1: First booking

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"eir-dup-01@identity-qa.example.com",
  "inviteeName":"Marina Cole",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Random question":"EIR_DUP_1"
  }
}'
```

### TC-E2: Second booking with similar name and same non-public domain

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"eir-dup-02@identity-qa.example.com",
  "inviteeName":"Marina Cole Jr",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Random question":"EIR_DUP_2"
  }
}'
```

CLI validation:

1. Capture the returned `eventUri` values for `D1` and `D2`.
2. Verify:
   - two distinct lead rows exist
   - the second opportunity has `potentialDuplicateLeadId` set
   - `potentialDuplicateLeadId` points to the first lead
   - `leadIdentifiers` contains only email identifiers for this case
   - no social or phone identifiers were created for this case

Expect verification:

1. Sign in as the closer assigned to `D2`.
2. Open `/workspace/closer/meetings/<D2 meetingId>`.
3. Verify the amber `Potential Duplicate Lead` banner is visible.
4. Verify the banner text references:
   - the current lead name `Marina Cole Jr`
   - the suspected duplicate `Marina Cole`
   - the duplicate lead email `eir-dup-01@identity-qa.example.com`
5. Verify the banner is informational only and has no merge action.

Optional extra check:

1. Open `/workspace/closer/meetings/<D1 meetingId>` as the closer assigned to `D1`.
2. Verify the first meeting does not show the banner.

---

## 10. TC-F: Potential Duplicate Negative For Public Domains

**Goal:** Verify similar names on a public email domain do not produce a duplicate suggestion.

Do not provide a social handle or phone in this case.

### TC-F1: First booking

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-public-01@icloud.com",
  "inviteeName":"Public Domain Lead",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Random question":"EIR_PUBLIC_1"
  }
}'
```

### TC-F2: Second booking with similar name on the same public domain family

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId":"<tenantId>",
  "eventTypeUri":"<eventTypeUri>",
  "inviteeEmail":"vas.claudio15+eir-public-02@icloud.com",
  "inviteeName":"Public Domain Lead Jr",
  "inviteeTimezone":"America/Tegucigalpa",
  "windowDays":2,
  "questionAnswers":{
    "Random question":"EIR_PUBLIC_2"
  }
}'
```

CLI validation:

1. Capture the returned `eventUri` values for `N1` and `N2`.
2. Verify:
   - two distinct lead rows exist
   - the second opportunity does not have `potentialDuplicateLeadId`
   - no banner-triggering duplicate suggestion was stored

Expect verification:

1. Sign in as the closer assigned to `N2`.
2. Open `/workspace/closer/meetings/<N2 meetingId>`.
3. Verify there is no `Potential Duplicate Lead` banner.
4. Verify the page otherwise loads normally.

---

## 11. TC-G: Cross-Case Regression Checks

Run these after all functional cases above.

### TC-G1: Lead identifier confidence and uniqueness

CLI validation:

```bash
npx convex data leadIdentifiers
```

Verify:

- email identifiers are stored with `confidence = "verified"`
- phone identifiers are stored with `confidence = "verified"`
- instagram identifiers are stored with `confidence = "inferred"`
- there are no duplicate rows for the same `(tenantId, type, value)` pair

### TC-G2: Denormalized social handles

CLI validation:

```bash
npx convex data leads
```

Verify:

- the reused social-match lead contains `socialHandles`
- the phone-match and email-match leads do not accidentally gain unrelated social handles

### TC-G3: Processing logs

CLI validation:

```bash
npx convex logs --history 300
```

Verify:

- no uncaught errors in the invitee pipeline
- no unexpected identifier-conflict warnings for the planned test cases
- field-mapping saves do not log backend validation failures during the successful save path

---

## 12. TC-H: Non-Functional Expect Gates

Run these after the functional cases pass.

### TC-H1: Responsive checks

Use the Expect skill on:

- `/workspace/settings` with the `Field Mappings` tab open
- `/workspace/closer/meetings/<D2 meetingId>` with the duplicate banner visible

Test these viewports:

- `375x812`
- `768x1024`
- `1280x800`
- `1440x900`

Verify:

- no horizontal overflow
- dialog controls remain usable on mobile
- the duplicate banner wraps cleanly without clipped text
- meeting detail content remains readable

### TC-H2: Console and network checks

For the same two routes above, use Expect to confirm:

- browser console has no `error` entries
- network requests do not contain 4xx or 5xx failures in the tested flow

### TC-H3: Accessibility audit

Run Expect `accessibility_audit` on:

- the `Field Mappings` tab
- the duplicate-banner meeting detail page

Fail the suite on any critical or serious violations.

### TC-H4: Performance metrics

Run Expect `performance_metrics` on:

- the `Field Mappings` tab
- the duplicate-banner meeting detail page

Fail the suite on:

- any Web Vital rated `poor`
- any LoAF with blocking duration over `150ms`

---

## 13. Completion Checklist

- [ ] Tenant and event type verified through the CLI
- [ ] Field mappings configured to `Instagram Handle -> instagram` and `Phone Number -> phone override`
- [ ] Same-email pair reuses one lead and shows two meetings in UI
- [ ] Same-Instagram pair reuses one lead and stores the second email only in `leadIdentifiers`
- [ ] Same-phone pair reuses one lead through the mapped custom phone field
- [ ] Non-public-domain duplicate pair creates two leads and flags the second opportunity
- [ ] Public-domain duplicate pair creates two leads and does not flag the second opportunity
- [ ] `leadIdentifiers` confidence values are correct and unique
- [ ] `socialHandles` denormalization is correct
- [ ] Settings UI authorization is enforced for closers
- [ ] Responsive, console/network, accessibility, and performance checks pass in Expect
