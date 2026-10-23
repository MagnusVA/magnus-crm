# Phase 6: runtime cleanup

Status: planned, 2026-10-22. Waiting for the tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`) to answer the decision batch in §11. The answers they gave before planning started are recorded there as U1 to U7.

Scope comes from the Phase 6 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md), as rescoped on 2026-10-22, and from the Phase 6 card in §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) (finding F11, and "Meetings also get an honest status" in §6). Terms follow [`CONTEXT.md`](../../CONTEXT.md). Phase 5 is in [phase-5-deal-status.md](phase-5-deal-status.md). Phase 6 is the last phase of the roadmap.

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

Phase 6 drops what the earlier phases left dead, bounds the reads that still grow with the tenant, and finishes the meeting model:

1. **`tenantStats` goes** (U1). Nothing reads it, and 15 modules write it, three of them on the booking path. The writes, the helper, the seed and every reference go first, then the row, then the table (§3, §5.1).
2. **Open loops are bounded**: the closer dashboard and calendar, Pipeline Health's aging and loss reads, and the unused `getTimePeriodStats` is deleted (§6.1, §6.2).
3. **Counts cover their range**: the activity summary and the lead gen Deals column count from aggregates instead of capped reads (§6.3, §6.4).
4. **Dead indexes and fields go**: 44 unused indexes, plus the two that leave with their field or table; `meetingOutcome`, the legacy `operationsMeetingDailyStats` table, `opportunities.canceledAt` and `noShowAt`, `paymentRecords.commissionable` with the origins `customer_direct` and `bookkeeper_direct`, and the unread day keys on `opportunitySearch` (§3.3). `meetings.notes` stays (U5).
5. **The meeting records attendance only** (§4.1): `completed` becomes `held`, the time a person recorded it is `heldMarkedAt`, and no-shows lose `completedAt`. This runs as widen, dual-write, move readers, narrow.
6. **"Not recorded" is a display rule** (U2, §4.2), defined once and used wherever a past scheduled meeting appears.
7. **One show rate**, held ÷ (held + no-show), on every screen and export (U3, §4.3).
8. **The business day is a tenant setting** (U4, §4.4): a time zone and a start hour, defaulting to today's America/Tegucigalpa 01:00. Every server-side day uses it. Every dated screen says which day it uses.

It ships in 13 code PRs after this plan (§9). Each is safe to deploy alone.

## 2. Production snapshot (2026-10-22)

These were read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant, around 18:40 UTC, on `main` at `f50ef01`.

### 2.1 Meetings

6,918 meetings.

| Status | `completedAt` set | `noShowMarkedAt` set | Count |
| --- | --- | --- | --- |
| `scheduled` | no | no | 2,823 |
| `completed` | yes | no | 715 |
| `no_show` | yes | yes | 510 |
| `no_show` | no | yes | 22 |
| `canceled` | no | no | 2,848 |

- 2,747 scheduled meetings are past their start time (2,310 by more than 30 days), and 76 are upcoming.
- No meeting has `meetingOutcome` or `notes` set.
- Every completed meeting has a `completedAt`, and none is before its start time. The lag from start to `completedAt`: under an hour for 89, 1 to 24 hours for 406, 1 to 7 days for 204, later for 16. So `completedAt` is the click time, not the call time.
- 961 of the 4,070 non-canceled meetings (23.6%) start between 18:00 and 24:00 Honduras time. A UTC day puts them on the next date.
- September 2026 (UTC month, by start time): held 189, no-show 198, canceled 286, still scheduled 384.

### 2.2 Deals and payments

- 11,600 deals. `opportunities.canceledAt` is set on 2,452 and `noShowAt` on 527.
- 291 payments, all `commissionable: true`. By origin: `closer_meeting` 273, `closer_side_deal` 9, `closer_additional` 5, `closer_reminder` 4. No payment has `customer_direct` or `bookkeeper_direct`.

### 2.3 Dead tables

- `tenantStats`: one row (`mh7fhxxkhx73hbnw6ys762fqzh8543bb`). It holds `totalTeamMembers` 56, `totalClosers` 22, `totalOpportunities` 11,600, `totalCustomers` 286, `totalPaymentRecords` 291, `totalLeads` 10,649 and `totalRevenueMinor` 143,164,310. The commissionable revenue counters sum to the total, and the two non-commissionable ones are 0.
- `operationsMeetingDailyStats`: 5,761 rows. Nothing writes the table.

### 2.4 Activity volume

Domain events created per Honduras business day: 2,295 on 10-20 and 2,844 on 10-21. 10-19 had 8,248, which includes backfill writes. That is two to three times the "about 1,000 a day" the ADR assumed, so the activity summary's 10,000-event cap cuts off ranges longer than about four days, not nine.

### 2.5 Booking reviews

One review is open and three are resolved. The open one is the team's queue work. This phase doesn't touch it, or person B's two blocked deliveries.

### 2.6 Code inventory (`f50ef01`)

- **Indexes:** 282 in total: `convex/schema.ts` 234, `operations/reports/schema.ts` 26, `pipeline/schema.ts` 12 and `operations/meetingProjectionSchema.ts` 10. `opportunities` has 22. 46 index names appear nowhere outside the schema files (exact-name match; a substring search finds 45, because `eventTypeConfigs.by_tenantId_and_bookingProgramId` is a substring of longer names). One `withIndex` call takes a variable (`admin/tenantsMutations.ts:62`, the tenant deletion's table list), and it reaches none of the 46. §3.3 lists them.
- **`tenantStats`:** the only reads are the helper's own read-before-write, the upsert in `seedTenantStatsInternal` (`admin/migrations.ts`), the row count in `testing/operationalData.ts`, the tenant deletion's scan, and tests. Nothing under `app/`, `lib/` or `components/` reads it.
- **Attendance:** 15 production write sites, which go through `completeMeetingForOutcome`, `patchMeetingLifecycle`, the two manual no-show paths, booking-fact reconciliation, three booking inserts, the reschedule cancel and the redistribution cancel. About 26 backend readers and 14 display sites read it, plus 8 test files and 9 fixture files.
- **Show rate today:**

  | Read | Formula |
  | --- | --- |
  | Team report (`teamPerformance.ts:373`) | held ÷ (all − canceled) |
  | Pipeline Health (`pipelineHealth.ts:629`) | held ÷ (all − canceled) |
  | Sales Calls (`salesCallsDashboard.ts:114`) | held ÷ (all − canceled) |
  | Exported operations reports (`operations/reports/reducers.ts:378`) | held ÷ (all − canceled) |
  | Overview (`overviewOperations.ts:120`) | held ÷ all, canceled included |

  In the first four, "all − canceled" still counts the unrecorded scheduled meetings.
- **Days:** four definitions, as the brief lists. The Honduras business day is hardcoded as 07:00 UTC in the server helper and in four client files. UTC days are used by the meeting projections, `revenueTrend` and the sales report reducers, and UTC midnight by the overview's operations window. Browser midnight is used by the legacy report controls, the closer dashboard, `time-period-filter.tsx`, billing filters and `mark-unavailable-dialog.tsx`. Only the Slack qualifications report and the exports say which day they use.
- **Merge (F11):** already fixed. Duplicate flags are read through `by_tenantId_and_potentialDuplicateLeadId` in pages of 25 (`leads/merge.ts:247-276`), source deals are capped at 50, identifiers at 100, and repoints run in 200-row pages. This phase changes no merge code.
- **`stageForStatus` and `legacyStatus`:** one production caller, `pipeline/bookingHistory.ts`, which reads old events. Both stay.

## 3. Schema

### 3.1 Widen

| PR | Change |
| --- | --- |
| 5 | `meetings` index `by_tenantId_and_assignedCloserId_and_status_and_scheduledAt` |
| 6 | Aggregates `openDealAging` and `personLosses` (§6.2) |
| 7 | Aggregate `activityEventCounts` (§6.3) |
| 8 | Aggregate `leadGenDealsByWorker` (§6.4) |
| 10 | `meetings.status` accepts `held` beside `completed`; `meetings.heldMarkedAt` (optional number); `meetingProjectionSchema`'s contribution status accepts `held` |
| 11 | `tenants.businessDay` (optional `{ timeZone: string, dayStartHour: number }`) and `tenants.businessDayVersion` (optional number); `businessDayRebuilds`, one row per settings change being applied (§4.4) |

### 3.2 Made optional, then cleared

| PR | Field | Rows to clear |
| --- | --- | --- |
| 2 | `opportunitySearch.activityDayKey`, `activityWeekKey`, `activityMonthKey`, and their `search_opportunities` filter fields | about 11,600 |
| 3 | `paymentRecords.commissionable` | 291 |
| 4 | `opportunities.canceledAt`, `noShowAt` (already optional) | 2,452 and 527 |
| 10 | `meetings.completedAt` | 715 held, 510 no-show |

### 3.3 Dropped

**In PR 2, the 44 unused indexes that don't leave with a field or table:**

| Table | Indexes |
| --- | --- |
| `leadGenWorkers` | `by_tenantId_and_workosUserId` |
| `leadGenProspects` | `by_tenantId_and_normalizedHandle`, `by_tenantId_and_latestSource`, `by_tenantId_and_lastSubmittedAt`, `by_tenantId_and_firstCapturedByWorkerId`, `by_tenantId_and_currentAuditMatchId` |
| `leadGenAuditMatches` | `by_tenantId_and_matchStatus` |
| `leadGenCorrectionEvents` | `by_tenantId_and_correctedAt`, `by_tenantId_and_targetType_and_targetId` |
| `rawWebhookEvents` | `by_calendlyEventUri` |
| `leads` | `by_tenantId_and_firstSeenAt` |
| `leadCustomerSearchRows` | `by_tenantId_and_leadStatus_and_latestActivityAt`, `by_tenantId_and_customerStatus_and_latestActivityAt` |
| `attributionTeams` | `by_tenantId_and_slug` |
| `dmClosers` | `by_tenantId_and_slug` |
| `linkPortalAuthAttempts` | `by_publicSlug_and_ipHash` |
| `linkPortalCopyEvents` | `by_tenantId_and_dmCloserId_and_copiedAt`, `by_tenantId_and_eventTypeConfigId_and_copiedAt` |
| `opportunities` | `by_tenantId_and_latestActivityAt`, `by_tenantId_and_source_and_latestActivityAt`, `by_tenantId_and_assignedCloserId_and_latestActivityAt`, `by_tenantId_and_assignedCloserId_and_source_and_latestActivityAt`, `by_tenantId_and_firstBookingProgramId_and_qualifiedAt` |
| `opportunitySearch` | `by_tenantId_and_latestActivityAt` |
| `meetingReassignments` | `by_toCloserId`, `by_fromCloserId` |
| `eventTypeConfigs` | `by_tenantId_and_bookingProgramId` |
| `paymentRecords` | `by_tenantId_and_commissionable_and_recordedAt`, `by_tenantId_and_paymentType_and_recordedAt` |
| `billingExportEvents` | `by_tenantId_and_actorUserId_and_createdAt` |
| `followUps` | `by_tenantId_and_createdSource_and_createdAt` |
| `domainEvents` | `by_entityId` |
| `slackUsers` | `by_slackTeamId_and_slackUserId` |
| `rawSlackEvents` | `by_tenantId_and_processed`, `by_teamId_and_apiAppId` |
| `operationsReportJobs` | `by_tenantId_and_requestedByUserId_and_requestKey_and_status`, `by_tenantId_and_requestedByUserId_and_purpose_and_status`, `by_cleanupPending_and_expiresAt`, `by_purgeAt` |
| `operationsReportRows` | `by_jobId_and_section_and_sortValue`, `by_jobId_and_rowType` |
| `operationsReportArtifacts` | `by_state_and_reservationExpiresAt` |
| `webhookRecoveryAttempts` | `by_tenantId_and_deliveryId` |
| `operationsMeetingStatsV2` | `by_tenantId_and_assignedCloserId_and_dayKey` |

The other two of the 46 go with their field or table: `meetings.by_tenantId_and_meetingOutcome_and_scheduledAt` (PR 4) and `operationsMeetingDailyStats.by_tenantId_and_assignedCloserId_and_dayKey` (PR 13). Before PR 2 opens, its worker reruns the exact-name search against the branch, and an index that has gained a reference stays. Afterwards: 236 indexes before this phase's new ones, and 17 on `opportunities`.

**In PR 4:** `meetings.meetingOutcome` and its index. No row has the field, so it narrows straight away.

**In PR 13, the narrow:**
- the `tenantStats` table;
- the `operationsMeetingDailyStats` table;
- `paymentRecords.commissionable`, and `customer_direct` and `bookkeeper_direct` from the origin validator;
- `opportunities.canceledAt` and `noShowAt`;
- the three `opportunitySearch` day keys;
- `completed` from `meetings.status` and from the projection contribution validator;
- `meetings.completedAt`.

## 4. Rules

### 4.1 Attendance (D1)

A meeting is `scheduled`, `held`, `no_show` or `canceled`. Each recorded state has its own time, and the fields have plain names, so a warehouse query needs no join:

| Status | Time it was recorded | Set by |
| --- | --- | --- |
| `held` | `heldMarkedAt` | the closer or admin action that records a payment, a follow-up, a reminder or a loss on the meeting (`completeMeetingForOutcome`) |
| `no_show` | `noShowMarkedAt` (exists) | a closer, an admin, or Calendly |
| `canceled` | `canceledAt` (exists) | Calendly, a reschedule, or a redistribution |

- `completedAt` goes. On the 715 completed meetings, `heldMarkedAt` takes its value. That value is the click time, as §2.1 shows. On the 510 no-shows that carry one, it is cleared; their `noShowMarkedAt` already holds the same click.
- The transition rules stay as they are, with `held` in `completed`'s place. Held is terminal, and Calendly can't change a held meeting (`bookingFacts.ts:131`). Only a Calendly-owned no-show returns to scheduled when Calendly withdraws it.
- The person's Showed stage keeps its rule: the time is `min(scheduledAt, heldMarkedAt ?? scheduledAt)`, which gives the same value as today's `completedAt`. A cleared no-show `completedAt` never granted Showed. So no stage time moves, and `assertLeadLifecycle` proves it.
- Meeting events from PR 10 carry `held` in `toStatus`; old events keep `completed`. Every reader and label of event statuses reads both forms, as Phase 5 did for deal statuses. In PostHog, `meeting.*` events show `to_status: "held"` from PR 10's deploy.
- **The rename runs in two steps.** In PR 10, every reader treats `completed` and `held` as one state through `isHeldStatus` in `convex/lib/meetingAttendance.ts`, and every writer writes `held` and `heldMarkedAt`. Then the backfill moves the old rows (§10.4). PR 13 removes `completed`. A status field can't hold both values at once, so the "dual write" here means readers that accept both values, and a time written to both `heldMarkedAt` and `completedAt` until the backfill passes. PR 10 keeps writing `completedAt` on held meetings, so a revert to PR 9 still finds it.

### 4.2 "Not recorded" (U2)

One helper, `meetingAttendanceDisplay(meeting, now)` in `lib/status-config.ts`, beside the meeting status config. It returns `not_recorded` when the status is `scheduled` and the meeting's end time (`scheduledAt + durationMinutes`) has passed. Otherwise it returns the status. Nothing stores or backfills `not_recorded`.

- **Where it's used:** the calendar blocks, the day, week and month views and the popover; the meeting info panel and overview card; the reminder history panel; the deal's meetings list; the person page's meeting rows; and the Sales Calls and Booked Calls detail lists.
- **Labels:** "Not recorded", with a muted amber style. The labels and palettes some of these components define for themselves go; they read the shared config.
- **Reports:** counts that come from day buckets count the scheduled meetings of finished days as Not recorded. For the current day, a bounded read of that day's scheduled meetings by `by_tenantId_and_status_and_scheduledAt` (at most about 100 rows) splits them by end time, so the counts apply the same rule.
- **Exports:** the raw call and booking rows keep the stored status in `MeetingStatus` and add an `Attendance` column with the display value.

### 4.3 Show rate (U3)

**Show rate = held ÷ (held + no-show).** Canceled and Not recorded meetings are in neither number. A range with no held or no-show meeting shows "—".

- **Where it applies:** all five reads in §2.6, the per-program and per-closer rows, and the exported operations reports (summary, closer and program sheets).
- **No-show rate:** no-show ÷ (held + no-show), so the two add up to 100%.
- **Copy:** every tooltip and help text says "Held calls ÷ (held + no-show). Canceled and not-recorded calls are left out." The overview's "Completed calls divided by booked calls", the Sales Calls "Showed ÷ (total calls − canceled)", and every "marked completed" become "held".
- **Results recorded (if Q2 is yes):** beside each show rate, "X of Y past calls have a result". Y counts the past calls that weren't canceled, and X counts those that are held or no-show.

### 4.4 The business day (U4)

- **Setting:** `tenants.businessDay = { timeZone, dayStartHour }`, an IANA zone and a local hour from 0 to 23. When it's absent, it means `{ "America/Tegucigalpa", 1 }`, today's 07:00 UTC. One module, `lib/businessDay.ts`, is shared by the server and the client. It turns an instant into a business date and a business date into its `[start, end)` instants. It uses the zone's offset at that date, so a zone with daylight saving gets 23- and 25-hour days, and a start hour that doesn't exist on a change day moves to the first instant after it. `convex/reporting/lib/hondurasBusinessTime.ts` and `app/workspace/_components/dashboard-date-utils.ts` become thin callers of it.
- **Where it applies:** every server-side day:
  - the meeting projections' `dayKey` (UTC today), and so Sales Calls, Booked Calls, the team report's operations dimensions and the pipeline show rate;
  - `revenueTrend`'s day, week and month buckets;
  - the overview's operations window (UTC midnight today);
  - the operations report reducers and their exports, whose "UTC days (00:00)" boundary text goes;
  - everything on the Honduras business day today: lead gen stats, Slack qualifications, booked calls, work schedules and the report contracts.
- **Screens on the browser clock stay** (U4): the legacy report controls, the closer dashboard and calendar, the closer pipeline filter, billing filters and the unavailability dialog. `lib/opportunitySearch.ts`'s day keys aren't moved: they go (§3.2).
- **Every dated screen says its day.** A line under the date control reads "Days run 1:00 am to 1:00 am, America/Tegucigalpa time" (from the setting) or "Days follow your browser's time zone". The weeks follow D9.
- **Who may change it:** `settings:manage` (tenant owner and tenant admin; Q5), on a new "Business day" card in `/workspace/settings`, through `updateBusinessDay`. That mutation takes the tenant and role from the identity, as every public function does.
- **How a change applies:** `updateBusinessDay` refuses while a rebuild is running. Otherwise it saves the setting, bumps `businessDayVersion`, inserts a `businessDayRebuilds` row and schedules the rebuild:
  1. `rebuildMeetingProjections` for the tenant, which re-keys `operationsMeetingStatsV2` through the projection worker;
  2. `rebuildLeadGenDayStats` (new), which rebuilds `leadGenDailyStats`, `leadGenOriginStats` and `leadGenTeamOriginStats` from the unvoided submissions in 200-row pages;
  3. a check of the three projections' asserts, which marks the row done.

  Report requests include `businessDayVersion` in their request key, so a report cached under the old day isn't returned. While the row is open, the dated screens show "Day totals are being rebuilt after a business day change." The meeting projection rebuild takes about 20 minutes at today's volume, and the lead gen rebuild runs over every submission (its count is taken at the PR 11 dry run on dev).
- **Unavailability dates** keep their stored browser-local instants. The dialog's comment, which says "midnight UTC", is corrected.

### 4.5 Behaviour that stays

Apart from §4.2 to §4.4, every screen shows the same numbers:

- **Bounded reads** return the same rows below their bound, and say so when they reach it.
- **Aggregates replace reads one for one**, and the parity checks (§10.6) prove the old and new ways agree on today's data.
- **Moving the meeting projections to the business day** moves the 961 evening meetings to the previous date (§7). It changes no total over a month.

## 5. Write paths

### 5.1 `tenantStats` (PR 1)

The writes go from all 15 modules. Three are on the booking path:

- the deal insert in `pipeline/inviteeCreated.ts`;
- `resolveLeadIdentity` in `leads/identityResolution.ts`;
- `writeLifecycle` in `lib/leadLifecycle.ts`.

The others are the payment paths (`applyPaymentStatsDelta`), user and team member writes, enrollments, side deals and merges. `convex/lib/tenantStatsHelper.ts` is deleted, along with:

- `seedTenantStatsInternal` and its callers;
- the `tenantStats` entry in the tenant deletion's table list;
- the `testing/operationalData.ts` inventory and reset entries;
- the tests that read the table.

The payment paths keep every other side effect. `deleteTenantStatsRows` (an internal mutation) deletes the one row (§10.1), and PR 13 drops the table. A total a screen needs later comes from an aggregate.

### 5.2 Attendance (PR 10)

- `completeMeetingForOutcome` writes `status: "held"`, `heldMarkedAt: now`, and `completedAt: now` until PR 13.
- `closer/noShowActions.ts` and `admin/meetingActions.ts` stop writing `completedAt` on a no-show.
- `bookingFacts.ts` protects `held` as it protects `completed`. `bookingTargets.ts`'s `BookingFactMeetingStatus` excludes both.
- `statusTransitions.ts` treats `held` and `completed` as one terminal state.
- The `meetingsByStatus` aggregate and the projections take the status as it's stored. During the window between deploy and backfill, every reader counts `completed` and `held` together. The backfill patches through `patchMeetingLifecycle`, which replaces the aggregate entry and queues the projection.

### 5.3 New aggregates

All three use `insertIfDoesNotExist`, `replaceOrInsert` and `deleteIfExists` until their backfill passes. They switch to the strict methods in PR 13.

- **`openDealAging` and `personLosses`** (opportunities) are written in `insertOpportunityAggregate`, `replaceOpportunityAggregate` and `deleteOpportunityAggregate` (`reporting/writeHooks.ts`), and `updateOpportunityMeetingRefs` calls the replace, since it patches `nextMeetingAt` without it today.
- **`activityEventCounts`** is written in `emitDomainEvent`, the only production insert into `domainEvents`, and deleted wherever events are deleted: tenant teardown, the blocker purge and the test-data reset.
- **`leadGenDealsByWorker`** is written in `insertRow` (`lib/attribution/dealAttributions.ts`), the only insert into `dealAttributions`, and in `deleteDealAttributions` and `deleteMeetingAttributions`. Moves and team member repoints don't change its key.

### 5.4 Dead fields

- **`opportunities.canceledAt` and `noShowAt` (PR 4):** the writers in `bookingFacts.ts`, `closer/noShowActions.ts` and `admin/meetingActions.ts` stop, along with the preservation read at `bookingFacts.ts:167`. The `testing/e2e.ts` payload reads the meeting's times instead.
- **`commissionable` (PR 3):** the four payment inserts stop writing it. About 20 convex readers and 6 UI components stop reading it. `paymentSums` keys every payment to its `attributedCloserId`, which is the key every payment has today, so no re-key is needed. The two retired origins leave `lib/paymentTypes.ts`, the backfill normalizer (`customer_flow` maps to `closer_meeting`, as it does for every other legacy row) and the UI label maps.
- **The search row day keys (PR 2):** `buildOpportunitySearchRow` stops writing them.

## 6. Readers

### 6.1 Closer dashboard and calendar (PR 5)

- **`readCloserMeetingDeals`** reads the closer's meetings in the range through the existing index with `readLiveQueryRows` (at most 2,000 meetings and a 4 MiB budget), plus one deal read per distinct deal. It returns `isMeetingDataTruncated`, and the strip shows "Partial: narrow the range" when it's true. A closer's busiest month today is under 300 meetings.
- **`getNextMeeting`** reads the new `by_tenantId_and_assignedCloserId_and_status_and_scheduledAt` from now and takes the first 25 scheduled meetings. It returns the first whose deal is still the closer's. If none of the 25 is, it says so rather than returning "no meeting".
- **The calendar** caps the range at 45 days and reads at most 1,000 meetings, with a partial flag the view shows. It keeps showing canceled meetings and the missing-deal labels.

### 6.2 Pipeline Health (PR 6)

- **Aging** comes from `openDealAging`: a TableAggregate on `opportunities` keyed by tenant and `[stage, nextMeetingAt ?? 0]`, with `sumValue: createdAt`, counting only open deals.
  - The count per stage is the count under `[stage]`.
  - The mean age is `(now × count − sum) ÷ count`.
  - The stale count is the count of keys below `[stage, now − 14 days]`. A deal with no next meeting has key 0, so it counts as stale, which is today's rule.
  - The oldest deal is the first row of `by_tenantId_and_stage_and_outcome_and_createdAt`.
  - The stale list (top 20 by age) reads that index from the oldest, keeps the stale deals, and stops at 20 or after 500 rows, with a flag.
  - Velocity is already bounded and stays.
- **Losses** come from `personLosses`: a TableAggregate keyed by tenant and `[lostAt, lostByUserId ?? ""]`, for deals Closed lost by a person (`isPersonLoss`), so no system loss is in it. The report pages through the aggregate's entries in `[start, end)` and counts them by actor. That is about 250 entries in all today, so a month from any date reads only its own losses, with no cut-off. A cap of 2,000 entries stays as a safety bound, with the existing "Capped" label.

### 6.3 Activity report (PR 7)

- **The summary** counts from `activityEventCounts`, a DirectAggregate keyed by tenant and `[dimension, value, occurredAt]`. Each event writes six entries:
  - `all` (value ""): the total;
  - `source`;
  - `entityType`;
  - `eventType`;
  - `actor` (the user ID, or "" when there's none);
  - `reminderOutcome`, only for `followUp.completed`.

  The summary reads every count for the range in one `countBatch`. The value lists come from code: the event type, source and entity type catalogs, the reminder outcomes, and the tenant's users. An actor who has been deleted is counted as "Removed user": the total minus the sum of the known actors. The summary is exact, so it loses `isTruncated`, along with the truncation notice in `activity-feed-page-client.tsx` and `activity-summary-cards.tsx`.
- **The feed** paginates the index it already picks, 50 events a page with a 500-row read budget per page. It returns a cursor and `isDone`, and "Load more" continues from the cursor instead of rereading. Filtered pages can come back short and still have more.
- **Tests:** `activityFeed.test.ts`'s truncation test becomes one that proves the summary counts an event behind 10,000 newer ones, and that the feed reaches it through its cursor.

### 6.4 Lead gen conversions (PR 8)

The Deals column counts from `leadGenDealsByWorker`, a TableAggregate on `dealAttributions` keyed by tenant and `[source.workerId, attributedAt]`, for `role: "lead_gen"` rows with `source.kind: "capture"`. It reads one `countBatch` per page of workers over the capture-time range. The count is still of rows, one per deal, as today. `dealsCapped` and its "partial" label go.

### 6.5 Attendance readers (PRs 9 and 10)

- **PR 9** applies §4.2 and §4.3: the display helper and its call sites; the show-rate formula in the five reads, in the reducers and in the export sheets; the copy; and the results-recorded line.
- **PR 10** moves every comparison with `"completed"` to `isHeldStatus`:
  - the `meetingsByStatus` readers in `teamPerformance.ts`;
  - the projection readers;
  - `outcomeDerivation.ts`;
  - `leadLifecycle.ts`'s meeting evidence;
  - the `MeetingStatus` types in `lib/status-config.ts` and `phoneSales.ts`;
  - the return validators in `salesCallsDashboard.ts` and `bookedCallsDashboard.ts`;
  - the generic string comparison in `operations/reports/reducers.ts:378` and the loose `meetingStatus: string` in `operations/reports/model.ts`;
  - the legacy `status=completed` link in `app/workspace/pipeline/page.tsx`.

  The label is "Held", and "Completed" leaves the meeting labels. The output field `completed` in `overviewTypes.ts` becomes `held`.
- **`sideDeals/deleteEmptyOpportunity.ts`** reads follow-ups, not meetings, so it doesn't change.

### 6.6 Booking Answers (PR 12, only if Q4 is yes)

`getMeetingDetail` reads that meeting's `meetingFormResponses` through `by_meetingId` (at most 100 rows). The card shows the meeting's own answers, each under its `questionLabelSnapshot`. A meeting with no stored responses shows "No answers stored for this booking"; it doesn't fall back to the person's latest answers.

## 7. Report numbers

The before and after values for September 2026 (UTC month, by meeting start time; the after values keep the UTC month so the formulas compare like for like):

| Screen | Today | After |
| --- | --- | --- |
| Sales Calls, team report, Pipeline Health, exports | show rate 189 ÷ (1,057 − 286) = 24.5% | 189 ÷ (189 + 198) = 48.8% |
| Overview | show rate 189 ÷ 1,057 = 17.9% | 48.8% |
| Same screens | no-show rate 198 ÷ 771 = 25.7% (overview 18.7%) | 198 ÷ 387 = 51.2% |
| Results recorded (if Q2 is yes) | none | 387 of 771 past calls have a result |

- **Day buckets:** the move to the business day takes the 961 meetings that start between 18:00 and 24:00 Honduras time off the next UTC date and onto their own date. Per-day counts on Sales Calls, Booked Calls and the team report's dimensions move. Monthly totals move only at the month's edges: a meeting at 20:00 Honduras time on the last day of a month is in that month from PR 11.
- **The revenue trend's days:** a payment recorded between 00:00 and 07:00 UTC moves to the previous date.
- **The overview's operations window:** it starts at 07:00 UTC instead of 00:00, as its Slack window already does.
- **Week start (D9):** from Monday on every screen, so "This week" on the report pages loses Sunday.
- **Everything else** shows the same numbers. The parity checks in §10.6 prove that for the aggregates.

The exact before and after values for each screen are recorded in §13 as each PR deploys.

## 8. What else moves

- `docs/agents/convex.md`: the `tenantStats` write side effect goes; the new aggregates join the write hooks list; attendance says `held` and `heldMarkedAt`; the "Dates" section names `lib/businessDay.ts`.
- `docs/agents/frontend.md`: the Not recorded helper and the day line under date controls.
- `CONTEXT.md`: Meeting says held; the business day joins as a term.
- ADR 0001 (§11.2), the review's Phase 6 card, and `AGENTS.md`'s line about the model.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 0 | This plan, with the ADR row and review card amended (A1) | docs |
| 1 | `tenantStats` writes, helper, seed and references removed; `deleteTenantStatsRows` | nothing reads the table |
| 2 | The 44 indexes; `getTimePeriodStats` and its test; the search row day keys optional and unwritten, with their clear | no code reads any of them |
| 3 | `commissionable` and the retired origins unread and unwritten, the field optional; `assertPaymentsCommissionable`, the clear | every payment is commissionable, so every number is unchanged |
| 4 | `meetingOutcome` and its index dropped; the deal's meeting times unwritten, with their clear; the reports' readiness guard stops checking the legacy table; `deleteLegacyMeetingDailyStats` | no reader; the guard's other checks stay, and a test proves the five reports stay ready |
| 5 | Closer dashboard, next meeting and calendar bounded; the meeting index | the same rows below the bound |
| 6 | `openDealAging` and `personLosses` with their hooks, backfills and parity checks; Pipeline Health reads them only once the parity checks pass (a tenant flag set by the check, `pipelineHealthAggregatesVerifiedAt`) | until then the report reads as today |
| 7 | `activityEventCounts`, hooks, backfill and parity check; the summary reads it once its check passes (same pattern); the feed paginated | as PR 6 |
| 8 | `leadGenDealsByWorker`, hooks, backfill and parity check; the Deals column reads it once its check passes | as PR 6 |
| 9 | Not recorded helper, the one show rate, copy, the results-recorded line | reads stored fields only |
| 10 | Attendance: `held` and `heldMarkedAt` accepted and written, readers take both, no-shows lose `completedAt` from new writes; `backfillMeetingAttendance` and `assertMeetingAttendance` | readers accept both values, so rows before and after the backfill read the same |
| 11 | The business day setting, `lib/businessDay.ts`, every server day on it, the day line on every screen, Monday weeks, the settings card, the rebuild on change, `rebuildLeadGenDayStats` | the default equals today's Honduras day; the meeting projections move to it through `rebuildMeetingProjections` straight after the deploy |
| 12 | Booking Answers (only if Q4 is yes) | reads only |
| 13 | The narrow (§3.3); the new aggregates on strict methods; the parity code and flags removed; ADR, review, `CONTEXT.md`, `AGENTS.md`, the agent guides; this plan's status | after every clear, deletion and backfill has passed in production and on dev |

- **Merge order:** PRs 1 to 4 merge in any order, but PR 3 rebases on PR 1, since both touch the payment paths. PRs 5 to 8 can go in any order. PR 9 goes before PR 10, and PR 10 before PR 11, because PR 11's projection rebuild follows PR 10's backfill: one rebuild, not two. PR 12 can go anywhere.
- **Dev (U7):** before PR 13 merges, every clear, deletion and backfill runs on dev too, with `.env.local` without its `CONVEX_DEPLOY_KEY` line, and never a production file. Then `npx convex dev --once` must pass on PR 13's branch.

**Production runs, in this order** (§10.7 has the commands):

1. After PR 1: `deleteTenantStatsRows` dry run, then the run (1 row). A read-only check finds no row.
2. After PR 2: `clearOpportunitySearchDayKeys`, then `assertOpportunitySearchDayKeysCleared`.
3. After PR 3: `assertPaymentsCommissionable`, which finds no payment with `commissionable: false`. Then `clearPaymentCommissionable` and `assertPaymentCommissionableCleared`, and then `assertEnrollments` and `assertPaymentEnrollments`, since the payment paths changed.
4. After PR 4:
   - `clearDealMeetingTimes` and `assertDealMeetingTimesCleared`;
   - `deleteLegacyMeetingDailyStats` (5,761 rows) and `assertLegacyMeetingDailyStatsEmpty`;
   - a read-only check that the five reports behind `requireReportingReady` still answer;
   - then `assertBookingAttributions` and `assertDealAttributions`, since the booking-fact path changed.
5. After PR 5: none. A read-only check compares each closer's strip and calendar counts for this month.
6. After PR 6: `backfillOpenDealAging` and `backfillPersonLosses`, then `verifyPipelineHealthAggregates`, which compares both ways on the live data and sets the flag only when they agree.
7. After PR 7: `backfillActivityEventCounts` (every event; its count is taken at the dry run), then `verifyActivityEventCounts` over the last 30 days, day by day.
8. After PR 8: `backfillLeadGenDealsByWorker`, then `verifyLeadGenDealsByWorker`.
9. After PR 9: none. A read-only recheck of §7's numbers.
10. After PR 10:
    - `backfillMeetingAttendance` dry run, then the run: 715 meetings to `held`, and 510 `completedAt` cleared;
    - `assertMeetingAttendance`;
    - poll `meetingProjections` until none is queued, then `assertMeetingProjections`, `assertMeetingProjectionBuckets` and `assertMeetingProjectionSources`;
    - `verifyBackfillCounts` (the meetings aggregate);
    - `assertLeadLifecycle` in the background (about an hour).
11. After PR 11: `rebuildMeetingProjections` (reset), poll until drained, then the three projection asserts. `rebuildLeadGenDayStats` doesn't run, since the default day equals today's. A read-only recheck of §7's day numbers.
12. After PR 13: the schema push checks every row. Then `assertDealStages`, `assertMeetingAttendance` and the projection asserts (reset) once more.

## 10. Backfill, parity and assert migrations

All are `migrations.define` in `convex/migrations.ts` unless named otherwise, batch 200 unless the dry run says otherwise. None emits an event or moves a person's stage. Rows keep arriving between runs; the asserts check each row rather than a count.

### 10.1 `deleteTenantStatsRows` (PR 1)

An internal mutation. It deletes every `tenantStats` row: one in production and one on dev. With `dryRun: true` it returns the row IDs and counts only. No export is taken: §2.3 records the counters, and each one recounts from its table.

### 10.2 The clears (PRs 2 to 4)

| Clear | Table | Expected | Assert |
| --- | --- | --- | --- |
| `clearOpportunitySearchDayKeys` | `opportunitySearch` | about 11,600 | `assertOpportunitySearchDayKeysCleared` |
| `clearPaymentCommissionable` | `paymentRecords` | 291 | `assertPaymentCommissionableCleared`; before it, `assertPaymentsCommissionable` |
| `clearDealMeetingTimes` | `opportunities` | 2,452 `canceledAt`, 527 `noShowAt` | `assertDealMeetingTimesCleared` |
| `deleteLegacyMeetingDailyStats` | `operationsMeetingDailyStats` | 5,761 deleted | `assertLegacyMeetingDailyStatsEmpty` |

The clears patch directly. None of the fields is in an aggregate key or a projection.

`clearDealMeetingTimes` changes no number, because every value is a copy of the meeting's `canceledAt` or `noShowMarkedAt`. The deletion of the legacy table drops rows that nothing reads, and V2 holds the same counts.

No export is taken for any of them (D10).

### 10.3 Aggregate backfills and parity (PRs 6 to 8)

- **The backfills** page their source table with `insertIfDoesNotExist`, as `reporting/backfill.ts` does.
- **Each `verify*` is an internal query** that computes the report's numbers both ways for given ranges and returns the differences, IDs and counts only:
  - Pipeline Health: aging per stage now, and losses by actor for each month from 2026-04;
  - activity: the summary for each of the last 30 business days, where the old way is exact under 10,000 events a day;
  - Deals: per worker for each month from 2026-04, where the old way is exact under 5,000 rows.
- **The flag:** an internal mutation sets the PR's tenant flag only when every difference is zero, or is explained by rows written between the two reads. A rerun clears that.
- **The aging comparison** allows for `now` moving between the reads by comparing the counts and the sums of `createdAt`, not the ages.

### 10.4 `backfillMeetingAttendance` and `assertMeetingAttendance` (PR 10)

**`backfillMeetingAttendance`**, over `meetings`, through `patchMeetingLifecycle`, so that the aggregate entry is replaced and the projection queued:

- `completed`: set `status: "held"` and `heldMarkedAt: completedAt`. `completedAt` stays until PR 13 clears it.
- `no_show` with `completedAt`: unset `completedAt`.

It expects 715 and 510 rows, and a rerun changes nothing.

**`assertMeetingAttendance`** checks:

- no meeting is `completed`;
- every `held` meeting has `heldMarkedAt`;
- no `no_show` or `scheduled` meeting has `completedAt`;
- no meeting other than a held one has `heldMarkedAt`.

PR 13 drops `completedAt` from the schema. Before that, `clearHeldCompletedAt` unsets it on the held meetings, with the assert amended to check none is left. It stays as a health check.

### 10.5 `rebuildLeadGenDayStats` (PR 11)

An internal, tenant-scoped rebuild of the three lead gen day tables from unvoided submissions, under the tenant's business day. It runs in two passes: compute the new rows, then swap them in a page at a time, so a reader never sees a day both empty and counted. `auditAggregateRange` and `auditTeamOriginStatsRange` are its asserts.

In this phase it runs only on dev, as a test of the change path; production keeps the default day. The settings card starts it for real when someone changes the day.

### 10.6 Parity for the attendance and day changes

- **PR 10:** after the backfill, `verifyBackfillCounts` and the projection asserts prove that the aggregate and buckets carry `held` and no `completed` key. A read-only recheck of §7's September numbers must give the same figures as before the backfill.
- **PR 11:** a read-only query compares the old UTC-day and new business-day projection totals for each month from 2026-04. The totals must differ only by the meetings that start between 18:00 and 24:00 Honduras time on a month's last day, or on the first day of the next month.

### 10.7 Commands

Every command runs against production with `--env-file .env.vercel.production`; without it, the CLI targets dev. Each run goes through a `#!/bin/bash` driver script with `set -euo pipefail`, which stops when a dry run fails or shows an error. Dry-run output is filtered with `grep -E '"processed"|"DryRun"|error'`, since a dry run prints whole documents.

