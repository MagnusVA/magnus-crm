# Phase 5: deal status

Status: plan, 2026-10-21. Waiting for the tenant admin's answers to the decisions in §11, the questions in §11.1 and the ADR changes in §11.2.

Scope comes from §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) (finding F2, the target model's "Stage and status on the deal" and "How today's statuses map" in §6, the anti-pattern "Appointment outcomes as deal stages" in §8) and the Phase 5 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md): this file says deal stage, outcome, attendance or task, and says "status" only for today's `opportunities.status` field. Phase 4 is in [phase-4-customers.md](phase-4-customers.md).

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

`opportunities.status` does four jobs: where the deal is, what happened to its meeting, which task is pending, and how it ended. Phase 5 gives each job one owner:

1. **One stage module**, `convex/opportunities/stages.ts`: the five deal stages (Qualified, Booked, Call held, Follow-up, Closed), the outcome (open, won, lost), which outcomes each stage allows, the labels, and the stage state machine. The validators, the state machine, the UI labels and the Slack labels all come from it (§4.1).
2. **Widen**: `stage` and `outcome` on `opportunities` beside `status`. `transitionOpportunity` and the three inserts write both from the status they write today, through the ADR's mapping (§4.2). A new aggregate, `opportunityByStage`, counts deals by stage and outcome.
3. **Tasks and attendance get their facts.** A no-show or cancellation opens a rebook task, a `followUps` row of the new type `rebook`. The reschedule link and the follow-up keep the `followUps` rows they already write. Attendance stays on the meeting, where it already is (§4.4).
4. **Backfills** for every deal's stage and outcome and every canceled or no-show deal's rebook task, each with an assert that checks today's status can be rebuilt from the new fields (§10).
5. **Readers move**, one dashboard at a time: the leads page and labels, the closer pipeline, the reports and operations pages, then the guards and the booking rules. Each reader's numbers are compared both ways in production before it switches (§10.4).
6. **The narrow**: `opportunities.status`, its copies on meetings, search rows, qualification rows and meeting projections, the `opportunityByStatus` aggregate, the status counters in `tenantStats`, and the nine indexes that name the status leave the schema. The stage list is defined once (§3.3).

Every guard and booking rule keeps today's behaviour. A deal waiting for a rebook behaves as a canceled or no-show deal does today (§4.5). What changes is what the screens show and count (§7).

It ships in ten code PRs after this plan (§9). Each is safe to deploy alone.

## 2. Production snapshot (2026-10-21)

Read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant, around 21:30 UTC.

### 2.1 Deals

11,520 deals.

| Status | Calendly | Slack | Side deal | All |
| --- | --- | --- | --- | --- |
| `qualified_pending` | | 1,230 | | 1,230 |
| `scheduled` | 1,536 | 1,265 | 1 | 2,802 |
| `follow_up_scheduled` | 72 | 94 | | 166 |
| `reschedule_link_sent` | | | | 0 |
| `canceled` | 951 | 1,069 | | 2,020 |
| `no_show` | 213 | 269 | | 482 |
| `payment_received` | 140 | 131 | 9 | 280 |
| `lost` | 95 | 4,445 | | 4,540 |

- Every deal at `scheduled`, `follow_up_scheduled`, `canceled`, `no_show` and `payment_received` has an `assignedCloserId`; no `qualified_pending` deal has one.
- 45 more deals than the brief's count earlier the same day, one of them the scheduled side deal.

### 2.2 Deals and their meetings

6,866 meetings, all on a deal.

| Status | Meetings behind the deals |
| --- | --- |
| `qualified_pending` | none |
| `scheduled`, Calendly or Slack (2,801) | 64 have a call still to come. 2,737 have a scheduled meeting whose time has passed with no attendance recorded: 22 within a day, 69 within a week, 357 within 30 days, 2,289 older. 26 have a later canceled meeting beside an earlier scheduled one. 6 also have a held (completed) meeting |
| `scheduled`, side deal (1) | none |
| `follow_up_scheduled` (166) | 165 have a held meeting; on 3 the latest meeting is canceled or no-show |
| `canceled` (2,020) | the latest meeting is canceled on 2,005 and held on 15; 18 have a held meeting |
| `no_show` (482) | the latest meeting is no-show on 476, canceled on 6 |
| `payment_received` (280) | 271 have a held meeting; the 9 side deals have none |
| `lost` (4,540) | 4,297 have no meeting (the Slack 30-day expiry); 243 have a held meeting |

By the deal's last update, canceled deals are 116 within 14 days, 99 within 30 days and 1,805 older; no-show deals are 73, 95 and 314. The booking pipeline joins a new booking to a canceled or no-show deal only within 14 days of its last update (§6.7).

### 2.3 Meetings

| Meeting status | Meetings | Note |
| --- | --- | --- |
| `scheduled` | 2,801 | 64 still to come |
| `completed` | 705 | every one has `completedAt` |
| `canceled` | 2,840 | |
| `no_show` | 520 | 498 have `completedAt`: a closer or admin marked them, and the outcome write sets it. The 22 Calendly no-shows don't |

Of the meetings whose time has passed and that weren't canceled, attendance is recorded (completed or no-show) on 22 of 170 in April, 51 of 504 in May, 212 of 586 in June, 240 of 637 in July, 77 of 740 in August, 387 of 771 in September and 236 of 554 in October.

### 2.4 Lost reasons

| Reason | Deals | Who |
| --- | --- | --- |
| `stale` (Slack 30-day expiry) | 4,297 | the system |
| free text | 184 | a closer or admin (71 Calendly, 113 Slack) |
| none | 59 | a closer or admin (24 Calendly, 35 Slack), all with a held meeting, lost between 2026-04 and 2026-10 |

### 2.5 Tasks

236 `followUps` rows, all `manual_reminder` with reason `closer_initiated`: 167 pending (165 on `follow_up_scheduled` deals, 2 on `scheduled` deals), 62 completed, 7 booked. No `scheduling_link` row exists, and no row has reason `no_show_follow_up` or `cancellation_follow_up`: the reschedule link and the scheduling link have never been used. No canceled or no-show deal has a task. One `follow_up_scheduled` deal has no pending task.

### 2.6 Copies of the status

| Copy | Rows | Agrees with its deal |
| --- | --- | --- |
| `meetings.opportunityStatus` | 6,866 | all 6,866 |
| `opportunitySearch.status` | 11,521 | all; 1 row names a deal created after the deal count |
| `operationsQualificationRows.opportunityStatus` | 8,602 (8,601 on a deal) | all |
| `meetingProjections.contribution.opportunityStatus` | 6,867 | (a projection key) |
| `operationsMeetingStatsV2.opportunityStatus` | 3,896 buckets | (a bucket key) |
| `operationsMeetingDailyStats.opportunityStatus` (legacy, no writer) | 5,761 | not checked; nothing reads it |
| `opportunityByStatus` aggregate | one entry per deal | checked by `reporting/verification.ts` |
| `tenantStats` | `activeOpportunities` 4,199 (`qualified_pending`, `scheduled`, `follow_up_scheduled`, `reschedule_link_sent`), `wonDeals` 280, `lostDeals` 4,540, `totalOpportunities` 11,521 | yes |
| `domainEvents` | 5,488 `opportunity.status_changed`, 4,540 `opportunity.marked_lost`, at least 9,000 `opportunity.created` | history |

### 2.7 Code that reads the status

About 108 files outside the tests: the write paths in §5, the readers in §6, and these dead ones, which nothing renders or calls:

- the pages behind `/workspace/pipeline` and `/workspace/opportunities`, which only redirect: `app/workspace/pipeline/_components/pipeline-page-client.tsx`, `app/workspace/opportunities/_components/opportunities-page-client.tsx` with `opportunity-filters.tsx` and `opportunities-table.tsx` in the same folder, and `opportunity-detail-client.tsx`; with them `opportunities/queries.ts:listOpportunitiesForAdmin` and `opportunities/listQueries.ts` (`listOpportunities`, `searchOpportunities`). Their live neighbours stay and move with their readers: the closer pipeline's `app/workspace/_components/pipeline/opportunities-table.tsx` and `pipeline-filters.tsx`, and the deal sheet's `opportunity-activity-timeline.tsx` and dialogs;
- the unmounted dashboard sections `pipeline-section.tsx`, `pipeline-summary-client.tsx`, `pipeline-summary.tsx`, `stats-section.tsx`, `stats-row-client.tsx` and `closer/_components/pipeline-strip-section.tsx`; `dashboard/adminStats.ts:getAdminDashboardStats` is read only by them;
- `operations/phoneSales.ts:getPhoneSalesStats` (tests only), `pipeline/queries.ts:getFollowUpOpportunity` (no caller), `slack/metrics.ts` (no importer), and the `opportunityStatus` field of `slack/notifyData.ts`'s bump payload (never read).

Enrollments and attribution read no deal status (Phase 4's handoff said so; confirmed). The lifecycle derivation reads none either: Showed comes from a held meeting and a side deal's creation. Only `shouldMarkUnresponsive` reads it (§6.8).

## 3. Schema

### 3.1 Widen (PR 1 and PR 2)

```ts
// convex/opportunities/stages.ts
export const DEAL_STAGES = ["qualified", "booked", "call_held", "follow_up", "closed"] as const;
export const DEAL_OUTCOMES = ["open", "won", "lost"] as const;
export const dealStageValidator = v.union(/* the five */);
export const dealOutcomeValidator = v.union(/* the three */);

// opportunities, beside status
stage: v.optional(dealStageValidator),
outcome: v.optional(dealOutcomeValidator),
```

- PR 1 adds the two fields and these indexes, which the moved readers use (§6):

| Index | Replaces | For |
| --- | --- | --- |
| `by_tenantId_and_leadId_and_source_and_stage_and_outcome_and_createdAt` | `by_tenantId_and_leadId_and_source_and_status_and_createdAt` | the Slack join (Qualified, and Closed lost for a stale-expired deal) and the Slack duplicate check |
| `by_source_and_stage_and_createdAt` | `by_source_and_status_and_createdAt` | the Slack expiry and the side deal nudge, across tenants |
| `by_tenantId_and_source_and_stage_and_createdAt` | `by_tenantId_and_source_and_status_and_createdAt` | the Slack stale digest |
| `by_tenantId_and_assignedCloserId_and_stage_and_outcome_and_createdAt` | `by_tenantId_and_assignedCloserId_and_status_and_createdAt` | the closer pipeline list and the user removal guard |
| `by_tenantId_and_stage_and_outcome_and_createdAt` | `by_tenantId_and_status_and_createdAt` | pipeline aging and velocity |
| `by_tenantId_and_stage_and_outcome_and_latestActivityAt` | `by_tenantId_and_status_and_latestActivityAt` | loss attribution |

  The other three status indexes (`by_tenantId_and_source_and_status_and_latestActivityAt`, `by_tenantId_and_assignedCloserId_and_status_and_latestActivityAt` and `by_tenantId_assignedCloserId_source_status_latestActivityAt`) are read only by the dead opportunities list in §2.7 and get no replacement.
- PR 1 mounts `opportunityByStage` (`convex.config.ts`), a `TableAggregate` on `opportunities`, namespace `tenantId`, key `[stage, outcome, assignedCloserId ?? "", createdAt]`. Until the narrow, its key takes the stage and outcome from `stageForStatus(status, source)` when the fields are unset, so the entry doesn't move when the backfill writes them. Until its backfill and `verifyStageCounts` pass, the hooks write it with `insertIfDoesNotExist`, `replaceOrInsert` and `deleteIfExists`: a strict `replace` throws when the old entry is missing, which would fail every deal write on the 11,520 deals not yet in it. PR 9 moves it to the strict methods.
- PR 2 adds `"rebook"` to `followUps.type`. A rebook task uses the existing reasons `no_show_follow_up` and `cancellation_follow_up`, and `createdSource: "system"`. PR 2 also adds `followUps` indexes that lead with the type, `by_tenantId_and_type_and_status_and_createdAt` and `by_tenantId_and_type_and_createdAt`. Pipeline Health's reminder backlog and the Reminders report read the first 2,001 and 2,000 follow-ups of any type and then keep the reminders; 2,502 backdated rebook tasks would push real reminders past those caps. Both move to the type indexes in PR 2, before the backfill runs.

### 3.2 PR 3

`operationsQualificationRows` gains `dealStage` and `dealOutcome` (optional), the index `by_tenantId_and_dealStage_and_dealOutcome_and_qualifiedAt`, and both as filter fields of `search_qualification_rows`.

### 3.3 PRs 8 and 9, and the narrow (PR 10)

PR 8 makes `opportunities.status` and `opportunitySearch.status` optional while it still writes them, so a later revert to PR 8 finds a schema that accepts deals without one. PR 9 stops writing them, so the clears can unset them (§10.6). The other copies are optional already.

The narrow removes:

| Table | Removed | Indexes removed |
| --- | --- | --- |
| `opportunities` | `status`; `stage` and `outcome` become required | the nine that name `status` |
| `opportunitySearch` | `status` | `status` as a filter field of `search_opportunities` |
| `meetings` | `opportunityStatus` | `by_tenantId_and_opportunityStatus_and_scheduledAt` |
| `operationsQualificationRows` | `opportunityStatus` | `by_tenantId_and_opportunityStatus_and_qualifiedAt`, and the filter field |
| `operationsMeetingStatsV2`, `meetingProjections.contribution` | `opportunityStatus` (out of the bucket key in PR 9) | |
| `operationsMeetingDailyStats` | `opportunityStatus`, cleared on its 5,761 rows; Phase 6 drops the table | |
| `tenantStats` | `activeOpportunities`, `wonDeals`, `lostDeals` (D13) | |
| `convex.config.ts` | the `opportunityByStatus` aggregate, cleared first | |
| `opportunities/validators.ts` | `opportunityStatusValidator` | |

These stay:

- `domainEvents.fromStatus` and `toStatus`: the old events keep the status they recorded, and the new ones record the stage (§4.6).
- `opportunities.lostReason`, `lostAt`, `lostByUserId`, `paymentReceivedAt`, `canceledAt`, `noShowAt`, `cancellationReason`, `canceledBy`: facts with their own times, read by the reports and the person page. `canceledAt` and `noShowAt` duplicate the meeting's, and Phase 6 drops them with the other dead fields (the ADR's Phase 6 row gains them in PR 10).
- `followUps.completionOutcome`'s values `payment_received` and `lost`: a reminder's result, not a deal status.
- `meetings.status`, `completedAt` and `noShowMarkedAt`: attendance (D3).

## 4. Rules

### 4.1 The stage module

`convex/opportunities/stages.ts` follows `convex/leads/lifecycle.ts`, the person's stage list:

- `DEAL_STAGES` in order, `DEAL_OUTCOMES`, their validators and types;
- `DEAL_STAGE_CONFIG`: for each stage its label and the outcomes it allows. Qualified, Booked, Call held and Follow-up allow `open`; Closed allows `won` and `lost`. That is the open, won or lost category the ADR asks for: a stage is open, or it is where a deal is won or lost;
- `dealPosition(stage, outcome)`: the six positions a screen shows, in order: Qualified, Booked, Call held, Follow-up, Won, Lost. The closer's tabs, the report's distribution, the filters and the badges use it;
- `assertStageOutcome(stage, outcome)`: the one check that a pair is allowed;
- the stage state machine (§4.3) and `stageForStatus(status, source)`, the mapping (§4.2). After the narrow the mapping only reads old events (§4.6).

`lib/status-config.ts` loses its opportunity section: the badge and dot colours become a map typed by the position, so a new stage fails the typecheck until it has colours. `DEAL_STATUS_LABELS` in `convex/lib/slackBlockKit.ts` goes; the Slack text takes the labels from the module.

### 4.2 The mapping

A pure function of the status and the deal's source, the ADR's table:

| Status | Stage | Outcome | The rest lives on |
| --- | --- | --- | --- |
| `qualified_pending` | Qualified | open | |
| `scheduled`, Calendly or Slack | Booked | open | the meeting (scheduled) |
| `scheduled`, side deal | Call held | open | |
| `canceled` | Follow-up | open | the meeting (canceled) and a rebook task |
| `no_show` | Follow-up | open | the meeting (no-show) and a rebook task |
| `reschedule_link_sent` | Follow-up | open | the meeting (no-show) and the scheduling link task, reason `no_show_follow_up` |
| `follow_up_scheduled` | Follow-up | open | the reminder or scheduling link task, when there is one |
| `payment_received` | Closed | won | the payments |
| `lost` | Closed | lost | `lostReason` |

The edge cases (D2): the scheduled side deal is Call held. The 2,737 deals whose call has passed with nothing recorded are Booked; their meeting stays scheduled, and nothing invents an attendance or an outcome. The 59 lost deals with no reason are Closed and lost with no reason; the person page says "No reason recorded".

The mapping reads no meeting, so it gives the same answer in the backfill, in `transitionOpportunity` during the dual write, in the old events (§4.6) and in the asserts.

### 4.3 Transitions

From PR 1 to PR 7, `transitionOpportunity` takes the status as today and writes `stage` and `outcome` from the mapping with it, in the same patch. The three inserts (`pipeline/inviteeCreated.ts`, `slack/createQualifiedLead.ts`, `opportunities/createManual.ts`) do the same. ESLint's rule against a raw status patch also covers `stage` and `outcome`; only the backfill and the clears disable it, each with a comment.

From PR 8 the transition takes a stage and an outcome, and the state machine moves to the stage module:

| From | To | Today's moves it covers |
| --- | --- | --- |
| Qualified | Booked; Closed lost | `qualified_pending` → `scheduled`, `lost` |
| Booked | Follow-up; Closed won; Closed lost | `scheduled` → `canceled`, `no_show`, `follow_up_scheduled`, `payment_received`, `lost` |
| Call held | Follow-up; Closed won; Closed lost | the side deal's `scheduled` moves |
| Follow-up | Booked; Closed won; Closed lost | `canceled`, `no_show`, `reschedule_link_sent`, `follow_up_scheduled` → `scheduled`; `follow_up_scheduled` → `payment_received`, `lost` |
| Closed won | Closed lost, only with `payment_voided` | the voided side deal payment |
| Closed lost | Booked, only with `slack_stale_rejoin` | the Slack deal reopened by a late booking |

Moves inside Follow-up are not stage transitions any more: `no_show` ↔ `canceled` from Calendly, `no_show` → `reschedule_link_sent`, and `canceled` or `no_show` → `follow_up_scheduled` change the meeting or the task, and the deal stays at Follow-up. The deal is still patched, through `patchOpportunityLifecycle`, with the fields those moves write today: `updatedAt`, and from Calendly `canceledAt`, `cancellationReason` and `noShowAt`. `updatedAt` decides the 14-day reschedule join and which late bookings are held for review, so it must move as it moves today. The `calendly_webhook` exception goes.

The stage machine allows moves today's status forbids, such as a deal waiting for a rebook going straight to Closed. The call sites keep today's guards (§4.5), so no screen or webhook makes those moves. The guards read the deal's stage, its meeting's attendance and its tasks, and the state machine checks the stage move under them.

### 4.4 Where each part of the status goes

- **Attendance** is the meeting's, as it is today: scheduled, completed, canceled, no-show. The deal no longer copies it. Renaming `completed` to held and moving the outcome time out of `completedAt` is D3.
- **Rebook** after a no-show or cancellation is a task: a `followUps` row with type `rebook`, the deal's closer (else the meeting's, which every meeting has), and the reason `no_show_follow_up` or `cancellation_follow_up` (D4). Its `createdAt` is when the meeting was missed, which dates it; it has no reminder time. It is pending while the deal waits for the person to book again. It ends as:
  - `booked` when a booking joins the deal (a provider reschedule or the 14-day reschedule join);
  - `completed` when the closer or an admin sets the next step, at the moment today's status leaves `canceled` or `no_show`: confirming a follow-up (`confirmFollowUpScheduled`, `adminConfirmFollowUp`), creating a manual reminder, or creating a reschedule link. Creating a scheduling link the closer hasn't confirmed doesn't complete it, as it doesn't move the status today: the no-show bar keeps its dialog open so the closer can copy the link;
  - `expired` when the deal leaves Follow-up any other way: Calendly withdraws the no-show, or the deal closes.
  Calendly turning a no-show into a cancellation, or the reverse, changes the pending task's reason. One deal has at most one pending rebook task. Opening, booking, completing or expiring one emits no `followUp.*` event: the meeting event and the deal event already record it, and the activity feed would call it "created a follow-up".
