# Respark

Status: approved, 2026-10-24. The tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`) accepted the plan and every recommendation in §11.3, and the approval covers every production run in §9 and §10. PR 0 (this plan) is open; PRs 1 to 7 follow.

The spec is the approved [Respark proposal](../reviews/respark-proposal.html), mockups included. [The pipeline map](../reviews/pipeline-map.html) describes how the pipeline works today. Terms follow [`CONTEXT.md`](../../CONTEXT.md), and the model is [ADR 0001](../adr/0001-lead-lifecycle-model.md). Respark is new work after the roadmap, which closed with Phase 6. It runs as one phase under the ADR's "How a phase runs".

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

Respark gives each lead generator a batch of people who stalled, in a fixed order, to message again on Instagram. For each one, they mark resparked or not a fit, or skip.

1. **A capture means in conversation** (§4.1). A lead gen capture moves the person to In conversation if they're behind it, and it always counts as a touch. A backfill moves the 81,196 people at Prospect to In conversation, entered at their first capture. Prospect stays in the enum, unused.
2. **Notes don't set the stage** (§4.2). A DM portal note or profile edit stays a touch, but it no longer moves anyone to In conversation.
3. **Last touch and inactive** (§4.3). The person gets a last touch: the newest touch of any kind, wider than today's `latestTouch`. "Inactive" means no touch for N days (a tenant setting, default 90). It's worked out at read time, so the badge itself is never stored.
4. **The respark pool** (§4.4): five buckets in a fixed order, read from one index. No cron moves anyone between buckets.
5. **Batches and holds** (§4.5). A batch is held for its lead generator until the business day ends. Three actions: Resparked, Not a fit (with a few seconds to undo) and Skip.
6. **What each action writes** (§5.3): a touch, a disposition with the new source `respark`, In conversation, and credit when a resparked person later gets a deal.
7. **Screens** (§6): the Respark screen in the lead gen portal with its read-only person panel and a new permission, the Respark tab in Settings, the Lifecycle card's inactive badge and last touch, and capture confirmations that say where a known person stands.
8. **Reports** (§7): My Activity gets Resparks, Entries and Not a fit; Lead Gen Ops gets a per-worker respark table.
9. **Docs** (§11.4): the ADR amendment (four rules), `CONTEXT.md`, and `docs/agents/convex.md` and `auth.md`.

It ships in 7 code PRs after this plan (§9). Each is safe to deploy alone.

## 2. Production snapshot (2026-10-24)

These are read-only queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant, around 06:35 UTC, on `main` at `2b2e1a4`. Leads, deals and prospects were paged with inline queries that returned IDs, enums and times only.

### 2.1 People

92,221 people: 91,928 `active`, 288 `converted`, 5 `merged`. Not counting the merged ones:

| Lifecycle stage | People |
| --- | --- |
| Prospect | 81,196 |
| In conversation | 2 |
| Qualified | 5,527 |
| Booked | 4,769 |
| Showed | 434 |
| Customer | 288 |

- **Disposition:** 87,922 `open` and 4,294 `unresponsive`, all set by the system. No one is `not_a_fit`, `nurture` or `do_not_contact`.
- **Captures:** 87,203 `leadGenProspects` rows, one per captured person. Every Prospect has one, and 6,007 captured people are already past Prospect.
- **The two at In conversation** (`jh7cq56xxeytnz311kze6yndns8gkteh`, `jh76kqw37tqn26a0axsm11v7ad8gktdg`) have no capture. A DM portal link copy is their only touch. That copy path no longer records a person (§2.4), so no live path creates another case like theirs.

### 2.2 Touches today

Every non-merged person has a `latestTouch`. By event type: `lead.captured` 83,489, `meeting.created` 4,375, `opportunity.created` (Slack or side deal) 4,147, `lead.slack_qualified` 119, `lead.portal_note_added` 69, `lead.portal_profile_updated` 14, `lead.portal_link_copied` 3.

`touchChannel` in `convex/lib/touches.ts` decides what counts as a touch. Today that's captures (duplicates included), portal notes, edits and link copies, Slack qualifications, Calendly bookings, and the creation of a Slack deal or a side deal. Meeting results, deal closings, payments and the Slack expiry are on the timeline but aren't touches. `latestTouch` feeds attribution: each deal snapshots it at creation.

Time since `latestTouch`: under 30 days, 33,929; 30 to 90 days, 33,214; 90 to 180 days, 24,959; over 180 days, 114. At 90 days, 25,073 people are inactive.

### 2.3 Deals

11,693 deals. 4,005 people have an open deal, which takes them out of the pool. Slack deals: 4,386 closed `stale` by the 31-day expiry, 1,226 still open at Qualified, and 1,277 booked and open. The expiry closes a deal with source `system`, then sets the person `unresponsive` if they have no other open deal.

### 2.4 Code facts the design rests on

- **In conversation's live causes** are a DM closer's note and profile edit (`recordPortalTouch`, `convex/linkPortal/portalTouches.ts`). The link copy path (`copyMutations.insertCopyEvent`) inserts no `leadId`, so it records no touch and moves no one. Its old rows still count as lifecycle evidence.
- **The capture** (`convex/leadGen/capture.ts`) finds or creates the person through `resolveLeadIdentity` at Prospect, emits `lead.captured` for every submission, and returns `duplicateProspect` (this prospect was captured before). It says nothing about the person.
- **The Slack expiry** runs hourly (`expireStaleSlackOpportunities`), 31 days after the deal was created.
- **`leadGenDealsByWorker`** counts only lead gen rows whose source kind is `capture`. A row with a new source kind stays out of the Deals column without any change.
- **Lead generators** hold only `lead-gen:capture` and `lead-gen:view-own`, and can't open a person page (`lead:view-all`).
- **The leads table** has 3 indexes plus the search index.

### 2.5 The pool today

Counted with §4.4's rules, using `latestTouch` as last touch:

| Bucket | People |
| --- | --- |
| 1. Qualified, never booked | 3,644 |
| 2. Never qualified | 50,441 |
| 3. Inactive (90 days) | 1,133 |
| 4. Had a call, deal lost | 782 |
| 5. Not a fit | 0 |
| **Pool** | **56,000** |

Out of the pool: 31,923 touched in the last 30 days, 4,005 on an open deal, 288 customers, 5 merged.

The proposal's counts (4,299, 50,291, 1,133, 1,290; 57,013) were taken a day earlier with a looser test. The gap is in buckets 1 and 4: people whose touch is under 30 days old and people with an open deal are out of the pool here.

**Two variants, to settle what counts as a touch (Q3):**

| Last touch includes | Bucket 1 | 2 | 3 | 4 | Pool | Inactive at 90 days |
| --- | --- | --- | --- | --- | --- | --- |
| Today's touches only | 3,644 | 50,441 | 1,133 | 782 | 56,000 | 25,073 |
| + deal closings by a person (no-show, canceled, lost by a closer) | 3,644 | 50,441 | 1,105 | 766 | 55,956 | 25,044 |
| + every deal closing, the Slack expiry included | **0** | 50,441 | 1,099 | 751 | 52,291 | 23,395 |

Counting the Slack expiry as a touch empties bucket 1, the operations lead's list. The expiry closed 4,061 of its 4,386 deals on 16 October, when it first ran over the backlog, and the rest daily since, so every one of them is under 30 days old. After that, a qualified person would wait 61 days after qualifying before they reach the pool.

## 3. Schema

All additive. No field is narrowed, and nothing is dropped.

### 3.1 `leads`

| Field | Type | Meaning |
| --- | --- | --- |
| `lastTouch` | optional `{ eventId, eventType, occurredAt }` | The newest touch of any kind (§4.3). It's wider than `latestTouch`, which stays the channel touch that attribution snapshots |
| `resparkGroup` | optional `"qualified" \| "never_qualified" \| "had_call" \| "not_a_fit" \| "out"` | Which part of the pool the person's stage, disposition and deals put them in, before any time rule (§4.4). `out` covers customers, people on an open deal, do not contact and merged records |

- **Index:** `by_tenantId_and_resparkGroup_and_lastTouchAt` on `["tenantId", "resparkGroup", "lastTouch.occurredAt"]`. It's the 4th regular index on leads. Convex accepts a nested field in an index. A range bound also takes documents where the field is missing, because a missing value sorts below numbers, so a person with no `lastTouch` is always `out` (§4.4).
- **`dispositionSource`** gains `"respark"`, beside `system` and `admin`.

`opportunities` gains `by_tenantId_and_leadId_and_outcome`, its 18th index. With it, "does this person have an open deal" is one indexed read, however many deals they have.

### 3.2 New tables

**`resparkBatches`**: one per batch a lead generator asks for.

| Field | Type |
| --- | --- |
| `tenantId` | `Id<"tenants">` |
| `userId` | `Id<"users">` |
| `workerId` | `Id<"leadGenWorkers">` |
| `createdAt` | number |
| `heldUntil` | number, the end of the business day it was created in |
| `size` | number, the people it got |
| `requestedSize` | number, the batch size setting at the time |

Index: `by_tenantId_and_userId_and_createdAt`.

**`resparkBatchItems`**: one per person in a batch. An unworked item in an unexpired batch is the hold.

| Field | Type |
| --- | --- |
| `tenantId`, `batchId`, `leadId`, `userId`, `workerId` | IDs |
| `position` | number, its place in the batch |
| `bucket` | 1 to 5, at the time it was held |
| `heldUntil` | number, a copy of the batch's |
| `result` | optional `"resparked" \| "not_a_fit" \| "skipped"` |
| `workedAt` | optional number |
| `eventId` | optional `Id<"domainEvents">`, the respark touch |

Indexes:

- `by_batchId_and_position`, for the batch screen;
- `by_tenantId_and_leadId_and_heldUntil`, for the hold check and the person's respark history;
- `by_tenantId_and_workerId_and_workedAt`, for My Activity;
- `by_tenantId_and_workedAt`, for Lead Gen Ops.

### 3.3 `tenants`

`respark`: optional `{ inactiveAfterDays: number, batchSize: number }`. When it's absent, the defaults are 90 and 45. The hold isn't a setting: it always lasts until the business day ends (decision 4).

### 3.4 `dealAttributions`

The source union gains `{ kind: "respark", itemId: Id<"resparkBatchItems">, workerId: Id<"leadGenWorkers">, eventId: Id<"domainEvents"> }`, with role `lead_gen` (rule 4 of the ADR: a new kind of credit adds a source kind, not a column). An index on `["tenantId", "source.kind", "attributedAt"]` serves the report (§7.2), if the table has none that fits.

### 3.5 Aggregates

- **`resparkPool`**, a `DirectAggregate` with one entry per non-merged person that has a `lastTouch`. A merge deletes the merged person's entry. Its ID is the lead ID, its namespace the tenant, and its key `[resparkGroup, lastTouch.occurredAt]`. It counts the pool's buckets, which the Respark screen shows, and the inactive people, which the Settings tab counts live. It's written only where `resparkGroup` and `lastTouch` are written (§5.1). It uses tolerant writes (`insertIfDoesNotExist`, `replaceOrInsert`, `deleteIfExists`) until its backfill and assert pass, and strict ones from PR 7.
- **`resparkResultsByWorker`**, a `TableAggregate` on `resparkBatchItems` with namespace tenant and key `[workerId, result ?? "pending", workedAt ?? 0]`. It counts resparks and not-a-fits per worker for any range. The table starts empty, so its writes are strict from the start: there's nothing to backfill.

## 4. Rules

### 4.1 A capture means in conversation

- `prospectEvidence` becomes In conversation at `firstCapturedAt`. A first capture creates the person at In conversation, and `settleProspectPerson` advances a known person who is behind it. `advanceLifecycle` fills Prospect with the same time, so Prospect keeps its date (decision 7).
- A re-capture of someone further along changes no stage. It's a touch, as today.
- The leads list's Prospects view, the lead counts and `isProspectStage` already treat everything below Qualified the same way, so they don't change.

### 4.2 Notes don't set the stage

- A DM closer's note and profile edit stop moving the person to In conversation. `recordPortalTouch` keeps emitting the touch, and `portalNoteEvidence` and `portalEditEvidence` leave `collectLifecycleEvidence`.
- `portalCopyEvidence` stays as historical evidence. The live copy path writes no person, and the two people in §2.1 keep their In conversation from it (Q2).
- `LifecycleCause` gains `respark`. `dm_portal` stays for the old copies.

### 4.3 Last touch, and inactive as a rule

**Last touch** is the newest event about the person that is one of these:

- a touch under today's `touchChannel`: a capture (a duplicate included), a portal note, edit or link copy, a Slack qualification, a booking, or a Slack or side deal's creation;
- a meeting result: `meeting.no_show`, `meeting.canceled`, or `meeting.status_changed` to held;
- a deal move or loss someone made: `opportunity.stage_changed`, `opportunity.marked_lost` or `opportunity.status_changed` whose source isn't `system`. Marking a call held usually writes only the closer's deal move, so this is also how a held call counts (§11.5);
- `payment.recorded`;
- a respark: `lead.resparked` or `lead.marked_not_a_fit` (§5.3).

What's left out are events no one did with the person: the Slack expiry and other system deal moves, lifecycle stage and disposition changes, merges, and stats events (Q3). Two events at the same millisecond go to the one written later, on every path.

- `emitDomainEvent` keeps `lastTouch` current, in the same call that keeps `latestTouch` current, and it moves only forward. A merge keeps the later of the two, as `mergedTouches` does for `latestTouch`.
- `lead.resparked` is also a channel touch (`lead_gen`), so a deal created after a respark snapshots it as its latest touch. `lead.marked_not_a_fit` isn't: it brings no one back.
- **Inactive** means a non-merged person whose `lastTouch.occurredAt` is at least N days old, N being `tenants.respark.inactiveAfterDays` (30 to 365, default 90). Every reader works it out from the stored time and the setting at read time. No field, flag or cron stores the badge. Changing N rewrites no row.
- **Why a stored time doesn't break "nothing is stored":** `lastTouch` is a fact about the past, like `latestTouch`, and it's needed to index the pool. The rule, "N days" and the badge itself, are applied at read time. Nothing stores "inactive", and nothing has to change when the setting or the clock moves.

### 4.4 The pool

`resparkGroup` holds the parts of the rule that only change when something is written. It's worked out by one function, `resparkGroupFor(lead, hasOpenDeal)`:

| Person | `resparkGroup` |
| --- | --- |
| merged | none: no group and no pool entry (§11.5) |
| at Customer (`lifecycleStage`, not `status`), on an open deal, do not contact, or no `lastTouch` | `out` |
| disposition `not_a_fit` (any stage) | `not_a_fit` |
| Qualified | `qualified` |
| Prospect or In conversation | `never_qualified` |
| Booked or Showed | `had_call` |

At read time, with `now`, the 30-day rule and N:

| Bucket | Index range on `[resparkGroup, lastTouch.occurredAt]` | Order |
| --- | --- | --- |
| 1. Qualified, never booked | `qualified`, at or before `now − 30 days` | newest first |
| 2. Never qualified | `never_qualified`, at or before `now − 30 days` | newest first |
| 3. Inactive | `had_call`, at or before `now − N days` | newest first |
| 4. Had a call, deal lost | `had_call`, after `now − N days` and at or before `now − 30 days` | newest first |
| 5. Not a fit | `not_a_fit`, at or before `now − 30 days` | newest first |

- Each person is in one bucket, the first they match. A never-qualified person who is also inactive is in bucket 2, as the proposal says. Bucket 3 holds the inactive people that buckets 1 and 2 don't claim.
- "Most recently stalled first" (decision 1) means the newest last touch first.
- The buckets follow the stage, and a stage hides two edge cases. Both are 0 in production today:
  - **Bucket 1.** A Qualified person with no open deal normally had their Slack deal close with no booking. A person an admin moved back to Qualified after a booking also lands here, because the admin's stage decides.
  - **Bucket 4.** Booked or Showed with no open deal normally means every deal closed lost: a no-show, a cancellation or a closer's loss. A won deal with no undisputed payment leaves the person short of Customer and also lands here. Customer comes from payments, not from a won outcome.
- Not a fit counts as a touch, so a person marked not a fit leaves the pool for 30 days, then returns in bucket 5.
- `unresponsive` and `nurture` don't change the group (decision 6). `do_not_contact` is `out`.
- **No cron.** The 30-day and N-day lines are index bounds computed per read. Batch expiry is a comparison with `heldUntil`. The group changes only when the person, a deal or a disposition is written (§5.1).

### 4.5 Batches and the hold

- **Asking for a batch** (`claimResparkBatch`). If the lead generator has an unexpired batch with unworked people, they get that one back. Otherwise the mutation walks buckets 1 to 5 in index order. It skips anyone with an unworked, unexpired item, and anyone this lead generator skipped earlier in the same business day. It stops at the batch size or at 1,500 people read, whichever comes first, and returns a shorter batch if the pool runs dry. It inserts the batch and one item per person with `heldUntil` set to the end of the business day: `businessDayRange(businessDateForInstant(now)).end`.
- **Concurrency.** The claim reads each candidate's hold through `by_tenantId_and_leadId_and_heldUntil` and writes the new items in the same transaction. Two lead generators who claim at once both read the same index ranges. Convex's serializable transactions make one of them retry, and the retry sees the other's items. No lock, counter or person field is needed. A test claims twice, for two workers and across two tenants, and checks the batches don't overlap.
- **Each action rechecks the person** in its own transaction. Resparked and Not a fit are rejected when the person's group is now `out`: they booked, paid, were merged or were set to do not contact during the hold. The card says why and offers only Skip. Not a fit never overwrites a disposition an admin set; it records the touch and leaves the disposition alone.
- **Merges.** Items stay on the person they were made for, so their IDs, which credit rows point at, never change. Every reader of items (the hold check, respark history, the credit rule) reads across the merged people, as `computePersonTouches` does. A held merged-away person is `out`, so the card rejects Resparked and Not a fit.
- **Expiry.** When `heldUntil` passes, the unworked items stop holding anyone, and the people are back in the pool at their place. Nothing is written. An action on an expired item is rejected with "This batch ended with the business day".
- **Skip** sets the item's `result: "skipped"`. The person is back in the pool for everyone else. The same lead generator doesn't get them again until the business day ends, so their next batch isn't the same people.
- **Undo** happens in the browser (Q5). Not a fit shows for 5 seconds with Undo, and the mutation is sent when the 5 seconds pass or when the lead generator acts on another card. A closed tab leaves the person unworked and still held, which is safe: they show again on reload. The server has no undo, and nothing is reverted or deleted.

### 4.6 Credit (decision 2)

When a deal is created, `recordDealCreation` adds a `lead_gen` row with source `respark` for the person's latest resparked item if both hold:

- it was worked before the deal was created;
- it was worked after the person's previous deal was created, if they had one.

That's "the respark that started this attempt". The original capture row is unchanged, and the respark row is added beside it, never in its place. The `teamMemberId` is the resparker's, and the row's `attributedAt` is the item's `workedAt`, the time of the respark, so the report's range on `attributedAt` (§7.2) counts a respark in the range it happened. A person with no qualifying respark gets no row.

- `recordDealCreation` checks each source on its own: a capture row when the deal has none, and a respark row when it has none. Today it skips lead gen credit when any lead gen row exists.
- `teamMemberRepoint` (`convex/attribution/teamMemberRepoint.ts`) learns `respark → source.workerId`, so respark credit follows the worker when their team member changes, as capture credit does.
- `assertDealAttributions` accepts one capture row and at most one respark row per deal.

### 4.7 Not a fit reopens (decision 5)

- **A respark** reopens any not a fit to Open, with source `respark`, because a lead generator decided it.
- **A qualification or a booking**, or any evidence at Qualified or later that is newer than the not a fit, reopens it, whoever set it. This is decision 5 as approved: "a booking from a not-a-fit person shouldn't be hidden". It uses the same check as a system `unresponsive` in `advanceLeadLifecycle`.
- **A capture doesn't reopen not a fit** (Q1).

### 4.8 Behaviour that stays

- `latestTouch`, first touch and the deal snapshots keep their meaning. Only the new respark event joins `touchChannel`.
- `unresponsive` keeps its rule and source.
- Prospect stays in the enum and in `isProspectStage`, and the Prospects view keeps its name (decision 7).
- No deal moves, no meeting changes, and nothing is deleted.

## 5. Write paths

### 5.1 Last touch and group (PR 1)

`refreshResparkState(ctx, leadId, touch?)` in a new `convex/lib/respark/state.ts`:

1. It reads the person and their deals (`by_tenantId_and_leadId`) and checks for an open one.
2. It works out `lastTouch` (the later of the stored one and `touch`) and `resparkGroup`.
3. When either changed, it patches the person and replaces the `resparkPool` entry.

It runs from two places:

- **`emitDomainEvent`**, after the event's insert, for an event with a `leadId` that is a §4.3 touch or can change the group: a stage, disposition or status change, or a deal's creation, stage change or loss. Other events skip it, so bulk paths (50 side-deal nudges, up to 64 follow-up expiries in one booking, enrollment loops) add no reads. Most writes that change a group emit their event after the write. A test covers each: the lifecycle stage, `lead.disposition_changed` from each source, `lead.status_changed`, `opportunity.created`, `opportunity.stage_changed` and `opportunity.marked_lost`.
- **Explicit calls after the final write** where no event follows it:
  - `deleteEmptyOpportunity`, which emits `opportunity.deleted` before the delete;
  - `repointLeadReferences` and `patchOpportunityLifecycle` when a deal's `leadId` changes, for both people;
  - `mergeLead`, for both people, after the deals, the items and the lifecycle have moved (`mergeLeadLifecycle` can return without an event);
  - the blocker purge in `admin/migrations.ts`.

  The test data reset (`testing/operationalData.ts`) and tenant deletion (`admin/tenantsMutations.ts`) delete the new tables' rows and clear both aggregates' namespaces.

`assertResparkState` is the health check for any path this list misses.

### 5.2 Lifecycle (PR 2)

`prospectEvidence` returns In conversation, as §4.1 says, and §4.2 drops the note and edit evidence. `recordPortalTouch` drops its `advanceLeadLifecycle` call. The respark evidence (`resparkEvidence`, an item with `result: "resparked"` gives In conversation at `workedAt`) and the reopen rules (§4.7) ship in PR 4.

### 5.3 The respark actions (PR 4)

Each action is one mutation. It checks that the caller holds `lead-gen:respark`, that the item is theirs and in their tenant, and that it's unworked and unexpired. All writes happen in that transaction.

| | Item | Event (touch) | Disposition | Lifecycle | Credit |
| --- | --- | --- | --- | --- | --- |
| Resparked | `result: "resparked"`, `workedAt`, `eventId` | `lead.resparked`, actor the lead generator | not a fit → Open, source `respark`, with `lead.disposition_changed` | In conversation if behind it (cause `respark`) | none now; §4.6 at the next deal |
| Not a fit | `result: "not_a_fit"`, `workedAt`, `eventId` | `lead.marked_not_a_fit` | `not_a_fit`, source `respark`, `dispositionSetAt`, with `lead.disposition_changed`, when the current source is `system` or `respark` and the value isn't already `not_a_fit`. When an admin set the disposition (source `admin`, any value), it stays: the item and the event are still written | unchanged | none |
| Skip | `result: "skipped"`, `workedAt` | none | unchanged | unchanged | none |
| Batch expires | unchanged | none | unchanged | unchanged | none |

- The events go through `emitDomainEvent`, so `lastTouch`, the group, the pool aggregate, the activity counts and PostHog follow on their own.
- The lifecycle goes through `advanceLeadLifecycle`, and the disposition through a new `respark` branch beside `adminSetDisposition` in `convex/lib/leadLifecycle.ts`.
- The person page's Lifecycle card shows a respark not a fit from the person's `dispositionSource: "respark"` and `dispositionSetAt`, naming the role, not the lead generator. The person panel's respark history, which names no one either, comes from the items. No new field goes on the person.

### 5.4 The capture (PR 2)

`capture.submit` also returns `person: { isNew, stage, disposition, dispositionSource, lastTouchAt (before this capture), nextMeetingAt? }`. `isNew` means the capture created the person. The other fields are read before the capture's own touch, so "inactive for 127 days" describes the gap the capture closed.

### 5.5 Settings (PR 3)

`updateResparkSettings` (`settings:manage`): `inactiveAfterDays` 30 to 365, `batchSize` 10 to 100. It writes `tenants.respark` and nothing else, because the rule applies at the next read. Batches already held keep their size and hold.

## 6. Readers

### 6.1 The Respark screen (PRs 4 and 5)

`/workspace/lead-gen/respark` is guarded by `requirePermission("lead-gen:respark")` and sits in the lead generator nav and the command palette after My Activity. It follows the proposal's mockups, steps 1 to 5:

- **Start:** "Get my batch" (or "Continue my batch"), the batch size and the hold's end, the five bucket counts from `resparkPool`, and today's line (batches done, entries, not a fit). There's no filter and no bucket picker.
- **Cards** in batch order. Each shows the reason badge (its bucket), the stage, the capture date and who captured them, the qualification, the deal and its loss reason, the time zone when a booking gave one, and the last three touches. Buttons: Open Instagram, Resparked, Not a fit, Skip. Keys: O, R, N, S, with J and K to move between cards.
- **Worked cards** shrink to one line. Not a fit shows the 5-second Undo toast (§4.5).
- **Batch done:** the summary (entries, not a fit, skipped, time from claim to last action), "Get another batch" and "See My Activity".

Queries: `getMyResparkBatch`, `getResparkPoolCounts` and `getMyResparkToday`. Every query takes the user, tenant and worker from the identity.

### 6.2 The person panel (PR 4 backend, PR 5 UI)

`getResparkPersonPanel({ itemId })`, under the new permission `lead-gen:respark` (`lead_generator`, `tenant_master`, `tenant_admin`, like `lead-gen:capture`). It answers only for an item in the caller's own batch, in their tenant, while the batch is unexpired, worked items included.

It returns:

- the handle and stage, disposition and reason;
- identity, with phone and email masked on the server so the full values never reach the browser, and the time zone;
- every touch, from the timeline, without payments;
- deals and calls, with the booking answers;
- the opener notes (`leadNotes`);
- respark history from the items.

It returns no payments, credit or links to admin pages, and it is read-only.

### 6.3 Person page (PR 3)

The Lifecycle card (`entity-lifecycle-section.tsx`) gets:

- **the inactive badge**, "Inactive · 127 days", from `lastTouch` and the setting. The detail query returns the setting with the person;
- **"Last touch"**, the date and a label for its event type;
- **the respark not a fit line:** "Set in a respark, by a lead generator, on 24 Oct". It reopens on its own (§4.7) and reads the latest `not_a_fit` item. It names the role, not the person.

No list filter or tab for inactive people.

### 6.4 Settings (PR 3)

A Respark tab after Business day, for `settings:manage`. It holds:

- "Inactive after N days", with a live count from `resparkPool`: "At 90 days, 25,073 people are inactive today";
- the batch size;
- the hold, shown as text: "Held until the business day ends (01:00, America/Tegucigalpa)". There's one option, so no select.

### 6.5 Capture confirmations (PR 2)

The toast and the last-capture card show one of four:

- **"New prospect captured · In conversation from now"**;
- **"Already in the CRM · in conversation"**, with "inactive for N days; this capture makes them active again" when they were inactive;
- **"Already in the CRM · booked"**, with the next call's date when there is one;
- **"Already in the CRM · not a fit"**, with "marked in a respark on …".

Duplicate counting is unchanged.

## 7. Report numbers

### 7.1 My Activity (PR 6)

- **Tiles:** Raw Leads (captures, unchanged), Resparks, Entries (Raw Leads + Resparks), Not a fit, Leads/hr (captures only, unchanged). The two new counts come from `resparkResultsByWorker` over the same business-day range.
- **Table:** a Type column ("Capture", "Respark · resparked", "Respark · not a fit"), merged by time from submissions and worked items. For a respark, Source reads "Respark pool" and Origin reads its bucket.

### 7.2 Lead Gen Ops (PR 6)

A Respark table beside the conversion table, per lead gen specialist:

- Raw Leads, from the daily stats, as the specialist table;
- Resparks and Not a fit, from `resparkResultsByWorker`;
- Entries;
- Not a fit share, not a fit ÷ (resparks + not a fit);
- Resparked, then booked: `respark` credit rows whose respark falls in the range and whose deal has `firstBookedAt`, read by index.

### 7.3 Numbers that change on deploy

- **Lead Gen Ops' conversion table, In conversation column.** It counts a prospect once its In conversation time is at or after the capture. Today that's the captured people who later jumped to Qualified or beyond. After the backfill, nearly every captured person reaches it at capture, so the column nearly equals Prospects. The exceptions are people who were already in conversation, qualified or booked before their first capture; they keep the earlier time and, as today, give that capture no conversion credit. The backfill's dry run counts them.
- **Stage totals** (`leadStageEntries`): 81,196 move from Prospect to In conversation, and the In conversation entry times of the 6,007 captured people past Prospect move to their capture time. Lead counts (Qualified and later) don't change.
- **The Deals column** doesn't change: respark rows aren't `capture` rows.

## 8. What else moves

- `lib/permissions.ts` and `convex/lib/permissions.ts` gain `lead-gen:respark`, and ESLint's guard list is unchanged (`requireTenantUser`).
- `convex/lib/attribution/validators.ts` gains the source. `assertDealAttributions` and the attribution display (`Booked Calls`, the person page credit list) learn `respark`.
- `lib/status-config.ts` (or the timeline labeler) gains labels for `lead.resparked` and `lead.marked_not_a_fit`.
- `convex/testing/operationalData.ts` (the test data reset) and `admin/tenantsMutations.ts` (tenant deletion) list the two new tables.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 0 | This plan, the proposal and pipeline map pages, and the ADR amendment (§11.4) | docs |
| 1 | `lastTouch`, `resparkGroup` and the index; `dispositionSource: "respark"` accepted; `refreshResparkState` from `emitDomainEvent`; `resparkPool` (tolerant); `backfillResparkState` and `assertResparkState` | nothing reads the new fields yet |
| 2 | A capture means in conversation; notes and edits stop setting the stage; the capture returns the person and the four confirmations; `backfillCaptureLifecycle` | the stage only moves forward; readers already treat both stages as below Qualified |
| 3 | `tenants.respark`, the Settings tab, the Lifecycle card's badge, last touch and not-a-fit line | reads PR 1's fields, after its backfill passed |
| 4 | The pool backend: the two tables, `resparkResultsByWorker`, the claim and the three actions, the respark evidence and reopen rules, the credit source, `lead-gen:respark`, the panel query | no screen calls it yet |
| 5 | The Respark screen, the panel and the nav item | PR 4 is live |
| 6 | My Activity and Lead Gen Ops | PR 4 is live |
| 7 | `resparkPool` on strict writes; `CONTEXT.md`, `docs/agents/convex.md` and `auth.md`; this plan's status and log | after every backfill and assert passed |

- **Merge order:** 1, then 2, then 3 and 4 in either order, then 5 and 6 in either order, then 7. PR 3 needs PR 1's backfill to have passed in production, and PR 4 needs PR 2's, because respark evidence joins the derivation that the PR 2 backfill rewrote.
- **Dev:** each backfill runs on dev (`.env.local` without its `CONVEX_DEPLOY_KEY` line) before the PR that needs it merges, and `npx convex dev --once` passes on each branch.

**Production runs, in this order** (§10 has the details):

1. After PR 1:
   - `backfillResparkState` dry run, then the run, over 92,221 people;
   - `assertResparkState`;
   - a read-only check that the `resparkPool` count for each group equals a paged count of the stored `resparkGroup` values with a `lastTouch`, and a recount of the buckets and the inactive people under the §4.3 rule, logged in §13. §2.5 counted with `latestTouch`, so its numbers are a reference, not a target.
2. After PR 2:
   - `backfillCaptureLifecycle` dry run, then the run. Every non-merged person is re-derived. About 81,196 stage moves and up to 6,007 In conversation times are expected, plus the people whose In conversation came from a note or an edit;
   - `assertLeadLifecycle` (reset, about an hour, in the background);
   - `assertResparkState` (reset);
   - a read-only count that finds no one at Prospect.
3. After PR 4: `assertPersonTouches` (reset), and `assertDealAttributions` and `assertBookingAttributions`.
4. After PR 7: `assertResparkState`, `assertLeadLifecycle` and `assertPersonTouches` (reset) once more, as health checks.

## 10. Backfill, parity and assert migrations

All are `migrations.define` in `convex/migrations.ts`, batch 25 like `assertLeadLifecycle` unless the dry run says otherwise. None emits an event. People keep changing between runs, so each assert checks each row against the rule rather than comparing counts.

### 10.1 `backfillResparkState` and `assertResparkState` (PR 1)

- **The backfill:** for each person, it sets `lastTouch` from their domain events (`by_tenantId_and_leadId_and_occurredAt`, newest first, over the person and anyone merged into them, the first event §4.3 counts), sets `resparkGroup`, and writes the `resparkPool` entry with `replaceOrInsert`. Expected: 92,221 people, every non-merged one with a `lastTouch`.
- **The assert** recomputes both for each person and checks the aggregate entry's key. It throws on the first mismatch, naming the lead ID.
- It stays as a rebuild tool and a health check.

### 10.2 `backfillCaptureLifecycle` (PR 2)

- For each non-merged person, it re-derives the lifecycle from `collectLifecycleEvidence` under the new rules and writes the stage, the entry times, the `leadStageEntries` entries and the `prospectConversions` entries. It uses the same helpers as the write path, so all four agree. It also rebuilds the search row when the stage changed.
- It skips people an admin moved back (`lifecycleStageMovedBackAt`), as `assertLeadLifecycle` does. The stage never moves back: it takes the later of the stored stage and the derived one, the way `advanceLifecycle` does.
- It emits no event, so the 81,196 moves don't flood the timeline or the activity counts.
- **Fan-out.** `collectLifecycleEvidence` reads up to 200 deals and their meetings and payments per person. The largest person in production has far fewer, and `assertLeadLifecycle` already runs it at batch 25. A batch that hits a limit resumes from its cursor at batch 1. A single person who can't fit alone stops the run, which goes to the tenant admin as an unexplained failure.
- **`prospectConversionProblems`** (`convex/lib/prospectConversions.ts`) joins the assert, because `assertLeadLifecycle` doesn't check `prospectConversions`.
- **Its dry run** reports the people it would move, by from and to stage, and the people whose times change, as counts.
- **The assert** is the existing `assertLeadLifecycle`, which compares each person with the derivation, plus an inline count of people at Prospect, which must be 0.

### 10.3 Commands

Every command runs against production with `--env-file .env.vercel.production`. Each run goes through a `#!/bin/bash` driver with `set -euo pipefail` that stops when a dry run fails or shows an error. Dry-run output is filtered with `grep -E '"processed"|"DryRun"|error'`.

