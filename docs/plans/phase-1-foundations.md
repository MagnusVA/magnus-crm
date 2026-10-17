# Phase 1: foundations

Status: plan approved 2026-10-17, with every §10 decision taken as recommended. Nothing has shipped or run in production yet.

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

- **An admin, with a reason** (D4). The entry times above the new stage are cleared and their aggregate entries deleted. The domain event keeps the old values.
- **Voiding a side-deal payment.** It already deletes the customer and returns the lead to `active` (`rollbackCustomerConversionIfEmpty`). The stage is derived again from what is left, and the event records reason `payment_voided`.
- **A split or split rollback.** The split refresh chain derives the stage again for each lead it touched, and gives a lead it created its first stage. The split ran once; this only matters if a rollback runs before Deploy 3 removes the code.

A lost deal, an expired Slack deal, a no-show or a cancellation never moves the stage.

### 4.4 Merge

`executeMerge` combines the two people: the target takes the higher stage and, for each stage, the earlier entry time. The source keeps its frozen values and loses its aggregate entries. This gives the same result as deriving the target again, because the merge moves the source's deals, Slack events and audit matches.

### 4.5 Disposition

Every person starts at `open`. An admin sets any value with a reason (D4). An expired Slack deal sets `unresponsive` when the person has no other open deal and is still `open` (D3). Only the system changes a system-set value, and an admin-set value never changes on its own.

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

Write paths create or find the team member when a role record is created:

- `users`: `createInvitedUser` and onboarding's `redeemInviteAndCreateUser` create one. A reactivated user keeps theirs.
- `leadGenWorkers`: `syncWorkerProfileForUser` and the admin path in `leadGen/capture.ts` use the user's team member.
- `slackUsers`: `upsertSlackUserOnSubmission` creates one, or uses the linked user's if `crmUserId` is ever set.
- `dmClosers`: `createDmCloser` uses the linked user's team member, or creates one. `updateDmCloser` relinking `userId` moves the DM closer to the user's team member, and unlinking gives it a new one.

A role record without `teamMemberId` hasn't been backfilled, and code that needs one treats it as unknown.

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

`leadCustomers/queries.ts` gains a `prospect` lifecycle filter that reads `isSearchVisible: false` with `lifecycle: "prospect"`. The All, Leads and Customers views are unchanged, and the toolbar gets a Prospects toggle. No person is at Prospect until Phase 2, so the filter is empty until then.

## 8. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 1 | Schema widen (§3), the lifecycle module with its stage list and pure rules, tests | optional fields, a new table and an empty aggregate |
| 2 | Write paths (§5, §6) | they skip rows the backfill hasn't reached |
| 3 | Backfill and assert migrations (§9) | nothing reads the fields yet |
| 4 | Reporting switch and prospect filter (§7) | gated on `leadStageReportingVersion` |
| 5 | Admin move-back, disposition editing and the lead page control (D4) | admin-only, and needs PR 3's data |

Production runs, each with the tenant admin's approval:

1. After PR 3 deploys: `backfillTeamMembers`, then `backfillLeadLifecycle`, then `backfillDomainEventLinks`, each with a dry run first, then its assert.
2. After the asserts pass and PR 4 deploys: `activateLeadStageReporting`.
3. `backfillDomainEventLinks` must finish before the split's Deploy 3 drops `leadSplitAudit`, from about 16 Nov, because its assert checks split deals against that table.

## 9. Backfill and assert migrations (PR 3)

All are `migrations.define` in `convex/migrations.ts`, so they run in batches and none hits the 16 MB read limit that stops `verifyBackfillCounts`.

### 9.1 `backfillTeamMembers` / `assertTeamMembers`

Over `users`, then the other three role tables, using explicit links only:

- Each user without `teamMemberId` gets a new team member.
- A lead gen worker takes its user's team member. The worker whose user is missing gets its own.
- A DM closer with `userId` takes that user's team member. The other 19 get their own.
- A Slack user gets its own; none is linked.

The assert checks that every role record has a team member in its tenant, that every linked worker and DM closer shares its user's team member, and that every team member has at least one role record.

Name matches between Slack users, DM closers and users are not applied by code. §10 D5 covers them.

### 9.2 `backfillLeadLifecycle` / `assertLeadLifecycle`

Over `leads`, batch 25:

- skip a merged lead
- derive the stage and entry times from source data (§4.1), with the shared `deriveLifecycle`
- write them, and the disposition from D3
- insert the `leadStageEntries` entries
- rebuild the lead/customer row only if its `lifecycle` changes, which doesn't happen with today's data

It overwrites whatever PR 2 wrote, which is the same derivation. It emits no domain events: it records state, and 10,000 events would flood PostHog.

The assert derives each lead again and throws on any difference in stage, entry times or aggregate entries. It also checks `status` against the stage (`converted` exactly when stage is `customer`) and that a merged lead has no entries. Later it can run as a health check, with a moved-back lead compared against its move-back event.

### 9.3 `backfillDomainEventLinks` / `assertDomainEventLinks`

Over `domainEvents`, all 37,912 rows (D6), batch 200. It runs after `backfillTeamMembers` and applies the rules in §6.2, with one exception for split deals.

Deals moved whole, by a merge or by the split, keep their current `leadId` for every past event: the same human owned the whole deal.

A deal the split took apart is different. 25 such documents stayed with their keeper while other people's meetings moved out into new deals. Their 134 events from before the split are:

- 25 `opportunity.created`: the keeper, as rule O1 gave the document to them
- 107 `opportunity.status_changed` and 2 `slack_qualified_lead_booked`: each was written in the same transaction as a meeting event on the meeting that caused it
  - 108 match exactly one meeting event at the same `occurredAt`; 52 of those meetings now sit with another person and 56 with the keeper
  - the event takes the lead of that meeting's current deal
  - the last one is a payment, and stays with the keeper

The rule is general: an opportunity event whose same-transaction meeting now sits on another person's deal takes that person's lead. Only split meetings moved between deals, so nothing else is affected.

- One `opportunity.deleted` event names a side deal that no longer exists and carries no lead. It stays without one.
- The assert re-derives each event and also checks the 134 split events against `leadSplitAudit`'s meeting moves. That is why it must run before Deploy 3.

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

Nothing has run yet.