- **Reschedule link sent** is the pending `scheduling_link` task with reason `no_show_follow_up`, which the reschedule link actions already write. A deal leaves `reschedule_link_sent` only through a booking link; from PR 2 that booking also expires any other pending reschedule link on the deal, so a stale one can't make a later Follow-up look like `reschedule_link_sent`. Today a booking through an older, unconfirmed scheduling link books only that link and leaves the reschedule link pending forever.
- **Follow-up scheduled** is the pending `manual_reminder` or `scheduling_link` task the follow-up actions already write. A Follow-up deal with neither, such as one whose reminder was closed with "close only", stays in Follow-up with no next step, as it stays `follow_up_scheduled` today.
- **Won and lost** are the outcome. The reason stays in `lostReason`.

Until PR 8, `transitionOpportunity` keeps the rebook tasks in step with the status it writes: a move to `no_show` or `canceled` opens one (or changes its reason), a move from them to `scheduled` books it (or expires it when the move is Calendly withdrawing the no-show), a move to `follow_up_scheduled` or `reschedule_link_sent` completes it. Until `backfillRebookTasks` has run, a deal that leaves `canceled` or `no_show` may have no task; the bookkeeping then does nothing, and a Calendly move between `no_show` and `canceled` opens the missing one. From PR 8 the call sites say it: a no-show or cancellation passes `rebook: "no_show" | "canceled"` to the transition into Follow-up, the next-step actions complete the task through `convex/lib/rebookTasks.ts`, and leaving Follow-up books or expires any pending one inside `transitionOpportunity`.

