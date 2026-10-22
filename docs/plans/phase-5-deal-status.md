# Phase 5: deal status

Status: accepted, 2026-10-21. The tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`) accepted the recommendations in §11, answered Q1 to Q6 (§11.1), approved the ADR changes in §11.2 and every production run in §9 and §10. The answer to Q2 replaced the first plan's rebook task and its open Follow-up deals with D16: a missed meeting ends the deal. No PR has merged yet.

Scope comes from §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) (finding F2, the target model's "Stage and status on the deal" and "How today's statuses map" in §6, the anti-pattern "Appointment outcomes as deal stages" in §8) and the Phase 5 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md): this file says deal stage, outcome, attendance or task, and says "status" only for today's `opportunities.status` field. Phase 4 is in [phase-4-customers.md](phase-4-customers.md).

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

`opportunities.status` does four jobs: where the deal is, what happened to its meeting, which task is pending, and how it ended. Phase 5 gives each job one owner:

1. **One stage module**, `convex/opportunities/stages.ts`: the five deal stages (Qualified, Booked, Call held, Follow-up, Closed), the outcome (open, won, lost), which outcomes each stage allows, the labels, the reason codes the system writes on a loss, and the stage state machine. The validators, the state machine, the UI labels and the Slack labels come from it (§4.1).
2. **Widen**: `stage` and `outcome` on `opportunities` beside `status`. `transitionOpportunity` and the three inserts write both from the status they write today, through the mapping (§4.2). A new aggregate, `opportunityByStage`, counts deals by stage and outcome.
3. **A missed meeting ends the deal** (D16, from Q2). A no-show or a cancellation closes the deal as lost, with the reason `no_show` or `canceled`. A later booking from the person is a new deal. The same deal goes on only when Calendly moves an upcoming booking, when the closer sends a reschedule link or sets a follow-up, or when Calendly withdraws a no-show. The 14-day reschedule join goes (§4.3).
4. **A list for outreach** (D17, from Q2): Operations gets a No-shows and cancellations page, the deals a missed meeting ended, with the person's contact details and who worked the deal, and a CSV export. Qualifiers and openers work it outside the CRM (§6.5).
5. **Backfills** for every deal's stage and outcome, which closes the 2,502 canceled and no-show deals as lost, each with an assert that checks today's status can be rebuilt from the new fields (§10).
6. **Readers move**, one set of screens at a time: the labels and the person page, the closer pipeline and calendar, the reports and operations pages, then the guards and booking rules. Each reader's numbers are compared both ways in production before it switches (§10.4).
7. **The narrow**: `opportunities.status`, its copies on meetings, search rows, qualification rows and meeting projections, the `opportunityByStatus` aggregate, the status counters in `tenantStats`, and the nine indexes that name the status leave the schema (§3.3).

Apart from D16, every guard and booking rule keeps today's behaviour: the old status is rebuilt exactly from the stage, the outcome, the loss reason and the tasks (§4.6), and the asserts prove it on every deal.

It ships in ten code PRs after this plan (§9). Each is safe to deploy alone.

## 2. Production snapshot (2026-10-21)

Read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant, around 21:30 UTC.

### 2.1 Deals

11,520 deals, 45 more than the brief's count earlier the same day.

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

Every deal at `scheduled`, `follow_up_scheduled`, `canceled`, `no_show` and `payment_received` has an `assignedCloserId`; no `qualified_pending` deal has one. No `canceled` or `no_show` deal has `lostReason`, `lostAt` or `lostByUserId`.

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

By the deal's last update, canceled deals are 116 within 14 days, 99 within 30 days and 1,805 older; no-show deals are 73, 95 and 314. Today a new booking joins a canceled or no-show deal only within 14 days of its last update.

### 2.3 Meetings and Calendly

| Meeting status | Meetings | Note |
| --- | --- | --- |
| `scheduled` | 2,801 | 64 still to come |
| `completed` | 705 | every one has `completedAt` |
| `canceled` | 2,840 | |
| `no_show` | 520 | 498 have `completedAt`: a closer or admin marked them, and the outcome write sets it. The 22 Calendly no-shows don't |

Of the meetings whose time has passed and that weren't canceled, attendance is recorded (completed or no-show) on 22 of 170 in April, 51 of 504 in May, 212 of 586 in June, 240 of 637 in July, 77 of 740 in August, 387 of 771 in September and 236 of 554 in October.

Of the latest 375 `invitee.canceled` webhooks still stored (30-day retention), 113 are Calendly reschedules: `rescheduled: true`, with a `new_invitee`. Today such a cancel moves the deal to `canceled`, and the new booking moves it back.

### 2.4 Lost reasons

| Reason | Deals | Who |
| --- | --- | --- |
| `stale` (Slack 30-day expiry) | 4,297 | the system |
| free text | 184 | a closer or admin (71 Calendly, 113 Slack) |
| none | 59 | a closer or admin (24 Calendly, 35 Slack), all with a held meeting |

No lost deal has the reason `no_show` or `canceled`, the codes D16 writes.

### 2.5 Tasks

236 `followUps` rows, all `manual_reminder` with reason `closer_initiated`: 167 pending (165 on `follow_up_scheduled` deals, 2 on `scheduled` deals), 62 completed, 7 booked. No `scheduling_link` row exists: the reschedule link and the scheduling link have never been used. One `follow_up_scheduled` deal has no pending task.

### 2.6 Copies of the status

| Copy | Rows | Agrees with its deal |
| --- | --- | --- |
| `meetings.opportunityStatus` | 6,866 | all |
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

Enrollments and attribution read no deal status (Phase 4's handoff said so; confirmed). The lifecycle derivation reads none either: Showed comes from a held meeting and a side deal's creation. Only `shouldMarkUnresponsive` reads it (§6.10).

## 3. Schema

### 3.1 Widen (PRs 1 and 2)

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

PR 1 adds the two fields and these indexes, which the moved readers use (§6). With them `opportunities` has 31 indexes, under Convex's 32. Two names drop the `_and_`s to stay under Convex's 64 characters, as `by_tenantId_assignedCloserId_source_status_latestActivityAt` does.

| Index | Replaces | For |
| --- | --- | --- |
| `by_tenantId_leadId_source_stage_outcome_createdAt` | `by_tenantId_and_leadId_and_source_and_status_and_createdAt` | the Slack join (Qualified, and Closed lost for a stale-expired deal) and the Slack duplicate check |
| `by_source_and_stage_and_createdAt` | `by_source_and_status_and_createdAt` | the Slack expiry and the side deal nudge, across tenants |
| `by_tenantId_and_source_and_stage_and_createdAt` | `by_tenantId_and_source_and_status_and_createdAt` | the Slack stale digest |
| `by_tenantId_assignedCloserId_stage_outcome_createdAt` | `by_tenantId_and_assignedCloserId_and_status_and_createdAt` | the closer pipeline list and the user removal guard |
| `by_tenantId_and_stage_and_outcome_and_createdAt` | `by_tenantId_and_status_and_createdAt` | pipeline aging and velocity |
| `by_tenantId_and_stage_and_outcome_and_latestActivityAt` | `by_tenantId_and_status_and_latestActivityAt` | loss attribution and the No-shows and cancellations list, read from the range's start by activity and filtered by `lostAt`. PR 1 added `…_and_lostAt` here; the parity run after PR 3 found the Slack expiry's 4,000 recent losses filled a `lostAt` range before any person's loss, while the expiry keeps a deal's earlier activity, so it was replaced |

The other three status indexes (`by_tenantId_and_source_and_status_and_latestActivityAt`, `by_tenantId_and_assignedCloserId_and_status_and_latestActivityAt` and `by_tenantId_assignedCloserId_source_status_latestActivityAt`) are read only by the dead opportunities list in §2.7 and get no replacement.

PR 1 mounts `opportunityByStage` (`convex.config.ts`), a `TableAggregate` on `opportunities`, namespace `tenantId`, key `[stage, outcome, assignedCloserId ?? "", createdAt]`. Until the narrow, its key takes the stage and outcome from `stageForStatus(status, source)` when the fields are unset, so the entry doesn't move when the backfill writes them. Until its backfill and `verifyStageCounts` pass, the hooks write it with `insertIfDoesNotExist`, `replaceOrInsert` and `deleteIfExists`: a strict `replace` throws when the old entry is missing, which would fail every write to a deal not yet in it. PR 9 moves it to the strict methods.

PR 2 adds `rescheduled: v.optional(v.boolean())` to `calendlyBookingFacts`, from the cancel webhook's own field (§4.3).

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

- `domainEvents.fromStatus` and `toStatus`: the old events keep the status they recorded, and the new ones record the stage (§4.7).
- `opportunities.lostReason`, `lostAt`, `lostByUserId`, `paymentReceivedAt`, `cancellationReason`, `canceledBy`: facts with their own times, read by the reports and the person page. `canceledAt` and `noShowAt` duplicate the meeting's; Phase 6 drops them with the other dead fields (A3).
- `followUps.completionOutcome`'s values `payment_received` and `lost`: a reminder's result, not a deal status.
- `meetings.status`, `completedAt` and `noShowMarkedAt`: attendance (D3).

## 4. Rules

### 4.1 The stage module

`convex/opportunities/stages.ts` follows `convex/leads/lifecycle.ts`, the person's stage list:

- `DEAL_STAGES` in order, `DEAL_OUTCOMES`, their validators and types;
- `DEAL_STAGE_CONFIG`: for each stage its label and the outcomes it allows. Qualified, Booked, Call held and Follow-up allow `open`; Closed allows `won` and `lost` (A1);
- `dealPosition(stage, outcome)`: the six positions a screen shows, in order: Qualified, Booked, Call held, Follow-up, Won, Lost. The closer's tabs, the report's distribution, the filters and the badges use it;
- `assertStageOutcome(stage, outcome)`: the one check that a pair is allowed;
- the loss reason codes the system writes, with their labels: `stale` (the Slack expiry, moved here from `pipeline/slackJoinLookup.ts`), `no_show` and `canceled` (D16). A loss the system writes has no `lostByUserId`; a loss a person records has one and free text or no reason (Q4);
- the stage state machine (§4.4) and `stageForStatus(status, source)`, the mapping (§4.2). After the narrow the mapping only reads old events (§4.7).

`lib/status-config.ts` loses its opportunity section: the badge and dot colours become a map typed by the position, so a new stage fails the typecheck until it has colours. `DEAL_STATUS_LABELS` in `convex/lib/slackBlockKit.ts` goes; the Slack text takes the labels from the module.

### 4.2 The mapping

A pure function of the status and the deal's source:

| Status | Stage | Outcome | The rest lives on |
| --- | --- | --- | --- |
| `qualified_pending` | Qualified | open | |
| `scheduled`, Calendly or Slack | Booked | open | the meeting (scheduled) |
| `scheduled`, side deal | Call held | open | |
| `follow_up_scheduled` | Follow-up | open | the reminder or scheduling link task, when there is one |
| `reschedule_link_sent` | Follow-up | open | the meeting (no-show) and the reschedule link task (A2) |
| `canceled` | Closed | lost, reason `canceled` | the meeting (canceled) |
| `no_show` | Closed | lost, reason `no_show` | the meeting (no-show) |
| `payment_received` | Closed | won | the payments |
| `lost` | Closed | lost | `lostReason` |

During the dual write, a move to `canceled` or `no_show` also writes `lostReason` and `lostAt`, and a move out of them clears them with `lostByUserId`, as the Slack stale rejoin does. `backfillDealStages` writes them on the 2,502 deals.

The edge cases (D2): the scheduled side deal is Call held. The 2,737 deals whose call has passed with nothing recorded are Booked; their meeting stays scheduled, and nothing invents an attendance or an outcome (Q3). The 59 lost deals with no reason stay so; the person page shows no reason, as today.

### 4.3 A missed meeting ends the deal (D16)

From PR 2 the booking rules follow Q2's answer: a no-show or a cancellation leaves the person to the qualifiers' and openers' outreach, and a later booking is a new deal.

- **Closing.** A no-show (closer, admin or Calendly) or a cancellation (Calendly, or an admin resolving a closer's unavailability) on the deal's current booking closes it: Closed, lost, reason `no_show` or `canceled`, `lostAt` the time of the no-show or cancellation. The meeting keeps its attendance. Calendly turning a no-show into a cancellation, or the reverse, changes the reason on the closed deal.
- **A Calendly reschedule isn't a cancellation.** When the cancel webhook carries `rescheduled: true`, the old meeting is canceled and the deal stays Booked; the new booking, which names the old one (`old_invitee`), re-points the deal as a provider reschedule of a scheduled deal does today. If the new booking is processed first, it cancels the old meeting itself, as today.
- **What keeps the deal going** after a missed meeting, each a named exception from Closed lost (§4.4):
  - the closer or an admin sends a reschedule link or sets a follow-up from the no-show or cancellation (today `no_show` → `reschedule_link_sent` or `follow_up_scheduled`, `canceled` → `follow_up_scheduled`): the deal reopens at Follow-up, and a booking through the link joins it;
  - Calendly withdraws the no-show (today `no_show` → `scheduled`): the deal reopens at Booked.
- **Any other booking is a new deal.** The 14-day reschedule join goes. A Calendly reschedule whose old booking ended the deal (it was a no-show, or a cancellation without the flag) creates a new deal instead of joining. The other joins stay: a booking link the closer sent, a follow-up deal's booking, the Slack join.

This changes what happens today in three ways, all asked for in Q2: bookings within 14 days of a no-show or cancellation, which today rejoin the old deal, become a new deal beside a closed one, with their own credit rows; the 113 recent Calendly reschedules stop showing a cancellation on the deal; an admin's unavailability cancel ends the deal too. A reschedule link or follow-up the closer sets keeps the deal, as today.

`legacyStatus` reads a missed meeting from the loss: a deal Closed lost with no `lostByUserId` and the reason `no_show` or `canceled` was `no_show` or `canceled`.

### 4.4 Transitions

From PR 1 to PR 7, `transitionOpportunity` takes the status as today and writes `stage` and `outcome` from the mapping with it, in the same patch. The three inserts (`pipeline/inviteeCreated.ts`, `slack/createQualifiedLead.ts`, `opportunities/createManual.ts`) do the same. ESLint's rule against a raw status patch also covers `stage` and `outcome`; only the backfill and the clears disable it, each with a comment.

From PR 8 the transition takes a stage and an outcome, and the state machine moves to the stage module:

| From | To | Today's moves it covers |
| --- | --- | --- |
| Qualified | Booked; Closed lost | `qualified_pending` → `scheduled`, `lost` |
| Booked | Follow-up; Closed won; Closed lost | `scheduled` → `follow_up_scheduled`, `payment_received`, `lost`, `canceled`, `no_show` |
| Call held | Follow-up; Closed won; Closed lost | the side deal's `scheduled` moves |
| Follow-up | Booked; Closed won; Closed lost | `follow_up_scheduled`, `reschedule_link_sent` → `scheduled`; `follow_up_scheduled` → `payment_received`, `lost` |
| Closed won | Closed lost, only with `payment_voided` | the voided side deal payment |
| Closed lost | Booked, only with `slack_stale_rejoin` | the Slack deal reopened by a late booking |
| Closed lost | Follow-up, only with `missed_meeting_next_step` | `no_show` → `reschedule_link_sent`, `follow_up_scheduled`; `canceled` → `follow_up_scheduled` |
| Closed lost | Booked, only with `no_show_withdrawn` | `no_show` → `scheduled` from Calendly |

Each exception checks the loss it reopens: `missed_meeting_next_step` and `no_show_withdrawn` take only a deal the system closed with `no_show` or `canceled`, and `slack_stale_rejoin` only one closed with `stale`. A Calendly move between no-show and canceled on a closed deal patches the reason through `patchOpportunityLifecycle`, with the same `updatedAt`, `canceledAt`, `cancellationReason` and `noShowAt` it writes today: `updatedAt` decides which late bookings are held for review. The `calendly_webhook` exception goes.

### 4.5 Where each part of the status goes

- **Attendance** is the meeting's, as it is today: scheduled, completed, canceled, no-show. The deal no longer copies it. Renaming `completed` to held and moving the outcome time out of `completedAt` is D3.
- **A missed meeting** closes the deal with its reason (§4.3). Who should reach out next is the No-shows and cancellations list (§6.5), a view over those deals, not a task row (D4).
- **Reschedule link sent** is the pending `scheduling_link` task with reason `no_show_follow_up`, which the reschedule link actions already write (A2). A deal leaves `reschedule_link_sent` only through a booking link; from PR 2 that booking also expires any other pending reschedule link on the deal. Today a booking through an older, unconfirmed scheduling link books only that link and leaves the reschedule link pending forever, which would make a later Follow-up look like `reschedule_link_sent`.
- **Follow-up scheduled** is the pending `manual_reminder` or `scheduling_link` task the follow-up actions already write. A Follow-up deal with neither, such as one whose reminder was closed with "close only", stays in Follow-up with no next step, as it stays `follow_up_scheduled` today.
- **Won and lost** are the outcome. A person's reason stays optional (Q4).

### 4.6 Behaviour otherwise stays the same

Each status a guard or booking rule tests becomes a test of the stage, the outcome, the loss and the tasks (`convex/opportunities/dealState.ts`):

| Today | From PR 7 |
| --- | --- |
| `qualified_pending` | Qualified |
| `scheduled` | Booked, or Call held for a side deal |
| `follow_up_scheduled` | Follow-up with no pending reschedule link |
| `reschedule_link_sent` | Follow-up with a pending reschedule link |
| `canceled`, `no_show` | Closed lost by the system with that reason |
| `payment_received` | Closed won |
| `lost` | Closed lost otherwise |

`legacyStatus(deal, tasks)` reads them in that order and rebuilds today's status from the new fields; the asserts prove it on every deal (§10.2). The sets that leave out canceled and no-show deals today (the Slack duplicate check, `shouldMarkUnresponsive`, the user removal guard, Pipeline Health's aging) become "open", which leaves them out too. Every closer and admin control shows on the same deals as today; on the reminder pages a canceled deal now counts as finished, as `no_show` already does, where today it shows buttons the server refuses.

### 4.7 Events

From PR 8, `transitionOpportunity` emits `opportunity.stage_changed` for every move, with `fromStatus` and `toStatus` holding the stages and the outcomes in its metadata (`fromOutcome`, `toOutcome`). A loss keeps the type `opportunity.marked_lost`, with the same fields and the reason. A Calendly move between no-show and canceled on a closed deal emits only its meeting event. Until PR 8 the events stay as they are.

The 5,488 `opportunity.status_changed` and 4,540 `opportunity.marked_lost` events keep the statuses they recorded. Every reader learns both forms (D7):

- `pipeline/bookingHistory.ts` rebuilds a deal's past position from its events to decide whether a late booking could have joined it, and gives no answer when the chain has a gap. Between two old events it checks continuity on the raw statuses, as today; only where an old event meets a new one, and against the deal's current stage and outcome at the end, does it map the old status through `stageForStatus` with the deal's source. A deal it couldn't join is Booked, Call held or Closed won, which is today's `scheduled` and `payment_received`.
- The deal sheet's activity, the person's timeline, the activity feed, `reporting/lib/eventLabels.ts` and the PostHog properties show old events with the old labels and new ones with the stage labels.
- `opportunity.created` records the stage it starts at.

So `stageForStatus` stays after the narrow, as the reader of old events, in the stage module beside the frozen list of the old statuses. Nothing writes them.

### 4.8 Copies

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

The stage and outcome are plain fields on the deal, so the warehouse sync the tenant admin plans (Q5) reads them without joins; the loss reasons the system writes are fixed codes beside the free text people write.

## 5. Write paths

Every status write goes through `transitionOpportunity`; these are its callers, with what each becomes in PR 8.

| Write | Where | Today | From PR 8 |
| --- | --- | --- | --- |
| Booking creates a deal | `pipeline/inviteeCreated.ts` | insert `scheduled` | insert Booked |
| Slack qualifies | `slack/createQualifiedLead.ts` | insert `qualified_pending` | insert Qualified |
| Side deal | `opportunities/createManual.ts` | insert `scheduled` with no meeting | insert Call held |
| Booking joins a Slack deal | `inviteeCreated.ts` | `qualified_pending` → `scheduled`; a stale-expired deal with `slack_stale_rejoin` | Qualified → Booked; Closed lost (`stale`) → Booked with the exception |
| Booking joins a follow-up deal | `inviteeCreated.ts` | `follow_up_scheduled` → `scheduled` | Follow-up with no reschedule link → Booked |
| Booking link | `inviteeCreated.ts` | `follow_up_scheduled` or `reschedule_link_sent` → `scheduled` | Follow-up → Booked |
| Calendly reschedule | `inviteeCreated.ts` | the deal of the old booking: `scheduled` re-points; `canceled` or `no_show` → `scheduled` | Booked re-points; from PR 2 a deal the old booking ended gets no join, and the booking creates a new deal |
| 14-day reschedule join | `inviteeCreated.ts` | `canceled` or `no_show` updated within 14 days → `scheduled` | removed in PR 2 |
| Calendly cancel, no-show, no-show withdrawn | `pipeline/bookingFacts.ts` | `scheduled` ↔ `canceled`, `no_show`; `no_show` ↔ `canceled` with `calendly_webhook` | Booked → Closed lost (`canceled`, `no_show`); a reschedule's cancel moves only the meeting; the withdrawn no-show reopens at Booked; the reason changes in place |
| Closer or admin no-show | `closer/noShowActions.ts`, `admin/meetingActions.ts` | `scheduled` → `no_show` | Booked → Closed lost (`no_show`) |
| Reschedule link | same | `no_show` → `reschedule_link_sent` | Closed lost (`no_show`) → Follow-up with `missed_meeting_next_step`; link task as today |
| Follow-up or reminder, with or without the meeting | `closer/followUpMutations.ts`, `closer/followUp.ts`, `admin/meetingActions.ts` | `scheduled`, `canceled` or `no_show` → `follow_up_scheduled` | Booked → Follow-up; from a missed meeting, Closed lost → Follow-up with the exception, at the confirm step as today |
| Payment on a meeting | `closer/payments.ts` | `scheduled` → `payment_received` | Booked → Closed won |
| Payment on a reminder | `closer/reminderOutcomes.ts` | `scheduled` or `follow_up_scheduled` → `payment_received` | Booked, or Follow-up with no reschedule link → Closed won |
| Side deal payment | `sideDeals/logPayment.ts` | `scheduled` or `follow_up_scheduled` → `payment_received` | Call held or Follow-up → Closed won |
| Lost: meeting, reminder, side deal, admin | `closer/meetingActions.ts`, `closer/reminderOutcomes.ts`, `sideDeals/markLost.ts`, `admin/meetingActions.ts` | `qualified_pending`, `scheduled`, `follow_up_scheduled` → `lost` | Qualified, Booked, Call held, or Follow-up with no reschedule link → Closed lost |
| Slack expiry | `slack/staleExpiry.ts` | `qualified_pending` → `lost`, reason `stale` | Qualified → Closed lost (`stale`) |
| Voided side deal payment | `sideDeals/voidPayment.ts` | `payment_received` → `lost` with `payment_voided` | Closed won → Closed lost with the exception |
| Unavailability cancel | `unavailability/redistribution.ts` | `scheduled` → `canceled` | Booked → Closed lost (`canceled`) |
| Empty side deal deleted | `sideDeals/deleteEmptyOpportunity.ts` | only at `scheduled` | only at Call held |

A side deal that a booking joins, which only the API can do today, stays Call held during the dual write, since the mapping reads the source; from PR 8 the join moves it to Booked.

`transitionOpportunity` also rewrites the aggregates, the search rows and the qualification rows when the stage or outcome changes (`AGGREGATE_KEY_FIELDS`, `QUALIFICATION_ROW_FIELDS`), and from PR 9 stops writing `tenantStats` (D13) and stops asking for the meeting projections, which no longer carry a deal field. The payment paths call `syncPersonEnrollments` and the lifecycle hooks as now. A deal closing doesn't move the person's lifecycle stage (rule 8).

## 6. Readers

### 6.1 Labels and the person page (PR 4)

- `components/status-badge.tsx` becomes a deal stage badge reading the position, with the system's loss reasons as a suffix ("Lost: no-show"). Its users: the person page's deal rows and sheet, the closer pipeline table.
- The person page: the deal row's accent, badge and Won chip, the sheet's badge, value and reason, "Winning deal" in the snapshot aside. The sheet's controls (`opportunities/detailQuery.ts`): record payment, mark lost and delete on a side deal at Call held; add payment and void payment on a won deal.
- The meeting and reminder pages' labels: the header badge on the closer and admin meeting pages, the deal badge on each row of the meeting history card and timeline (`closer/meetingDetail.ts`), the reminder metadata card's badge, and the `opportunity_status` property the reminder pages send to PostHog, which becomes `deal_stage` and `deal_outcome`.
- The booking review page and its Slack message show each deal's position with the module's labels.
- The deal sheet's activity, the person's timeline and the activity feed label old events with the old status labels and new ones with the stage labels (§4.7). PR 4 adds the new labels so they are ready when PR 8 starts emitting them.
- The person search text takes the stage labels (`leadCustomers/searchText.ts`); `backfillLeadCustomerSearchRows` rebuilds the rows after PR 4 deploys (§9).

### 6.2 Closer pipeline and dashboard (PR 5)

- `/workspace/closer/pipeline`: tabs All, Booked, Call held, Follow-up, Won, Lost, each with its count from `opportunityByStage` (a `countBatch` over the closer's prefix instead of eight unbounded scans). The Canceled and No Show tabs go, since closers don't use them (Q1); those deals are under Lost with "no-show" or "canceled" on the badge. Each Follow-up row says its next step: "Reschedule link sent", the reminder's date, or nothing. The list reads `by_tenantId_assignedCloserId_stage_outcome_createdAt`. The period toggle stays as it is.
- The URL takes `stage=` (the six positions). An old `status=` link still works: `scheduled` opens Booked; `follow_up_scheduled` and `reschedule_link_sent` open Follow-up; `payment_received` opens Won; `lost`, `canceled` and `no_show` open Lost; `qualified_pending` opens All.
- `/workspace/closer`'s pipeline strip: segments by position; Won as today. The close rate is won ÷ (won + lost), where lost counts only the losses a person recorded: the ones the system wrote for a missed meeting (`no_show`, `canceled`) are left out, so the rate doesn't change when the canceled and no-show deals become losses.

### 6.3 Closer calendar (PR 5, from Q1)

Closers work from the dashboard calendar. `closer/calendar.ts:getMeetingsForRange` stops leaving out canceled meetings, which show with the canceled style `lib/status-config.ts` already has (muted, struck through), and returns each meeting's deal position. The meeting's details dialog shows the deal's position and, for a deal a missed meeting closed, "No-show" or "Canceled". A Calendly reschedule shows the old slot canceled beside the new one.

### 6.4 Meeting and reminder pages (PR 7)

The controls show on the same deals as today, from the stage, the loss and the tasks (§4.6):

- Closer meeting page: the outcome bar (log payment, follow-up, no-show, lost) on a Booked deal whose meeting is scheduled, inside the time window, with no active follow-up; the no-show bar (request reschedule, follow-up) on a deal a no-show closed; the "reschedule link sent" banner on a Follow-up deal with a pending reschedule link; "Deal won" on Closed won.
- Admin meeting page: no bar on a closed deal, except a missed meeting's; the four actions on a Booked deal with a scheduled meeting; "Schedule follow-up" on a deal a missed meeting closed; "Reschedule link" on one a no-show closed.
- Reminder pages: the deal counts as finished when it is Closed.
- `lib/outcomeEligibility.ts` (`assertCanRecordMeetingOutcome`) requires a Booked deal; the reschedule link mutations require a deal a no-show closed; `closer/additionalPayment.ts` requires Closed won; the reminder's "no response, schedule a new one" requires Follow-up with no reschedule link.

### 6.5 No-shows and cancellations (PR 6, from Q2)

A new page under Operations for admins, `/workspace/operations/missed-meetings`, gated like the other Operations pages:

- the deals a missed meeting closed (Closed lost with the system's `no_show` or `canceled`), by when they closed, newest first, over a date range (the last 30 days by default), read through `by_tenantId_and_stage_and_outcome_and_latestActivityAt` from the range's start and filtered by `lostAt`;
- per row: the person's name, Instagram handle, email and phone; no-show or canceled; the missed meeting's time; the deal's source; the closer, the setter and the DM closer or team from `dealAttributions`; and whether the person has a deal created since. A filter hides people who booked again, on by default, and one picks no-shows or cancellations;
- **Export CSV** downloads the rows the filters show, up to 2,000, and says so when a range holds more. Past 2,000 the list keeps the first rows read, by activity, so it is roughly, not exactly, the newest; about 200 deals a month close this way, far under the cap.

What the team does with the list is undecided (Q2), so the page only lists and exports; it writes nothing and assigns no one. Old deals are on it from the backfill: the 2,502 canceled and no-show deals, each with the time of its no-show or cancellation.

### 6.6 Reports and operations (PR 6)

- **Pipeline Health** (`reporting/pipelineHealth.ts`): the distribution chart shows the six positions from `opportunityByStage`. The aging table shows Booked, Call held and Follow-up (Qualified stays computed and hidden, as today); the stale list covers open deals whose `nextMeetingAt` is unset or more than 14 days past, the rule it has today; both read `by_tenantId_and_stage_and_outcome_and_createdAt`, the same open deals as today. Velocity reads Closed won. Loss attribution reads Closed lost with `lostAt` in the range, from the range's start by activity, leaving out the system's losses (`stale`, `no_show`, `canceled`), as it leaves out `stale` today.
- **Team report** (`reporting/lib/outcomeDerivation.ts`): a meeting's deal counts as lost when a person closed it, so a no-show or canceled meeting stays a no-show or a cancellation; a follow-up is a held meeting on a Follow-up deal with no reschedule link.
- **Qualifications** (`operations/qualifications.ts`): the filter takes the six positions, through the qualification row's `dealStage` and `dealOutcome` and their index; the badge and the search text use the labels.
- **Booked Calls** and **Sales Calls** lists: the detail's "Opportunity status" becomes "Deal stage", read from the deal (`meetings.opportunityStatus` goes). The bookings export's `OpportunityStatus` column becomes `DealStage` and `DealOutcome`; nothing imports it today (Q5).
- `operations/phoneSales.ts:listPhoneSalesMeetings` loses its unused `opportunityStatus` argument.

### 6.7 Booking pipeline (PRs 2 and 7)

PR 2 changes the rules as §4.3 says, still in statuses. PR 7 moves them to the stage, the loss and the tasks without changing them again: the booking link joins a Follow-up deal; a Calendly reschedule re-points a Booked deal; the follow-up join takes one Follow-up deal with no reschedule link; the Slack join takes a Qualified Slack deal from the last 30 days or one the Slack expiry closed after the booking. `bookingFacts.ts` follows the deal's current booking as §4.3 says. `bookingHistory.ts` reads both event forms (§4.7). `convex/pipeline/bookingReviews.test.ts` stays green in every PR.

### 6.8 Slack (PR 7)

- `createQualifiedLead.ts`: a pending duplicate is a Qualified Slack deal from the last 30 days; an existing booking is an open deal that isn't an old Qualified one.
- `staleExpiry.ts`, `staleRemindersData.ts`: Qualified Slack deals, on the new indexes.
- The stale digest's "View all" link names `stage=qualified`; `/workspace/pipeline` keeps redirecting whatever it is given, so the links already posted keep landing where they land today.

### 6.9 Side deals, staleness, users (PR 7)

`opportunities/staleness.ts` nudges side deals at Call held; `sideDeals/*` act on Call held as they act on `scheduled`. `users/queries.ts:getActiveAssignedOpportunityCount` and `workos/userMutations.ts:removeUser` block removing a closer with a Booked, Call held or Follow-up deal, one indexed `take(1)` each: the deals `scheduled`, `follow_up_scheduled` and `reschedule_link_sent` name today.

### 6.10 Lifecycle (PR 7)

`shouldMarkUnresponsive` counts a person's open deals, the same set as today's active statuses. The lifecycle stage derivation doesn't change. `assertLeadLifecycle` runs after PR 7 deploys anyway, since the lifecycle code changes (§9).

## 7. Report numbers

Counts from §2.

| Report | Change |
| --- | --- |
| Pipeline Health, distribution | 8 statuses become 6 positions: Qualified 1,230, Booked 2,801, Call held 1, Follow-up 166, Won 280, Lost 7,042 (4,540 + 2,020 canceled + 482 no-show) |
| Pipeline Health, aging and stale list | none: they count the open deals, today's active statuses; the side deal shows as Call held instead of Scheduled |
| Pipeline Health, velocity, loss attribution, reminder backlog | none |
| Closer pipeline tabs | Booked equals today's Scheduled less the closer's scheduled side deals, which move to Call held; Follow-up the same; Lost equals Lost + Canceled + No Show; Canceled and No Show go |
| Closer dashboard strip | segments by position; Won and the close rate unchanged |
| Qualifications filter | 6 positions instead of 8 statuses; Lost holds canceled and no-show deals |
| Team report, Reminders, Booked Calls, Sales Calls, Revenue, Leads & Conversions, lead gen, billing | none from the fields; Booked and Sales Calls show the stage label |
| New deals and bookings, from PR 2 | a booking within 14 days of a no-show or cancellation creates a new deal instead of rejoining, so it counts as a new deal and its call as a first call rather than a follow-up; a Calendly reschedule no longer cancels its deal on the way |
| Bookings export | `OpportunityStatus` becomes `DealStage` and `DealOutcome` |
| Activity feed | from PR 8, deal moves count as `opportunity.stage_changed`; a no-show or cancellation shows as the deal marked lost |
| Leads search | a person's deals match by their stage labels (booked, call held, follow-up, won, lost); "no show" and "canceled" still match a deal a missed meeting closed; the other status words ("scheduled", "payment received") stop matching |
| `tenantStats` active, won, lost | gone; no screen read them |

## 8. What else moves

- Tests: about 29 insert sites in `convex/**/*.test.ts` and 9 in `tests/*.ts`, plus `forceOpportunityState` in `tests/opportunityFixtures.ts`, write a status. From PR 1 they write the stage and outcome beside it through one fixture helper (`tests/dealStageFixtures.ts`, `stageFields(status, source)`), and from PR 9 only the stage and outcome. The 14-day join's tests (`pipeline/incidentReschedule.test.ts`, `pipeline/slackBeforeHeuristic.test.ts`) change in PR 2 to expect a new deal. Each PR's subagent gets its own fixture file name.
- `docs/agents/convex.md`'s "Write side effects" and the ADR's rule 2 name the stage machine instead of the status from PR 8.
- `admin/migrations.ts`: `seedTenantStatsInternal`, `repairTenantStatusCounters` and its copy of the active set lose the status counters; `reporting/verification.ts` counts `opportunityByStage` instead.
- The existing health checks that read the status (`assertOpportunitySearchProjectionBackfilled`, `assertQualificationRowsCurrent`, `assertMeetingProjections`) compare the new fields.
- The dead code in §2.7 is deleted in the PR whose reader it shadows, so nothing is moved to the stage only to be deleted.
- ADR 0001 and `CONTEXT.md` take the changes in §11.2 in PR 10.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 0 | This plan | docs |
| 1 | Widen: the stage module, `stage` and `outcome`, the six indexes, `opportunityByStage` through its `IfExists` methods, the dual write in `transitionOpportunity` and the three inserts (with the loss fields of a missed meeting), the ESLint rule, `backfillDealStages`, `assertDealStages`, `backfillOpportunityByStage`, `verifyStageCounts` | new optional fields and a new aggregate written beside the status; nothing reads them |
| 2 | A missed meeting ends the deal (§4.3), in statuses: `calendlyBookingFacts.rescheduled`, the 14-day join removed, a Calendly reschedule of an ended deal makes a new deal, a booking link expires stale reschedule links | the status machine is unchanged; each rule is its own test |
| 3 | `dealStage` and `dealOutcome` on the qualification rows; `dealState.ts` (§4.6); the parity queries (§10.4) | additive |
| 4 | Labels and the person page (§6.1) | after the PR 1 backfill passes; reads fields every deal has; a revert goes back to the status, still written |
| 5 | The closer pipeline, dashboard and calendar (§6.2, §6.3) | as PR 4 |
| 6 | Reports and operations, and the No-shows and cancellations page (§6.5, §6.6) | as PR 4, after the parity queries agree |
| 7 | Guards and rules read the stage, the loss and the tasks: meeting and reminder pages, the booking pipeline, Slack, side deals, the user guard, the lifecycle (§6.4, §6.7 to §6.10) | the status is still written, so a revert is safe; the behaviour is the same (§4.6), proven by tests and the asserts |
| 8 | The transition and the state machine on stages, with the exceptions in §4.4, and `opportunity.stage_changed`. `status` is still written, as `legacyStatus` of the new fields, after every transition and every change to a reschedule link, with `opportunityByStatus` (now through its `IfExists` methods) and the counters; `status` becomes optional | a revert goes back to PR 7, which reads the stage and writes the status from its own transitions; nothing reads the stored status |
| 9 | Stop writing the status: the status, `opportunityByStatus`, the counters, the meeting mirror, the search and qualification row copies and the meeting bucket key's deal field are no longer written; `opportunityByStage` on its strict methods; the asserts stop comparing the status; the dead code removed; the clears | no reader reads the status after PR 7, and no writer after PR 8 needs it |
| 10 | The narrow (§3.3); ADR 0001 and `CONTEXT.md` (§11.2), the review's Phase 5 and Phase 6 cards, the ADR's Phase 4 row note, this plan's status | after the clears and their asserts pass in production |

PRs 4, 5 and 6 can merge in any order after PR 3. Each moves one set of screens.

Production runs, in this order (§10.7 has the commands):

1. After PR 1: `backfillDealStages` dry run, run, then `assertDealStages`; `backfillOpportunityByStage` (the aggregate), then `verifyStageCounts`.
2. After PR 2: `backfillCancelRescheduledFlags` dry run, run, then `assertCancelRescheduledFlags`, straight after the deploy; `assertBookingAttributions`, `assertDealAttributions` and `assertPersonTouches`, since bookings now create deals the join used to take.
3. After PR 3: `assertDealStages` (reset), which now also rebuilds the status from the new fields; `rebuildQualificationRows` (reset), then `assertQualificationRowsCurrent` (reset); the parity queries.
4. After PR 4: `backfillLeadCustomerSearchRows` (reset), then `assertLeadCustomerSearchRowsBackfilled` (reset), in the background (about 20 minutes over 90,000 people). After PRs 4 to 6: a read-only recheck of the numbers each one shows.
5. After PR 7: `assertDealStages` (reset); `assertLeadLifecycle` in the background (about an hour), since the lifecycle code changed; `assertBookingAttributions`, `assertDealAttributions` and `assertPersonTouches`, since the booking pipeline changed; `assertEnrollments` and `assertPaymentEnrollments`, since the payment paths changed.
6. After PR 8: `assertDealStages` (reset), which now checks the stored status against `legacyStatus`; then every health check in step 5 once more, since every write path changed.
7. After PR 9: `assertDealStages` (reset), with no status comparison; the clears, each with its assert (§10.6); then the health checks in step 5 once more.
8. After PR 10: the schema push checks that no row carries a removed field; `assertDealStages` (reset) once more.

## 10. Backfill, parity and assert migrations

All are `migrations.define` in `convex/migrations.ts` unless named otherwise. None emits an event or moves a person's stage. Batch sizes are a first guess; each dry run sets the real one.

Deals keep arriving and moving between runs, so a run can process more rows than §2 counts. No migration checks a count; the asserts check each row, and the recheck accounts for any difference with rows created after the snapshot.

### 10.1 `backfillDealStages` (PR 1)

Over `opportunities`, batch 200: sets `stage` and `outcome` from `stageForStatus(status, source)` where they differ, and on a `canceled` or `no_show` deal with no `lostReason`, `lostReason` (`canceled` or `no_show`) and `lostAt`: the deal's `canceledAt` or `noShowAt`, else its latest meeting's `canceledAt` or `noShowMarkedAt`, else its `updatedAt`. Expected: 11,520 deals, the §7 distribution, 2,502 with the loss fields. A rerun changes nothing. It patches directly: `updatedAt` and `latestActivityAt` stay as they are, so no booking rule moves; the aggregate's key already reads the mapped stage; nothing else reads the fields yet.

`backfillOpportunityByStage` pages over `opportunities` with `insertIfDoesNotExist`, as `reporting/backfill.ts` does for `opportunityByStatus`. `verifyStageCounts` (internal query) compares each position's count in `opportunityByStage` with the sum of its statuses in `opportunityByStatus`, and the total with the table.

### 10.2 `assertDealStages` (PR 1, changed in PRs 3, 8 and 9)

Over `opportunities`, batch 200. Each deal has a stage and an outcome that `assertStageOutcome` allows; a `canceled` or `no_show` deal has no `lostByUserId` (a person's free text may match a code, and reads as `lost`); a deal at Follow-up has at most one pending reschedule link. Then, by PR:

- PR 1: the pair is `stageForStatus(status, source)`, and a `canceled` or `no_show` deal has the matching reason.
- PRs 3 to 7: also `legacyStatus` (§4.6, in `dealState.ts` from PR 3), rebuilt from the deal and its pending tasks, equals its status.
- PR 8: the stage machine sets the pair and writes the status from it, so only `legacyStatus` against the status is checked.
- From PR 9: no status comparison, since the status is no longer written. `assertQualificationRowsCurrent` and `assertOpportunitySearchProjectionBackfilled` stop comparing it in the same PR.

It throws on the first problem, with IDs only. It stays as a health check.

### 10.3 Qualification rows (PR 3)

The existing `rebuildQualificationRows` (reset) writes `dealStage` and `dealOutcome` on the 8,602 rows, and `assertQualificationRowsCurrent`, amended, checks them against their deal.

### 10.4 Parity (PR 3, run before PRs 4 to 6 deploy)

Internal queries in `convex/opportunities/stageParity.ts` compute each number both ways and return the differences, IDs and counts only:

- `compareStageCounts`: each position's count from `opportunityByStage` against its statuses' counts, tenant-wide and for each closer (the closer tabs).
- `comparePipelineHealth`: aging, the stale list, velocity and loss attribution, from the status and from the stage, and the bytes the aging scan reads. The expected difference is the side deal's row.
- `compareQualificationQueue`: for each position, the qualification rows the new filter returns against the rows of the statuses it covers.
- `compareTeamOutcomes`: the team report's outcome mix per closer for each month from 2026-04, both ways.
- `compareCloseRates`: each closer's won and lost counts on the dashboard strip, both ways.
- `compareDealState`: for each deal, `legacyStatus` against the status, every mismatch instead of the first.

Both ways of each number are functions beside the reader that shows it, and PR 9 removes the status ways with the parity module. Every "none" in §7 must come back with no difference, and every listed change with exactly the listed difference, before the PR that shows it deploys. The results go into §13.

### 10.5 Missed meetings (PR 2)

PR 1 already closed the 2,502 deals, and the rules apply to bookings from PR 2's deploy. There are no `scheduling_link` rows, so no stale reschedule link to expire.

One gap needs a backfill. A cancel's booking fact recorded before PR 2 has no `rescheduled` flag, so if the original booking of a reschedule is applied late (a held delivery retried), it reads the cancel as a plain one and cancels the deal. `backfillCancelRescheduledFlags`, over `rawWebhookEvents`, batch 200, sets the flag on the fact of every stored `invitee.canceled` that Calendly flagged, found under the URIs the processor records it with; it writes nothing else. `assertCancelRescheduledFlags` checks none is left. Production holds 113 flagged cancels among the latest 375 stored; resolved deliveries lose their payload after 30 days, and those cancels were already applied, so the facts that can still matter are the ones the backfill reaches.

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

Before `clearDealStatus`'s dry run, a search of the deployed commit shows no reader of `opportunities.status`, `opportunitySearch.status`, `meetings.opportunityStatus` or `operationsQualificationRows.opportunityStatus` outside the schema, the clears and the old-event mapping; if one is left, the clears wait for a reviewed fix. No export is taken: every cleared value rebuilds from the stage, the outcome, the loss, the tasks and the source (§12), and nothing is deleted except the aggregate's entries and the emptied meeting buckets, which rebuild from their tables.

### 10.7 Commands

Every command runs against production with `--env-file .env.vercel.production`; without it the CLI targets the dev deployment. Filter dry-run output with `grep -E '"processed"|"DryRun"|error'`, since a dry run prints whole documents.

```
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillDealStages","dryRun":true}'
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillDealStages"}'
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:backfillDealStages"]}'
```

The others run the same way, in §9's order. The dry run must finish without an error and process rows of the table it names; an error, or a dry run that would write rows the plan doesn't expect, stops the phase for a fix in a reviewed PR. Then the run, then poll `lib:getStatus` until it reports `"isDone": true` (a background loop that waits 30 seconds between calls), read any error, and only then run its assert, polled the same way. A batch that fails on a known Convex limit commits nothing and resumes from its cursor at a smaller batch. Any other failure, and any failed assert, stops the phase until a reviewed fix ships and the failed step and its assert pass again (§12). The parity queries run with `npx convex run --env-file .env.vercel.production opportunities/stageParity:<name> '<args>'` and each `continueCursor` until done.

The health checks that stay after the phase, with `"reset":true`: `assertDealStages`, beside Phase 3's and Phase 4's.

## 11. Decisions

Accepted as recommended on 2026-10-21, with D4 and D5 replaced by D16 after Q2, and D9 extended by D18 after Q1.

- **D1. The stage list.** Five stages and a separate outcome, defined in `convex/opportunities/stages.ts`, where each stage says which outcomes it allows (open for the first four, won or lost for Closed) and screens show six positions (§4.1).
- **D2. The mapping's edge cases.** The ADR's table as a pure function of status and source (§4.2), with D16's change for canceled and no-show deals. The scheduled side deal is Call held. The 2,737 Booked deals whose call passed with nothing recorded stay Booked, since the meeting, not the deal, is where attendance is missing. The 59 lost deals with no reason stay lost with none.
- **D3. Meeting attendance.** Into the ADR's Phase 6 row (A3). Renaming `completed` to held, adding a recorded-at time and clearing `completedAt` on the 498 marked no-shows touches the meeting status everywhere it is read: the `meetingsByStatus` aggregate, the meeting buckets, the show-rate reports, the calendar, the lifecycle's Showed and most of the booking tests.
- **D4. Tasks.** No new task type. The reminders and links stay the rows the code writes; the reschedule link is the pending link task (A2). Q2's answer made a rebook task unnecessary: a missed meeting ends the deal, and the list in §6.5 is a view over those deals.
- **D5.** Replaced by D16.
- **D6. Stage times.** No new field. The deal keeps its times per fact (`qualifiedAt`, `firstBookedAt`, `paymentReceivedAt`, `lostAt`), and the events give every stage change with its time.
- **D7. Events.** From PR 8, `opportunity.stage_changed`, with the stages in `fromStatus` and `toStatus` and the outcomes in the metadata; losses keep `opportunity.marked_lost` (§4.7). Old events stay as they are, and every reader reads both. In PostHog the deal events arrive under the new name from PR 8.
- **D8. Each copy.** §4.8. `opportunityByStage` replaces `opportunityByStatus`; the qualification rows keep a copy for the Qualifications filter; the search row, meeting, meeting projection and legacy table copies are dropped.
- **D9. What closers and admins see.** The closer pipeline's tabs become All, Booked, Call held, Follow-up, Won and Lost (§6.2). Old `status=` links keep working. No admin pipeline page is built. The Slack digest's link keeps landing where it does.
- **D10. Report numbers.** §7: the screens that list statuses merge them into positions; Lost grows by the canceled and no-show deals; no other number changes from the fields. PR 2 changes which bookings start a new deal.
- **D11. Indexes.** The six stage indexes in §3.1 replace the nine status indexes; the meeting and qualification row status indexes go, and the qualification rows get one stage index.
- **D12. The data changes.** The backfill closes the 2,502 canceled and no-show deals as lost with their reason and time. No deal, meeting, payment, person or task is deleted. The clears unset the status and its copies on about 11,520 deals, 11,521 search rows, 6,866 meetings, 8,602 qualification rows and the legacy table's 5,761 rows; the 6,867 meeting projections are re-keyed, which deletes the emptied old buckets (3,896 rows) as their meetings move; the `opportunityByStatus` aggregate's entries are cleared and it is unmounted; three `tenantStats` fields are unset. No export. The dead code in §2.7 is deleted.
- **D13. The deal counters in `tenantStats`.** Dropped. Only unmounted components read them, `opportunityByStage` counts the same on demand, and the transition stops writing the one `tenantStats` document per tenant that every booking contends on. `totalOpportunities` stays.
- **D14. Production runs.** §9's order, dry run first for each backfill and clear, batch sizes from the dry runs, each run as soon as the previous assert passes, with no approval stop in between.
- **D15. Dev deployment.** No dev rehearsal; nothing is deleted on dev.
- **D16. A missed meeting ends the deal** (from Q2). §4.3. A no-show or cancellation closes the deal as lost with the reason `no_show` or `canceled`; a later booking is a new deal. The same deal goes on when Calendly moves an upcoming booking (its cancel says `rescheduled`, 113 of the latest 375 cancels), when the closer or an admin sends a reschedule link or sets a follow-up (Q3: closers do, and the code has it), or when Calendly withdraws a no-show. The 14-day reschedule join goes, which also removes a time-window join the ADR's rule 6 argues against.
- **D17. The No-shows and cancellations list** (from Q2). §6.5: a read-only Operations page over the deals a missed meeting closed, with contact details, who worked the deal and whether the person booked again, and a CSV export. It assigns nothing; what the team does with it is decided later.
- **D18. The closer calendar** (from Q1). §6.3: canceled meetings show, and each meeting's details show its deal's position.

### 11.1 Questions about how the team works

Answered by the tenant admin on 2026-10-21.

- **Q1. My Pipeline.** Closers don't use the Canceled and No Show tabs; they work from the dashboard calendar, which should show that information (D18).
- **Q2. After a no-show or a cancellation.** The person goes on a list that qualifiers and openers work outside the CRM; for now a page to view it and a CSV export, and what to do with it is decided later (D17). The deal is effectively dead, and a reschedule should be a new deal (D16).
- **Q3. Recording results.** Closers record payments and no-shows, send reschedule links from their own Calendly and set follow-up reminders, all already in the code; Fathom links and comments are optional. No "needs a result" view.
- **Q4. Lost reasons.** Stay optional: what matters is that the deal is lost.
- **Q5. Reports.** The reporting layer will be rebuilt with other services (Fivetran and ClickHouse), so the data should be as easy to query as possible. Nobody uses the Canceled or No Show filters or the export's status column.
- **Q6. Production runs.** Approved: the phase runs end to end.

### 11.2 Changes to ADR 0001 and `CONTEXT.md`

Approved with the decisions; PR 10 writes them.

- **A1. Stage list** (D1). "Each with an open, won, or lost category" becomes: each stage allows outcome open, except Closed, which allows won or lost.
- **A2. A missed meeting ends the deal** (D16). The Deal bullet's "A no-show or cancellation happens to a meeting. It creates a rebook task and moves the deal to Follow-up" becomes: a no-show or cancellation happens to a meeting and closes the deal as lost with that reason; the person goes to the outreach list, and a later booking is a new deal unless Calendly moved the same booking, the closer set a next step, or Calendly withdrew the no-show. The mapping table's `canceled` and `no_show` rows become Closed, lost; `reschedule_link_sent` keeps Follow-up with the reschedule link as its task. `CONTEXT.md`'s Task example "rebooking after a no-show" becomes "sending a reschedule link after a no-show".
- **A3. Phase 6's row.** Phase 5 drops the status indexes (the ADR's "Phase 5 frees the status indexes it drops" and the review's Phase 6 card say Phase 6 does) and the `tenantStats` deal counters (D13), so they leave Phase 6's row; the meeting's held status and recorded-at time (D3) and the dead `opportunities.canceledAt` and `noShowAt` join it.

The first plan's "tasks are dated" change isn't needed, since no rebook task is written.

## 12. Rollback

Fix forward, reviewed. Every repair is an internal migration with its own assert, run as §10.7 says, and the phase continues only after that assert and the assert of the step it repaired pass again.

- **PR 1.** Revert. The new fields and aggregate are read by nothing. The loss fields the backfill wrote on the 2,502 canceled and no-show deals would then show as a reason on those deals' sheets, so a reviewed repair unsets `lostReason` and `lostAt` on every deal whose status is `canceled` or `no_show`, which held none before (§2.1).
- **PR 2.** Revert: the 14-day join comes back and cancels flagged `rescheduled` move the deal again. The deals created in the meantime stay, each a real booking with its own credit; nothing needs repair.
- **PR 3.** Revert; the qualification row fields are read by nothing yet.
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
