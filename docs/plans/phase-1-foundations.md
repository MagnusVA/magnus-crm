# Phase 1: foundations

Status: done, 2026-10-17. Every PR (#112 to #118) is merged and deployed, every backfill and assert ran clean in production, and the leads report counts people reaching Qualified (§12).

Scope comes from §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) and the Phase 1 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md). Phase 0 history is in the [polluted lead split plan](polluted-lead-split.md).

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

Phase 1 adds four things, all additive:

1. A lifecycle stage on each person (`leads`), with an entry time for every stage, and a disposition.
2. Lead counts keyed to a stage entry instead of `leads` row creation, before Phase 2 makes every lead gen capture a person.
3. A `teamMembers` table, one row per human, linked from the user, lead gen worker, Slack user and DM closer records.
4. `leadId` and `teamMemberId` on `domainEvents`, so the event log can be the person timeline.

It ships in five PRs (§8). Each is safe to deploy alone: the schema only widens, write paths skip rows the backfill hasn't reached, and the report switches only after the asserts pass.

## 2. Production snapshot (2026-10-17)

Read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant.

| Table | Rows | Notes |
| --- | --- | --- |
| `leads` | 10,489 | 10,224 active, 263 converted, 2 merged. None split-locked. |
| `opportunities` | 11,115 | 8,205 Slack, 2,902 Calendly, 8 side deals. 4,073 lost as `stale`. |
| `meetings` | 6,654 | 2,722 scheduled (2,689 of them in the past), 2,777 canceled, 664 completed, 491 no-show |
| `paymentRecords` | 268 | all `recorded`, all on a deal |
| `customers` | 263 | all `active`, one per converted lead |
| `slackQualificationEvents` | 8,271 | |
| `leadGenAuditMatches` | 4,243 | all `accepted`, one prospect per lead |
| `domainEvents` | 37,912 | oldest from 2026-04-19 |
| `users` | 55 | 19 closers, 20 lead generators, 13 admins, 1 owner, 2 deleted |
| `leadGenWorkers` | 21 | every one has a `userId`; one points at a missing user |
| `slackUsers` | 16 | none has `crmUserId` |
| `dmClosers` | 25 | 6 linked to a user; 24 distinct names across 4 teams |

`tenantStats.totalLeads` is 10,224, the active lead count. Nothing outside tests reads it or `totalCustomers`. The only live "new leads" number is the `leadTimeline` count on the Leads & Conversions report.

Every lead has at least one deal, except the 2 merged ones. So every person today came in through Slack, Calendly or a side deal, and none is at Prospect or In conversation yet.

## 3. Schema (PR 1)

All new fields are optional. The write paths (PR 2) and the asserts (PR 3) read them, and no report or screen does until PR 4.

### `leads`

```ts
lifecycleStage: v.optional(lifecycleStageValidator),
// First time the person reached each stage or a later one (§4.1).
lifecycleStageEnteredAt: v.optional(v.object({
  prospect: v.optional(v.number()),
  in_conversation: v.optional(v.number()),
  qualified: v.optional(v.number()),
  booked: v.optional(v.number()),
  showed: v.optional(v.number()),
  customer: v.optional(v.number()),
})),
disposition: v.optional(dispositionValidator),
dispositionSetAt: v.optional(v.number()),
dispositionSource: v.optional(v.union(v.literal("system"), v.literal("admin"))),
dispositionReason: v.optional(v.string()),
```

- `lifecycleStageValidator`: `prospect`, `in_conversation`, `qualified`, `booked`, `showed`, `customer`.
- `dispositionValidator`: `open`, `nurture`, `not_a_fit`, `unresponsive`, `do_not_contact`.
- Both lists live once, in `convex/leads/lifecycle.ts`, with the stage order.
- `status` keeps `merged` and `converted`. `merged` stays the identity flag. `converted` stays until Phase 4. Once a lead has a stage, it is `converted` exactly when the stage is `customer`; a lead the backfill hasn't reached has no stage yet.
- No index on `leads`. Counts come from an aggregate (§7), and lists from `leadCustomerSearchRows`.
- These fields don't touch `splitLockedAt`, so the split's Deploy 3 narrow can remove that field independently.

### `teamMembers` (new)

```ts
teamMembers: defineTable({
  tenantId: v.id("tenants"),
  displayName: v.string(),
  createdAt: v.number(),
  updatedAt: v.number(),
}).index("by_tenantId", ["tenantId"]),
```