A rebook task has no due date and no reminder time, so the closer's reminder list, the reminder report and the active follow-up on the meeting page, which read `manual_reminder` or any pending follow-up, leave it out (§6.3). `markFollowUpBooked`, which books a deal's pending non-reminder task on a rebooking, leaves it out too, so a deal with a rebook task and an old scheduling link isn't refused as ambiguous.

### 4.5 Behaviour stays the same

Each status a guard or booking rule tests becomes a test of the stage, the outcome and the tasks (`convex/opportunities/dealState.ts`):

| Today | From PR 7 |
| --- | --- |
| `canceled` | Follow-up with a pending rebook task, reason `cancellation_follow_up` |
| `no_show` | Follow-up with a pending rebook task, reason `no_show_follow_up` |
| `reschedule_link_sent` | Follow-up with a pending reschedule link (scheduling link, reason `no_show_follow_up`) |
| `follow_up_scheduled` | Follow-up otherwise |
| `scheduled` | Booked, or Call held for a side deal |
| `qualified_pending`, `payment_received`, `lost` | Qualified; Closed won; Closed lost |

`legacyStatus(deal, tasks)` reads them in that order: a pending rebook decides first, then a pending reschedule link, then Follow-up otherwise. With the rules in §4.4 it rebuilds today's status from the new fields, and the asserts prove it on every deal (§10.2). "Not waiting for a rebook or a reschedule link" is exactly `follow_up_scheduled`; a Follow-up deal with a pending ordinary scheduling link still takes a reminder payment or a loss, as today. The sets that leave out canceled and no-show deals today (the Slack duplicate check, `shouldMarkUnresponsive`, the user removal guard) leave out deals waiting for a rebook. The reschedule join takes deals waiting for a rebook updated within 14 days. Every closer and admin control shows on the same deals as today.

