# Pipeline Operations Manual E2E Test Suite

**Status:** Draft  
**Scope:** Manual qualification for the production test tenant: Slack `/qualify-lead` -> DM link portal / UTM Calendly booking -> phone closer call -> closed deal, plus production permutations.  
**Source designs:** [`pipeline-operations-redesign-design.md`](./pipeline-operations-redesign-design.md), [`dm-link-portal-and-alias-retirement-design.md`](./deferred/dm-link-portal-and-alias-retirement-design.md)

## How to Use This Suite

Run this against the test tenant only. Use a unique run ID in every lead name, handle, email, and test payment note so the records can be found and cleaned up later.

Use the canonical Slack command currently handled by the app: `/qualify-lead`. If Slack later adds `/qualify` as an alias, run one smoke pass with the alias, but use `/qualify-lead` for the primary certification pass.

Record evidence for each case:

- [ ] Slack timestamp and setter account
- [ ] Generated Calendly URL
- [ ] Calendly booking confirmation timestamp
- [ ] Opportunity ID
- [ ] Meeting ID
- [ ] Customer ID, if a payment closes the deal
- [ ] Screenshots of Operations, opportunity detail, meeting detail, and reports where relevant

## Test Run Variables

Fill this out before starting the run.

| Variable | Value |
| --- | --- |
| Run ID | `qa-YYYYMMDD-HHMM` |
| Tenant | |
| Admin user | |
| Slack setter user | |
| Phone closer CRM user | |
| DM team | |
| DM closer | |
| Campaign | `organic` or test campaign |
| Test booked program | |
| Test sold program | |
| Calendly event type / base URL | |
| Portal URL | `/dm-links/...` |
| Portal password rotation time | |
| Test lead full name | `QA Pipeline <Run ID>` |
| Test social platform | Instagram |
| Test social handle | `@qa_pipeline_<Run ID>` |
| Test booking email | `qa+<Run ID>@example.com` |
| Test payment amount | |

## Global Preconditions

- [ ] Admin or owner can sign in to `/workspace`.
- [ ] Phone closer can sign in and has role `closer`.
- [ ] Slack integration is active in Settings -> Integrations.
- [ ] Slack `/qualify-lead` opens a modal with Full name, Social platform, and Social handle fields.
- [ ] Calendly integration is active and webhooks are processing `invitee.created`.
- [ ] The test Calendly event type has `bookingBaseUrl` set.
- [ ] The test Calendly event type has `bookingProgramId` mapped to the test booked program.
- [ ] The test Calendly event type has `bookingProgramMappingStatus = mapped`.
- [ ] The test Calendly event type is enabled for the DM link portal if portal generation is being tested.
- [ ] The DM team is active and has canonical `utm_source`.
- [ ] The DM closer is active, belongs to the selected DM team, and has canonical `utm_medium`.
- [ ] The DM team canonical source does not normalize to `ptdom`.
- [ ] At least one campaign preset is active.
- [ ] The portal is enabled and has a freshly rotated password.
- [ ] The phone closer is the Calendly host or is mapped from the event host so `assignedCloserId` can be set.
- [ ] An active tenant program exists for the sold payment.

## Primary Golden Path

### GP-01: Admin Confirms Attribution and Portal Readiness

**Goal:** Confirm the CRM configuration is capable of generating a canonical DM booking link for the test program.

1. Sign in as admin.
2. Open `/workspace/settings?tab=attribution`.
3. Confirm the Portal Access card shows the portal enabled.
4. Confirm the DM team row is active and displays the canonical `utm_source`.
5. Confirm the DM closer row is active, belongs to the selected team, and displays the canonical `utm_medium`.
6. Confirm the campaign preset is active.
7. Confirm the booking link matrix shows the test program/event type as ready.
8. Open `/workspace/settings?tab=event-types`.
9. Confirm the test event type has the expected booked program, booking base URL, and portal visibility.

Expected:

- [ ] No alias UI is required for this flow.
- [ ] No readiness badge is missing URL, unmapped, or hidden for the selected event type.
- [ ] Admin can tell which booked program the Calendly event type represents.
- [ ] The booked program is not presented as the sold/payment program.

### GP-02: Generate a Canonical DM Link

**Goal:** Generate the Calendly URL a DM closer would send to a lead.

