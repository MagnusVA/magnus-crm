# Phase 3: attribution

Status: in progress, 2026-10-20. The tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`) accepted every recommendation in §11 on 2026-10-20 and delegated every production run in §9 to the agent.

Scope comes from §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) (findings F5 and F6, target rules 3 to 5 in §6) and the Phase 3 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md). Phase 2 is in [phase-2-person-first.md](phase-2-person-first.md).

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

Phase 3 gives credit one owner:

1. **`dealAttributions`**: one row per deal, role and team member, with its source and time; for the roles a booking credits, one per booking (D1). The roles are lead gen, setter, DM team, DM closer and closer. Each role has one source: the person's first capture, the Slack qualification, the booking's UTMs, and the closer the booking was assigned to. A rebook or a reassignment adds rows and never replaces one.
2. **First and latest touch** on the person, computed from the touch events in `domainEvents`, and a snapshot of both on each deal when it is created.
3. **Backfills** for every existing deal, meeting and person, each with an assert.
4. **Readers move to the rows**: Booked Calls and the Overview leaderboard, the sales calls list, the qualifications queue, the show-rate filters on the pipeline and team reports, the operations report export, billing, the meeting and deal detail payloads, and lead gen operations. Each is checked against the columns in production before it switches (§10.4).
5. **The narrow**: the copied `attributionTeamId` and `dmCloserId` columns, and their projection copies, leave the schema with their indexes.

It ships in seven code PRs after this plan (§9); the four reader PRs can merge in any order. Each is safe to deploy alone.

## 2. Production snapshot (2026-10-20)

Read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant.

### 2.1 Deals and meetings

| Table | Rows | Notes |
| --- | --- | --- |
| `opportunities` | 11,403 | 8,416 from Slack, 2,979 from Calendly, 8 side deals. 5,924 have meetings; 5,471 Slack deals never booked. |
| `meetings` | 6,798 | 5,924 first bookings (`callClassification: "new"`), 874 rebooks. None reassigned (`reassignedFromCloserId` unset on all; `meetingReassignments` is empty). |

Attribution resolution, as copied today:

| Resolution | Deals | Meetings |
| --- | --- | --- |
| mapped, team and DM closer | 4,246 | 4,793 |
| mapped, team only | 395 | 472 |
| unmapped | 55 | 60 |
| none (no UTMs) | 320 | 402 |
| never resolved | 6,387 | 1,071 |

- The deals that were never resolved are the 5,471 unbooked Slack deals, the 8 side deals, and 908 deals whose bookings were never resolved. Of the 1,071 unresolved meetings, 956 carry UTMs. Nothing resolves them later: the two re-resolution backfills in `convex/attribution/backfills.ts` have no caller, and editing a team or DM closer rewrites nothing.
- Every deal's copied team and DM closer equals its first external booking's (5,924 of 5,924), and every deal with a copy has a `firstMeetingId`. 38 deals have a `firstMeetingId` whose booking was never resolved.
- Every deal's `assignedCloserId` equals every one of its meetings'. A rebook with a different Calendly host rewrites all of the deal's meetings to the new host (`syncOpportunityMeetingsAssignedCloser`), so earlier hosts are not stored anywhere.

### 2.2 Rebooks

The 874 rebooks, against the latest earlier booking on the same deal that named a team or DM closer:

| Rebook | Meetings |
| --- | --- |
| same team and DM closer | 393 |
| different team | 178 |
| same team, different DM closer | 41 |
| names no one, after one that did | 48 |
| names someone, after none did | 16 |
| names no one, and none before did | 198 |

203 deals have bookings through more than one DM closer, and 177 through more than one team.

### 2.3 Team-only bookings

First bookings whose UTMs named a team and no DM closer, by booking month:

| Month | Team and DM closer | Team only | Neither |
| --- | --- | --- | --- |
| 2026-07 | 874 | 119 | 115 |
| 2026-08 | 893 | 34 | 70 |
| 2026-09 | 876 | 12 | 49 |
| 2026-10, to the 20th | 543 | 68 | 42 |

Booked Calls counts a booking toward a team's progress only when it also names a DM closer (`countBookedMeetings` in `dashboard/overviewLeaderboardBuilders.ts`), so the team-only bookings count nowhere today (D9).

### 2.4 Setters

- 8,510 `slackQualificationEvents`. On Slack deals: 8,258 `created_opportunity`, 151 `duplicate_pending`, 18 `already_booked`. On Calendly deals: 83 `already_booked` events, on 76 deals.
- Every Slack deal has `qualifiedBy`. 155 of them, from 2026-05, have no qualification event; their only record is `qualifiedBy` and the `opportunity.created` event, which carries the setter's team member.
- 108 deals were qualified by more than one setter (103 Slack deals, 5 Calendly deals).

### 2.5 Lead gen

- 6,101 deals belong to a person with a prospect, exactly one prospect each. On 1,967 of them, more than one worker submitted that prospect.
- On 1,289 of the 6,101 the first capture came after the deal was created. On 4,749 the capture is the person's first touch at the deal's creation (§4.3).

### 2.6 Touches

At each deal's creation, its person's first touch was a capture on 4,749 deals, a Slack qualification on 4,202, a Calendly booking on 2,450, a portal copy on 1 and a side deal on 1. Every deal has at least one touch by its creation, counting the `opportunity.created` event of the 155 early Slack deals. Persons are in §2.8.

### 2.7 Team members and the copies

- 74 team members. Every DM closer (25), lead gen worker (21), Slack user (16) and user (56) has one. One team member holds two DM closer records, so rows keep the DM closer record as well as the team member. 5 attribution teams.

| Copy | Rows | With a team | With a DM closer |
| --- | --- | --- | --- |
| `opportunities` | 11,403 | 4,641 | 4,246 |
| `meetings` | 6,798 | 5,265 | 4,793 |
| `operationsQualificationRows` | 8,510 | 2,963 | 2,948 |
| `operationsMeetingStatsV2` (in the bucket key) | 5,204 | 4,476 | 4,158 |
| `meetingProjections.contribution` | 6,798, all applied | 5,265 | 4,793 |
| `operationsMeetingDailyStats` (legacy, no writer) | 5,761 | 4,999 | 4,632 |

### 2.8 Persons

89,763 leads, 2 of them merged. Every one of the other 89,761 has at least one touch (§4.5):

| Channel | First touch | Latest touch |
| --- | --- | --- |
| lead gen | 83,575 | 81,111 |
| Slack | 4,028 | 4,242 |
| Calendly | 2,154 | 4,315 |
| DM portal | 3 | 87 |
| side deal | 1 | 6 |

87,607 first touches name a team member on their event. The other 2,154 are Calendly bookings, whose DM closer, if any, is on the booking's row.

## 3. Schema

### 3.1 `dealAttributions` (PR 1)

```ts
// convex/lib/attribution/dealAttributionValidators.ts
export const dealAttributionRoleValidator = v.union(
  v.literal("lead_gen"),
  v.literal("setter"),
  v.literal("dm_team"),
  v.literal("dm_closer"),
  v.literal("closer"),
);