### 4.6 Events

From PR 8, `transitionOpportunity` emits `opportunity.stage_changed` for every move, with `fromStatus` and `toStatus` holding the stages and the outcomes in its metadata (`fromOutcome`, `toOutcome`). A loss keeps the type `opportunity.marked_lost`, with the same fields. A move inside Follow-up emits no deal event: the meeting and task events record it (`meeting.no_show`, `meeting.canceled`, `followUp.created`). Until then the events stay as they are.

The 5,488 `opportunity.status_changed` and 4,540 `opportunity.marked_lost` events keep the statuses they recorded. Every reader learns both forms (D7):

- `pipeline/bookingHistory.ts` rebuilds a deal's past position from its events to decide whether a late booking could have joined it, and gives no answer when the chain has a gap. Between two old events it checks continuity on the raw statuses, as today; only where an old event meets a new one, and against the deal's current stage and outcome at the end, does it map the old status through `stageForStatus` with the deal's source. Mapping every old event first would hide gaps inside Follow-up (`no_show` followed by an event from `follow_up_scheduled`), and two cases in `bookingHistory.test.ts` that give no answer today would then call the deal out of reach. A deal it couldn't join is Booked, Call held or Closed won, which is today's `scheduled` and `payment_received`.
- The deal sheet's activity, the person's timeline, the activity feed, `reporting/lib/eventLabels.ts` and the PostHog properties show old events with the old labels and new ones with the stage labels.
- `opportunity.created` records the stage it starts at.

So `stageForStatus` stays after the narrow, as the reader of old events, in the stage module beside the frozen list of the old statuses. Nothing writes them.

### 4.7 Copies

| Copy | After Phase 5 |
| --- | --- |
| `opportunityByStatus` aggregate | replaced by `opportunityByStage` (§3.1); cleared and unmounted |
| `opportunitySearch.status` | dropped: its only filter reader is the dead opportunities page (§2.7); the sales and booked calls searches don't filter on it |
| `operationsQualificationRows.opportunityStatus` | replaced by `dealStage` and `dealOutcome`, which the Qualifications page filters on |
| `meetings.opportunityStatus` | dropped: its index has no caller, and the two lists and the export that show it read the deal they already load |
| `operationsMeetingStatsV2` and `meetingProjections` `opportunityStatus` | out of the bucket key and the contribution: only `getPhoneSalesStats`, which nothing calls, read it. A deal's stage change no longer re-buckets its meetings |
| `operationsMeetingDailyStats.opportunityStatus` | cleared on the legacy table's 5,761 rows |
| `tenantStats` `activeOpportunities`, `wonDeals`, `lostDeals` | dropped (D13) |
| `leadCustomerSearchRows` | the search text takes the stage labels instead of the status words; `wonOpportunityCount` counts won deals |
| the status in payloads (`leads/queries.ts`, `billing/enrichment.ts`, `leadCustomers/detailPayload.ts`, `pipeline/bookingReviews.ts`, `testing/e2e.ts`) | stage and outcome |

## 5. Write paths

Every status write goes through `transitionOpportunity`; these are its callers, with what each becomes in PR 8. "Rebook" is the pending rebook task (§4.4).

| Write | Where | Today | From PR 8 |
| --- | --- | --- | --- |
| Booking creates a deal | `pipeline/inviteeCreated.ts` | insert `scheduled` | insert Booked |
| Slack qualifies | `slack/createQualifiedLead.ts` | insert `qualified_pending` | insert Qualified |
| Side deal | `opportunities/createManual.ts` | insert `scheduled` with no meeting | insert Call held |
| Booking joins a Slack deal | `inviteeCreated.ts` | `qualified_pending` → `scheduled`; a stale-expired deal with `slack_stale_rejoin` | Qualified → Booked; Closed lost → Booked with the exception |
| Booking joins a follow-up deal | `inviteeCreated.ts` | `follow_up_scheduled` → `scheduled` | Follow-up with no rebook or reschedule link → Booked |
| Booking link | `inviteeCreated.ts` | `follow_up_scheduled` or `reschedule_link_sent` → `scheduled` | Follow-up (not waiting for a rebook) → Booked |
| Provider reschedule, 14-day reschedule join | `inviteeCreated.ts` | `canceled` or `no_show` → `scheduled`; a `scheduled` target only re-points | Follow-up with a rebook → Booked, rebook booked; a Booked target only re-points |
| Calendly cancel, no-show, no-show withdrawn | `pipeline/bookingFacts.ts` | `scheduled` ↔ `canceled`, `no_show`; `no_show` ↔ `canceled` with `calendly_webhook` | Booked → Follow-up with a rebook; Follow-up → Booked, rebook expired; the reason changes in place |
| Closer or admin no-show | `closer/noShowActions.ts`, `admin/meetingActions.ts` | `scheduled` → `no_show` | Booked → Follow-up, rebook `no_show_follow_up` |
| Reschedule link | same | `no_show` → `reschedule_link_sent` | no deal move; rebook completed, link task written as today |
| Follow-up or reminder, with or without the meeting | `closer/followUpMutations.ts`, `closer/followUp.ts`, `admin/meetingActions.ts` | `scheduled`, `canceled` or `no_show` → `follow_up_scheduled` | Booked → Follow-up; from a rebook, no deal move and the rebook completed |
| Payment on a meeting | `closer/payments.ts` | `scheduled` → `payment_received` | Booked → Closed won |
| Payment on a reminder | `closer/reminderOutcomes.ts` | `scheduled` or `follow_up_scheduled` → `payment_received` | Booked or Follow-up (not waiting for a rebook or a reschedule link) → Closed won |
| Side deal payment | `sideDeals/logPayment.ts` | `scheduled` or `follow_up_scheduled` → `payment_received` | Call held or Follow-up → Closed won |
| Lost: meeting, reminder, side deal, admin | `closer/meetingActions.ts`, `closer/reminderOutcomes.ts`, `sideDeals/markLost.ts`, `admin/meetingActions.ts` | `qualified_pending`, `scheduled`, `follow_up_scheduled` → `lost` | Qualified, Booked, Call held, Follow-up (not waiting for a rebook or a reschedule link) → Closed lost |
| Slack expiry | `slack/staleExpiry.ts` | `qualified_pending` → `lost`, reason `stale` | Qualified → Closed lost |
| Voided side deal payment | `sideDeals/voidPayment.ts` | `payment_received` → `lost` with `payment_voided` | Closed won → Closed lost with the exception |
| Unavailability cancel | `unavailability/redistribution.ts` | `scheduled` → `canceled` | Booked → Follow-up with a rebook |
| Empty side deal deleted | `sideDeals/deleteEmptyOpportunity.ts` | only at `scheduled` | only at Call held |

A side deal that a booking joins, which only the API can do today, stays Call held during the dual write, since the mapping reads the source; from PR 8 the join moves it to Booked.

`transitionOpportunity` also rewrites the aggregates, the search rows and the qualification rows when the stage or outcome changes (`AGGREGATE_KEY_FIELDS`, `QUALIFICATION_ROW_FIELDS`), and from PR 9 stops writing `tenantStats` (D13) and stops asking for the meeting projections, which no longer carry a deal field that changes with the stage. The payment paths call `syncPersonEnrollments` and the lifecycle hooks as now.

## 6. Readers

### 6.1 Labels, the person page and the booking review (PR 4)