1. Open the portal URL in a fresh browser profile or incognito window.
2. Confirm the locked screen does not reveal tenant name, DM closers, programs, campaigns, or booking URLs.
3. Enter the portal password.
4. Select the configured DM closer.
5. Select the test booked program/event type.
6. Select the campaign.
7. Copy or manually select the generated link.
8. Paste it into the run log.

Expected:

- [ ] Unlock sets access without requiring WorkOS login.
- [ ] Generated URL uses the configured Calendly `bookingBaseUrl`.
- [ ] Generated URL includes canonical `utm_source=<team source>`.
- [ ] Generated URL includes canonical `utm_medium=<dm closer medium>`.
- [ ] Generated URL includes `utm_campaign=<campaign>`.
- [ ] Existing non-UTM query params on `bookingBaseUrl` are preserved.
- [ ] Existing UTM params on `bookingBaseUrl`, if any, are overwritten with canonical values.
- [ ] No internal CRM IDs, tenant IDs, `bookingProgramId`, WorkOS org IDs, or payment links appear in the URL.

### GP-03: Qualify a Lead From Slack

**Goal:** Create the Slack qualification event and linked opportunity before any booking exists.

1. In the connected Slack workspace, run `/qualify-lead`.
2. Fill the modal:
   - Full name: `QA Pipeline <Run ID>`
   - Social platform: selected test platform
   - Social handle: `@qa_pipeline_<Run ID>`
3. Submit the modal.
4. Wait for any Slack confirmation message or notification.
5. In CRM, open `/workspace/operations?tab=qualifications`.
6. Search for the run ID.
7. Open the linked opportunity detail.

Expected:

- [ ] Slack accepts the modal submission.
- [ ] A `slackQualificationEvents` ledger row is represented in Operations.
- [ ] The Operations Qualification row has result kind equivalent to `created_opportunity`.
- [ ] Status is `qualified_pending`.
- [ ] Qualified by shows the Slack setter display name or fallback Slack user ID.
- [ ] Booked program is empty or unmapped because no Calendly booking exists yet.
- [ ] DM closer is empty because Slack qualification has no UTM attribution.
- [ ] Phone closer is empty because no meeting is assigned yet.
- [ ] Opportunity detail shows Slack qualification context.
- [ ] Opportunity source is Slack-qualified.

### GP-04: Book the Calendly Call Using the Generated UTM Link

**Goal:** Confirm a real Calendly booking links back to the Slack-qualified opportunity and writes booked-program, DM attribution, and phone closer fields.

1. Open the generated Calendly link from GP-02.
2. Book a meeting time inside the phone closer's test availability.
3. Use the same lead name and test booking email from the run variables.
4. Complete any required Calendly questions.
5. Wait for webhook processing.
6. Refresh `/workspace/operations?tab=qualifications` and search for the run ID.
7. Open `/workspace/operations?tab=scheduling` and search/filter for the run ID.
8. Open `/workspace/operations?tab=phone-sales` and search/filter for the run ID.
9. Open the opportunity detail.
10. Open the admin meeting detail from the Operations row.

Expected:

- [ ] Qualification row remains visible and now shows scheduled state.
- [ ] Opportunity status transitions from `qualified_pending` to `scheduled`.
- [ ] `firstBookedAt` is set from CRM webhook processing time.
- [ ] `firstMeetingAt` is set from Calendly scheduled start time.
- [ ] First meeting ID is linked.
- [ ] Booked program shows the test booked program.
- [ ] Opportunity first booked program matches the test booked program.
- [ ] Meeting booked program matches the test booked program.
- [ ] DM team resolves to the configured DM team.
- [ ] DM closer resolves to the configured DM closer.
- [ ] `attributionResolution` is `mapped`.
- [ ] Raw UTM values are still visible where the UI exposes raw/audit data.
- [ ] Phone closer shows the expected CRM closer from the Calendly host mapping.
- [ ] Scheduling tab uses scheduled start time for date filters.
- [ ] Phone Sales tab contains the meeting and includes booked program, DM attribution, phone closer, opportunity status, and meeting status.
- [ ] No duplicate opportunity was created for the same Slack-qualified lead.

### GP-05: Phone Closer Takes the Call

**Goal:** Confirm closer-owned meeting actions move the meeting and opportunity through execution.