```
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillMeetingAttendance","dryRun":true}'
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillMeetingAttendance"}'
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:backfillMeetingAttendance"]}'
```

- **Order:** dry run, run, poll `lib:getStatus` until `"isDone": true`, read any error, run the assert the same way, then a read-only recheck.
- **Polling:** a background loop that waits 30 seconds with `perl -e 'select(undef,undef,undef,30)'`.
- **Failures:** a batch that fails on a known Convex limit resumes from its cursor at a smaller batch. Any other failure, and any failed assert, stops the phase until a reviewed fix ships and the step passes again (§12).

The health checks that stay, with `"reset":true`, are `assertMeetingAttendance` and those from earlier phases.

## 11. Decisions

### 11.1 Answered by the tenant admin before planning (2026-10-22)

- **U1. Drop `tenantStats`:** the table, its helper and every reference.
- **U2. Not recorded is a display rule** (§4.2). Closers are expected to record every call. The daily prompt that walks a closer through their numbers and unrecorded meetings isn't built in this phase. It goes in the handoff's ideas for after the roadmap.
- **U3. One show rate:** held ÷ (held + no-show) on every screen and export, with tooltips to match (§4.3, before and after in §7).
- **U4. The business day is a tenant setting** (§4.4), defaulting to America/Tegucigalpa 01:00, with an admin control. Every server-side day uses it. Browser-clock screens may stay, and each screen says its day.
- **U5. `meetings.notes` stays.**
- **U6. Convex dashboard leftovers stay:** the empty `customers` table, and the `customerConversions` and `opportunityByStatus` component data. The handoff lists them.
- **U7. Dev is repaired.** Each backfill and clear runs on dev before its narrow merges (§9).