- `components/status-badge.tsx` becomes a deal stage badge reading the position (§4.1). Its users: the person page's deal rows and sheet, the closer pipeline table.
- The person page: the deal row's accent, badge and Won chip, the sheet's badge and value, "Winning deal" in the snapshot aside, the meeting rows' deal badge in the history card and timeline. The sheet's controls (`opportunities/detailQuery.ts`): record payment, mark lost and delete on a side deal at Call held; add payment and void payment on a won deal.
- The meeting and reminder pages' labels: the header badge on the closer and admin meeting pages, the deal badge on each row of the meeting history card and timeline (`closer/meetingDetail.ts`), the reminder metadata card's badge, and the `opportunity_status` property the reminder pages send to PostHog, which becomes `deal_stage` and `deal_outcome`. `closer/calendar.ts` stops returning the status, which no screen reads.
- The booking review page and its Slack message show each deal's position with the module's labels.
- The person search text takes the stage labels (`leadCustomers/searchText.ts`); `backfillLeadCustomerSearchRows` rebuilds the rows after PR 4 deploys (§9).
- The deal sheet's activity, the person's timeline and the activity feed label old events with the old status labels and new ones with the stage labels (§4.6). PR 4 adds the new labels so they are ready when PR 8 starts emitting them.

### 6.2 Closer pipeline and dashboard (PR 5)