1. Sign out or switch to the phone closer account.
2. Open the closer dashboard or direct closer meeting route for the meeting.
3. If testing before the start window, verify Start Meeting is disabled until 5 minutes before `scheduledAt`.
4. Inside the start window, click Start Meeting.
5. Confirm the meeting join URL opens when available.
6. Confirm the meeting detail refreshes.
7. Verify Operations as admin in another session.

Expected:

- [ ] Closer can only start their assigned meeting.
- [ ] Meeting status becomes `in_progress`.
- [ ] Opportunity status becomes `in_progress`.
- [ ] Started-at timestamp/source are shown on the meeting detail where exposed.
- [ ] Phone Sales row updates from scheduled to in-progress.
- [ ] Browser navigation away from an in-progress meeting is blocked with the End Meeting warning.

### GP-06: Closer Logs Payment and Closes the Deal

**Goal:** Confirm closing a deal records sold-program data separately from booked-program data and creates/updates the customer.

1. While signed in as the phone closer, click Log Payment on the meeting detail.
2. Enter the test payment amount.
3. Choose currency.
4. Select the sold program.
5. Select payment type.
6. Optionally upload a small PNG/JPG/PDF proof file.
7. Submit the payment.
8. Click End Meeting if the meeting is still in progress.
9. Refresh the opportunity, meeting, customer, Operations, and reports pages.

Expected:

- [ ] Payment logs successfully.
- [ ] Opportunity status becomes `payment_received`.
- [ ] Meeting can be ended and becomes `completed`.
- [ ] Sold program equals the selected payment program.
- [ ] Booked program remains the event type's booked program and is not overwritten by the sold program.
- [ ] If booked program and sold program differ, the mismatch is visible and treated as valid business data.
- [ ] Payment appears in the Deal Won card or payment history.
- [ ] Customer record exists or is updated from the winning opportunity.
- [ ] Customer detail shows winning opportunity attribution: Slack qualifier, booked program, sold program, DM team/closer, and phone closer.
- [ ] Phone Sales row outcome shows won/payment received.
- [ ] Phone Sales stats count scheduled, completed, and won correctly for the full filtered period.
- [ ] Revenue reporting uses sold program, not booked program.
- [ ] Booked-vs-sold matrix, if enabled, includes this run in the booked program x sold program cell.

## Required Production Permutations

Run these after the golden path. Reuse the same tenant, but use fresh lead names/handles unless the case explicitly requires a duplicate.

### Slack Qualification Permutations

#### SQ-01: Required Field Validation

1. Run `/qualify-lead`.
2. Submit with empty Full name.
3. Submit with empty Social handle.

Expected:

- [ ] Slack shows inline required-field errors.
- [ ] No opportunity is created for invalid submissions.
- [ ] No Operations row is created for invalid submissions.

#### SQ-02: Duplicate Pending Lead

1. Run `/qualify-lead` using the exact same platform and handle from GP-03 while the first opportunity is still active or recreate with a new pending lead.
2. Submit from the same setter.
3. Submit again from a different Slack setter if available.

Expected:

- [ ] Slack returns duplicate feedback such as "Already qualified by ...".
- [ ] A durable qualification event is still recorded for each accepted duplicate attempt.
- [ ] Operations Qualification shows the duplicate attempt with `duplicate_pending` behavior.
- [ ] Row links to the existing opportunity.
- [ ] The original opportunity is not overwritten.
- [ ] No extra active duplicate opportunity is created.

#### SQ-03: Already Booked Lead

1. Use a lead that already has a scheduled, in-progress, follow-up, or payment-received opportunity.
2. Run `/qualify-lead` with the same social platform and handle.

Expected:

- [ ] Slack indicates the lead already has a booked or active opportunity.
- [ ] A qualification event is recorded.
- [ ] Operations shows an `already_booked` style row linked to the existing opportunity.
- [ ] Existing booked-program, UTM attribution, first-booking fields, and sold-program fields are not overwritten.

#### SQ-04: Lead Exists Only in Terminal Lost, Canceled, or No-Show State

1. Create or find a lead whose prior opportunity is `lost`, `canceled`, or `no_show`.
2. Run `/qualify-lead` with the same social handle.

Expected:

- [ ] A new `qualified_pending` opportunity can be created when business rules allow requalification after terminal outcomes.
- [ ] Lead identity is reused rather than creating a duplicate lead.
- [ ] Prior terminal opportunity remains unchanged.

#### SQ-05: Slack User Display Fallback

1. Submit a qualification from a Slack user whose display name has not synced yet, or temporarily inspect a row where display is missing.