```
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillResparkState","dryRun":true}'
npx convex run --env-file .env.vercel.production migrations:run '{"fn":"migrations:backfillResparkState"}'
npx convex run --env-file .env.vercel.production --component migrations lib:getStatus '{"names":["migrations:backfillResparkState"]}'
```

- **Order:** dry run, run, poll until `isDone`, the assert the same way, then a read-only recheck.
- **Polling:** a background loop that waits 30 seconds with `perl -e 'select(undef,undef,undef,30)'`.
- **Failures:** a batch that hits a known Convex limit resumes from its cursor at a smaller batch. Any other failure, and any failed assert, stops the phase until a reviewed fix ships and the step passes.

## 11. Decisions

### 11.1 Answered by the tenant admin before planning (2026-10-23 and 24)

The proposal was approved as written:

1. **Bucket order** as §4.4, with the operations lead's bucket first. Inside a bucket, the most recently stalled first.
2. **Credit: both.** The capturer keeps their row, and a resparked person who gets a deal adds a `respark` row for the resparker (§4.6).
3. **No region or shift routing.**
4. **Batch size** is a tenant setting, default 45, held until the business day ends; unworked people go back to the pool.
5. **Not a fit reopens on its own** when the person qualifies, books or is resparked.
6. **`unresponsive` stays** and doesn't change the bucket.
7. **Prospect stays, unused.** It's retired later, once reports read In conversation as the entry stage.