### 11.2 Design decisions (recommended; accept or change)

- **D1. Attendance** (§4.1). `held` replaces `completed`. The recorded time is `heldMarkedAt`, beside `noShowMarkedAt` and `canceledAt`, and the 715 take their `completedAt`, which is the click time. The 510 no-shows lose `completedAt` and keep `noShowMarkedAt`. Showed keeps its rule and its times.
- **D2. Not recorded's moment.** The meeting's end time, start plus duration, so a call in progress isn't flagged.
- **D3. `tenantStats`.** The row is deleted, with no export (§10.1).
- **D4. Indexes.** All 44 in §3.3 are dropped in PR 2, after a recheck, plus the two that leave with their field or table.
- **D5. The deal's meeting times.** `canceledAt` and `noShowAt` are cleared on 2,452 and 527 deals, then dropped; the meeting holds both times.
- **D6. `commissionable`.** It's dropped after an assert finds no `false`. `paymentSums` keeps its keys, and the two origins leave every list.
- **D7. The legacy daily stats table.** Its 5,761 rows are deleted in PR 4 and the table dropped in PR 13.
- **D8. The search row day keys.** They're dropped: no query reads them, and keeping them would mean moving them to the business day.
- **D9. Week start: Monday everywhere.** That covers report presets, the closer calendar's week view and month grid, the closer dashboard and the Slack and lead gen periods. The business-day and ISO screens already start on Monday.
- **D10. Exports.** None is taken. Every value cleared or deleted is a copy that rebuilds from its source.
- **D11. Bounded reads** (§6.1, §6.2). Caps with a visible partial flag where a closer's own data stays small, and aggregates where the report must be exact.
- **D12. The aggregates' keys** (§6.2 to §6.4), and the parity flag that keeps each report on its old read until the check passes.
- **D13. Production runs.** §9's order: dry run first for each, each run as soon as the previous assert passes, with no approval stop in between.