Expected:

- [ ] Operations uses a stable fallback such as truncated Slack user ID.
- [ ] Reports and detail pages do not crash on missing Slack display name.

#### SQ-06: Slack Integration Disconnected or Token Refreshing

1. In a non-critical test window, disable/reconnect Slack or use a staging tenant with inactive Slack installation.
2. Run `/qualify-lead`.

Expected:

- [ ] Slack returns a clear ephemeral disconnected/retry message.
- [ ] Bad or inactive Slack state does not create leads or opportunities.
- [ ] Admin integration card communicates that Slack must be reconnected.

### DM Link Portal and URL Permutations

#### LP-01: Wrong Password and No Data Disclosure

1. Open the portal in a fresh browser.
2. Enter an incorrect password.
3. Repeat until just below the rate-limit threshold.

Expected:

- [ ] Portal does not disclose whether the slug exists.
- [ ] Tenant name, closers, programs, campaigns, and URLs remain hidden.
- [ ] Error copy is generic and useful.
- [ ] Failed attempts do not create sessions.

#### LP-02: Rate-Limit Lockout

1. Enter incorrect passwords until the threshold is reached.
2. Try the correct password immediately after lockout.

Expected:

- [ ] Portal blocks further attempts for the configured lockout window.
- [ ] Lockout is scoped to tenant portal plus requester IP hash.
- [ ] Raw IP address is not exposed in CRM UI or logs.

#### LP-03: Rotate Password Revokes Existing Sessions

1. Unlock the portal in one browser.
2. As admin, rotate the portal password.
3. Refresh the unlocked portal browser.
4. Try the old password, then the new password.

Expected:

- [ ] Existing session is revoked.
- [ ] Old password fails.
- [ ] New password unlocks.
- [ ] Plaintext password is only shown once after rotation.

#### LP-04: Disable Portal Revokes Sessions

1. Unlock the portal.
2. As admin, disable the portal.
3. Refresh the portal page.

Expected:

- [ ] Portal returns to a generic locked/unavailable screen.
- [ ] Existing session no longer exposes bootstrap data.
- [ ] Re-enabling the portal requires valid current password/session behavior.

#### LP-05: Disabled Team or DM Closer Is Hidden

1. Disable a non-critical test DM closer.
2. Refresh the authenticated portal.
3. Disable the closer's team.

Expected:

- [ ] Disabled closer does not appear.
- [ ] Closers whose team is disabled do not appear.
- [ ] Existing old links with disabled values may book, but attribution resolves as unmapped or no longer mapped according to resolver rules.

#### LP-06: Event Type Readiness Gates Portal Visibility

Run these on a throwaway event type, not the real test event type.

1. Remove `bookingBaseUrl` and try to enable portal visibility.
2. Restore URL, remove booked-program mapping, and try to enable visibility.
3. Set mapping to unmapped and try to enable visibility.

Expected:

- [ ] Enabling visibility fails unless URL, booked program, and mapped status are present.
- [ ] Public portal hides missing URL, unmapped, and hidden event types.
- [ ] Settings shows the correct readiness badge.

#### LP-07: URL Builder Preserves and Overwrites Correct Params

1. Configure a test base URL with a non-UTM param, such as `month=2026-05`.
2. Configure or inspect a base URL that already has old `utm_source`, `utm_medium`, or `utm_campaign`.
3. Generate a portal link.

Expected:

- [ ] Non-UTM params are preserved.
- [ ] UTM params are overwritten with canonical selected values.
- [ ] URL encoding is valid for spaces and special characters.

#### LP-08: Clipboard Failure Fallback

1. Deny clipboard permission or use a browser context where clipboard API fails.
2. Click Copy.

Expected:

- [ ] Portal leaves the generated URL visible and selectable.
- [ ] User can manually copy the URL.
- [ ] No sensitive session token appears in the DOM or URL.

### UTM Attribution and Calendly Webhook Permutations

#### UT-01: Canonical Pair Maps

1. Book with canonical `utm_source` and canonical `utm_medium` from the same active team/closer pair.

Expected:

- [ ] Meeting attribution is `mapped`.
- [ ] Team and DM closer both resolve.
- [ ] Opportunity first-booking attribution resolves on the first external booking.

#### UT-02: Source-Only Maps to Team

1. Manually remove `utm_medium` from a generated test link, keeping canonical `utm_source`.
2. Book the call.