Also decided:

- There's no filter anywhere for inactive people. The pool is the only way to them.
- The rule is called "inactive", because `stale` is a deal loss reason.
- Openers keep notes. Lead generators aren't asked for notes or a reason.
- The Slack modal is dropped.

### 11.2 Design decisions

Recommended; each is the design above.

- **D1. Storage** (§3.1, §4.4). The time rules stay out of storage. `resparkGroup` stores only what changes on a write, and `lastTouch` stores when. Both are indexed together, so a batch is a few index reads and no table scan. `resparkPool` counts the buckets and the inactive people. No cron moves anyone, and changing N rewrites nothing.
- **D2. One choke point** (§5.1). `emitDomainEvent` keeps `lastTouch` and the group current, and `assertResparkState` is the health check.
- **D3. The hold lives on the batch items** (§4.5), not on the person, and Convex's transactions keep two claims apart.
- **D4. `lastTouch` is a new field**, not a wider `latestTouch` (§4.3). Widening `latestTouch` would change what every new deal snapshots for attribution.
- **D5. New permission `lead-gen:respark`**, and the panel answers only for the caller's own unexpired batch (§6.2).
- **D6. Each action rechecks the person** (§4.5): no Resparked or Not a fit on someone who left the pool during the hold, and Not a fit never overwrites an admin's disposition.
- **D7. The credit rule** (§4.6): the latest respark after the person's previous deal and before this one.
- **D8. Skip** keeps the person away from the same lead generator until the business day ends (§4.5).
- **D9. Limits:** inactive after 30 to 365 days, batch size 10 to 100, and a claim reads at most 1,500 people.
- **D10. `do_not_contact` is out of the pool**, and `nurture` is in it like `open`. Both are 0 today.
- **D11. No export.** No row is deleted. The lifecycle backfill is re-derived from the records, and a rerun under the old evidence rules reproduces today's values.
- **D12. Buckets follow the stage** (§4.4), with the two edge cases stated. Both are 0 today.