Each role table gets `teamMemberId: v.optional(v.id("teamMembers"))` and an index `by_tenantId_and_teamMemberId`: `users`, `leadGenWorkers`, `slackUsers` and `dmClosers`. The link points from the role record to the team member, because one human can hold several records of one kind. Production has a name on two DM teams. The role tables keep their settings.

### `domainEvents`

```ts
leadId: v.optional(v.id("leads")),
teamMemberId: v.optional(v.id("teamMembers")),
```

with indexes `by_tenantId_and_leadId_and_occurredAt` and `by_tenantId_and_teamMemberId_and_occurredAt`.

### `leadCustomerSearchRows`

`lifecycle` gains `prospect`, for a person below Qualified. Prospect rows are stored with `isSearchVisible: false`, so the default list and search leave them out with no query change (§7.3).

### Aggregate

A new `DirectAggregate` named `leadStageEntries`, mounted in `convex/convex.config.ts`:

- namespace: `tenantId`
- key: `[stage, enteredAt]`
- id: `` `${leadId}:${stage}` ``

It holds one entry per person and stage reached. Counting the persons who reached a stage in a range is one bounded `count`. Merged persons have no entries.

## 4. Lifecycle rules

### 4.1 Entry times

The entry time of a stage is the first time the person reached that stage or a later one. A person who books straight from a DM link skips Qualified, so their Qualified time is their booking time. That keeps the funnel monotone: everyone counted at Booked in a month was also Qualified by then.

Entry times only ever come from the event that moved the person:

| Stage | Evidence, earliest wins |
| --- | --- |
| Prospect | `leadGenProspects.firstCapturedAt` of an accepted `leadGenAuditMatches` row |
| In conversation | none today; Phase 2 adds DM portal activity |
| Qualified | `slackQualificationEvents.submittedAt`; a Slack deal's `qualifiedAt` or `qualifiedBy.submittedAt` |
| Booked | `meetings.createdAt` of any meeting, whatever its status. It is the Calendly envelope's `created_at`. |
| Showed | a `completed` meeting's `scheduledAt`, capped at its `completedAt`; a side deal's `createdAt` |
| Customer | the `recordedAt` of a payment that isn't `disputed`, or `customers.convertedAt` |

`leads._creationTime` and `firstSeenAt` are never used, so a time the split, a merge or the placeholder cleanup wrote can't leak in. The split moved meetings, Slack events and audit matches to the right person, and preserved their `createdAt` and `submittedAt`.

Gaps in the evidence:

- `completed` means a closer recorded an outcome, which the ADR maps to held. Payment, lost, follow-up and reminder outcomes all set it. A no-show never does.
- 2,689 past meetings are still `scheduled` because nobody recorded an outcome. Those persons stay at Booked.
- Opportunity `firstBookedAt` holds the slot time, not the booking time, so the rules don't use it.

### 4.2 Moving forward

`advanceLifecycleStage(ctx, leadId, { stage, at })` is the one write path:

- The stage becomes the higher of the current and the new one.
- Each entry time at or below the new stage becomes the earlier of the stored value and `at`. A late-processed booking can move an entry time earlier.
- It writes the `leadStageEntries` entries that changed.
- When the stage changes, it emits `lead.lifecycle_stage_changed` with source `system`, `fromStatus`, `toStatus` and the cause as `reason`, and rebuilds the lead/customer row if its `lifecycle` changed. The record that caused it has its own event with the actor.
- Evidence at Qualified or later that is newer than a system-set `unresponsive` sets the disposition back to `open` (D3).
- A lead with no `lifecycleStage` hasn't been backfilled yet. The call does nothing, because the backfill derives the whole history from source data and will include this event.
- A merged lead never advances.

### 4.3 Moving back

The stage never moves back on its own. Three things move it back, and each one is a correction:

- **An admin, with a reason** (D4, `leads/lifecycleAdmin:moveLifecycleStageBack`). The entry times above the new stage are cleared and their aggregate entries deleted. The domain event keeps the old values, and `lifecycleStageMovedBackAt` tells the assert the stage no longer follows the records. A person with a customer record can't be moved back this way; voiding the payment moves both.
- **Voiding a side-deal payment.** It already deletes the customer and returns the lead to `active` (`rollbackCustomerConversionIfEmpty`). The stage is derived again from what is left, and the event records reason `payment_voided`.
- **A split or split rollback.** The split refresh chain derives the stage again for each lead it touched, and gives a lead it created its first stage. The split ran once; this only matters if a rollback runs before Deploy 3 removes the code.

A lost deal, an expired Slack deal, a no-show or a cancellation never moves the stage.

### 4.4 Merge