export const dealAttributionSourceValidator = v.union(
  // lead gen: the capture that was the person's first touch
  v.object({
    kind: v.literal("capture"),
    prospectId: v.id("leadGenProspects"),
    workerId: v.id("leadGenWorkers"),
    eventId: v.id("domainEvents"),
  }),
  // setter: a qualification event, or `qualifiedBy` for the 155 deals that predate the events
  v.object({
    kind: v.literal("slack_qualification"),
    slackUserId: v.string(),
    qualificationEventId: v.optional(v.id("slackQualificationEvents")),
  }),
  // DM team and DM closer: the booking's UTMs
  v.object({
    kind: v.literal("booking_utm"),
    dmCloserId: v.optional(v.id("dmClosers")),
  }),
  // closer: the closer the booking was assigned to (the Calendly host)
  v.object({ kind: v.literal("booking_closer"), userId: v.id("users") }),
  // closer: a reassignment of a meeting or of the deal
  v.object({
    kind: v.literal("reassignment"),
    userId: v.id("users"),
    fromUserId: v.optional(v.id("users")),
  }),
  // closer: whoever a side deal names
  v.object({ kind: v.literal("side_deal"), userId: v.id("users") }),
);

dealAttributions: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  role: dealAttributionRoleValidator,
  // The human credited. Every role but dm_team.
  teamMemberId: v.optional(v.id("teamMembers")),
  // The team credited. dm_team only.
  teamId: v.optional(v.id("attributionTeams")),
  source: dealAttributionSourceValidator,
  // The booking or meeting the row came from, and its scheduled time.
  meetingId: v.optional(v.id("meetings")),
  meetingScheduledAt: v.optional(v.number()),
  // When the fact happened: the capture, the qualification, the booking
  // (the meeting's createdAt) or the reassignment.
  attributedAt: v.number(),
  createdAt: v.number(),
})
  .index("by_tenantId_and_opportunityId_and_role", ["tenantId", "opportunityId", "role"])
  .index("by_tenantId_and_meetingId", ["tenantId", "meetingId"])
  .index("by_tenantId_and_role_and_attributedAt", ["tenantId", "role", "attributedAt"])
  .index("by_tenantId_and_role_and_teamMemberId_and_meetingScheduledAt",
    ["tenantId", "role", "teamMemberId", "meetingScheduledAt"])
  .index("by_tenantId_and_role_and_teamId_and_meetingScheduledAt",
    ["tenantId", "role", "teamId", "meetingScheduledAt"]),