- `/workspace/closer/pipeline`: tabs All, Booked, Call held, Follow-up, Won, Lost, each with its count from `opportunityByStage` (a `countBatch` over the closer's prefix instead of eight unbounded scans). The Canceled and No Show tabs go; their deals are in Follow-up, and each Follow-up row says its next step: "Rebook: no-show", "Rebook: canceled", "Reschedule link sent", the reminder's date, or nothing. The list reads `by_tenantId_and_assignedCloserId_and_stage_and_outcome_and_createdAt`. The period toggle stays as it is (created time, default Day), subject to Q1.
- The URL takes `stage=` (the six positions). An old `status=` link still works: `scheduled` opens Booked, `follow_up_scheduled`, `reschedule_link_sent`, `canceled` and `no_show` open Follow-up, `payment_received` Won, `lost` Lost, `qualified_pending` All.
- `/workspace/closer`'s pipeline strip: segments by position; Won and the close rate (won ÷ won and lost) as today. Each segment links to its tab.

### 6.3 Meeting and reminder pages (PR 7)

The controls show on the same deals as today, from the stage and the tasks (§4.5):

- Closer meeting page: the outcome bar (log payment, follow-up, no-show, lost) on a Booked deal whose meeting is scheduled, inside the time window, with no active follow-up; the no-show bar (request reschedule, follow-up) on a deal waiting for a no-show rebook; the "reschedule link sent" banner on a deal with a pending reschedule link; "Deal won" on Closed won.
- Admin meeting page: no bar on a closed deal; the four actions on a Booked deal with a scheduled meeting; "Schedule follow-up" on a deal waiting for a rebook; "Reschedule link" on a no-show rebook.
- Reminder pages: the deal counts as finished when it is Closed or waiting for a no-show rebook, as `payment_received`, `lost` and `no_show` do today.
- `lib/outcomeEligibility.ts` (`assertCanRecordMeetingOutcome`) requires a Booked deal; the reschedule link mutations require a no-show rebook; `closer/additionalPayment.ts` requires Closed won; the reminder's "no response, schedule a new one" requires `follow_up_scheduled` exactly (Follow-up with no rebook and no reschedule link).
- The active follow-up on the meeting page leaves rebook tasks out (§4.4).

### 6.4 Reports and operations (PR 6)

- **Pipeline Health** (`reporting/pipelineHealth.ts`): the distribution chart shows the six positions from `opportunityByStage`. The aging table shows Booked, Call held and Follow-up (Qualified stays computed and hidden, as today); the stale list covers open deals whose `nextMeetingAt` is unset or more than 14 days past, the rule it has today; both read `by_tenantId_and_stage_and_outcome_and_createdAt`. That read is an unbounded scan of every open deal, about 4,198 deals today and about 6,700 once Follow-up holds the canceled and no-show deals. `comparePipelineHealth` measures its bytes in production before PR 6 deploys; past 8 MB, PR 6 bounds it and reports `isAgingTruncated` instead of hard-coding false. Velocity reads Closed won, loss attribution Closed lost (still leaving out the Slack expiry). The reminder backlog reads reminders through the type index from PR 2 (§3.1).
- **Reminders report** (`reporting/remindersReporting.ts`): reads reminders through the type index from PR 2.
- **Team report** (`reporting/lib/outcomeDerivation.ts`): a lost deal is Closed lost; a follow-up is a held meeting on a Follow-up deal that isn't waiting for a rebook or a reschedule link, which is `follow_up_scheduled` with a completed meeting today. Without the task check, held meetings on the 19 canceled or no-show deals that have one would move from Scheduled to Follow-up.
- **Qualifications** (`operations/qualifications.ts`): the filter takes the six positions, through the qualification row's `dealStage` and `dealOutcome` and their index; the badge and the search text use the labels.
- **Booked Calls** and **Sales Calls** lists: the detail's "Opportunity status" becomes "Deal stage", read from the deal (`meetings.opportunityStatus` goes). The bookings export's `OpportunityStatus` column becomes `DealStage` and `DealOutcome` (Q5).
- `operations/phoneSales.ts:listPhoneSalesMeetings` loses its unused `opportunityStatus` argument.

### 6.5 Booking pipeline (PR 7)

`pipeline/inviteeCreated.ts` keeps its order and its rules (§5), on the new tests: the booking link joins a Follow-up deal not waiting for a rebook; a provider reschedule targets a Booked deal or one waiting for a rebook; the 14-day reschedule join takes one deal waiting for a rebook, updated in the last 14 days; the follow-up join takes one Follow-up deal with no rebook or reschedule link; the Slack join takes a Qualified Slack deal from the last 30 days or a stale-expired one. `bookingFacts.ts` follows a Booked deal or one waiting for a rebook. `bookingHistory.ts` reads both event forms (§4.6). `convex/pipeline/bookingReviews.test.ts` stays green in every PR.

### 6.6 Slack (PR 7)

- `createQualifiedLead.ts`: a pending duplicate is a Qualified Slack deal from the last 30 days; an existing booking is an open deal that isn't an old Qualified one and isn't waiting for a rebook.
- `staleExpiry.ts`, `staleRemindersData.ts`: Qualified Slack deals, on the new indexes.
- The stale digest's "View all" link names `stage=qualified`; `/workspace/pipeline` keeps redirecting whatever it is given, so the links already posted keep landing where they land today (D9).

### 6.7 Side deals, staleness, users (PR 7)

`opportunities/staleness.ts` nudges side deals at Call held; `sideDeals/*` act on Call held as they act on `scheduled`. `users/queries.ts:getActiveAssignedOpportunityCount` and `workos/userMutations.ts:removeUser` block removing a closer with a Booked, Call held or Follow-up deal that isn't waiting for a rebook, the deals `scheduled`, `follow_up_scheduled` and `reschedule_link_sent` name today. Booked and Call held are one indexed `take(1)` each. Follow-up reads the closer's Follow-up deals newest first, up to 1,000, with one indexed read of each deal's pending rebook task, and stops at the first deal without one; if it reaches 1,000 without an answer it refuses the removal and asks the admin to reassign the closer's deals first. The largest closer has 481 deals at Follow-up today.

### 6.8 Lifecycle (PR 7)

`shouldMarkUnresponsive` counts a person's open deals that aren't waiting for a rebook, the same set as today's active statuses. The lifecycle stage derivation doesn't change. `assertLeadLifecycle` runs after PR 7 deploys anyway, since the lifecycle code changes (§9).

## 7. Report numbers

Counts from §2.

| Report | Change |
| --- | --- |
| Pipeline Health, distribution | 8 statuses become 6 positions: Qualified 1,230, Booked 2,801, Call held 1, Follow-up 2,668 (166 + 2,020 canceled + 482 no-show), Won 280, Lost 4,540 |
| Pipeline Health, aging table | Follow-up adds the canceled and no-show deals, which are open (D5); Booked is today's Scheduled less the side deal, which shows as Call held |
| Pipeline Health, stale list | adds the deals waiting for a rebook, which have no scheduled meeting: up to 2,502 more |
| Pipeline Health, velocity, loss attribution and reminder backlog | none |
| Closer pipeline tabs | Booked equals today's Scheduled less the closer's scheduled side deals, which move to Call held; Follow-up equals Follow-up + Canceled + No Show; Won and Lost the same; Canceled and No Show go |
| Closer dashboard strip | segments by position; Won and the close rate unchanged |
| Qualifications filter | 6 positions instead of 8 statuses; the counts per position are the sums of the statuses they cover |
| Team report, Reminders, Booked Calls, Sales Calls, Revenue, Leads & Conversions, lead gen, billing | none; Booked and Sales Calls show the stage label |
| Bookings export | `OpportunityStatus` becomes `DealStage` and `DealOutcome` |
| Activity feed | from PR 8, deal moves count as `opportunity.stage_changed`, and moves inside Follow-up as their meeting or task events only; rebook tasks add no events |
| Leads search | typing a status word ("no show") stops matching by deal; the stage labels match |
| `tenantStats` active, won, lost | gone; no screen read them |

With D5's other option, about 2,313 canceled and no-show deals older than 14 days would close as lost, moving them from Follow-up to Lost in the distribution, the aging table, the stale list and the closer's tabs, and lowering each affected closer's close rate unless it leaves those losses out.

## 8. What else moves

- Tests: about 29 insert sites in `convex/**/*.test.ts` and 9 in `tests/*.ts`, plus `forceOpportunityState` in `tests/opportunityFixtures.ts`, write a status. From PR 1 they write the stage and outcome beside it through one fixture helper (`tests/dealStageFixtures.ts`, `stageFields(status, source)`), and from PR 9 only the stage and outcome. Each PR's subagent gets its own fixture file name.
- `docs/agents/convex.md`'s "Write side effects" and the ADR's rule 2 name the stage machine instead of the status from PR 8.
- `admin/migrations.ts`: `seedTenantStatsInternal`, `repairTenantStatusCounters` and its copy of the active set lose the status counters; `reporting/verification.ts` counts `opportunityByStage` instead.
- The existing health checks that read the status (`assertOpportunitySearchProjectionBackfilled`, `assertQualificationRowsCurrent`, `assertMeetingProjections`) compare the new fields.
- The dead code in §2.7 is deleted in the PR whose reader it shadows, so nothing is moved to the stage only to be deleted.
- The ADR's Phase 6 row gains: the meeting's held status and recorded-at time if D3 is accepted as recommended, and `opportunities.canceledAt` and `noShowAt` as dead copies of the meeting's.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 0 | This plan | docs |
| 1 | Widen: the stage module, `stage` and `outcome`, the six indexes, `opportunityByStage`, the dual write in `transitionOpportunity` and the three inserts, the ESLint rule, `backfillDealStages` and `assertDealStages` | new optional fields and a new aggregate written beside the status; nothing reads them |
| 2 | Rebook tasks: the `rebook` type, the bookkeeping in `transitionOpportunity`, the readers that must leave them out (§4.4), `backfillRebookTasks` and `assertRebookTasks` | new rows that no screen lists; the status still decides everything |
| 3 | `dealStage` and `dealOutcome` on the qualification rows; `dealState.ts` (§4.5); the parity queries (§10.4) | additive |
| 4 | Labels, the person page, the booking review, Slack labels (§6.1) | after the PR 1 and PR 2 backfills pass; reads fields every deal has; a revert goes back to the status, still written |
| 5 | The closer pipeline and dashboard (§6.2) | as PR 4 |
| 6 | Reports and operations (§6.4) | as PR 4, after the parity queries agree |
| 7 | Guards and rules read the stage and tasks: meeting and reminder pages, the booking pipeline, Slack, side deals, the user guard, the lifecycle (§6.3, §6.5 to §6.8) | the status is still written, so a revert is safe; the behaviour is the same (§4.5), proven by tests and the asserts |
| 8 | The transition and the state machine on stages: the call sites pass a stage and say when a rebook opens, `opportunity.stage_changed`, the `calendly_webhook` exception gone. `status` is still written, as `legacyStatus` of the new fields, after every transition and every change to a rebook task or reschedule link, with `opportunityByStatus` (now through its `IfExists` methods) and the counters; `status` becomes optional | a revert goes back to PR 7, which reads the stage and writes the status from its own transitions; nothing reads the stored status |
| 9 | Stop writing the status: the status, `opportunityByStatus`, the counters, the meeting mirror, the search and qualification row copies and the meeting bucket key's deal field are no longer written; `opportunityByStage` on its strict methods; the asserts stop comparing the status; the dead code removed; the clears | no reader reads the status after PR 7, and no writer after PR 8 needs it |
| 10 | The narrow (§3.3); the ADR status and amendments (§11.2), the review's Phase 5 and Phase 6 cards, the ADR's Phase 4 row note, this plan's status | after the clears and their asserts pass in production |

PRs 4, 5 and 6 can merge in any order. Each moves one set of screens.

Production runs, in this order (§10.7 has the commands):

1. After PR 1: `backfillDealStages` dry run, run, then `assertDealStages`; `backfillOpportunityByStage` (the aggregate), then `verifyStageCounts`.
2. After PR 2: `backfillRebookTasks` dry run, run, then `assertRebookTasks` and `assertDealStages` (reset), which now checks the tasks; a read-only check that the reminder backlog and the Reminders report show the same numbers as before the backfill.
3. After PR 3: `rebuildQualificationRows` (reset), then `assertQualificationRowsCurrent` (reset); the parity queries.
4. After PR 4: `backfillLeadCustomerSearchRows` (reset), then `assertLeadCustomerSearchRowsBackfilled` (reset), in the background (about 20 minutes over 90,000 people). After PRs 4 to 6: a read-only recheck of the numbers each one shows.
5. After PR 7: `assertDealStages` (reset); `assertLeadLifecycle` in the background (about an hour), since the lifecycle code changed; `assertBookingAttributions`, `assertDealAttributions` and `assertPersonTouches`, since the booking pipeline changed; `assertEnrollments` and `assertPaymentEnrollments`, since the payment paths changed.
6. After PR 8: `assertDealStages` and `assertRebookTasks` (reset), which now check the stored status against `legacyStatus`; then every health check in step 5 once more, since every write path changed.
7. After PR 9: `assertDealStages` and `assertRebookTasks` (reset), with no status comparison; the clears, each with its assert (§10.6): `clearDealStatus`, `clearOpportunitySearchStatus`, `clearMeetingOpportunityStatus`, `clearQualificationRowStatus`, `clearLegacyDailyStatsStatus`, `rebuildMeetingProjections` then `assertMeetingProjections`, `clearOpportunityByStatus`, `clearTenantStatusCounters`; then the health checks in step 5 once more.
8. After PR 10: the schema push checks that no row carries a removed field; `assertDealStages` and `assertRebookTasks` (reset) once more.

## 10. Backfill, parity and assert migrations

All are `migrations.define` in `convex/migrations.ts` unless named otherwise. None emits an event or moves a person's stage. Batch sizes are a first guess; each dry run sets the real one.

Deals keep arriving and moving between runs, so a run can process more rows than §2 counts. No migration checks a count; the asserts check each row, and the recheck accounts for any difference with rows created after the snapshot.

### 10.1 `backfillDealStages` (PR 1)

Over `opportunities`, batch 200: sets `stage` and `outcome` from `stageForStatus(status, source)` where they differ. Expected: 11,520 deals, the §7 distribution. A rerun changes nothing. It patches the fields directly: the aggregate's key already reads the mapped stage, and nothing else reads the fields yet.

`backfillOpportunityByStage` pages over `opportunities` with `insertIfDoesNotExist`, as `reporting/backfill.ts` does for `opportunityByStatus`. `verifyStageCounts` (internal query) compares each position's count in `opportunityByStage` with the sum of its statuses in `opportunityByStatus`, and the total with the table.

### 10.2 `assertDealStages` (PR 1, changed in PRs 2, 8 and 9)

Over `opportunities`, batch 200. Each deal has a stage and an outcome that `assertStageOutcome` allows, and a deal at Follow-up has at most one pending rebook task and a deal at any other stage none. Then, by PR:

- PRs 1 to 7: the pair is `stageForStatus(status, source)`; from PR 2, `legacyStatus` (§4.5) rebuilt from the deal's stage and pending tasks equals its status.
- PR 8: the stage machine sets the pair and writes the status from it, so only `legacyStatus` equals the status is checked.
- From PR 9: no status comparison, since the status is no longer written. `assertQualificationRowsCurrent` and `assertOpportunitySearchProjectionBackfilled` stop comparing it in the same PR.

It throws on the first problem, with IDs only.

### 10.3 `backfillRebookTasks` and `assertRebookTasks` (PR 2)

`backfillRebookTasks`, over `opportunities`, batch 100: for each `canceled` or `no_show` deal with no pending rebook task, inserts one: the deal's person and closer, reason `cancellation_follow_up` or `no_show_follow_up`, `createdSource: "system"`, `createdAt` the deal's `canceledAt` or `noShowAt`, else its latest meeting's `canceledAt` or `noShowMarkedAt`, else its `updatedAt`. Expected: 2,502 tasks (2,020 and 482). It emits no `followUp.created` event and touches no deal, so no `updatedAt` moves and the 14-day reschedule window stays where it is.

`assertRebookTasks`, over `followUps`, batch 200: each pending rebook task's deal exists in its tenant, is at Follow-up, and (until PR 9) is `canceled` or `no_show` with the matching reason; no deal has two. A pending reschedule link (scheduling link, reason `no_show_follow_up`) is on a deal at Follow-up with no pending rebook, which until PR 9 is `reschedule_link_sent`.

### 10.4 Parity (PR 3, run before PRs 4 to 6 deploy)

Internal queries in `convex/opportunities/stageParity.ts` compute each number both ways and return the differences, IDs and counts only:

- `compareStageCounts`: each position's count from `opportunityByStage` against its statuses' counts, tenant-wide and for each closer (the closer tabs).
- `comparePipelineHealth`: aging, the stale list, velocity and loss attribution, from the status and from the stage; the expected differences are §7's.
- `compareQualificationQueue`: for each position, the qualification rows the new filter returns against the rows of the statuses it covers.
- `compareTeamOutcomes`: the team report's outcome mix per closer for each month from 2026-04, both ways.
- `compareDealState`: for each deal, `legacyStatus` against the status (the assert's check, as a query that returns every mismatch instead of stopping).
- `compareReminderReads`: the reminder backlog and the Reminders report for each month from 2026-04, through the old read and the type index (PR 2's change, checked after its backfill).

Both ways of each number are functions beside the reader that shows it, and PR 9 removes the status ways with the parity module. Every "none" in §7 must come back with no difference, and every listed change with exactly the listed difference, before the PR that shows it deploys. The results go into §13.

### 10.5 Qualification rows (PR 3)

The existing `rebuildQualificationRows` (reset) writes `dealStage` and `dealOutcome` on the 8,602 rows, and `assertQualificationRowsCurrent`, amended, checks them against their deal.

### 10.6 The clears (PR 9)

Each clear unsets one field and has an assert that counts none left:

| Clear | Table | Expected | Assert |
| --- | --- | --- | --- |
| `clearDealStatus` | `opportunities` | about 11,520 | `assertDealStatusCleared` |
| `clearOpportunitySearchStatus` | `opportunitySearch` | about 11,521 | `assertOpportunitySearchStatusCleared` |
| `clearMeetingOpportunityStatus` | `meetings` | 6,866 | `assertMeetingOpportunityStatusCleared` |
| `clearQualificationRowStatus` | `operationsQualificationRows` | 8,602 | `assertQualificationRowStatusCleared` |
| `clearLegacyDailyStatsStatus` | `operationsMeetingDailyStats` | 5,761 | `assertLegacyDailyStatsStatusCleared` |
| `rebuildMeetingProjections` (existing, reset) | `meetings` | 6,867 projections re-keyed without the deal status; the old buckets empty and are deleted | `assertMeetingProjections` (reset), `assertMeetingProjectionBuckets` |
| `clearOpportunityByStatus` (internal mutation) | the aggregate | one entry per deal | `"dryRun":true` counts; a second run finds 0 |
| `clearTenantStatusCounters` (internal mutation) | `tenantStats` | 1 row | a read-only check |

Before `clearDealStatus`'s dry run, a search of the deployed commit shows no reader of `opportunities.status`, `opportunitySearch.status`, `meetings.opportunityStatus` or `operationsQualificationRows.opportunityStatus` outside the schema, the clears and the old-event mapping; if one is left, the clears wait for a reviewed fix. No export is taken: every cleared value rebuilds from the stage, the outcome, the tasks and the source (§12), and nothing is deleted except the aggregate's entries and the emptied meeting buckets, which rebuild from their tables.

### 10.7 Commands

Every command runs against production with `--env-file .env.vercel.production`; without it the CLI targets the dev deployment. Filter dry-run output with `grep -E '"processed"|"DryRun"|error'`, since a dry run prints whole documents.

```
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillDealStages","dryRun":true}'
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillDealStages"}'
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:backfillDealStages"]}'
```

The others run the same way, in §9's order. The dry run must finish without an error and process rows of the table it names; an error, or a dry run that would write rows the plan doesn't expect, stops the phase for a fix in a reviewed PR. Then the run, then poll `lib:getStatus` until it reports `"isDone": true` (a background loop that waits 30 seconds between calls), read any error, and only then run its assert, polled the same way. A batch that fails on a known Convex limit commits nothing and resumes from its cursor at a smaller batch. Any other failure, and any failed assert, stops the phase until a reviewed fix ships and the failed step and its assert pass again (§12). The parity queries run with `npx convex run --env-file .env.vercel.production opportunities/stageParity:<name> '<args>'` and each `continueCursor` until done.

The health checks that stay after the phase, with `"reset":true`: `assertDealStages` and `assertRebookTasks`, beside Phase 3's and Phase 4's.

## 11. Decisions

Each with a recommendation. The tenant admin answers them in one batch, with §11.1 and §11.2.

- **D1. The stage list.** Recommended: five stages and a separate outcome, defined in `convex/opportunities/stages.ts`, where each stage says which outcomes it allows (open for the first four, won or lost for Closed) and screens show six positions (§4.1). The other option, six stages with Closed split into Closed won and Closed lost and the outcome derived from the stage, drops the ADR's separate outcome field.
- **D2. The mapping's edge cases.** Recommended: the ADR's table as a pure function of status and source (§4.2). The scheduled side deal is Call held. The 2,737 Booked deals whose call passed with nothing recorded stay Booked, since the meeting, not the deal, is where attendance is missing (Q3). The 59 lost deals with no reason stay lost with none. Canceled and no-show deals are Follow-up and open with a rebook task (D4, D5).
- **D3. Meeting attendance.** Recommended: into the ADR's Phase 6 row, not this phase. Phase 5 moves attendance out of the deal, and the meeting already holds it. Renaming `completed` to held, adding a recorded-at time and clearing `completedAt` on the 498 marked no-shows touches the meeting status everywhere it is read: the `meetingsByStatus` aggregate, the meeting buckets, the show-rate reports, the calendar, the lifecycle's Showed (another `assertLeadLifecycle`) and most of the booking tests. That is about as many files as this phase again, with its own backfill. Done here, it doubles the riskiest phase; in Phase 6 it lands beside the meeting projection and "one definition of day" work, which reads the same code.
- **D4. Tasks.** Recommended: a rebook is a `followUps` row of type `rebook`, as the ADR's "it creates a rebook task" says; "reschedule link sent" and "follow-up scheduled" are the rows the code already writes (§4.4). The backfill writes 2,502 rebook tasks. No screen lists them as reminders; the closer pipeline shows them as the Follow-up row's next step. PR 2 first moves the two reminder reports to a type index, so the backfill doesn't push real reminders past their read caps. The other option writes no rebook row and derives "waiting for a rebook" from the deal's last meeting and whether a task was written after it; that saves the backfill but rebuilds a status from three tables in every guard, and an old pending reminder can make it wrong.
- **D5. Canceled and no-show deals older than two weeks.** Recommended: keep them open in Follow-up, as the ADR maps them, unless Q2 says the team treats a deal not rebooked within two weeks as dead. In that case, the other option: a rebook window. A deal waiting for a rebook that hasn't changed for 14 days, the same window in which a new booking still joins it, closes as lost with reason `no_rebook`, by the system, from an hourly cron like the Slack expiry and in a backfill. In production that closes about 2,313 deals (1,904 canceled, 409 no-show). The loss attribution and the closer's close rate would leave `no_rebook` out, as loss attribution leaves out `stale`.
- **D6. Stage times.** Recommended: no new field. The deal keeps its times per fact (`qualifiedAt`, `firstBookedAt`, `paymentReceivedAt`, `lostAt`), and the events give every stage change with its time. No reader in this phase needs the time a deal entered its current stage; a time-in-stage report can read the events.
- **D7. Events.** Recommended: from PR 8, `opportunity.stage_changed`, with the stages in `fromStatus` and `toStatus` and the outcomes in the metadata; losses keep `opportunity.marked_lost` (§4.6). Old events stay as they are, and every reader reads both. In PostHog the deal events arrive under the new name from PR 8, so an insight built on `opportunity.status_changed` stops at that deploy. The other option keeps the name `opportunity.status_changed` with stage values, which mixes two formats under one event name.
- **D8. Each copy.** Recommended: §4.7. `opportunityByStage` replaces `opportunityByStatus`, keyed by stage, outcome, closer and creation time, so the report reads it by stage and the closer tabs by closer. The qualification rows keep a copy (the Qualifications filter needs it); the search row, meeting, meeting projection and legacy table copies are dropped, since no live screen filters on them.
- **D9. What closers and admins see.** Recommended: §6.1 to §6.4. The closer pipeline's tabs become All, Booked, Call held, Follow-up, Won and Lost, and each Follow-up row names its next step. Old links with `status=` keep working. There is no admin pipeline page today (`/workspace/pipeline` redirects to the leads list), and none is built; admins see stages on the person page, Pipeline Health and Qualifications. The Slack digest's link keeps landing where it does. Subject to Q1 and Q5.
- **D10. Report numbers.** Recommended: §7. Only the screens that list statuses change, by merging the statuses into positions; no won or lost number changes, and the team report, revenue, Leads & Conversions and the booking and sales call numbers don't change.
- **D11. Indexes.** Recommended: the six stage indexes in §3.1 replace the nine status indexes, of which three served only the dead opportunities list; the meeting and qualification row status indexes go, and the qualification rows get one stage index.
- **D12. The deletions and clears.** Recommended: no deal, meeting, payment, person or task is deleted. The clears unset the status and its copies on about 11,520 deals, 11,521 search rows, 6,866 meetings, 8,602 qualification rows and the legacy table's 5,761 rows; the 6,867 meeting projections are re-keyed, which deletes the emptied old buckets (3,896 rows) as their meetings move; the `opportunityByStatus` aggregate's entries are cleared and it is unmounted; three `tenantStats` fields are unset. No export: each cleared value rebuilds from what stays (§12). The dead pages, components and queries in §2.7 are deleted.
- **D13. The deal counters in `tenantStats`.** Recommended: drop `activeOpportunities`, `wonDeals` and `lostDeals`. Only unmounted components read them, `opportunityByStage` counts the same on demand, and the transition stops writing the one `tenantStats` document per tenant that every booking contends on (a Phase 6 goal). `totalOpportunities` stays.
- **D14. Production runs.** Recommended: §9's order, dry run first for each backfill and clear, batch sizes from the dry runs (first guesses in §10), each run as soon as the previous assert passes, with no approval stop in between. Migrations on different tables may run side by side, and the log says so.
- **D15. Dev deployment.** Recommended: no dev rehearsal, so dev's Phase 4 customer rows stay and nothing is deleted on dev. The convex-test suites cover the code, and each production migration has its dry run and assert.

### 11.1 Questions about how the team works

- **Q1. My Pipeline.** Which tabs do closers use today, and do they work the Canceled and No Show tabs to rebook people? The plan folds those into Follow-up with the next step on each row (D9). Is the Day default on the period toggle (by when the deal was created) what they want?
- **Q2. After a no-show or a cancellation.** Does the team rebook the person on the same deal, and does anyone work a canceled or no-show deal after two weeks? 2,119 are older than 30 days. The answer decides D5.
- **Q3. Recording results.** Attendance is recorded on about half of the past calls in September and October, and on 10 to 38% in earlier months; 2,737 deals have a call in the past with nothing recorded. Do closers record a result only when there is a payment, or on every call? The plan keeps those deals Booked and builds no "needs a result" view unless you want one.
- **Q4. Lost reasons.** Closers may mark a deal lost without a reason today (59 did). Should the closer and admin mark-lost dialogs require one from now on? The Slack expiry and voided payments write their own.
- **Q5. Reports.** Does anyone filter the Qualifications page or read Pipeline Health's status chart by Canceled or No Show separately, or import the bookings export's `OpportunityStatus` column into a sheet? The plan replaces them with the stage (§6.4).
- **Q6. Production runs.** Do you approve every run in §9 and §10, as in Phase 4, so the phase runs end to end?

### 11.2 Changes to the ADR

The ADR's "How a phase runs" stops a phase for a change to the record that wasn't approved. These go into ADR 0001 in PR 10, and need your approval with the decisions:

- **A1. Stage list** (D1). "Each with an open, won, or lost category" becomes: each stage allows outcome open, except Closed, which allows won or lost.
- **A2. `reschedule_link_sent`** (D4). The mapping table's task "rebook, link sent" becomes "the reschedule link (the rebook is complete)": the link task replaces the rebook task, as the code's own reschedule link already does.
- **A3. Tasks are dated** (D4). A rebook task is dated by when the meeting was missed and has no due date or reminder time; the Task bullet's "tasks with due dates" becomes "dated tasks".
- **A4. Phase 6's row.** Phase 5 drops the status indexes (the ADR's "Phase 6 runs last, because Phase 5 frees the status indexes it drops", and the review's Phase 6 card, say Phase 6 does) and the `tenantStats` deal counters (D13), so they leave Phase 6's row; the meeting's held status and recorded-at time (D3) and the dead `opportunities.canceledAt` and `noShowAt` join it.
- **A5. Only with D5's other option:** the rebook window as a rule beside the Slack 30-day expiry.

## 12. Rollback

Fix forward, reviewed. Every repair is an internal migration with its own assert, run as §10.7 says, and the phase continues only after that assert and the assert of the step it repaired pass again.

- **PRs 1 to 3.** Revert. The new fields, tasks, aggregate and qualification row fields are written beside the status and read by nothing yet; a wrong value is rewritten by rerunning its backfill after a reviewed fix.
- **PRs 4 to 7.** Revert: the readers and guards go back to the status, which is still written.
- **PR 8.** Revert to PR 7. PR 8 writes the status on every insert and move as `legacyStatus` of the new fields, which the assert after it proves equal, and keeps `opportunityByStatus` and the counters in step, so PR 7 finds every deal as it would have written it.
- **PR 9.** Revert to PR 8, before or after the clears; PR 8 accepts a deal with no status or a stale one, since it never reads the stored status and writes `opportunityByStatus` through its `IfExists` methods. Then one reviewed, idempotent repair sets `status` from `legacyStatus(deal, tasks)` on every deal, and rebuilds what the clears emptied: the search rows, qualification rows and meeting mirror through their existing rebuilds, the meeting projections through `rebuildMeetingProjections`, `opportunityByStatus` through its backfill, and the counters through `repairTenantStatusCounters`. Writes during the repair keep the status current, since PR 8 writes it.
- **PR 10.** Revert brings the fields back as optional; then PR 9 is reverted and repaired as above.

## 13. Production log

All runs on tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, times in UTC, with `--env-file .env.vercel.production`.

### 13.1 Baseline, 2026-10-21

§2.

### 13.2 Deploys

| PR | What | Deployed |
| --- | --- | --- |

### 13.3 Runs

| When | Run | Result |
| --- | --- | --- |