### 11.3 Questions for the tenant admin

- **Q1. Week start.** Report pages start "This week" on Sunday; the closer dashboard's stats start on Monday, while its calendar starts on Sunday. The recommendation is Monday everywhere (D9).
- **Q2. Results recorded.** Should "X of Y past calls have a result" show beside the show rate? The recommendation is yes, on Sales Calls, the team report, Pipeline Health and the overview's closer table. It shows whether the show rate rests on enough calls (September: 387 of 771).
- **Q3. Attendance as D1.** That covers held, `heldMarkedAt` from the click time, and no-shows losing `completedAt`. The recommendation is yes.
- **Q4. Booking Answers.** The card on the meeting pages shows the person's latest answers, merged across bookings, not that meeting's own. Should it show the meeting's own (§6.6)? The recommendation is yes: a closer reading an old meeting sees what the person answered for that call.
- **Q5. Who may change the business day.** The recommendation is the tenant owner and tenant admins (`settings:manage`), the same as the other tenant settings. A change rebuilds the day totals in about half an hour, and the screens say so while it runs.
- **Q6. Outside readers.** Is Fivetran, or anything else, already syncing Convex tables? If so, dropping `tenantStats`, the legacy table and the dead fields changes what it receives. The recommendation is to proceed: none of them holds a fact that isn't elsewhere.
- **Q7. Production runs.** Every run in §9 and §10, including the deletion of the `tenantStats` row and the 5,761 legacy rows: does the approval of this plan cover them, as in Phase 5?