```

- The DM team is its own role, so team credit stands on its own (D3): a booking that names a team writes a `dm_team` row, and one that also names a DM closer writes a `dm_closer` row beside it.
- Booking rows key on the meeting (D1): each booking writes its own rows, so a rebook through the same DM closer adds a second `dm_closer` row with its own `meetingId`. Lead gen and setter rows are one per deal and team member.
- `meetingScheduledAt` is the meeting's `scheduledAt`, which no code changes after insert. The show-rate filters range over it (§6.4).
- No share or commission field (decision 2).

### 3.2 First and latest touch (PR 1)

```ts
// convex/lib/touches.ts
export const touchChannelValidator = v.union(
  v.literal("lead_gen"),
  v.literal("dm_portal"),
  v.literal("slack"),
  v.literal("calendly"),
  v.literal("side_deal"),
);
export const touchSnapshotValidator = v.object({
  eventId: v.id("domainEvents"),
  eventType: v.string(),
  channel: touchChannelValidator,
  occurredAt: v.number(),
});

// leads
firstTouch: v.optional(touchSnapshotValidator),
latestTouch: v.optional(touchSnapshotValidator),
// opportunities: the person's touches when the deal was created
firstTouch: v.optional(touchSnapshotValidator),
latestTouch: v.optional(touchSnapshotValidator),
```

- A snapshot names its event, not a team member. Who made the touch is the event's `teamMemberId`, which `mergeTeamMembers` keeps current; for a Calendly booking it is the booking's `dm_closer` row. So a team member merge never leaves a snapshot pointing at a deleted team member.
- The fields stay optional: a person is inserted before the event that touches them, in the same transaction. §10.5 counts any person left without one.

### 3.3 Fields that change in the narrow (PR 7)

| Table | Removed | Indexes removed |
| --- | --- | --- |
| `opportunities` | `attributionTeamId`, `dmCloserId`, `attributionResolution`, `attributionResolvedAt`, `attributionResolutionVersion` (D10) | `by_tenantId_and_attributionTeamId_and_qualifiedAt`, `by_tenantId_and_dmCloserId_and_qualifiedAt` |
| `meetings` | `attributionTeamId`, `dmCloserId` | `by_tenantId_and_attributionTeamId_and_scheduledAt`, `by_tenantId_and_dmCloserId_and_scheduledAt` |
| `operationsQualificationRows` | `attributionTeamId`, `dmCloserId`, `attributionResolution` | the four attribution indexes, and `attributionTeamId` and `dmCloserId` from the search index's filter fields |
| `operationsMeetingStatsV2`, `meetingProjections.contribution` (`meetingContribution`) | `attributionTeamId`, `dmCloserId`, and both from `bucketKey` | none |
| `operationsMeetingDailyStats` | `attributionTeamId`, `dmCloserId` | none |

Meetings keep `utmParams`, `attributionResolution`, `attributionResolvedAt`, `attributionResolutionVersion` and `utmTruncated`: they are the booking's own record of its UTMs and whether they matched the registry, not credit. A meeting whose resolution is `mapped` always has a `dm_team` row, and the assert checks it. Deals keep `utmParams` and `firstMeetingId`.

These `dmCloserId` columns stay, because each records who did something, not who gets credit for a deal:

| Table | Records |
| --- | --- |
| `dmCloserSchedules` | whose working hours these are |
| `leadNotes` | the DM closer who wrote the note (`authorKind: "dm_closer"`) |
| `linkPortalLeadEdits` | the DM closer who edited the person |
| `linkPortalCopyEvents` | the DM closer who copied the link, and in `attributionTeamId` the team whose link it was |

`leadMergeHistory` has no `dmCloserId`.

## 4. Rules

### 4.1 Rows a booking writes

Every meeting insert in `pipeline/inviteeCreated.ts` (the UTM relink, the reschedule, and the Slack join, follow-up and new deal paths) calls `recordBookingAttribution` right after the insert, with the booking's resolved UTMs:

- `dm_team`: when the UTMs resolve to a team. `teamId` is the team.
- `dm_closer`: when they resolve to a DM closer. `teamMemberId` is the DM closer's team member, and the source keeps the DM closer record.
- `closer`: always, for the closer the booking was assigned to, with source `booking_closer`.

Each row has the meeting's `meetingId` and `meetingScheduledAt`, and `attributedAt` equal to the meeting's `createdAt`. An internal (`ptdom`), unmapped or UTM-less booking writes only its `closer` row. When the pipeline moves a deal's meetings to a new host, the working owner changes and the earlier meetings' `closer` rows stay.

### 4.2 Rows a deal writes when it is created

`recordDealCreation` runs once per deal, after the event that creates it: after `opportunity.created` for a Slack deal and a side deal, and after `meeting.created` for a new Calendly deal. It:

1. snapshots the person's `firstTouch` and `latestTouch` onto the deal (§4.5);
2. writes a `lead_gen` row when that first touch is a capture (§4.3);
3. writes a `setter` row for a Slack deal, from its qualification event;
4. writes a `closer` row for a side deal, for the closer it names, with source `side_deal`.

### 4.3 Lead gen

The lead gen row credits the worker of the person's first touch, when that touch is a capture (D4). The source is the capture event, its prospect and its worker; `attributedAt` is the capture time. One row at most: other workers who submitted the same handle later get none. A worker who captures someone Slack or Calendly reached first gets no deal credit, as Phase 2 D3 and D6 decided for the person.

### 4.4 Setters

A qualification that creates the deal or joins it while it waits for a booking (`created_opportunity`, `duplicate_pending`) writes a `setter` row for its setter, unless that setter already has one on the deal (D5). `insertQualificationEvent` in `slack/createQualifiedLead.ts` calls `recordSetterAttribution` for both. An `already_booked` qualification stays a touch: the person had booked before it. The deal page lists every `setter` row; the earliest is the one in `qualifiedBy`. Its Slack section keeps showing the newest qualification event, as today.

### 4.5 First and latest touch

A touch, for first and latest touch, is one of these events (D7):

| Event | Channel |
| --- | --- |
| `lead.captured` | lead gen |
| `lead.portal_note_added`, `lead.portal_profile_updated`, `lead.portal_link_copied` | DM portal |
| `lead.slack_qualified` | Slack |
| `opportunity.created` with `metadata.source` `slack_qualified` | Slack |
| `meeting.created` | Calendly |
| `opportunity.created` with `metadata.source` `side_deal` | side deal |

No-shows, cancellations, outcomes, payments, follow-ups and stage or status changes stay on the timeline but are not touches here: they happen to a person the team already has.

- `emitDomainEvent` calls `recordPersonTouch` after it inserts an event of one of these types with a `leadId`. It sets `firstTouch` when the person has none, or when the event is earlier than the stored one (a webhook processed late), so first touch is always the earliest touch; a new touch is later and never replaces it. It sets `latestTouch` when the event is at or after the stored one. It never touches `updatedAt`, so the search projection doesn't change.
- A merge gives the surviving person the earlier first touch and the later latest touch of the two (`mergeLeadLifecycle` does the same for stages).
- A deal copies the person's two touches at creation (§4.2) and never changes them.

### 4.6 Reassignment

A reassignment adds a `closer` row with source `reassignment` and never removes one:

- `unavailability/redistribution.ts`: `autoDistributeMeetings` and `manuallyResolveMeeting`, for the reassigned meeting, with `fromUserId`.
- `closer/reminderOutcomes.ts:logReminderPayment`, when it changes the deal's `assignedCloserId`, with no meeting.

### 4.7 Credit and the working owner

`assignedCloserId` stays on deals and meetings as the working owner: the closer dashboards, the pipeline, the closer indexes and `paymentRecords.attributedCloserId` read it, and the closer reports keep reading it (D6). Closer credit is the `closer` rows, which the detail payloads show.

### 4.8 Merges

- `mergeLead` moves deals with their IDs (`moveOpportunityToLead`), so their rows move with them and need no write. It combines first and latest touch (§4.5).
- `moveMeetingToOpportunity` moves the meeting's rows to the new deal.
- `mergeTeamMembers` repoints `dealAttributions.teamMemberId`, role by role, in pages, as it does events.

## 5. Write paths

| Event | Where | Change |
| --- | --- | --- |
| Calendly booking, every path | `pipeline/inviteeCreated.ts` (three meeting inserts) | `recordBookingAttribution` (§4.1) |
| New Calendly deal | `pipeline/inviteeCreated.ts`, new deal branch | `recordDealCreation` after `meeting.created` |
| Slack deal | `slack/createQualifiedLead.ts` | `recordDealCreation` after `opportunity.created` |
| Slack qualification joins a deal | `slack/createQualifiedLead.ts:insertQualificationEvent` | `recordSetterAttribution` for `duplicate_pending` |
| Side deal | `opportunities/createManual.ts` | `recordDealCreation` after `opportunity.created` |
| Reassignment | `unavailability/redistribution.ts` (two sites), `closer/reminderOutcomes.ts` | `closer` row (§4.6) |
| Any touch event | `lib/domainEvents.ts:emitDomainEvent` | `recordPersonTouch` (§4.5) |
| Person merge | `leads/merge.ts` | combine touches |
| Meeting moved to a deal | `leads/repointLeadReferences.ts:moveMeetingToOpportunity` | move its rows |
| Team member merge | `lib/teamMembers.ts:mergeTeamMembers` | repoint rows |
| Empty side deal deleted | `sideDeals/deleteEmptyOpportunity.ts` | delete its rows with it |
| Old opportunity cleanup | `admin/migrations.ts` (the one-off that deletes a deal and its meetings) | delete their rows with them |

Until PR 6 the pipeline keeps writing the copied columns beside the rows, so the readers that haven't moved stay right.

## 6. Readers (PRs 2 to 5)

### 6.1 Booked Calls and the Overview leaderboard

`buildDmCloserEfficiencyRows` keeps its one bounded meetings read by `createdAt`, for the first-booking population, and adds two range reads on `by_tenantId_and_role_and_attributedAt` (`dm_closer` and `dm_team`) over the same window, joined by `meetingId`. A DM closer's count is the first bookings with a `dm_closer` row for that DM closer record; a team's progress is the first bookings with a `dm_team` row for that team (D9). `listBookedCallsDetails`, `searchBookedCallsDetails` (rows by deal, not by meeting) and the operations report's `readBookedMeetings` read the same rows.

### 6.2 Qualifications

`operationsQualificationRows` stops copying attribution. `enrichQualificationRows` reads the deal's first booking (`firstMeetingId`): its `dm_team` and `dm_closer` rows for the labels and its `attributionResolution` for the badge, which is what the copy held. The unused team and DM closer branches of `qualificationRowsQuery` and `searchQualificationQueue`, and of `scheduling.ts:listSchedulingQueue` (no caller), are removed with their indexes.

### 6.3 Sales calls

`phoneSales.enrichPhoneSalesRows` labels each meeting from its own rows. The unused team and DM closer branches of `listPhoneSalesMeetings` are removed with their indexes.

### 6.4 Show-rate filters

`reporting/pipelineHealth.getSchedulingShowRateByOperationsDimensions` and `reporting/teamPerformance.getTeamOperationsDimensions` keep their bucket read when no team or DM closer is chosen. With one chosen, they read the matching rows on `by_tenantId_and_role_and_teamId_and_meetingScheduledAt` or `by_tenantId_and_role_and_teamMemberId_and_meetingScheduledAt` over the range (filtering a DM closer's rows to that record), and each row's `meetingProjections` row for its status, closer and program. They keep the 8,192 cap and `truncated`. The meeting stats bucket key drops team and DM closer, and `rebuildMeetingProjections` re-keys every meeting (§10.6).

### 6.5 Detail payloads and billing

- `lib/attribution/detailPayload.ts` and `closer/meetingDetail.ts`: a meeting shows its own booking's rows, a deal its first booking's. The deal payload adds every row with its role, team member, source and time, and the first and latest touch. The attribution card lists them.
- `billing/enrichment.ts` labels a payment from its meeting's rows, else its deal's first booking's. `billing/audit.ts:hasAttributionContext` checks for rows.
- `operations/unmappedUtms.ts` keeps reading the meeting's resolution.

### 6.6 Lead gen operations

Lead gen operations reads no copied DM column. Its worker credit is the prospect's first capture, which is the lead gen role's source. The conversion report keeps its person counts from `prospectConversions`, since it counts people at Prospect and In conversation, who have no deals and so no rows, and gains a Deals column: the deals with a `lead_gen` row for the worker whose capture falls in the range, read from `by_tenantId_and_role_and_attributedAt` (D8).

### 6.7 Removed

`convex/attribution/backfills.ts` (`backfillMeetingAttribution`, `backfillOpportunityAttribution`, `verifyAttributionBackfill`): manual re-resolution jobs with no caller, which write the copies. Attribution is resolved once.

## 7. Report numbers

| Report | Change when it moves to the rows |
| --- | --- |
| Booked Calls, DM closer counts and total | none |
| Booked Calls, team progress and goal | rises by the team-only first bookings in the range (§2.3), if D9 is accepted; otherwise none |
| Overview Top DM Closers | none |
| Sales calls labels | none |
| Show-rate with a team or DM closer filter | none |
| Qualifications queue labels and badge | none |
| Operations report export | team progress as Booked Calls; the rest none |
| Meeting and deal detail, billing | none for DM team and DM closer; the deal adds its other roles and touches |
| Lead gen conversion | none; a Deals column is added |

§10.4 proves each "none" in production before the reader PRs deploy.

## 8. What else moves

- `lib/operations-reports/dashboard-parity.test.ts` gives two meetings on one deal the same DM closer and only one a team, which the resolver can't produce (a DM closer always brings its team). The fixture gets real rows.
- `migrations.ts:assertMeetingProjections` rebuilds the bucket key without team and DM closer.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 0 | This plan | docs |
| 1 | Widen: the touch fields (§3.2) and `dealAttributions` (§3.1); `recordPersonTouch`, the deal snapshot and every write path in §5; the backfills and asserts in §10.1 to §10.3; the parity checks in §10.4 | optional fields and a new table, written beside the columns; every reader still reads the columns |
| 2 | Booked Calls, the Overview leaderboard, the details list and search, and the operations report's booked rows (§6.1) | each runs after the PR 1 backfills and asserts pass and the parity checks agree in production; the copies are still written, so a revert is safe |
| 3 | Qualifications, sales calls, the detail payloads, billing and the attribution card (§6.2, §6.3, §6.5); `attribution/backfills.ts` removed | as PR 2 |
| 4 | The show-rate filters and the bucket key without attribution (§6.4, §10.6) | as PR 2 |
| 5 | Lead gen operations' Deals column (§6.6) | reads only |
| 6 | The pipeline and projections stop writing the copies; `operationsQualificationRows.attributionResolution` becomes optional; `clearAttributionCopies` and its assert | no reader reads the copies after PRs 2 to 5 |
| 7 | Narrow (§3.3), the ADR status, the review's Phase 3 card, this plan's status | after the clear and its assert pass in production |

Production runs, in this order (§10.7 has the commands):

1. After PR 1: `backfillPersonTouches` dry run, run, `assertPersonTouches`; `backfillDealTouches` dry run, run, `assertDealTouches`; `backfillBookingAttributions` dry run, run, `assertBookingAttributions`; `backfillDealAttributions` dry run, run, `assertDealAttributions`; `assertQualificationAttributionParity`; the read-only parity queries (§10.4).
2. After PR 4: `rebuildMeetingProjections` (reset), then `assertMeetingProjections`, `assertMeetingProjectionBuckets` and `assertMeetingProjectionSources`; the parity queries again.
3. After PRs 2 to 5: a read-only recheck.
4. After PR 6: `clearAttributionCopies` dry run, run, `assertAttributionCopiesCleared`; `assertBookingAttributions` (reset) against the resolution status.
5. After PR 7: the schema push checks that no row carries a removed field; `assertDealAttributions` (reset) once more.

## 10. Backfill and assert migrations

All are `migrations.define` in `convex/migrations.ts`. None emits events, moves a stage or changes a counter. Batch sizes are a first guess; each dry run sets the real one, and a "too many system operations" failure resumes at a smaller batch from the cursor.

### 10.1 `backfillPersonTouches` / `assertPersonTouches` (PR 1)

Over `leads`, batch 100, skipping merged leads. For each person, the earliest and latest touch event (§4.5) on `by_tenantId_and_leadId_and_occurredAt`, across the person and every lead merged into them (`leadMergeHistory.by_targetLeadId`, as the timeline walks it). Sets `firstTouch` and `latestTouch`; a live touch that arrived first is kept if it is newer. The assert recomputes both and checks they match.

Expected: 89,761 persons with both touches (§2.8), plus the persons created in between. About 900 batches.

### 10.2 `backfillDealTouches` / `assertDealTouches` (PR 1)

Over `opportunities`, batch 100. The snapshot is the person's earliest and latest touch at or before the deal's `createdAt`, plus the event that created the deal: its `opportunity.created`, or for a Calendly deal or side deal its earliest meeting's `meeting.created`. Expected: all 11,403 deals get both.

### 10.3 `backfillBookingAttributions` / `backfillDealAttributions` and their asserts (PR 1)

`backfillBookingAttributions`, over `meetings`, batch 100: the rows of §4.1 from each meeting's copied team and DM closer and its `assignedCloserId`, with `attributedAt` its `createdAt`. A meeting that already has its rows is skipped. The 1,071 meetings that were never resolved get only their `closer` row (D11). Expected: 5,265 `dm_team`, 4,793 `dm_closer`, 6,798 `closer`.

`backfillDealAttributions`, over `opportunities`, batch 100: the lead gen, setter and side deal rows of §4.2 to §4.4, using the deal's touch snapshot from §10.2. Expected: 4,749 `lead_gen`, 8,508 `setter` (156 of them from `qualifiedBy`; 90 deals with more than one), 8 side deal `closer`.

`assertBookingAttributions` checks, for each meeting, one `dm_team` row exactly when the copy has a team and for that team, one `dm_closer` row exactly when it has a DM closer and for that record and its team member, and one `booking_closer` row. After PR 6 clears the copies, it checks the rows against the meeting's resolution instead: `mapped` has a `dm_team` row, and anything else has none. `assertDealAttributions` recomputes the deal rows and checks them, and that no row's team member or team belongs to another tenant.

Total about 30,100 rows.

### 10.4 Parity (PR 1, run before the reader PRs deploy)

`assertQualificationAttributionParity`, over `operationsQualificationRows`: the team and DM closer from the deal's first booking's rows equal the row's copy, for all 8,510.

`attribution/parity.ts:compareReaders`, an internal query that computes each report both ways and returns the differences:

- Booked Calls for each month from 2026-05 and the last 7 days: DM closer counts, the total, and team progress both with and without the team-only bookings;
- the two show-rate reports for each team and each DM closer, for each month;
- the operations report's booked rows for one month.

Every "none" in §7 must come back with no difference. The results go into §13.

### 10.5 `clearAttributionCopies` / `assertAttributionCopiesCleared` (PR 6)

Over `opportunities`, `meetings`, `operationsQualificationRows` and `operationsMeetingDailyStats`, batch 200: unset the fields in §3.3. Expected: 11,403, 6,798, 8,510 and 5,761 rows, with values on 4,641 deals, 5,265 meetings, 2,963 qualification rows and 4,999 daily stats rows. The assert checks none is left. `operationsMeetingStatsV2` and `meetingProjections` are cleared by the rebuild in §10.6.

### 10.6 `rebuildMeetingProjections` (PR 4)

The existing migration, run with `reset`: it re-queues every meeting (6,798), and each projection moves its count to the bucket without team and DM closer. Old buckets reach zero and are deleted. Then the three existing projection asserts.

### 10.7 Commands

Every run uses `--env-file .env.vercel.production`. Poll `npx convex run --component migrations lib:getStatus '{"names":["migrations:<name>"]}'` until `isDone`. Filter dry-run output with `grep -E '"processed"|"DryRun"|error'`.

```
npx convex run migrations:run '{"fn":"migrations:backfillPersonTouches","dryRun":true}'
npx convex run migrations:run '{"fn":"migrations:backfillPersonTouches"}'
npx convex run migrations:run '{"fn":"migrations:assertPersonTouches"}'
```

and the same for each migration in §9's order.

## 11. Decisions

Each has a recommendation. The tenant admin accepted all thirteen on 2026-10-20; the phase runs to the end on them.

- **D1. Row grain for the booking roles.** Recommended: DM team, DM closer and closer rows are one per booking, keyed by the meeting; lead gen and setter rows are one per deal and team member. Booked Calls, the sales calls list and the show-rate filters credit each meeting by its own booking, and 393 rebooks repeat the DM closer of an earlier booking. The other option, one row per deal, role and team member, leaves those 393 meetings with no row of their own, so the show-rate filters and meeting labels lose them.
- **D2. A rebook through a different DM closer.** Recommended: it adds a second DM closer row on the deal, with its meeting (203 deals have one). Each Booked Calls row is a first booking and credits that booking's DM closer, as today. Deal-level views (the qualifications queue, the deal page's DM fields) credit the deal's first external booking, as today; the deal page also lists every row.
- **D3. Team-only credit.** Recommended: a `dm_team` role whose subject is the team (`teamId`, no team member). Every row then names exactly one subject, and team reports read one role. The other option puts the team on the DM closer row and leaves its team member empty for team-only bookings, which makes "DM closer" rows with no DM closer.
- **D4. Which lead gen worker gets credit.** Recommended: the worker whose capture is the person's first touch at the deal's creation, one row (4,749 deals). Other workers who submitted the same handle get none (1,967 deals' prospects had more than one). The other options credit the prospect's first worker whenever the capture came before the deal (4,812 deals, 63 more, where Slack, Calendly or the portal reached the person first), or every worker who captured the person before the deal.
- **D5. Which setters get credit.** Recommended: one row per setter whose qualification created the deal or joined it while it waited for a booking (8,508 rows; 90 deals with two or more). `already_booked` qualifications (101, 83 of them on Calendly deals) stay touches. The other option credits only the setter in `qualifiedBy`, one per Slack deal.
- **D6. `assignedCloserId`.** Recommended: it stays as the working owner, separate from credit; closer dashboards and reports keep reading it, and closer credit lives in rows that a host change or a reassignment adds to and never rewrites. Closer rows backfill from the closer each meeting carries today, because the pipeline already rewrote earlier hosts. Moving the closer reports to rows would change every closer number for the 0 meetings reassigned so far and for any future reassignment, and nothing asks for it yet.
- **D7. What first and latest touch store.** Recommended: the event, its type, its channel and its time (§3.2); the touch events in §4.5, not outcomes; first touch set once (a merge takes the earlier), latest on every touch. Every existing deal gets a snapshot from the touches at or before its creation plus its creating event; all 11,403 have one, the 155 early Slack deals through their `opportunity.created`. The other option snapshots only deals created after PR 1, which leaves every existing deal without one.
- **D8. Lead gen operations.** Recommended: the conversion report keeps counting people from the prospect's first capture, and gains a Deals column read from the `lead_gen` rows (§6.6). The other option keeps it as it is and changes the ADR's Phase 3 row to say lead gen operations reads the prospect, not the rows.
- **D9. Team-only bookings in Booked Calls.** Recommended: count them toward their team's progress and the goal, since team credit stands on its own; the DM closer table and its total stay DM-closer bookings. Team progress rises by 68 for 2026-10-01 to 2026-10-20, 12 for September, 34 for August and 119 for July. The other option keeps today's numbers exactly, and team-only bookings stay uncounted.
- **D10. The deal's copy of the resolution status.** Recommended: remove `attributionResolution`, `attributionResolvedAt` and `attributionResolutionVersion` from deals and qualification rows too; they copy the first booking's, which the meeting keeps. The other option keeps them on deals, a seventh copy with no team or DM closer beside it.
- **D11. The 1,071 meetings that were never resolved.** Recommended: rows mirror today's copies, so they get no DM rows and their numbers don't change. Resolving their 956 sets of UTMs against today's registry would credit bookings from before the registry matched them, which "attribution is resolved once" rules out.
- **D12. The narrow's deletions.** Recommended: clear the values in §3.3 on 11,403 deals, 6,798 meetings, 8,510 qualification rows and 5,761 daily stats rows, re-key the 6,798 meeting projections and their buckets, then drop the fields and the eight indexes. The four actor `dmCloserId` columns in §3.3 stay. `convex/attribution/backfills.ts` is deleted. No row is deleted except meeting stats buckets whose count reaches zero in the rebuild, as any projection change does. The legacy `operationsMeetingDailyStats` table keeps its rows; its removal goes into Phase 6's row in the ADR.
- **D13. Production runs.** Recommended: the order in §9, one migration at a time, dry run first for each backfill and the clear, batch sizes from the dry runs (first guesses in §10), each run as soon as the previous assert passes, with no approval stop in between. `assertLeadLifecycle` is not run: nothing in this phase moves a stage.

## 12. Rollback

Fix forward, reviewed. No snapshot is held; nothing in this phase deletes a source record.

- **PR 1.** Revert. The fields and rows are new and nothing reads them yet; a wrong row or touch is fixed by an internal repair mutation that deletes and rewrites one deal's or person's values, in a reviewed PR.
- **PRs 2 to 5.** Revert: the readers go back to the copies, which PR 6 hasn't stopped writing. Reverting PR 4 puts the bucket key back, and `rebuildMeetingProjections` re-keys again.
- **PR 6.** Before the clear runs, revert. After it, the copies are rebuilt from the rows by a reviewed repair migration: each meeting's `dm_team` and `dm_closer` rows, each deal's first booking's.
- **PR 7.** Revert makes the fields optional again; the values come back through the same repair.

## 13. Production log

All runs on tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, times in UTC, with `--env-file .env.vercel.production`.

### 13.1 Baseline, 2026-10-20

§2.

### 13.2 Deploys

| PR | Deployed |
| --- | --- |

### 13.3 Runs

| When | Run | Result |
| --- | --- | --- |