### 11.3 Answered by the tenant admin on 2026-10-24

Each was accepted as recommended.

- **Q1. A new capture doesn't reopen not a fit.** The capture is recorded and counts as a touch, and the confirmation says the person is not a fit.
- **Q2. DM portal notes and profile edits stop setting In conversation.** In conversation has two live causes: a capture and a respark. The two people who reached it through an old link copy keep it.
- **Q3. Last touch** is today's touches, plus meeting results, deal closings by a person, payments and the two respark actions. System events don't count, the Slack expiry included.
- **Q4. The pool's storage** is D1 to D3: a stored group and last touch time, indexed and counted by an aggregate, with no cron. The tenant admin added: every read uses an index and a bounded or paginated read, never a scan or an unbounded `collect`.
- **Q5. Undo in the browser.** The mutation is sent after 5 seconds or at the next action.
- **Q6. The panel's permission** is `lead-gen:respark`, for lead generators and admins, for people in their own batch until the batch ends.
- **Q7. Production runs.** Approving the plan covers every run in §9 and §10.

The two calls made without a question stand: a qualification or a booking reopens any not a fit (§4.7), and a skip keeps the person away from the same lead generator until the business day ends (§4.5).

### 11.4 Changes to ADR 0001

**A1, in PR 0 (done).** A dated amendment to the status line, plus these rules in "Rules for code" and the Decision's Person bullet:

1. A capture enters the person at In conversation. Prospect stays in the enum, unused, and a DM portal note or edit no longer moves the stage.
2. A lead generator can set not a fit, from a respark, with disposition source `respark`. A respark, a qualification or a booking reopens it.
3. Inactive is a rule: no touch for the tenant's N days, from `lastTouch`, worked out at read time and never stored as a flag.
4. A respark is a touch on the timeline (`lead.resparked`, a lead gen channel touch), and `respark` is a lead gen credit source in `dealAttributions`.

The phase table and "How a phase runs" stay. `CONTEXT.md` (Prospect, In conversation, Touch, and the new Respark and Inactive) changes in PR 7, when the behaviour is live.

### 11.5 Changes made while the phase ran

- **Merged people have no group** (PR 1). Their `resparkGroup` is cleared, so "has a pool entry" is exactly "has a group and a `lastTouch`". The action recheck still treats a merged person as `out`.
- **Last touch, as built** (PR 1). Marking a call held usually writes only the closer's deal move, not a meeting event. So "meeting results and deal closings by a person" is: `meeting.no_show`, `meeting.canceled`, `meeting.status_changed` to held, and every deal move or loss (`opportunity.stage_changed`, `opportunity.marked_lost`, `opportunity.status_changed`) whose source isn't `system`. Events at the same millisecond go to the newer one, as `latestTouch` does.
- **A new person starts in group `out`** (PR 1), set at insert, so every person has a group from birth.
- **Backfill batch sizes:** `backfillResparkState` and `assertResparkState` run at 50; `backfillCaptureLifecycle` at 25.
- **`backfillCaptureLifecycle` stops on a stage it would lower** (PR 2): a person whose records now support a lower stage, or none, throws with their ID. §2.1 expects none. Its population dry run is `previewCaptureLifecycle` (below).
- **The person page's respark not-a-fit line** (PR 3) reads `dispositionSource: "respark"` and `dispositionSetAt` from the person, not the item, so it ships before the items table (§5.3).
- **The claim reads at most 1,000 people, not 1,500 (D9), and at most 3,000 index reads** (PR 4). A candidate costs its lead and, per person merged into them, three index reads (the merge walk, an unworked item, today's skips). The read budget leaves about 1,000 of Convex's 4,096 reads for the batch's writes.
- **An empty pool creates no batch** (PR 4, from the browser QA): the claim returns no batch ID and writes nothing. A batch records `completedAt` when its last person is worked, and the Respark screen's today line counts batches done, not started.
- **Respark needs an active lead gen worker** (PR 4 and PR 5, from CodeRabbit): the actions and the queries reject a lead generator whose lead gen access was turned off, held batch included.
- **Holds and skips follow merges** (PR 4): the hold check reads the items of everyone merged into the person. Items gain two indexes by result, for the hold check and for the respark evidence and credit.
- **A second Not a fit moves `dispositionSetAt`** (PR 4), without an event, so only evidence newer than the latest decision reopens it.
- **Respark evidence and credit read Resparked items only** (PR 4): the stage takes the earliest one; credit takes the latest one between the previous deal and this one (`latestResparkedItemBetween`).
- **Batch cards carry no time zone** (PR 4): it needs the booking's stored payload, so only the person panel reads it. A card reads at most three merged people. A card's loss reason is masked like the panel's text.
- **The credit assert** (PR 4) checks the row's own facts, and that no deal written before the credit began between the respark and the deal, ignoring deals of people merged in after the credit.
- **New indexes** (PR 4): `opportunities.by_tenantId_and_leadId_and_createdAt` (the previous deal) and `dealAttributions.by_tenantId_and_source_kind_and_attributedAt` (the report).
- **The capture backfill's dry run** (PR 2) is `previewCaptureLifecycle`, a read-only paged count over the whole table, because the migration's dry run checks one batch. `assertLeadLifecycle` also checks each prospect's conversion entries, and the backfill syncs them for people whose lifecycle doesn't change.
- **`resparkPoolTotals`** (PR 1), an internal query for the read-only pool check.
- **The blocker purge** recomputes everyone it touched at the end of each call, partial calls included.
- **Capture confirmations, as built** (PR 2): the next call comes from the person's scheduled meetings, a keyed retry says "Capture already recorded", do not contact gets its own line, and a known person's stage is named as stored.
- **Dates in the business day's zone** (PR 3 and PR 7): the Settings count follows an hour-rounded browser clock, and the Lifecycle card's respark line, stage dates and last touch format in the business day's zone, so the server and the browser agree.
- **My Activity pins loaded pages** (PR 6): the merged capture and respark table uses `convex-helpers`' paginated hook, which pins each loaded page, so new activity can't drop a row.
- **CodeRabbit on PR 0:** the Not a fit guard against an admin's disposition is explicit (§5.3); the PR 1 pool check compares the aggregate with the stored groups, not with §2.5; a respark credit row's `attributedAt` is the respark time (§4.6); rollback of PRs 4 to 6 turns the feature off rather than reverting the schema (§12).

## 12. Rollback

Fix forward, reviewed.

- **PR 1:** revert. The new fields stay on the people, unread, and the aggregate stays, unread.
- **PR 2:** revert brings back Prospect for new captures and notes as evidence. The data doesn't revert by rerunning the backfill, since the stage never moves back on its own. A reviewed repair moves each person whose stage no longer matches the old rules back through the correction path (`correctLeadLifecycle`, which may move a stage back and syncs the projections), skipping anyone an admin moved back, then `assertLeadLifecycle`.
- **PR 3:** revert.
- **PR 4 to 6:** once a respark has been worked in production, the rows it wrote stay: the items, the events, the credit rows and the dispositions. They are real history, and Convex refuses a schema that drops the tables or the `respark` source kind while rows use them. So a rollback keeps PR 4's schema, validators, `touchChannel` entry and attribution readers, and turns the feature off instead: it removes `lead-gen:respark` from the roles and the nav item, which hides the screen and rejects every respark mutation. A full revert needs a reviewed data repair first. Before any respark is worked, PR 4 reverts cleanly.
- **PR 7:** revert to tolerant writes.

## 13. Production log

All production runs are on tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, with `--env-file .env.vercel.production`. Times are in UTC.

### 13.1 Baseline, 2026-10-24

§2, at about 06:35 UTC on `2b2e1a4`.

### 13.2 Deploys

Each PR merged after CodeRabbit approved it, and Vercel deployed it to production:

| PR | Merged | Commit | Deployed |
| --- | --- | --- | --- |
| PR 1 (#198) | 04:55, 2026-10-25 | `2f81f93` | 04:57 |
| PR 2 (#199) | 07:43 | `be56a26` | 07:45 |
| PR 3 (#200) | 11:15 | `e3fb290` | 11:18 |
| PR 4 (#201) | 14:27 | `62db7e7` | 14:29 |
| PR 5 (#202) | 16:22 | `55323ec` | 16:24 |
| PR 6 (#203) | 18:29 | `61acb91` | 18:33 |

### 13.3 Runs

**After PR 1:**

- **04:58, before the backfill:** `resparkPoolTotals` returned 0 in every group.
- **04:58 to 06:11:** `backfillResparkState` dry run (50 processed, no error), then the run: success, 92,837 people processed (the table's count by then, merged people included). A machine crash at about 05:10 stopped the poller, not the migration; the status was read at 06:32.
- **06:33 to 07:05:** `assertResparkState` passed on 92,972 people.
- **07:08, read-only pool check** (a paged scan of IDs, enums and times; deleted after):
  - Every one of the 92,967 non-merged people has a group and a `lastTouch`; no merged person has a group.
  - The aggregate equals the stored groups exactly: `out` 4,332, `had_call` 2,429, `qualified` 4,334, `never_qualified` 81,872, `not_a_fit` 0.
  - Under §4.3 as built, the buckets are 3,650 / 50,758 / 1,113 / 774 / 0, a pool of 56,295; 25,535 people are inactive at 90 days.

**After PR 2:**

- **07:46 to 08:11:** `previewCaptureLifecycle`, read only, over 92,975 people:

  | Outcome | People |
  | --- | --- |
  | Prospect → In conversation | 81,872 |
  | Times only, at Customer | 89 |
  | Times only, at Booked | 1,479 |
  | Times only, at Qualified | 3,017 |
  | Times only, at Showed | 154 |
  | Unchanged | 6,359 |
  | Skipped (merged or moved back) | 5 |
  | Would lower a stage | 0 |
  | Conversion entries out of step | 0 |

- **08:10 to 09:59:** `backfillCaptureLifecycle` dry run (25, no error), then the run: success, 92,986 people, no person stopped it.
- **10:00 to 10:32:** `assertResparkState` (reset) passed on 92,993 people.
- **10:03, read-only stage count** (deleted after): 0 people at Prospect. In conversation 81,884, Qualified 5,576, Booked 4,800, Showed 434, Customer 288.
- **10:00 to 11:23:** `assertLeadLifecycle` (reset), now with the conversion entries, passed on 92,998 people.

**After PR 4:**

- **14:30 to 14:40:** `assertDealAttributions` (reset) passed on 11,788 deals, `assertBookingAttributions` (reset) on 7,012 meetings, and `assertPersonTouches` (reset) on 93,071 people.

**Temp files:** the crash cleared the temp directory, including the read-only scan exports from planning (IDs, enums and times; no names or contacts). The scans made during the phase were deleted after each check.

### 13.4 Dev

On the dev deployment (34 people), with `convex dev --once`:

- PR 1: `backfillResparkState` dry run and run, 34 processed; `assertResparkState` passed.
- PR 2: `backfillCaptureLifecycle` dry run and run, 34 processed; `assertLeadLifecycle` and `assertResparkState` (reset) passed.
- PRs 3 to 6 pushed to dev for the browser check. A Codex QA run drove the screens as the dev lead generator and owner: navigation, the Respark screen (claim, cards, undo, keys, panel, batch done), My Activity, capture confirmations, Settings, the person page and Lead Gen Ops all passed. Its one finding, the today line, was fixed in PR 4. It created one test capture and one batch of 8 dev people.
