# Phone Closer Overrun Refactor Scope

Date: 2026-05-28
Status: exploratory brainstorm, not an implementation design

## Summary

The phone-closer "Start Meeting / End Meeting / Meeting Overran" system is deeply coupled into the product. It is not just a UI feature. It currently controls:

- How a closer opens a meeting link.
- How an opportunity becomes actionable.
- How a stale scheduled meeting is detected.
- How admin reviews are created and resolved.
- How several reports calculate show-up, timing, review-required, and compliance metrics.

The highest-risk finding: outcome actions are currently gated on `opportunity.status === "in_progress"` or a pending `meeting_overran` review. If we remove Start/End without changing the outcome contract, a normal scheduled meeting cannot log payment, schedule follow-up, mark no-show, or mark lost.

Recommended direction for the design phase:

1. Remove Start Meeting and End Meeting as required lifecycle controls.
2. Keep the meeting join link as a normal link/button, not a state transition.
3. Let outcome actions operate directly from eligible scheduled meetings.
4. Stop producing `meeting_overran`, `meetingReviews`, attendance checks, and actual-duration timing data.
5. Preserve operational records: opportunities, leads, meetings, payments, follow-ups, no-show records, cancellations, reschedule chains, and optional Fathom links.
6. Do not preserve `meeting_overran` as a hidden legacy status. The target state is as if overran never existed: clean every existing overran artifact before removing the schema literals/table.

## Current System

### Meeting creation schedules overrun detection

On Calendly `invitee.created`, the pipeline creates a meeting and schedules an attendance check for `scheduledAt + durationMinutes + 1 minute`.

Key references:

- `convex/lib/attendanceChecks.ts`
- `convex/pipeline/inviteeCreated.ts`
- `convex/closer/meetingOverrun.ts`
- `convex/closer/meetingOverrunSweep.ts`
- `convex/crons.ts`

The check marks still-`scheduled` meetings as `meeting_overran`, creates a `meetingReviews` row, and usually moves the opportunity to `meeting_overran`.

There is also a 5-minute cron sweep that catches stale scheduled meetings and routes them into the same detector.

### Start Meeting is the main unlock

`api.closer.meetingActions.startMeeting`:

- Requires the meeting to be `scheduled`.
- Rejects starts after the scheduled end window.
- Cancels the attendance check.
- Sets meeting status to `in_progress`.
- Sets opportunity status to `in_progress`.
- Writes `startedAt`, `startedAtSource`, and `lateStartDurationMs`.
- Returns the meeting join URL.

This is the source of friction: opening the meeting and unlocking outcomes are tied to a CRM state transition.

### End Meeting creates actual-duration data

`api.closer.meetingActions.stopMeeting`:

- Requires meeting status `in_progress`.
- Sets meeting status to `completed`.
- Writes `stoppedAt`, `stoppedAtSource`, `completedAt`, and `exceededScheduledDurationMs`.
- Emits `meeting.stopped`.

The frontend hard-blocks navigation away from an in-progress meeting until the closer clicks End Meeting.

Key references:

- `app/workspace/closer/meetings/_components/end-meeting-button.tsx`
- `hooks/use-in-progress-meeting-guard.ts`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx`

### Outcome actions depend on the lifecycle

The action bar only shows:

- Start Meeting for scheduled meetings in the start window.
- End Meeting for in-progress meetings.
- Payment, follow-up, no-show, and lost actions when the opportunity is `in_progress` or when it is `meeting_overran` with a pending review.

Backend transitions match that assumption. For example, `scheduled -> payment_received`, `scheduled -> follow_up_scheduled`, and `scheduled -> lost` are not valid opportunity transitions today.

Key references:

- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx`
- `convex/lib/statusTransitions.ts`
- `convex/closer/payments.ts`
- `convex/closer/followUpMutations.ts`
- `convex/closer/noShowActions.ts`
- `convex/closer/meetingActions.ts`

### Review system exists only for overran meetings

`meetingReviews` is a dedicated overran review table. The admin review inbox, review detail page, review report, and pipeline backlog card are all built around this table.

Key references:

- `convex/schema.ts`
- `convex/reviews/queries.ts`
- `convex/reviews/mutations.ts`
- `convex/reporting/reviewsReporting.ts`
- `app/workspace/reviews/`
- `app/workspace/reports/reviews/`
- `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx`

## Reference Sweep

High-confidence overran/review/attendance references:

- 67 files across `app`, `convex`, and `lib`.
- Main clusters: overran detector, review system, closer meeting UI, operations filters, pipeline reports, team reports, status validators.

High-confidence timing/lifecycle references:

- 22 files across `app`, `convex`, `hooks`, and `lib`.
- Main clusters: start/stop mutations, End Meeting button, navigation guard, meeting time report, admin manual time resolution, timing fields in schema.