Expected:

- [ ] Meeting resolves to the DM team only.
- [ ] DM closer is blank or unknown.
- [ ] Operations can filter by team but not by specific DM closer.

#### UT-03: Medium-Only Unique Maps to Closer

1. Manually remove `utm_source`, keeping a unique canonical `utm_medium`.
2. Book the call.

Expected:

- [ ] If the closer medium is unique in the tenant, resolver maps to the DM closer and its team.
- [ ] If not unique, resolver returns unmapped rather than guessing.

#### UT-04: Unknown UTM Values Are Unmapped

1. Book with `utm_source=unknown qa team <Run ID>` and `utm_medium=unknown_qa_<Run ID>`.

Expected:

- [ ] Meeting is created.
- [ ] Opportunity is linked when lead identity can be resolved.
- [ ] Attribution resolution is `unmapped`.
- [ ] Settings -> Attribution unmapped panel surfaces the raw UTM pair.
- [ ] Operations still shows the row with raw/unmapped attribution state.

#### UT-05: Internal `ptdom` UTM Is Not External DM Attribution

1. Use a follow-up or no-show reschedule path that generates `utm_source=ptdom`, or manually test a safe internal link if available.

Expected:

- [ ] Resolution status is `internal`.
- [ ] Internal UTM is not mapped to any DM team or DM closer.
- [ ] Internal UTM does not overwrite opportunity-level first external DM attribution.
- [ ] Reports do not count internal follow-up UTMs as DM closer attribution.

#### UT-06: UTM Normalization

1. Book with source and medium values that differ only by case or extra whitespace from canonical values.

Expected:

- [ ] Resolver normalizes trim, lowercase, and whitespace collapse.
- [ ] Raw UTM strings remain stored for audit.
- [ ] Display uses canonical mapped team/closer labels.

#### UT-07: Oversized UTM Fields

1. In a controlled non-production or safe test tenant, book with a UTM field longer than 256 characters.

Expected:

- [ ] Stored raw/normalized fields are length-limited.
- [ ] Meeting is marked with `utmTruncated` where supported.
- [ ] Webhook processing does not fail.

#### UT-08: Event Type Missing Booked Program

1. Book a safe Calendly event type whose config is intentionally unmapped.

Expected:

- [ ] Meeting still creates or updates.
- [ ] Opportunity still links when possible.
- [ ] Booked program shows unmapped/not configured.
- [ ] Operations health/settings show the event type requires mapping.
- [ ] Sold program remains empty until payment.

#### UT-09: Later Booking Uses Different Booked Program

1. For an already Slack-qualified opportunity with a first external booking, book a later meeting through a different Calendly event type/program.

Expected:

- [ ] New meeting's booked program matches the later event type.
- [ ] Opportunity `firstBookingProgram*` remains the original first external booked program.
- [ ] Meeting-level attribution reflects the specific later booking.
- [ ] Reports can distinguish meeting-level booked program from opportunity first booked program.

#### UT-10: Duplicate Webhook Replay

1. Replay or trigger a duplicate `invitee.created` event in a safe environment.

Expected:

- [ ] No duplicate meeting is created for the same Calendly invitee/event identity.
- [ ] Existing meeting/opportunity fields remain coherent.
- [ ] Raw webhook event audit shows replay/duplicate handling if exposed.

#### UT-11: Unknown or Unassigned Calendly Host

1. Book through an event type or host that is not mapped to a CRM closer.

Expected:

- [ ] Webhook processing does not crash.
- [ ] Meeting is inserted with missing/invalid assignment state, or raw webhook event remains repairable.
- [ ] Operations/admin health exposes the assignment problem.
- [ ] Repairing host mapping and replaying/repairing links the phone closer.

### Operations Hub Permutations

#### OP-01: Qualification Filters

Use the qualification tab after several test rows exist.

Expected:

- [ ] Status filter finds `qualified_pending`, `scheduled`, `in_progress`, `lost`, and `payment_received` rows where present.
- [ ] Booked program filter uses first external booked program.
- [ ] Sold program filter returns only rows with payment/customer sold-program cache.
- [ ] Slack qualifier filter returns only the selected setter's qualification events.
- [ ] DM team filter returns mapped team rows.
- [ ] DM closer filter returns mapped closer rows.
- [ ] Period filter uses Slack qualification time, not opportunity created time.
- [ ] Search finds lead name, handle, email, and relevant text.
- [ ] Unlinked rows show a warning and no broken detail link.