`executeMerge` combines the two people: the target takes the higher stage and, for each stage, the earlier entry time. The source keeps its frozen values and loses its aggregate entries. This gives the same result as deriving the target again, because the merge moves the source's deals, Slack events and audit matches.

### 4.5 Disposition

Every person starts at `open`. An admin sets any value with a reason (D4, `leads/lifecycleAdmin:setDisposition`). An expired Slack deal sets `unresponsive` when the person has no other open deal and is still `open` (D3). Only the system changes a system-set value, and an admin-set value never changes on its own.

## 5. Write paths (PR 2)

| Event | Where | Stage, time |
| --- | --- | --- |
| Lead created | `resolveLeadIdentity` (`leads/identityResolution.ts:471`) takes the caller's initial stage and time | as below |
| Slack qualification, new or existing lead, any result kind | `slack/createQualifiedLead.ts` | Qualified, `qualifiedBy.submittedAt` |
| Calendly booking | the three meeting inserts in `pipeline/inviteeCreated.ts` (968, 1308, 1624) | Booked, the meeting's `createdAt` |
| Side deal | `opportunities/createManual.ts:208` | Showed, the deal's `createdAt` |
| Meeting held | `completeMeetingForOutcome` (`lib/meetingOutcomeCompletion.ts:40`), only for `completed` | Showed, `min(scheduledAt, completedAt)` |
| Payment or conversion | `executeConversion` (`customers/conversion.ts:25`) and the five payment inserts | Customer, the payment's `recordedAt` |
| Merge | `executeMerge` (`leads/merge.ts`) | §4.4 |
| Side-deal payment voided | `sideDeals/voidPayment.ts` | derive again (§4.3) |
| Split refresh chain | `leadSplit/apply.ts`, `leadSplit/rollback.ts` | derive again |
| Slack deal expired | `slack/staleExpiry.ts:59` | disposition only, per D3 |

`completeMeetingForOutcome` covers every closer and admin outcome, so Showed has one hook. The payment hook goes in a shared helper beside `executeConversion`, because a second-program payment on a converted lead skips conversion.

`tenantStats.totalLeads` becomes stage-aware: it goes up when a person first reaches Qualified, not when the row is inserted. Every lead created today starts at Qualified or later, so the count doesn't change until Phase 2.

## 6. Team members and domain events (PR 2)

### 6.1 Team members