Report-only surface groups:

- `app/workspace/reports/meeting-time/`: 12 files.
- `app/workspace/reports/reviews/`: 12 files.
- `app/workspace/reviews/`: 12 files.

## What To Remove

### Backend behavior

Remove or stop using:

- `startMeeting` as a required state transition.
- `stopMeeting`.
- `checkMeetingAttendance`.
- `sweepStaleMeetings`.
- `scheduleMeetingAttendanceCheck`.
- `cancelMeetingAttendanceCheck`, once queued jobs are drained.
- `meetingOverrun.respondToOverranReview`.
- `meetingOverrun.scheduleFollowUpFromOverran`.
- `assertOverranReviewStillPending` and `assertOverranReviewStillPendingViaQuery`.
- Overran-specific webhook ignore branches in `inviteeCanceled` and `inviteeNoShow`.
- Admin review resolution mutations if `meetingReviews` has no future use.
- Admin manual meeting time resolution if it only exists to repair missed Start/End usage.

### Frontend behavior

Remove:

- Start Meeting button and start-window alerts.
- End Meeting button.
- In-progress navigation blocker.
- Meeting overran banner.
- Meeting overran context dialog.
- Recorded timing section from the meeting info panel.
- Admin review inbox and detail routes if no other review type will replace them.
- Review badge count in the workspace shell.
- Review command palette entry.

Replace with:

- A normal Join Meeting action that opens `meetingJoinUrl` / `zoomJoinUrl`.
- Outcome actions that are available from a scheduled meeting when the meeting is eligible for outcome entry.

### Reporting surfaces

Remove or rewrite:

- `/workspace/reports/meeting-time`
- `/workspace/reports/reviews`
- Pipeline Health "Pending Overran Reviews" card.
- Pipeline Health "meeting-overran rows waiting for review" note.
- Team Performance "Meeting Time" summary.
- Team Performance "Review Req." columns and denominator logic.
- Operations and opportunity filters that expose `meeting_overran`.
- Pipeline and opportunity status charts that include `meeting_overran`.
- PostHog `meeting_started` funnel references.

## What To Preserve

Preserve as operational data:

- `leads`
- `opportunities`
- `meetings`
- `paymentRecords`
- `followUps`
- `customers`
- `meetingComments`
- `meetingFormResponses`
- `meetingReassignments`
- Calendly raw webhook history needed for operational debugging
- meeting schedule fields: `scheduledAt`, `durationMinutes`, event URIs, invitee URIs, join URLs, assignment fields
- no-show operational fields: `noShowMarkedAt`, `noShowReason`, `noShowNote`, `noShowMarkedByUserId`, `noShowSource`
- cancellation fields on opportunities and meetings
- reschedule chain fields
- Fathom link fields, if we want optional recording storage without enforcement

Do not preserve as legacy product state:

- `meeting_overran` literals in status unions.
- `meetingReviews` table.
- overran-specific timing/review fields on `meetings`.
- `attendanceCheckId`.

Convex still requires data at rest to match the schema at deploy time. That means cleanup must happen before the schema narrow, not that the app should ship with a hidden legacy status. The implementation window should use the current schema/code only long enough to erase the overran state, verify zero rows remain, then remove the status/table from the deployed product.

## Schema Cleanup Candidates

Delete candidates in this refactor:

- `meetings.startedAt`
- `meetings.startedAtSource`
- `meetings.stoppedAt`
- `meetings.stoppedAtSource`
- `meetings.lateStartDurationMs`
- `meetings.overranDurationMs`
- `meetings.exceededScheduledDurationMs`
- `meetings.attendanceCheckId`
- `meetings.overranDetectedAt`
- `meetings.reviewId`
- `meetingReviews` table
- `opportunities.status` literal `meeting_overran`
- `meetings.status` literal `meeting_overran`
- `operationsMeetingDailyStats.meetingStatus` literal `meeting_overran`

Possible preserve/deprecate decision:

- `meetings.completedAt`: preserve, but redefine as "meeting operationally completed/resolved at", not actual end time. If we remove actual duration tracking, this field should not be used for duration metrics.
- `meetings.noShowWaitDurationMs`: probably deprecate. It depends on `startedAt`. Keep the no-show reason and source fields.
- `meetings.fathomLink` and `fathomLinkSavedAt`: preserve if useful as an optional artifact. Remove compliance/reporting requirements around it.

## New Outcome Contract Needed

The design phase should explicitly choose this contract. A clean low-friction version:

1. Meeting link:
   - Clicking Join Meeting does not mutate Convex.
   - The meeting can remain `scheduled` until an outcome is recorded.