#### OP-02: Scheduling Filters

Expected:

- [ ] Scheduling tab includes only qualification rows with first meeting set.
- [ ] Date range filters on `firstMeetingAt`, not `firstBookedAt`.
- [ ] Booked program, sold program, closer, DM team, DM closer, and Slack qualifier filters work.
- [ ] Row links open the opportunity detail and meeting detail.

#### OP-03: Phone Sales Filters and Stats

Expected:

- [ ] Phone Sales tab includes meetings, including non-Slack meetings if in scope for tenant operations.
- [ ] Phone closer filter uses `assignedCloserId`.
- [ ] Booked program filter uses meeting `bookingProgramId`.
- [ ] Sold program filter uses winning payment/customer sold program.
- [ ] Meeting status and opportunity status filters work.
- [ ] DM team and DM closer filters work from meeting-level attribution.
- [ ] Stats header is computed over the full filtered date range, not just the current page.
- [ ] Show rate uses completed and no-show counts as designed.

#### OP-04: Legacy Pipeline Redirects

1. Open `/workspace/pipeline`.
2. Open `/workspace/pipeline?status=scheduled`.
3. Open `/workspace/pipeline?status=payment_received`.

Expected:

- [ ] Bare pipeline route redirects to Operations or the intended replacement.
- [ ] Scheduled/in-progress/no-show meeting-oriented filters map to `/workspace/operations?tab=phone-sales`.
- [ ] Opportunity-oriented filters map to `/workspace/opportunities`.
- [ ] Existing admin meeting detail routes still open.

#### OP-05: Role Access

Expected:

- [ ] Tenant owner/admin can access Operations and attribution settings.
- [ ] CRM closer cannot access admin Operations or attribution settings.
- [ ] CRM closer can access only their own closer pipeline/meeting routes.
- [ ] System admin org access follows existing admin rules and does not leak tenant workspace data.

### Phone Sales Outcome Permutations

#### PS-01: Booked Program Equals Sold Program

1. Close a call with the same program selected for booking and payment.

Expected:

- [ ] Opportunity sold program equals booked program.
- [ ] Reports count revenue under sold program.
- [ ] Booked-vs-sold matrix lands on the diagonal cell.

#### PS-02: Booked Program Differs From Sold Program

1. Book through the test booked program.
2. Log payment against a different active program.

Expected:

- [ ] Payment succeeds.
- [ ] Booked program remains original event type program.
- [ ] Sold program is the payment/customer program.
- [ ] UI treats mismatch as valid, not an error.
- [ ] Booked-vs-sold matrix lands on the off-diagonal cell.

#### PS-03: Mark Lost

1. Start the meeting.
2. Click Mark as Lost.
3. Enter a reason if prompted.
4. End the meeting if still in progress.

Expected:

- [ ] Opportunity status becomes `lost`.
- [ ] Meeting lifecycle can still be ended/completed explicitly.
- [ ] Operations outcome shows lost.
- [ ] Sold program remains empty.
- [ ] Attribution and booked program remain visible.

#### PS-04: Mark No-Show

1. Start or open a scheduled meeting in an allowed no-show path.
2. Click Mark No-Show.
3. Confirm.

Expected:

- [ ] Opportunity status becomes `no_show`.
- [ ] Meeting status becomes `no_show` or no-show state per current UI.
- [ ] Operations counts no-show.
- [ ] No sold program is set.
- [ ] No-show reschedule action appears where designed.

#### PS-05: No-Show Reschedule Uses Internal UTM

1. From a no-show opportunity, generate/send the reschedule link.
2. Book through that link.

Expected:

- [ ] Link uses internal `utm_source=ptdom` where designed.
- [ ] New meeting does not overwrite the original first external DM attribution.
- [ ] New meeting can be tracked as internal follow-up/reschedule.
- [ ] Opportunity/meeting refs update to latest/next meeting correctly.

#### PS-06: Schedule Follow-Up Instead of Payment

1. Start a meeting.
2. Use Schedule Follow-Up.

Expected:

- [ ] Opportunity moves to follow-up state.
- [ ] Meeting lifecycle can be ended explicitly.
- [ ] No sold program is set.
- [ ] Operations and reports do not count the row as won.

#### PS-07: Payment Form Validation

Expected:

- [ ] Empty amount is rejected.
- [ ] Zero or negative amount is rejected.
- [ ] Missing program is rejected.
- [ ] Missing payment type is rejected.
- [ ] Invalid proof file type is rejected.
- [ ] Proof file larger than 10 MB is rejected.
- [ ] If no active programs exist, user sees a clear error.

#### PS-08: Closer Access Boundary

1. Sign in as a different closer.
2. Try to open or act on the test meeting.

Expected:

- [ ] Different closer cannot start the meeting.
- [ ] Different closer cannot log payment.
- [ ] Different closer cannot mark lost/no-show.
- [ ] Admin detail access remains governed by admin role.

#### PS-09: Meeting Start Window

Expected:

- [ ] Start Meeting is disabled before 5 minutes prior to scheduled time.
- [ ] Start Meeting enables inside the window.
- [ ] Starting after scheduled time plus duration is rejected with a useful message.

#### PS-10: Payment Void or Correction

If the app exposes a safe void/correction workflow, run this on a test payment.

Expected:

- [ ] Voiding payment updates payment status.
- [ ] Sold-program caches are cleared or recomputed.
- [ ] Opportunity/customer/reporting totals update.
- [ ] Booked-program attribution remains unchanged.

### Entity Detail and Reporting Permutations

#### DR-01: Opportunity Detail Attribution

Expected:

- [ ] Opportunity detail shows Slack qualifier.
- [ ] Opportunity detail shows booked program from first external booking.
- [ ] Opportunity detail shows sold program after payment.
- [ ] Opportunity detail shows DM team/closer attribution.
- [ ] Opportunity detail shows phone closer.
- [ ] Duplicate qualification attempts are visible or at least do not hide the canonical qualification context.

#### DR-02: Meeting Detail Attribution

Expected:

- [ ] Admin meeting detail and closer meeting detail show booked program.
- [ ] Meeting detail shows meeting-level DM team/closer.
- [ ] Meeting detail shows raw UTM/audit fields where designed.
- [ ] Later meetings can show different booked program or UTM attribution from first booking.

#### DR-03: Customer Detail Attribution

Expected:

- [ ] Customer detail links to the winning opportunity.
- [ ] Customer detail shows booked program and sold program.
- [ ] Customer detail shows Slack qualifier, DM closer/team, and phone closer.
- [ ] Payment history uses sold-program/payment data.

#### DR-04: Reports Reconciliation

Use the same date range covering the test run.

Expected:

- [ ] Reports -> Slack Qualifications counts ledger qualification events, including duplicate/already-booked attempts if those were run.
- [ ] Reports -> Pipeline Health can filter by booked program, DM team, and DM closer.
- [ ] Reports -> Team can filter by phone closer and attribution dimensions.
- [ ] Reports -> Revenue uses sold program for revenue totals.
- [ ] Booked-vs-sold matrix totals match relevant won test payments.
- [ ] Differences between old and redesigned reports are explained in [`reporting-parity-checklist.md`](./reporting-parity-checklist.md).

## Cleanup and Audit

Do not delete production test-tenant rows unless a specific cleanup tool exists and the owner approves it. Prefer marking the run ID in notes/screenshots and keeping the records for audit until the release decision is made.

Cleanup record:

| Artifact | ID / URL | Keep or remove | Notes |
| --- | --- | --- | --- |
| Lead | | | |
| Opportunity | | | |
| Slack qualification event | | | |
| Meeting | | | |
| Payment | | | |
| Customer | | | |
| Portal copy event | | | |
| Raw webhook event | | | |

## Release Qualification Checklist

- [ ] Golden path GP-01 through GP-06 passed.
- [ ] At least one Slack duplicate or already-booked case passed.
- [ ] At least one unmapped UTM case passed.
- [ ] At least one booked-program/sold-program mismatch case passed.
- [ ] Portal password rotation and disable-session revocation passed.
- [ ] Phone closer access boundary passed.
- [ ] Operations Qualification, Scheduling, and Phone Sales filters passed.
- [ ] Opportunity, meeting, and customer attribution detail pages passed.
- [ ] Reports reconciliation pass completed.
- [ ] No tenant data isolation issue observed.
- [ ] No raw password, session token, WorkOS org ID, tenant ID, or full generated URL was logged in a place it should not be.
- [ ] Any failures have owner, severity, reproduction steps, and linked screenshots.