`convex/lib/teamMembers.ts` creates or finds the team member when a role record is written (#115):

- `users`: every user mutation creates one if missing, through the step they all share before the lead gen worker sync. Onboarding does the same. A user moved to another tenant at onboarding gets a new one.
- `leadGenWorkers`: always the user's. A worker whose user is gone keeps its own.
- `slackUsers`: its own, created on its first qualification or its next one, or the CRM user's if `crmUserId` is ever set. Its name updates when the Slack profile arrives.
- `dmClosers`: `createDmCloser` uses the linked user's team member, or creates one. `updateDmCloser` relinking `userId` moves the DM closer to the user's team member, and unlinking gives it a new one.

A role record without `teamMemberId` hasn't been reached yet, and code that needs one treats it as unknown.

Name matches are joined only after the tenant admin approves them (D5). `teamMembers/linking:nameLinkCandidates` lists them by team member and record ID, and `teamMembers/linking:applyApprovedLinks` joins the approved pairs: it moves the role records and the events of one team member to the other, then deletes the first.

### 6.2 Domain events

`emitDomainEvent` derives both fields itself, so none of its 80-odd callers change. A caller can pass either field to override the derived value.

- `leadId`:
  - a lead: the entity
  - an opportunity: `opportunity.leadId`
  - a meeting: through its opportunity
  - a payment: through its opportunity, else its customer
  - a customer: `customer.leadId`, else `metadata.leadId` (the rollback deletes the row first)
  - a follow-up: `followUp.leadId`
  - users and Slack installations have none
- `teamMemberId`: the actor's team member, from `actorUserId`. For a Slack-created deal's `opportunity.created`, it is the qualifier's, from `qualifiedBy.slackUserId`. Pipeline and system events have none. Credit for a booking belongs to Phase 3's attribution rows, not here.

`emitDomainEventInAction` and `domainEventsInternal.insert` take the same fields. PostHog gets `lead_id` and `team_member_id` properties.

## 7. Reporting switch (PR 4)

### 7.1 Leads report

`getLeadConversionMetrics` (`reporting/leadConversion.ts:31`) counts `newLeads` from `leadStageEntries` at the stage chosen in D2, instead of `leadTimeline`. The card reads "New leads: people who reached Qualified in the period". Conversions keep counting `customers` by `convertedAt`.

The report reads the new aggregate only once tenant field `leadStageReportingVersion` is set, the way `meetingProjectionVersion` gates meeting reports. `activateLeadStageReporting`, an internal mutation, sets it after `assertLeadLifecycle` passes. Before that it reads `leadTimeline`, so PR 4 can deploy first.

### 7.2 Historical counts

The report recomputes every month from real stage times. Compared with today, by UTC month (the report itself uses the browser's time zone):

| Month | Leads created (today's count) | Reached Qualified (after) | Change |
| --- | --- | --- | --- |
| 2026-04 | 334 | 345 | +11 |
| 2026-05 | 1,216 | 1,243 | +27 |
| 2026-06 | 1,823 | 1,832 | +9 |
| 2026-07 | 2,121 | 2,123 | +2 |
| 2026-08 | 1,922 | 1,925 | +3 |
| 2026-09 | 1,943 | 1,947 | +4 |
| 2026-10 | 1,130 | 1,072 | −58 |
| Total | 10,489 | 10,487 | −2 |

- 10,426 people reached Qualified within a minute of their row's creation, so their month doesn't move.
- 59 move to an earlier month. 57 of them are the split's new leads, created on 2026-10-16 with real dates from April to October. That is the fix the split plan deferred to Phase 1 (its §7, Q6).
- The 2 merged leads drop out, because a merged person is counted once, on the lead they merged into.

`leadTimeline` stays as it is until a later narrow, and `verifyBackfillCounts` keeps comparing it with the `leads` table.

`leadTimeline` stays as it is until a later narrow, and `verifyBackfillCounts` keeps comparing it with the `leads` table.

### 7.3 Prospect filter

`leadCustomers/queries.ts` gains a `prospect` lifecycle filter that reads `isSearchVisible: false` with `lifecycle: "prospect"`. The All, Leads and Customers views are unchanged, and a prospect row reads "Prospect". No person is at Prospect until Phase 2, so the toolbar toggle ships with Phase 2 rather than as an empty tab; until then `?lifecycle=prospect` lists them.

## 8. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 1 (#113) | Schema widen (§3), the lifecycle module with its stage list and pure rules, tests | optional fields, a new table and an empty aggregate |
| 2a (#114) | Lifecycle write paths (§5) | they skip leads the backfill hasn't reached |
| 2b (#115) | Team members and event links (§6) | a role record gets a team member when next written; older events lack the fields |
| 3 | Backfill and assert migrations (§9) | nothing reads the fields yet |
| 4 | Reporting switch and prospect filter (§7) | gated on `leadStageReportingVersion` |
| 5 | Admin move-back, disposition editing and the lead page control (D4) | admin-only, and needs PR 3's data |

Production runs, each with the tenant admin's approval, in this order once PR 3 deploys (§9.5 has the commands):

1. The team member backfills, then their asserts.
2. `nameLinkCandidates`, for the admin to approve, then `applyApprovedLinks` and `assertTeamMembersHeld` again.
3. `backfillLeadLifecycle`, then `assertLeadLifecycle` and the stage totals.
4. `backfillDomainEventLinks`, then `assertDomainEventLinks` and `leadSplit/verify:verifySplitEventLinks`. This must finish before the split's Deploy 3 drops `leadSplitAudit`, from about 16 Nov.
5. After PR 4 deploys: `activateLeadStageReporting`.

## 9. Backfill and assert migrations (PR 3)

All are `migrations.define` in `convex/migrations.ts`, so they run in batches and none hits the 16 MB read limit that stops `verifyBackfillCounts`.

### 9.1 Team member backfills

Four migrations, one per role table, use the same functions as the write paths, so they link through explicit IDs only:

- `backfillUserTeamMembers`: each user without `teamMemberId` gets a new team member.
- `backfillLeadGenWorkerTeamMembers`: a worker takes its user's. The worker whose user is missing gets its own.
- `backfillDmCloserTeamMembers`: a DM closer with `userId` takes that user's. The other 19 get their own.
- `backfillSlackUserTeamMembers`: each Slack user gets its own; none is linked.

The asserts are `assertUserTeamMembers`, `assertLeadGenWorkerTeamMembers`, `assertDmCloserTeamMembers`, `assertSlackUserTeamMembers` and `assertTeamMembersHeld`. They check that every role record has a team member in its tenant, and that a linked worker or DM closer shares its user's. They also check that every team member has a role record and at most one login.

Name matches between Slack users, DM closers and users are not applied by code. They wait for the admin's approval (§6.1, D5).

### 9.2 `backfillLeadLifecycle` / `assertLeadLifecycle`

Over `leads`, batch 25:

- skip a merged lead
- derive the stage and entry times from source data (§4.1), with the shared `deriveLifecycle`
- write them, and, for a lead with no disposition, the one D3 gives: `unresponsive` from the real expiry time (`createdAt` plus the join window, not the backlog run's `lostAt`) when a Slack deal expired, no deal is open and nothing at Qualified or later came after; else `open`
- insert the `leadStageEntries` entries
- rebuild the lead/customer row only if its `lifecycle` changes, which doesn't happen with today's data

It overwrites whatever PR 2 wrote, which is the same derivation, and keeps a disposition a write path already set. It emits no domain events: it records state, and 10,000 events would flood PostHog.

The assert derives each lead again and throws on any difference in stage or entry times, or a missing aggregate entry. It also checks `status` against the stage (`converted` exactly when stage is `customer`), that every lead has a disposition, and that a merged lead has no entries. An entry for a stage a lead never reached can't be found from the lead, so `leads/lifecycleChecks:stageTotals` compares the aggregate's totals with a count of the leads. Later the assert can run as a health check, with a moved-back lead compared against its move-back event.

### 9.3 `backfillDomainEventLinks` / `assertDomainEventLinks`

Over `domainEvents`, all 37,912 rows (D6), batch 100. It runs after the team member backfills, fills only fields an event lacks, and applies the rules in §6.2 (`deriveStoredEventLinks`), with one exception for split deals. A Slack deal's `opportunity.created` takes the setter's team member from `qualifiedBy.slackUserId`.

Deals moved whole, by a merge or by the split, keep their current `leadId` for every past event: the same human owned the whole deal.

A deal the split took apart is different. 25 such documents stayed with their keeper while other people's meetings moved out into new deals. Their 134 events from before the split are:

- 25 `opportunity.created`: the keeper, as rule O1 gave the document to them
- 107 `opportunity.status_changed` and 2 `slack_qualified_lead_booked`: each was written in the same transaction as a meeting event on the meeting that caused it
  - 108 match exactly one meeting event at the same `occurredAt`; 52 of those meetings now sit with another person and 56 with the keeper
  - the event takes the lead of that meeting's current deal
  - the last one is a payment, and stays with the keeper

The rule is general: an opportunity event whose same-transaction meeting now sits on another person's deal takes that person's lead. Only split meetings moved between deals, so nothing else is affected.

- One `opportunity.deleted` event names a side deal that no longer exists and carries no lead. It stays without one.
- The assert re-derives each event. A live event whose lead has since merged into the derived one still passes, because the timeline follows the merge.
- `leadSplit/verify:verifySplitEventLinks` checks the split events against `leadSplitAudit`'s meeting moves, an independent source. That is why it must run before Deploy 3.

### 9.4 Expected results

A read-only pass on 2026-10-17 applied the §4.1 rules to all 10,489 leads (`/tmp` script, counts only). The backfill's assert should land on the same numbers, plus whatever arrives in between.

| | People |
| --- | --- |
| Merged, skipped | 2 |
| Stage Qualified | 5,229 |
| Stage Booked | 4,590 |
| Stage Showed | 405 |
| Stage Customer | 263 |
| Stage Prospect or In conversation | 0 |
| No evidence at all | 0 |

- **Where people entered.** 4,214 were captured by lead gen first, so they get a Prospect time earlier than their qualification. 3,956 entered at Qualified, 2,315 at Booked, and 2 at Showed through a side deal.
- **Showed.** 661 people have a completed meeting and 7 a side deal.
- **Customer.** All 263 customers have a payment that isn't disputed, so none falls back to `convertedAt`.
- **Stale Slack deals.** 4,073 people have a deal that expired as `stale`. For 4,000 of them it is their only kind of deal, and they never got past Qualified. 72 booked on another deal.

### 9.5 Commands

Every run uses `--env-file .env.vercel.production`. `migrations:run` only starts the batches: poll `npx convex run --component migrations lib:getStatus '{"names":["migrations:<name>"]}'` until `isDone`. A dry run is `"dryRun": true`, and an assert runs again with `"reset": true`.

```
npx convex run migrations:run '{"fn":"migrations:backfillUserTeamMembers","next":["migrations:backfillLeadGenWorkerTeamMembers","migrations:backfillDmCloserTeamMembers","migrations:backfillSlackUserTeamMembers"]}'
npx convex run migrations:run '{"fn":"migrations:assertUserTeamMembers","next":["migrations:assertLeadGenWorkerTeamMembers","migrations:assertDmCloserTeamMembers","migrations:assertSlackUserTeamMembers","migrations:assertTeamMembersHeld"]}'
npx convex run teamMembers/linking:nameLinkCandidates '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
npx convex run teamMembers/linking:applyApprovedLinks '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q","approvedByUserId":"k97fgy2ckqhn8w2xynw3etwdf984dwb9","links":[...]}'
npx convex run migrations:run '{"fn":"migrations:backfillLeadLifecycle"}'
npx convex run migrations:run '{"fn":"migrations:assertLeadLifecycle"}'
npx convex run leads/lifecycleChecks:stageTotals '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
npx convex run migrations:run '{"fn":"migrations:backfillDomainEventLinks"}'
npx convex run migrations:run '{"fn":"migrations:assertDomainEventLinks"}'
npx convex run leadSplit/verify:verifySplitEventLinks '{}'
npx convex run migrations:activateLeadStageReporting '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
```

`stageTotals` must match a read-only count of the leads with each `lifecycleStageEnteredAt` field, and the §9.4 numbers plus whatever arrived since. `verifySplitEventLinks` must return 0 mismatches. The rest of the §2 checks (`verifyTenant`, the status counters, the search-row asserts) must still pass.

## 10. Decisions

Tenant admin `k97fgy2ckqhn8w2xynw3etwdf984dwb9` accepted every recommendation below on 2026-10-17.

- **D1. Backfill rule per stage.** Decided: the table in §4.1, with entry times that fill forward over skipped stages. The other option records only the stages a person passed through, which makes "reached Qualified" a minimum over three fields and lets funnel counts go up from one stage to the next.
- **D2. Which stage entry counts as a new lead.** Decided: Qualified, which includes anyone who skipped it. History changes as §7.2 shows, and `totalLeads` goes up at Qualified. Booked would drop the 5,229 people who qualified and never booked. Prospect would count every capture in Phase 2.
- **D3. Disposition defaults and stale expiry.** Decided: everyone starts `open`. When a Slack deal expires and the person has no other open deal and is still `open`, the expiry sets `unresponsive` with source `system`. A later qualification or booking sets a system `unresponsive` back to `open`. The backfill applies the same rule to the 4,000 people in §9.4. The other option leaves them `open`, which makes 4,000 people with no live deal look workable.
- **D4. Admin move-back.** Decided: in Phase 1, as PR 5 after the asserts pass. It adds an admin-only mutation to move the stage back with a reason, a mutation to set the disposition, and a small control on the lead page. Without it, `nurture`, `not_a_fit` and `do_not_contact` can't be set at all. The other option ships only the backend and adds the control with Phase 2's person page.
- **D5. Matching a human with several staff records.** Decided: code links only through explicit IDs (`leadGenWorkers.userId`, `dmClosers.userId`, `slackUsers.crmUserId`). Matching names would repeat the placeholder mistake for staff. Name candidates go to the tenant admin as a list of IDs to approve, and a one-off internal mutation applies the approved pairs. Production candidates:
  - Slack users: 10 match exactly one user by full name, 3 by first name only, 3 match none.
  - Unlinked DM closers: 6 match one user by full name, 3 by first name only, 10 match none.
  - 9 DM closers share a name with a Slack user.
- **D6. How far back to backfill `domainEvents`.** Decided: all 37,912, back to 2026-04-19. It takes about 190 batches, and the split rule in §9.3 covers the only events whose deal changed hands.

## 11. Rollback

- **PR 1.** Revert. The optional fields are empty, the table is empty and the aggregate holds nothing.
- **PR 2.** Revert. New rows keep the fields they got, which nothing reads, and PR 3's backfill rewrites them anyway.
- **PR 3 data.** Nothing reads it before activation. `clearLeadLifecycle` and `clearDomainEventLinks` unset the fields and clear the aggregate namespace, in batches. Team members are deleted after their role records are unlinked.
- **PR 4.** Unset `leadStageReportingVersion` with `deactivateLeadStageReporting`, and the report reads `leadTimeline` again. Reverting the code does the same.
- **PR 5.** Revert. Any move-back already made stays, with its domain event. A later re-derivation, run lead by lead, undoes it.

## 12. Production log

All runs were on tenant `k57dqjfyf8qqy31bq375ng8gb984b24q` on 2026-10-17, times in UTC. Tenant admin `k97fgy2ckqhn8w2xynw3etwdf984dwb9` delegated every Phase 1 production run and the D5 link decisions to the agent once CodeRabbit had approved the code.

### 12.1 Deploys

| PR | What | Deployed |
| --- | --- | --- |
| #113 | Schema widen, lifecycle rules | 05:40 |
| #112 | This plan | 05:52 |
| #115 | Team members, event links | 06:04 |
| #114 | Lifecycle write paths | 06:11 |
| #116 | Backfill and assert migrations | 06:44 |
| #117 | Report switch, prospect filter | 07:14 |
| #118 | Admin move-back and disposition | 07:42 |

Before any backfill, the live paths were already working. A Slack-qualified lead created after #114 had its stage and stage entries. The Slack deal created at 06:08 carried its person and its setter's team member, made on demand.

### 12.2 Team members (07:41)

- Dry runs of the four backfills ran one batch each and committed nothing.
- The real runs processed 55 users, 21 lead gen workers, 25 DM closers and 16 Slack users. That made 91 team members, 2 of them already created by live writes.
  - 6 DM closers share their linked user's team member, and 19 have their own.
  - The worker whose user is missing has its own.
- All five asserts passed.

### 12.3 Name links, D5 (07:42)

`nameLinkCandidates` listed 22 candidates and 13 records with no match:
- 16 match exactly one user by full name: 10 Slack users and 6 DM closers.
- 6 match by first name only.

The 16 full-name pairs were approved and applied with `applyApprovedLinks`, with none left unfinished. That brought the team members to 75. Seven users now share one team member across their login, their Slack user and their DM closer. The 6 first-name-only matches stay unlinked, because a first name alone doesn't decide identity. An admin can approve them later with the same function. The five asserts passed again.

Applied pairs, as record, then team member from and into:

```
dmCloser nx74jajqe75jvf4z2691ramaj588as33: v97aqvaxvpz1b98wh8sjn6bnex8gemhh -> v979s5eyh87hjr3v7njcv31qhd8gfp2h
dmCloser nx77w68njqwq4a16bv8jwcp461874f39: v97aq3shb0hh4x1dteyxnt2hms8germ6 -> v9703y6yay5wkrge41hn47erwx8gf8rj
dmCloser nx721rpq5qtwqkaawqv28tp5xd875da9: v97db32t8j8z9wrrrwqpdcc0j98gebnx -> v97011psg4jdtn1nhnh38mcdf18gert3
dmCloser nx7dnhs77gyqzmj5byfkedjccs875cr2: v972t4g9dah969z5rca2rcthcx8gerc9 -> v97b82gx89s69zmhg5992gzy9d8gfwke
dmCloser nx7a00fftgq4gfwnnqc688308h8746qt: v972ct7ta1w7spyy9861465r9n8gf2qy -> v972g940bb4zb8g0vwyxybpwd18gewrb
dmCloser nx726mtkb1vq1mbd0xtbe0szk98ctvq2: v979vbka0dpjw3g34he1js0szx8gfybc -> v97dvk4ekb8s5kv6ymp1fzcsf98gecbc
slackUser nh7djs0vmxpq3svbkgbvbhykcs86wkwn: v97dsve82q1nbfejgk63j1n7s58gfk3x -> v97dgapp91s7btrxwkjz9cn9hs8gedfj
slackUser nh706may6gpb258g14z673ze4n86zvaq: v976naw5fvc38pg7w0m89a5q498ge4jn -> v97fpgnpzmedxdtd2szbdcxmhs8gfbct
slackUser nh73hfgcc1z944d7jh2sqpx4ah870asf: v973sr30wnwpmxqhxgnn1rqzrd8gedjq -> v972g940bb4zb8g0vwyxybpwd18gewrb
slackUser nh72hahpzn1xbktqex5p120g05875eqv: v973sy149rmpzdhc30q06qpj898gepxj -> v97011psg4jdtn1nhnh38mcdf18gert3
slackUser nh78hjfeq5csyb8y7tkhywfrmx878390: v9726kd75bdxgvjzpfc183tqf58gfftv -> v9770f22arxqn1s6sm475g0tws8gebbd
slackUser nh74n37xpb3cvh8qrw7b30k9bx88b4y2: v972zawx5x7ycyhm9x7vqvg3k18gfty4 -> v979s5eyh87hjr3v7njcv31qhd8gfp2h
slackUser nh7521hjseskyyhkadj0gnw9fd8ca74m: v976zeh5gxq05azascfy4f6ath8ge02n -> v97b82gx89s69zmhg5992gzy9d8gfwke
slackUser nh7c9xb121qwm90kv9sxy331g18csjef: v97350tz18r0ygz207dd1jqpcn8gfmqr -> v97asctbexvnsaskfge5h6b8v58ge73a
slackUser nh771atycehentdf37jhh1gjt58e5ayk: v97dh01bjd7hc0rqhd868cnbw98ge4xv -> v977zpjnazhwhk02fte4dh1ep18ge05c
slackUser nh7cd37qtba87vwev58g8ds9qn8g51wm: v97bs19zmrfs0dccx1pckepdv58gf4w3 -> v97ek6q4jr6e92am9f5x9mc8a58gfqm6
```

Not linked (first name only): nx7dkjkb9zv2xp3jqb5j2m73cn875j1k nx7acnv2bqt2f6jg3cgjydt37h8758ds nx7fka2vxg7krrfb9s8d58mja1874chf nh71810awzjprf00nbbp8wy1ax86zfx1 nh72hf0r7wkvc4w65sm63bkwqx86yjmq nh78hyyrbz1hmrzk1n9knqzwjh871c79

### 12.4 Lifecycle (07:42 to 08:24)

- The dry run processed 25 leads and committed nothing.
- `backfillLeadLifecycle` processed 10,495 leads (07:42 to 07:58) and skipped the 2 merged ones. It emitted no domain events.
- `assertLeadLifecycle` passed on all 10,495 (08:13 to 08:24).

| | People |
| --- | --- |
| Stage Qualified | 5,234 |
| Stage Booked | 4,591 |
| Stage Showed | 405 |
| Stage Customer | 263 |
| No stage | 0 |
| Disposition `open` | 6,498 |
| Disposition `unresponsive` (expired Slack deal, nothing since) | 3,995 |
| `converted` without stage Customer, or the reverse | 0 |

`stageTotals` matches a scan of the stored stages exactly. It counts 10,493 people at each of Prospect, In conversation and Qualified, 5,259 at Booked, 668 at Showed and 263 at Customer.

The backfill has 6 more people than the §9.4 snapshot (10,493 against 10,487), all new leads that arrived after the plan was written. Net of people who moved on, they add 5 at Qualified and 1 at Booked; Showed and Customer are unchanged. A second read-only derivation at about 06:30 found 10,492 people (5,233 Qualified, 4,591 Booked, 405 Showed, 263 Customer). The backfill matches it plus one Slack-qualified lead that arrived before the run.

### 12.5 Event links (07:43 to 08:15)

- The dry run processed 100 events and committed nothing.
- `backfillDomainEventLinks` processed 37,926 events (07:43 to 07:47).
- `assertDomainEventLinks` passed on all 37,926 (08:13 to 08:15).
- `verifySplitEventLinks` checked the 52 deal events whose meetings the split moved, against `leadSplitAudit`, and found 0 mismatches. Deploy 3 can drop the audit table and this check with it.

### 12.6 Checks afterward

- `verifyTenant`: 0 failures on all 8 checks. It scanned 19,597 identifiers, 10,495 lead emails, 43,870 form responses, 221 follow-ups, 8,299 Slack events, 263 customers and 6,655 meetings.
- `verifyTenantStatusCounters`: match, with 4,107 active, 4,311 lost and 263 won.
- `assertLeadCustomerSearchRowsBackfilled`, re-run because the row's lifecycle rule changed: passed on 10,495.

### 12.7 Report switch (08:25)

`activateLeadStageReporting` set `leadStageReportingVersion` to 1, after confirming that the backfill and assert had finished and no split plan was applying. The leads report now counts people who first reached Qualified. By UTC month, from the stored stages:

| Month | Rows created (before) | Reached Qualified (now) |
| --- | --- | --- |
| 2026-04 | 334 | 345 |
| 2026-05 | 1,216 | 1,243 |
| 2026-06 | 1,823 | 1,832 |
| 2026-07 | 2,121 | 2,123 |
| 2026-08 | 1,922 | 1,925 |
| 2026-09 | 1,943 | 1,947 |
| 2026-10 | 1,136 | 1,078 |

The months match §7.2. To roll back, run `migrations:deactivateLeadStageReporting` with the tenant ID.

### 12.8 Left for later

- The Prospects toolbar toggle ships with Phase 2, when the first prospects exist (§7.3).
- 6 first-name-only and 13 unmatched staff records have their own team members until an admin links them.
- `leadTimeline`, `verifyBackfillCounts` and the creation-based branch of the report stay until a later narrow. So do the optional lifecycle fields, which a narrow can make required once no unstaged lead can be written.
- Deploy 3 of the split, from about 16 Nov, removes `leadSplit/verify:verifySplitEventLinks` and the split's calls to `correctLeadLifecycle` with the rest of the split code.