2. Payment:
   - Allow assigned closer or admin to log payment from `scheduled` or legacy `in_progress`.
   - Opportunity transitions to `payment_received`.
   - Meeting transitions to `completed`.
   - `completedAt = now`.
   - No `startedAt`, `stoppedAt`, or duration fields are written.

3. Follow-up:
   - Allow follow-up from `scheduled`, legacy `in_progress`, `canceled`, and `no_show` where appropriate.
   - Opportunity transitions to `follow_up_scheduled` once the follow-up is confirmed.
   - For a meeting-driven follow-up, meeting transitions to `completed` unless it is already terminal.

4. Lost:
   - Allow assigned closer to mark lost from `scheduled` or legacy `in_progress`.
   - Opportunity transitions to `lost`.
   - Meeting transitions to `completed` unless already terminal.

5. No-show:
   - Allow assigned closer to mark no-show from `scheduled` or legacy `in_progress`.
   - Opportunity transitions to `no_show`.
   - Meeting transitions to `no_show`.
   - Do not compute wait duration unless we add an explicit wait-duration input.

6. Stale scheduled meetings:
   - No automatic overran detection.
   - They remain scheduled until a webhook or user action resolves them.
   - If stale visibility matters, add a passive "stale scheduled meetings" report later, not a blocking closer workflow.

This breaks the old invariant that only Start Meeting unlocks outcomes. That is the point of the simplification.

## Existing Overran Data Cleanup Rule

The cleanup rule should make the database look like `meeting_overran` never existed.

Default rule:

- If a meeting/opportunity is `meeting_overran` and there is no concrete downstream action, set it back to `scheduled`.
- Do not turn unresolved overran rows into `no_show`, `lost`, or any other terminal outcome.
- Do not keep a hidden legacy overran bucket for manual review.
- Delete associated `meetingReviews` rows after the operational status is repaired.

Concrete downstream evidence can repair the row to a real outcome:

1. Payment evidence:
   - Evidence: a `paymentRecords` row linked by `meetingId` or `opportunityId`, or a converted customer linked to the opportunity.
   - Repair: opportunity -> `payment_received`; meeting -> `completed`; use the payment `recordedAt` as the best available operational completion timestamp.

2. Follow-up evidence:
   - Evidence: a `followUps` row linked to the opportunity, including rows created through the old overran review resolution path.
   - Repair: opportunity -> `follow_up_scheduled` if the follow-up is pending/booked; meeting -> `completed`.
   - If the follow-up itself is already completed with a terminal `completionOutcome`, prefer that terminal outcome.

3. No-show evidence:
   - Evidence: `meetings.noShowMarkedAt`, `opportunities.noShowAt`, or a Calendly no-show webhook that already wrote no-show fields.
   - Repair: opportunity -> `no_show`; meeting -> `no_show`.
   - Do not infer no-show from overran alone.

4. Lost evidence:
   - Evidence: `opportunities.lostAt`, `lostByUserId`, `lostReason`, or a domain event showing a closer/admin marked the opportunity lost.
   - Repair: opportunity -> `lost`; meeting -> `completed` unless the meeting has stronger no-show/cancel evidence.

5. Cancel evidence:
   - Evidence: meeting/opportunity cancellation fields or Calendly cancellation webhook data already applied to the row.
   - Repair: opportunity -> `canceled`; meeting -> `canceled`.

6. Review response only:
   - Evidence such as `meetingReviews.closerStatedOutcome` is not enough by itself. It was a review artifact, not an operational outcome write.
   - Repair: leave unresolved rows as `scheduled` unless there is one of the concrete records above.

This gives us a deterministic cleanup without pretending overran rows were lead no-shows and without asking admins to manually audit test-tenant artifacts.

## Migration Strategy

Use a compressed Convex cleanup-and-narrow sequence. The important constraint is not preserving legacy data; it is satisfying Convex schema validation before the narrow deploy.

### Step 1: stop producing overran data

- Remove new `scheduleMeetingAttendanceCheck` calls from meeting creation paths.
- Remove the stale-meeting cron.
- Cancel all queued attendance checks before deleting `checkMeetingAttendance`. If cancellation cannot be proven during the implementation window, keep only a temporary no-op compatibility function that never writes `meeting_overran`; this is a scheduler safety shim, not a product state.
- Remove Start/End UI and navigation blocking.
- Update outcome mutations to support direct outcomes from scheduled meetings.
- Hide overran/review/timing reporting surfaces.

### Step 2: erase existing overran state

Run a bounded migration or one-off internal mutation:

- Cancel queued attendance checks for meetings with `attendanceCheckId`.
- Unset `attendanceCheckId`, `reviewId`, `overranDetectedAt`, and overran-only duration fields.
- Repair `meeting_overran` meetings/opportunities using the evidence precedence in "Existing Overran Data Cleanup Rule".
- Set unresolved overran meetings/opportunities back to `scheduled`.
- Delete all `meetingReviews` rows.
- Remove or rebuild `operationsMeetingDailyStats` rows that use `meeting_overran`.
- Recompute reporting aggregates if they contain `meeting_overran` buckets.
- Delete or ignore overran-only domain events such as `meeting.overran_detected`, `meeting.overran_closer_responded`, and status-change events to/from `meeting_overran` if they feed reports.
- Verify there are zero `meeting_overran` values and zero `meetingReviews` rows before schema narrowing.

Because there is one test tenant on production, a simple audited internal mutation may be enough if row counts are small. If counts are uncertain, use `@convex-dev/migrations`.

### Step 3: narrow schema

After cleanup verification in the same refactor window:

- Remove deleted fields from `convex/schema.ts`.
- Remove `meetingReviews`.
- Remove `meeting_overran` literals.
- Remove validators, status configs, report calculations, and event labels that only support the deleted feature.
- Regenerate Convex types.

## Operational Risks

- Queued scheduled functions can call deleted function references. Cancel them first; if any cannot be proven canceled, use a temporary no-op compatibility function that never writes overran state.
- Existing `meeting_overran` rows block schema narrowing. The cleanup must prove zero remaining rows before removing the literal.
- Outcome transitions need careful tenant stats deltas. Direct `scheduled -> payment/lost/no_show/follow_up` changes active opportunity counts differently than the old `scheduled -> in_progress -> outcome` path.
- Operations daily aggregates include meeting status buckets. Rows with `meeting_overran` need cleanup or rebuild.
- Reports that use completed/no-show/show-rate math will change once review-required is removed.
- PostHog funnels using `meeting_started` will break unless replaced with outcome-based funnels.

## Open Questions For Design

1. When should outcome actions become available: always, at scheduled start, or after scheduled end?
2. Should Join Meeting be a primary action on the meeting info card, the action bar, or both?
3. Do we keep optional Fathom links as a meeting artifact, even after deleting compliance/reporting around them?
4. Should the cleanup evidence precedence above be encoded exactly, or should payment/follow-up/no-show/lost/cancel use a different priority?
5. Do admins still need a manual "resolve meeting" tool after Start/End is removed?
6. Should stale scheduled meetings be surfaced passively for admins, or ignored until users/webhooks act?

## Suggested Implementation Phases

1. Product contract: decide outcome availability and status transitions from `scheduled`.
2. Backend: stop attendance checks and update outcome mutations.
3. Frontend: remove Start/End/overran UI and expose direct outcome actions.
4. Reporting: delete meeting-time and review reports; simplify team, pipeline, and operations metrics.
5. Data cleanup: cancel queued checks, repair action-backed overran rows, reset unresolved overran rows to scheduled, delete review artifacts, rebuild affected aggregates.
6. Schema narrow: remove deprecated fields/table/status literals.

## Quick File Map

Core backend:

- `convex/schema.ts`
- `convex/lib/statusTransitions.ts`
- `convex/lib/tenantStatsHelper.ts`
- `convex/lib/attendanceChecks.ts`
- `convex/lib/overranReviewGuards.ts`
- `convex/closer/meetingActions.ts`
- `convex/closer/meetingOverrun.ts`
- `convex/closer/meetingOverrunSweep.ts`
- `convex/closer/payments.ts`
- `convex/closer/followUpMutations.ts`
- `convex/closer/noShowActions.ts`
- `convex/reviews/queries.ts`
- `convex/reviews/mutations.ts`
- `convex/pipeline/inviteeCreated.ts`
- `convex/pipeline/inviteeCanceled.ts`
- `convex/pipeline/inviteeNoShow.ts`

Core frontend:

- `app/workspace/closer/meetings/_components/outcome-action-bar.tsx`
- `app/workspace/closer/meetings/_components/end-meeting-button.tsx`
- `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx`
- `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx`
- `app/workspace/closer/meetings/_components/meeting-info-panel.tsx`
- `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx`
- `hooks/use-in-progress-meeting-guard.ts`
- `app/workspace/reviews/`

Reporting and navigation:

- `app/workspace/reports/meeting-time/`
- `app/workspace/reports/reviews/`
- `app/workspace/reports/pipeline/_components/pending-overran-reviews-card.tsx`
- `app/workspace/reports/team/_components/meeting-time-summary.tsx`
- `app/workspace/reports/team/_components/closer-performance-table.tsx`
- `app/workspace/_components/workspace-shell-client.tsx`
- `components/command-palette.tsx`
- `posthog-setup-report.md`