### 11.4 Changes to ADR 0001 and the review

- **A1, in this PR.** The Phase 6 row and the review's Phase 6 card now say the business day is a tenant setting (U4), and that `meetings.notes` stays (U5).
- **A2, in PR 13.** The roadmap closes:
  - the ADR's Phase 6 status and status line;
  - "Rules for code written now" read as standing rules;
  - the Meeting bullet names `heldMarkedAt`;
  - the review's Phase 6 card says what shipped;
  - `AGENTS.md` says leads, deals, meetings, customers and attribution follow the model;
  - `CONTEXT.md`'s Meeting says held.

## 12. Rollback

Fix forward, reviewed. Every repair is an internal migration with its own assert, run as §10.7 says.

- **PR 1:** revert brings back the writes. The deleted row is recreated by `seedTenantStatsInternal`, which the revert restores, from the tables.
- **PR 2:** revert. The indexes rebuild on deploy. The cleared search day keys are rebuilt by `backfillOpportunitySearchProjection` (reset).
- **PR 3:** revert. A reviewed repair sets `commissionable: true` on every payment, which is the only value it ever had.
- **PR 4:** revert. A reviewed repair copies each deal's `canceledAt` and `noShowAt` back from its latest canceled or no-show meeting. The legacy table stays empty, since nothing reads it.
- **PRs 5 to 9:** revert. The readers go back to their old reads; the aggregates stay written.
- **PR 10:** revert to PR 9, which reads `completed` only. Before the revert deploys, a reviewed repair sets `held` back to `completed`, with `completedAt` from `heldMarkedAt`, through `patchMeetingLifecycle`. The 510 cleared no-show `completedAt` values come back from `noShowMarkedAt`, where the two were equal at the click.
- **PR 11:** revert. The setting is ignored and the projections go back to UTC days through `rebuildMeetingProjections` (reset).
- **PR 13:** revert brings the fields and tables back as optional, then the PR before it is reverted and repaired as above.

## 13. Production log

All runs are on tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, times in UTC, with `--env-file .env.vercel.production`.

### 13.1 Baseline, 2026-10-22

§2. A read-only snapshot directory under the system temp directory (mode 700) holds the inventory notes. It holds no export, and it's deleted when the phase ends.

### 13.2 Deploys

| PR | What | Deployed |
| --- | --- | --- |

### 13.3 Runs

| Time | Step | Result |
| --- | --- | --- |
