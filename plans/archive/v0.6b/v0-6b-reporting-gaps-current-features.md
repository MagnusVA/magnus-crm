# v0.6b Reporting Gaps - Audit & Analysis

**Date:** 2026-04-18  
**Scope:** Re-audit reporting coverage after the active implementations for admin meeting management, late-start review v1/v2, meeting-time-tracking-accuracy, and reminder-outcomes.  
**Approach:** Read the referenced design docs, then traced mounted routes, schema, mutations, queries, aggregates, and report pages in `main`. Only live code paths were included. Dead or unmounted code was explicitly excluded.  
**Guidance used:** `.docs/internal/Design-document-creation.md` (Audit & Analysis format)

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Audit Boundaries](#2-audit-boundaries)
3. [Verified Active Feature Map](#3-verified-active-feature-map)
4. [Finding 1 - Reporting Model Was Not Widened For New Dimensions](#4-finding-1---reporting-model-was-not-widened-for-new-dimensions)
5. [Finding 2 - Team And Revenue Reports Flatten New Process States](#5-finding-2---team-and-revenue-reports-flatten-new-process-states)
6. [Finding 3 - Review And Meeting-Time Features Exist Only As Operational Workflows](#6-finding-3---review-and-meeting-time-features-exist-only-as-operational-workflows)
7. [Finding 4 - Reminder Outcomes Are Written But Unread](#7-finding-4---reminder-outcomes-are-written-but-unread)
8. [Finding 5 - Pipeline And Activity Reporting Are Incomplete For The New Flows](#8-finding-5---pipeline-and-activity-reporting-are-incomplete-for-the-new-flows)
9. [Prioritised Improvement Plan](#9-prioritised-improvement-plan)
10. [Migration Notes](#10-migration-notes)
11. [Appendix A - Files Referenced](#11-appendix-a---files-referenced)
12. [Appendix B - Excluded Dead Code](#12-appendix-b---excluded-dead-code)

## 1. Executive Summary

| Severity | Count | Summary |
|---|---:|---|
| Critical | 3 | The reporting layer does not currently consume the new meeting-time fields, reminder outcome fields, or review-system data that the product now writes. |
| High | 4 | Admin-vs-closer attribution is lost in reporting, revenue cannot be segmented by reminder/admin/dispute origin, the activity feed misses active event types, and pipeline reporting ignores the new operational queues. |
| Medium | 3 | The team report UI hides some backend metrics, operational review queries are bounded to 50/100 rows, and several assumptions from the previous v0.6b draft were no longer true in `main`. |

**Bottom line:** the new operational features are real and active, but reporting still reflects the older data model. Most of the missing value is not because data is absent; it is because the current report queries and aggregates never read the newer fields.

## 2. Audit Boundaries

### Included source plans

- `plans/admin-meeting-management/design.md`
- `plans/late-start-review/late-start-review-design.md`
- `plans/Late-start-reviewv2/overhaul-v2.md`
- `plans/meeting-time-tracking-accuracy/meeting-time-tracking-accuracy-design.md`
- `plans/reminder-outcomes/reminder-outcomes-design.md`

### Included live surfaces

- Mounted report routes under `app/workspace/reports/`: `activity`, `leads`, `pipeline`, `revenue`, `team`
- Mounted review workflow under `app/workspace/reviews/`
- Mounted closer reminder workflow under `app/workspace/closer/reminders/[followUpId]/`
- Mounted admin meeting detail workflow under `app/workspace/pipeline/meetings/[meetingId]/`

### Corrections vs. the previous v0.6b draft

| Topic | Previous draft assumption | Verified current code |
|---|---|---|
| Stale meeting safety-net | Not implemented | `convex/closer/meetingOverrunSweep.ts:22-76` is live and scheduled in `convex/crons.ts:41-46`, but it only covers stale `scheduled` meetings. |
| Late-start reason prompt | Assumed live | No mounted late-start reason dialog was found. The live closer path only computes `lateStartDurationMs` in `convex/closer/meetingActions.ts:72-104`. |
| Closer overran-response flow | Assumed relevant to reporting | `respondToOverranReview` and `scheduleFollowUpFromOverran` exist in `convex/closer/meetingOverrun.ts:159-347`, but no mounted UI calls them. They were excluded from this rewrite. |

## 3. Verified Active Feature Map

| Feature | Code evidence | Reporting-relevant writes | Current reporting consumer |
|---|---|---|---|
| Admin meeting management | `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx:95-270`, `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx:24-90`, `convex/admin/meetingActions.ts:21-561` | `lostByUserId`, `startedAtSource = "admin_manual"`, `stoppedAtSource = "admin_manual"`, `lateStartDurationMs`, `exceededScheduledDurationMs`, `meeting.admin_resolved`, admin-created follow-ups/reminders/reschedule links | No dedicated reports consumer. Some writes reach Activity Feed indirectly, but newer event types are not fully labeled. |
| Late-start review / review v2 | `app/workspace/reviews/_components/reviews-page-client.tsx:13-50`, `convex/reviews/queries.ts:24-193`, `convex/reviews/mutations.ts:48-613`, `convex/schema.ts:514-574` | `meetingReviews`, `manualStartedAt`, `manualStoppedAt`, `timesSetByUserId`, `resolutionAction`, `meeting.overran_detected`, `meeting.times_manually_set`, `meeting.overran_review_resolved`, `payment.disputed` | No reports route reads `meetingReviews`. Review data is operational only. |
| Meeting time tracking accuracy | `convex/closer/meetingActions.ts:47-200`, `convex/closer/noShowActions.ts:39-153`, `convex/admin/meetingActions.ts:444-561`, `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:146-198` | `startedAt`, `stoppedAt`, `startedAtSource`, `stoppedAtSource`, `lateStartDurationMs`, `exceededScheduledDurationMs`, `noShowSource` | Detail pages only. Current report queries do not read these fields. |
| Reminder outcomes | `app/workspace/closer/_components/reminders-section.tsx:52-100`, `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx:57-176`, `convex/closer/reminderOutcomes.ts:65-452`, `convex/schema.ts:711-779` | `followUps.completionOutcome`, reminder-origin `payment.recorded`, reminder-origin `opportunity.marked_lost`, `followUp.completed` | No reporting query reads `completionOutcome` or the `followUps` table. |
| Current reports area | `app/workspace/reports/` tree | Team, revenue, pipeline, leads, activity surfaces only | No mounted report page exists for reviews, meeting-time audit, or reminder outcomes. |

## 4. Finding 1 - Reporting Model Was Not Widened For New Dimensions

### 4.1 Aggregate keys still reflect the pre-v0.6 model

**Files:** `convex/reporting/aggregates.ts:8-46`, `convex/reporting/writeHooks.ts:46-112`, `convex/schema.ts:330-352`, `convex/schema.ts:390-425`, `convex/schema.ts:711-753`

**Observed behavior:** The active reporting aggregates only track:

- `meetingsByStatus`: `[assignedCloserId, callClassification, status, scheduledAt]`
- `paymentSums`: `[closerId, recordedAt]`
- `opportunityByStatus`: `[status, assignedCloserId, createdAt]`

None of the following active fields are part of any reporting aggregate key or summary:

- `startedAtSource`
- `stoppedAtSource`
- `lateStartDurationMs`
- `exceededScheduledDurationMs`
- `noShowSource`
- `lostByUserId`
- `manualStartedAt`
- `manualStoppedAt`
- `timesSetByUserId`
- `followUps.completionOutcome`

**Reporting gap:** The product now writes richer operational facts than the reporting layer can group by. Any report that needs timing accuracy, source attribution, reminder outcomes, or review correction metrics must currently fall back to raw scans because the aggregate model was never widened for those dimensions.

**Recommendation:** Treat the existing aggregates as stable baseline aggregates, not as the only reporting model. Add targeted read models for:

- meeting-time audit
- review backlog and resolution analytics
- reminder outcome funnel
- admin-vs-closer attribution

### 4.2 Admin-created follow-ups and payments lose origin at the row level

**Files:** `convex/lib/outcomeHelpers.ts:29-173`, `convex/admin/meetingActions.ts:116-149`, `convex/admin/meetingActions.ts:258-303`, `convex/schema.ts:667-709`, `convex/schema.ts:711-753`

**Observed behavior:**

- `createPaymentRecord` stores `paymentRecords.closerId` as the assigned closer and puts admin origin only in the `payment.recorded` event metadata (`loggedByAdminUserId`) at `convex/lib/outcomeHelpers.ts:76-93`.
- `createManualReminder` stores `followUps.reason = "closer_initiated"` even when the reminder was created by an admin at `convex/lib/outcomeHelpers.ts:142-170`.
- `adminCreateFollowUp` and `adminCreateManualReminder` also create `followUps` rows without a row-level `createdByUserId` or `createdSource`, and `adminCreateManualReminder` also uses `reason: "closer_initiated"` at `convex/admin/meetingActions.ts:258-269`.

**Reporting gap:** Admin intervention is partially preserved in domain events, but not in the primary rows that reports read. That makes admin-created reminders and admin-logged payments analytically indistinguishable from closer-owned activity unless the report scans domain events.

**Recommendation:** If admin-vs-closer reporting matters, persist that dimension in a reporting-friendly place. Domain-event metadata alone is not enough because the main report queries (`teamPerformance`, `revenue`) do not read it.

## 5. Finding 2 - Team And Revenue Reports Flatten New Process States

### 5.1 Team Performance counts `meeting_overran` as a no-show and ignores time-tracking fields

**Files:** `convex/reporting/teamPerformance.ts:146-184`, `app/workspace/reports/team/_components/closer-performance-table.tsx:105-157`, `app/workspace/reports/team/_components/team-kpi-summary-cards.tsx:50-135`

**Observed behavior:**

- `teamPerformance` calculates `noShows` as `no_show + meeting_overran` at `convex/reporting/teamPerformance.ts:160-163`.
- It never reads `lateStartDurationMs`, `exceededScheduledDurationMs`, `startedAtSource`, `stoppedAtSource`, `noShowSource`, or `lostByUserId`.
- The team UI shows only booked/canceled/no-shows/showed/show-up rate per table row, plus four summary cards.

**Reporting gap:** The team report treats "review-required / attendance-ambiguous" meetings as true no-shows and drops all of the new timing fidelity that v0.6 introduced. That means the report cannot answer:

- who starts late
- who overruns meetings
- how many meetings were corrected manually by admins
- how many no-shows came from closer action vs. Calendly webhook

**Recommendation:** Split `meeting_overran` from true no-show counts and add a dedicated meeting-time slice to team reporting rather than trying to overload the existing call-outcome table.

### 5.2 Team backend returns more than the UI shows

**Files:** `convex/reporting/teamPerformance.ts:172-249`, `app/workspace/reports/team/_components/closer-performance-table.tsx:21-57`, `app/workspace/reports/team/_components/team-report-page-client.tsx:45-72`

**Observed behavior:** The backend already returns `sales`, `cashCollectedMinor`, `closeRate`, and `avgCashCollectedMinor` per closer, but the main closer tables never render those fields.

**Reporting gap:** Even the metrics that already exist in the backend are partially silent in the UI. This is not a data gap; it is a report-surface gap.

**Recommendation:** Expose the already-returned commercial metrics before adding new KPIs. This is the lowest-effort reporting win in the current codebase.

### 5.3 Revenue reporting cannot separate reminder-driven, admin-logged, or disputed revenue

**Files:** `convex/reporting/revenue.ts:21-178`, `convex/reporting/lib/helpers.ts:90-185`, `convex/closer/reminderOutcomes.ts:100-181`, `convex/reviews/mutations.ts:265-452`, `convex/lib/outcomeHelpers.ts:59-93`

**Observed behavior:**

- `getRevenueMetrics` and `getRevenueDetails` read `paymentRecords` only.
- `getNonDisputedPaymentsInRange` filters disputed payments out entirely at `convex/reporting/lib/helpers.ts:161-184`.
- Reminder-origin revenue is stored only in the `payment.recorded` event metadata in `convex/closer/reminderOutcomes.ts:138-155`.
- Admin-logged payment origin is stored only in the `payment.recorded` event metadata in `convex/lib/outcomeHelpers.ts:76-93`.

**Reporting gap:** Revenue totals are numerically correct for non-disputed cash, but the report cannot answer:

- how much revenue came from reminder follow-through
- how much revenue was logged by admins
- how much revenue was later disputed and rolled back

**Recommendation:** Keep the current revenue totals, but add an origin-aware revenue layer. If that origin must survive beyond the activity feed, it needs a durable field or dedicated aggregate rather than event metadata only.

## 6. Finding 3 - Review And Meeting-Time Features Exist Only As Operational Workflows

### 6.1 The review system is active, but it has no reports-area surface

**Files:** `app/workspace/reviews/_components/reviews-page-client.tsx:13-50`, `convex/reviews/queries.ts:24-193`, `convex/reviews/mutations.ts:48-613`, `app/workspace/reports/` route tree

**Observed behavior:** The review workflow is mounted under `/workspace/reviews`, not under `/workspace/reports`. The reports area currently ships only `activity`, `leads`, `pipeline`, `revenue`, and `team`.

**Reporting gap:** There is no report page for:

- pending review backlog
- resolved review mix by action
- manual time corrections
- dispute rate
- disputed revenue reversed
- reviewer workload or SLA

**Recommendation:** Add a dedicated reporting surface for review operations. This can be a new route or a new section under an existing operations-style report, but it should not depend on the bounded operational list.

### 6.2 Current review queries are bounded and not suitable for analytics

**Files:** `convex/reviews/queries.ts:15-21`, `convex/reviews/queries.ts:176-192`

**Observed behavior:**

- `listPendingReviews` uses `.take(50)`.
- `getPendingReviewCount` uses `.take(100)` and returns `pending.length`.

**Reporting gap:** The current review page is an operational inbox, not a reporting source. Once backlog grows past those bounds, the visible count and visible rows stop being complete.

**Recommendation:** Build full-count review reporting separately from the operational inbox. Do not reuse the 50/100-row helpers for report KPIs.

### 6.3 Meeting-time and Fathom evidence are visible on detail pages but absent from reports

**Files:** `app/workspace/closer/meetings/_components/meeting-info-panel.tsx:146-198`, `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx:213-287`, `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx:246-270`, `convex/schema.ts:374-377`

**Observed behavior:**

- Meeting detail pages show `startedAt`, `stoppedAt`, `lateStartDurationMs`, `exceededScheduledDurationMs`, and source badges.
- Both closer and admin meeting detail pages mount `FathomLinkField`.
- No report query currently reads `fathomLink`, `fathomLinkSavedAt`, or the timing fields.

**Reporting gap:** Attendance proof and timing accuracy are only inspectable one meeting at a time.

**Recommendation:** Add a meeting-time audit report with:

- on-time start rate
- average late-start minutes
- average overrun minutes
- manual-time correction count
- source split for `startedAtSource` / `stoppedAtSource`
- Fathom-link compliance rate for completed and review-flagged meetings

### 6.4 The stale scheduled-meeting sweep is implemented, but not reportable as its own rescue path

**Files:** `convex/closer/meetingOverrunSweep.ts:22-76`, `convex/crons.ts:41-46`, `convex/closer/meetingOverrun.ts:50-130`

**Observed behavior:** The sweep cron schedules `checkMeetingAttendance`, and `checkMeetingAttendance` emits `meeting.overran_detected`. The sweep itself does not emit a distinct event or persist a "detected by sweep" marker.

**Reporting gap:** The system can count overran detections, but it cannot separately report how many were rescued by the sweep versus by the original per-meeting attendance check.

**Recommendation:** If operations wants "sweep rescued X stale meetings" as a KPI, the sweep path needs its own persistent signal.

## 7. Finding 4 - Reminder Outcomes Are Written But Unread

### 7.1 `followUps.completionOutcome` is active but unused by reports

**Files:** `convex/schema.ts:729-739`, `convex/closer/reminderOutcomes.ts:132-181`, `convex/closer/reminderOutcomes.ts:251-288`, `convex/closer/reminderOutcomes.ts:387-441`

**Observed behavior:** The reminder outcome mutations write:

- `payment_received`
- `lost`
- `no_response_rescheduled`
- `no_response_given_up`
- `no_response_close_only`

to `followUps.completionOutcome`, but no mounted report query reads `followUps` or `completionOutcome`.

**Reporting gap:** The new reminder-outcomes feature is operationally complete, but reporting cannot answer:

- how reminders resolve
- which closers convert reminders into payments
- how often reminders end in loss vs. another reminder
- how many reminder attempts are needed before closure

**Recommendation:** Add a reminder outcome funnel keyed directly off `followUps`, not just off domain events.

### 7.2 Reminder-driven payments and losses only survive as generic events

**Files:** `convex/closer/reminderOutcomes.ts:138-181`, `convex/closer/reminderOutcomes.ts:258-288`, `convex/closer/reminderOutcomes.ts:393-441`, `convex/reporting/revenue.ts:21-178`, `convex/reporting/pipelineHealth.ts:32-185`

**Observed behavior:**

- Reminder-origin payment and loss flows emit good domain-event metadata.
- Revenue and pipeline reports never read those events.
- `paymentRecords` and `opportunities` do not carry a durable reminder-origin dimension that the report layer uses.

**Reporting gap:** Reminder outcomes affect revenue and pipeline conversion, but the reports cannot isolate that channel.

**Recommendation:** Add reminder-origin reporting at the data layer, not only at the activity-feed layer.

## 8. Finding 5 - Pipeline And Activity Reporting Are Incomplete For The New Flows

### 8.1 Pipeline Health ignores review backlog, reminder backlog, and new attribution fields

**Files:** `convex/reporting/pipelineHealth.ts:32-185`

**Observed behavior:** Pipeline Health only reports:

- status distribution
- aging by active status
- average velocity from `payment_received`
- stale opportunities

It does not read `meetingReviews`, `followUps`, `completionOutcome`, `noShowSource`, `lostByUserId`, or any meeting-time fields.

**Reporting gap:** The pipeline report cannot show:

- pending meeting-overran reviews
- unresolved reminder workload
- reminder outcome funnel
- admin-vs-closer loss attribution
- closer-vs-webhook no-show split

**Recommendation:** Extend pipeline reporting to include exception queues and post-meeting follow-through, not just opportunity status counts.

### 8.2 Activity Feed does not fully cover the newer active event types

**Files:** `convex/reporting/lib/eventLabels.ts:1-84`, `app/workspace/reports/activity/_components/activity-feed-filters.tsx:23-29`, `convex/admin/meetingActions.ts:524-541`, `convex/closer/meetingOverrun.ts:116-130`, `convex/closer/meetingOverrun.ts:223-239`, `convex/reviews/mutations.ts:241-256`, `convex/reviews/mutations.ts:303-321`, `convex/reviews/mutations.ts:418-430`, `convex/pipeline/inviteeCanceled.ts:111-122`, `convex/pipeline/inviteeNoShow.ts:102-113`

**Observed behavior:** The active system emits event types such as:

- `meeting.admin_resolved`
- `meeting.overran_detected`
- `meeting.overran_closer_responded`
- `meeting.overran_review_resolved`
- `meeting.status_changed`
- `meeting.webhook_ignored_overran`
- `payment.disputed`

but `EVENT_LABELS` does not define labels for them.

**Reporting gap:** Unlabeled events fall back to raw strings in the feed, and because the event-type filter options are generated from `EVENT_LABELS`, those live event types cannot be selected from the filter UI.

**Recommendation:** Bring `EVENT_LABELS` into parity with the active emitters before adding any new Activity Feed analytics.

### 8.3 Activity rows read status transitions from the wrong place

**Files:** `convex/lib/domainEvents.ts:12-32`, `convex/reporting/activityFeed.ts:151-157`, `app/workspace/reports/activity/_components/activity-event-row.tsx:73-95`

**Observed behavior:** `emitDomainEvent` stores `fromStatus` and `toStatus` as top-level fields on `domainEvents`. `getActivityFeed` returns those top-level fields. `ActivityEventRow` ignores them and instead tries to read `metadata.fromStatus` and `metadata.toStatus`.

**Reporting gap:** Status transitions are frequently present in the data but missing in the rendered row.

**Recommendation:** Read top-level `fromStatus` and `toStatus` first, with metadata only as fallback.

### 8.4 Activity summary is source-only

**Files:** `convex/reporting/activityFeed.ts:161-227`, `app/workspace/reports/activity/_components/activity-summary-cards.tsx:19-63`

**Observed behavior:** The summary cards only break events down by `source`.

**Reporting gap:** That is too coarse for the new workflows. Admin review work, reminder completions, disputed payments, and overran detections all get flattened into generic source totals.

**Recommendation:** Keep the source cards, but add event-type and outcome slices once the label parity issue is fixed.

## 9. Prioritised Improvement Plan

### Phase 1 - Fix Existing Report Blind Spots (Low-Medium effort)

| # | Task | Impact | Effort |
|---|---|---|---|
| 1 | Add missing labels for all active event types and fix `ActivityEventRow` to render top-level `fromStatus` / `toStatus`. | Makes current domain-event data legible immediately. | Low |
| 2 | Expose already-returned team metrics (`sales`, `cashCollectedMinor`, `closeRate`, `avgCashCollectedMinor`) in the team UI. | Unlocks immediate value without schema work. | Low |
| 3 | Split `meeting_overran` out of the team report's no-show bucket. | Stops misreporting review-required meetings as true no-shows. | Medium |

### Phase 2 - Add Review And Meeting-Time Reporting (Medium effort)

| # | Task | Impact | Effort |
|---|---|---|---|
| 4 | Add full-count review reporting queries that do not reuse the 50/100-row operational helpers. | Makes backlog and SLA reporting accurate. | Medium |
| 5 | Add a reports-area surface for review compliance and meeting-time audit. | Gives owners/admins a home for review, manual-time, and Fathom metrics. | Medium |
| 6 | Add KPIs for on-time starts, late starts, overruns, manual corrections, and Fathom-link compliance. | Turns v0.6 timing data into actual reporting value. | Medium |

### Phase 3 - Add Reminder Outcome Analytics (Medium-High effort)

| # | Task | Impact | Effort |
|---|---|---|---|
| 7 | Add reminder outcome funnel queries directly off `followUps`. | Makes the reminder-outcomes feature visible in reporting. | Medium |
| 8 | Add reminder-driven revenue and reminder-driven loss slices to revenue and pipeline reporting. | Connects reminder work to money and pipeline movement. | Medium |
| 9 | Add reminder-chain metrics for repeated no-response handling. | Quantifies reminder churn and follow-up burden. | Medium |

### Phase 4 - Restore Attribution Integrity (High effort)

| # | Task | Impact | Effort |
|---|---|---|---|
| 10 | Add durable reporting dimensions for admin-vs-closer action origin where the current rows lose that distinction. | Makes admin intervention measurable and auditable in reports. | High |
| 11 | Extend pipeline reporting with review backlog, reminder backlog, no-show source split, and admin-vs-closer loss attribution. | Brings pipeline reporting back in line with the current process model. | High |
| 12 | Decide whether sweep-rescued meetings need their own persisted signal. | Enables "sweep rescue" operational reporting if required. | Medium |

## 10. Migration Notes

| Change type | Migration required? | Notes |
|---|---|---|
| Activity Feed label parity and row rendering fixes | No | Read/UI-only changes. |
| New report queries over existing `meetingReviews`, `meetings`, `followUps`, and `domainEvents` data | No | Safe read-side expansion. |
| New report pages or sections under `app/workspace/reports/` | No | Frontend-only. |
| Adding new row-level attribution fields to `paymentRecords` or `followUps` | Yes | Use the `convex-migration-helper` skill when implementing. |
| Expanding `followUps.reason` or adding `createdByUserId` / `createdSource` to follow-ups | Yes | Existing live rows would need a rollout/backfill strategy. |

## 11. Appendix A - Files Referenced

| File | Sections |
|---|---|
| `convex/reporting/aggregates.ts` | 4 |
| `convex/reporting/teamPerformance.ts` | 5 |
| `convex/reporting/revenue.ts` | 5 |
| `convex/reporting/pipelineHealth.ts` | 8 |
| `convex/reporting/activityFeed.ts` | 8 |
| `convex/reporting/lib/eventLabels.ts` | 8 |
| `convex/reporting/lib/helpers.ts` | 5 |
| `convex/reviews/queries.ts` | 3, 6 |
| `convex/reviews/mutations.ts` | 3, 5, 6, 8 |
| `convex/closer/meetingActions.ts` | 3, 6 |
| `convex/closer/noShowActions.ts` | 3, 5 |
| `convex/closer/meetingOverrun.ts` | 3, 6, 8 |
| `convex/closer/meetingOverrunSweep.ts` | 2, 6 |
| `convex/closer/reminderOutcomes.ts` | 3, 5, 7 |
| `convex/lib/outcomeHelpers.ts` | 4, 5 |
| `convex/admin/meetingActions.ts` | 3, 4, 8 |
| `convex/schema.ts` | 3, 4, 6, 7 |
| `app/workspace/reports/team/_components/*` | 5 |
| `app/workspace/reports/activity/_components/*` | 8 |
| `app/workspace/reviews/_components/reviews-page-client.tsx` | 3, 6 |
| `app/workspace/closer/meetings/_components/meeting-info-panel.tsx` | 3, 6 |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-detail-page-client.tsx` | 3 |
| `app/workspace/closer/_components/reminders-section.tsx` | 3 |
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | 3, 6 |
| `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx` | 3 |

## 12. Appendix B - Excluded Dead Code

These code paths were intentionally excluded from the rewritten reporting-gap design because they are not currently mounted or called by live UI flows:

| File | Why excluded |
|---|---|
| `convex/closer/meetingOverrun.ts:159-248` (`respondToOverranReview`) | No mounted UI call site was found. |
| `convex/closer/meetingOverrun.ts:250-347` (`scheduleFollowUpFromOverran`) | No mounted UI call site was found. |
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | The component exists, but no import/use site was found in the mounted app. |

This document does not propose reporting work for those paths unless they become active later.
