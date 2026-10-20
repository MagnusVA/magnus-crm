# Phase 2: person first

Status: plan accepted, 2026-10-19. The tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`) accepted every recommendation in §11, and the production runs in §9 run without further approval stops. PR 1 (#132) in review; PRs 2 to 5 (#133 to #136) stacked on it. Production runs start once PR 2 deploys.

Scope comes from §7 of the [lead lifecycle review](../reviews/lead-lifecycle-review.html#roadmap) (findings F1, F3 and F9) and the Phase 2 row of [ADR 0001](../adr/0001-lead-lifecycle-model.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md). Phase 1 is in [phase-1-foundations.md](phase-1-foundations.md).

This file holds IDs and counts only. It contains no personal data.

## 1. Summary

Phase 2 makes every channel find or create the person before anything else happens:

1. **Lead gen capture** finds or creates the person by Instagram handle, at Prospect. The prospect row gets a `leadId`, and each submission is a touch on the person's timeline.
2. **Every existing prospect** gets a person: 4,313 through their audit match, 1,395 through a handle identifier, and 78,367 new persons.
3. **The DM portal**: a portal note or edit is a touch on its person and moves them to In conversation. A copied link names no person: DM closers work people Slack already qualified, and the booking finds them by the Instagram handle on the Calendly form (§4.3, revised 2026-10-20).
4. **One timeline** on the person page, read from `domainEvents`, and the Prospects view in the leads list.
5. **A report**: prospect-to-customer conversion by lead gen worker.
6. **The narrow**: `leadGenProspects.leadId` required, and no code path that creates a prospect without a person.

It ships in eight PRs (§9). Each is safe to deploy alone.

## 2. Production snapshot (2026-10-19)

Read-only inline queries against tenant `k57dqjfyf8qqy31bq375ng8gb984b24q`, the only tenant.

| Table | Rows | Notes |
| --- | --- | --- |
| `leads` | 10,609 | 10,340 active, 267 converted, 2 merged. 5,309 Qualified, 4,620 Booked, 413 Showed, 267 Customer; none at Prospect or In conversation. 9,962 have an Instagram handle, and every one of those handles has its `leadIdentifiers` row. |
| `leadGenProspects` | 84,075 | 47,457 first captured from Instagram, 36,618 from Meta Business; every one is keyed by an Instagram handle. Captured from 2026-05 to now, about 500 new a day. |
| `leadGenSubmissions` | 138,576 | none voided; about 900 a day |
| `leadGenAuditMatches` | 4,313 | all `accepted`, one per prospect, each the prospect's `currentAuditMatchId` |
| `linkPortalCopyEvents` | 5,227 | none carries anything that names a person |
| `leadNotes` | 97 | all written by DM closers in the portal, on 78 persons |
| `linkPortalLeadEdits` | 32 | |
| `slackQualificationEvents` | 8,396 | |
| `leadGenWorkers` | 21 | |
| `dmClosers` | 25 | |

### 2.1 How each prospect finds its person

The same rules as `resolveLeadIdentity`: an Instagram handle identifier decides, a merged lead is followed to the lead it merged into, and a placeholder handle (`isPlaceholderHandle` in `convex/lib/normalization.ts`) never decides.

| Class | Prospects | Person |
| --- | --- | --- |
| Accepted audit match, and the handle identifier points at the same lead | 4,313 | that lead |
| Audit match and identifier disagree | 0 | |
| No audit match, one lead holds the handle identifier | 1,395 | that lead |
| Two or more leads hold the handle | 0 | |
| No lead holds the handle | 78,362 | a new person at Prospect |
| Placeholder handle | 5 | a new person with no identifier (D1) |

- Of the 5,708 prospects that link to an existing person, 121 link to a customer and none to a merged lead (D2).
- The existing persons' stages: 3,367 Qualified, 2,044 Booked, 176 Showed, 121 Customer.
- 4,284 of the 4,313 matched prospects were captured before the person was qualified; the Prospect entry time already comes from their match (Phase 1 §4.1).
- 219 of the 1,395 identifier-only prospects were captured before the person was qualified. Linking them moves those 219 persons' Prospect entry time earlier. No stage changes.
- The 5 placeholder prospects have 13 submissions from 3 workers.

### 2.2 DM portal activity

- The 5,227 copy events name a DM closer, a team, an event type and a campaign, but no person. The only way to tie one to a booking is a time window over the UTM values, which ADR rule 6 forbids. They stay unlinked (D7).
- The 97 portal notes and 32 portal edits name their person. They touch 90 persons: 71 Booked, 10 Showed, 8 Customer and 1 Qualified. None of them came before the person's current In conversation entry time, so counting them as In conversation evidence moves no entry time.

## 3. Schema (PR 1)

All additive.

```ts
// leadGenProspects
leadId: v.optional(v.id("leads")),
.index("by_tenantId_and_leadId", ["tenantId", "leadId"])

// linkPortalCopyEvents
leadId: v.optional(v.id("leads")),
.index("by_tenantId_and_leadId_and_copiedAt", ["tenantId", "leadId", "copiedAt"])

// leadIdentifiers.source gains
v.literal("lead_gen"), v.literal("dm_portal"),
```

A new `DirectAggregate` named `prospectConversions` is mounted in `convex/convex.config.ts` (§7):

- namespace: `tenantId`
- key: `[workerId, stage, firstCapturedAt]`
- id: `` `${prospectId}:${stage}` ``

No new tables. `domainEvents` takes the new touches with its existing fields: entity type `lead`, the person as `entityId` and `leadId`, the worker's or DM closer's team member as `teamMemberId`, source `pipeline`, and the channel and source record ID in `metadata`.

## 4. Rules

### 4.1 Lead gen capture

`leadGen/capture.ts:submit` calls `resolveLeadIdentity` with the Instagram handle, `identifierSource: "lead_gen"`, `createIdentifiers: true` and `initialLifecycle: { stage: "prospect", at: firstCapturedAt }`:

- A person who holds the handle is found, whatever their stage. A captured customer is a touch on the customer (D2).
- Otherwise a person is created at Prospect, with the handle as their identifier and their only social handle. `countsAsLead` leaves them out of `tenantStats.totalLeads` and the leads report until they reach Qualified.
- The prospect row gets the `leadId`, on insert for a new prospect and on its next submission for an older one.
- The person's Prospect entry time becomes the earlier of the stored one and `firstCapturedAt`, through `advanceLeadLifecycle` with cause `lead_gen_capture`. That never changes a stage above Prospect.
- Each submission emits `lead.captured` with the worker's team member, the submission, prospect and worker IDs, the source and the origin kind. A new person also gets `lead.created`, as the other channels emit.
- Voiding a submission emits `lead.capture_voided`.

A prospect who later qualifies in Slack or books in Calendly is the same person: both channels resolve by handle identifier first (Slack sends only the handle), so `recordSlackQualification` or `recordMeeting` moves them to Qualified or Booked. `writeLifecycle` raises `totalLeads` once, when they leave Prospect, and the leads report counts them at their Qualified entry time, once. A test covers each path.

A handle two leads hold makes `resolveLeadIdentity` refuse; the capture then fails with a clear error and reports it. Production has no such handle.

### 4.2 Lifecycle evidence

| Stage | Evidence, earliest wins |
| --- | --- |
| Prospect | `firstCapturedAt` of each prospect with this `leadId`. Until the narrow, also the accepted audit matches, as in Phase 1. |
| In conversation | a copy event's `copiedAt`, a portal note's `createdAt`, a portal edit's `createdAt` |
| Qualified and later | unchanged from Phase 1 §4.1 |

`collectLifecycleEvidence` reads each through its `leadId` index, so the write paths, `assertLeadLifecycle` and the correction path agree.

### 4.3 The DM portal

Revised on 2026-10-20 by the tenant admin (`k97fgy2ckqhn8w2xynw3etwdf984dwb9`), after PR 3 shipped. DM closers work people who are already qualified; they don't create them. The booking finds its person by the Instagram handle the invitee enters on the Calendly form: of the Slack-qualified deals created 30 to 60 days before 2026-10-20 that booked, 511 of 516 booked through event types whose form asks for it. The UTMs name the team and the DM closer. So the portal doesn't name the person on a copied link:

1. Copying a link records the copy event as before Phase 2: DM closer, team, event type and campaign, no person. The link carries no person ID, and the copy moves no one's stage.
2. A portal note and a portal edit already name their person. Each moves the person to In conversation and emits `lead.portal_note_added` or `lead.portal_profile_updated`, with the DM closer's team member.

PR 3 had the DM closer enter the person's Instagram handle before copying, found or created the person from it, and put the person's ID in the link's `utm_content`. PR 7 removes that. The 10 copies made while it was live keep their `leadId` and `lead.portal_link_copied` touches, and the persons they created stay; the lifecycle evidence still reads copies that have a person. The same per-DM-closer and tenant-wide write limits the notes use still cover copies. The portal search keeps showing customers first, then the rest, so prospects don't push customers out of the 20 results.

### 4.4 A booking from a portal link

Joins its person as any Calendly booking does: by the invitee's email, phone or Instagram handle (`resolveLeadIdentity`). PR 3's join on the link's person ID is removed with the portal handle (§4.3). A link copied while PR 3 was live still carries a lead ID in `utm_content`; the booking ignores it.

## 5. Write paths

| Event | Where | Change |
| --- | --- | --- |
| Lead gen capture | `leadGen/capture.ts:submit` | §4.1 |
| Submission voided | `leadGen/corrections.ts:voidSubmission` | `lead.capture_voided` |
| Slack audit match | `leadGen/auditMatching.ts` | sets the prospect's `leadId` when it has none |
| Portal copy | `linkPortal/copyMutations.ts` | none: the copy names no person (§4.3) |
| Portal note, edit | `linkPortal/leadMutations.ts` | In conversation, touch event |
| Calendly booking | `pipeline/inviteeCreated.ts` | none (§4.4) |
| Slack qualification | `slack/createQualifiedLead.ts` | `lead.slack_qualified` touch with the setter's team member, for every qualification, including the ones that join an open deal |
| Merge | `leads/repointLeadReferences.ts:moveRemainingLeadRows` | moves prospects and copy events, and re-syncs `prospectConversions` |
| Any stage write | `lib/leadLifecycle.ts:writeLifecycle` | re-syncs `prospectConversions` for the person's prospects |

## 6. Timeline and Prospects view (PR 4)

### 6.1 Timeline

`leadCustomers/timeline.ts:getLeadTimeline` reads `domainEvents` through `by_tenantId_and_leadId_and_occurredAt`, newest first, for the person and for each lead merged into them (`leadMergeHistory.by_targetLeadId`), and returns the newest 100 with a cursor for more. The person page's activity section renders it in place of the list it builds today from deals, meetings and payments:

- captures, with the worker, source and origin
- portal copies, notes and edits, with the DM closer
- Slack qualifications, with the setter
- deals created, bookings, reschedules, cancellations, no-shows, outcomes, follow-ups
- payments and conversion
- lifecycle stage and disposition changes

Each touch names its team member through `teamMemberId`. Event types the page doesn't know render as their type name, so a new touch shows up before it gets a label.

### 6.2 Prospects view

The toolbar gains a Prospects toggle beside All, Leads and Customers. It lists and searches the hidden prospect rows through the filter Phase 1 built (`?lifecycle=prospect`). A person at In conversation sits in this view too, since both stages are below Qualified.

## 7. The conversion report (PR 5)

Prospect conversion by lead gen worker, on the lead gen operations page (D5), for a range of capture dates:

| Worker | Prospects | In conversation | Qualified | Booked | Showed | Customer |
| --- | --- | --- | --- | --- | --- | --- |

- Credit goes to the prospect's `firstCapturedByWorkerId`, an existing column. No attribution column is added; Phase 3's attribution rows replace this source.
- Prospects counts each prospect first captured in the range.
- A later stage counts a prospect only when the person reached it at or after the first capture (D6). A worker who captures an existing customer gets the prospect, not the sale.
- Each cell is one bounded count on `prospectConversions`. An entry exists for each linked prospect at Prospect, and at each later stage the person reached at or after `firstCapturedAt`. `writeLifecycle`, the capture, the backfill and the merge keep them in step.

## 8. What the new prospect rows break, fixed in PR 1

The backfill takes `leads` from 10,609 to about 89,000 rows, 78,367 of them prospects with no email. A read-only survey of the code found these:

| Where | Problem | Fix |
| --- | --- | --- |
| `leads/identityResolution.ts:detectPotentialDuplicate` | reads the 50 newest leads, which would all be prospects with no email, so duplicate detection would stop | reads the 50 newest visible lead rows, through a new `leadCustomerSearchRows` index on `firstSeenAt` |
| `leads/queries.ts:searchLeads`, the merge picker | prospects match by handle and fill the 20 results | searches visible lead/customer rows only |
| `admin/migrations.ts:seedTenantStatsInternal` | collects every lead and counts active rows: over the read limit, and it would count prospects | counts with `countsAsLead`, in pages |
| `linkPortal/leadQueries.ts:searchLeadsForSession` | prospects can push customers out of the 20 results | §4.3 |
| `reporting/teamActions.ts` | reads the first 5,000 events in the range; the touches add about 1,000 a day, so closer actions would be cut off | reads only `source: "closer"` events, through a new `domainEvents` index on `source` |
| `admin/migrations.ts`: `backfillLeadStatus`, `auditOrphanedTenantRows`, `auditPhase6Readiness` | one-off admin scans of the whole table, over the read limit at the new size | removed; nothing calls them |

The activity report's summary already stops at 10,000 events and says so. With the touches it stops for ranges longer than about nine days. Phase 6's row in the ADR gains it: the summary counts from an aggregate.

## 9. Deploy order

| PR | What | Safe alone because |
| --- | --- | --- |
| 1 | Schema widen (§3), the §8 fixes, merge moves prospects and copy events, `emitDomainEvent` option to skip PostHog for backfills | optional fields and an empty aggregate; the fixes work on today's data |
| 2 | Capture write path (§4.1), lifecycle evidence (§4.2), `prospectConversions` writes, the capture backfills and asserts (§10.1, §10.2) | a prospect without a `leadId` is one the backfill hasn't reached, and the evidence reads both sources |
| 3 | DM portal (§4.3), booking join (§4.4), the portal backfill (§10.3) | a copy needs a person only in the new client, which ships with the backend; a booking without a portal person ID takes today's path |
| 7 | Removes the portal handle and the booking join (§4.3, §4.4); ships before PR 6 | the copy goes back to its pre-Phase 2 shape, and a booking matches by identifiers, as one without a portal person ID already did |
| 4 | Timeline and Prospects view (§6), Slack touches and their backfill (§10.4) | the timeline and view only read; the Slack touch is one more event beside the qualification's existing writes, and the backfill skips a Slack event that already has its touch, so new and backfilled touches never double |
| 5 | Conversion report (§7) | reads only |
| 6 | Narrow (§10.5), the ADR status and the review's Phase 2 card | after every backfill and assert passed in production |
| 0 | This plan | docs |

Production runs, in this order (§10.6 has the commands):

1. After PR 2: `linkProspectPeople` dry run, real run, `assertProspectPeople`; `backfillCaptureEvents`, `assertCaptureEvents`; `assertLeadLifecycle`; read-only recheck.
2. After PR 3: `backfillPortalTouches`, `assertPortalTouches`, `assertLeadLifecycle`.
3. After PR 4: `backfillSlackTouches`, `assertSlackTouches`, then `assertDomainEventLinks` over all events.
4. After PR 6 deploys: the schema push checks every prospect's `leadId`; `assertLeadLifecycle` once more.

## 10. Backfill and assert migrations

All are `migrations.define` in `convex/migrations.ts`. The backfills emit their events without PostHog, as Phase 1's did not flood it.

### 10.1 `linkProspectPeople` / `assertProspectPeople` (PR 2)

Over `leadGenProspects`, batch 50, skipping a prospect that has a `leadId`:

- the person is the accepted audit match's lead, followed through merges; else `resolveLeadIdentity` by handle, which finds the identifier's lead or creates the person at Prospect at `firstCapturedAt`
- a placeholder handle creates a person with no identifier (D1)
- set `leadId`, advance the Prospect entry time, insert the `prospectConversions` entries

No `lead.created` events for the backfilled persons: their capture events (§10.2) open their timelines.

The assert checks that every prospect has a `leadId` in its tenant, that the lead isn't merged, that the lead holds the handle identifier or is the audit match's lead, that the lead's Prospect entry time is at or before `firstCapturedAt`, and that the prospect's `prospectConversions` entries match the rule in §7.

Expected, from §2.1 plus what arrives in between: 84,075 prospects, 5,708 linked to existing persons, 78,367 new persons, 219 earlier Prospect times, no stage change on an existing person, `tenantStats.totalLeads` unchanged, and `stageTotals` up by 78,367 at Prospect only.

### 10.2 `backfillCaptureEvents` / `assertCaptureEvents` (PR 2)

Over `leadGenSubmissions`, batch 200. For each submission whose prospect has a `leadId` and that has no `lead.captured` event (looked up by person and `submittedAt`, matched on the submission ID), insert one. A voided submission also gets its `lead.capture_voided`. The assert checks that each submission has exactly one.

Expected: 138,576 events plus what arrives in between; about 700 batches.

### 10.3 `backfillPortalTouches` / `assertPortalTouches` (PR 3)

Over `leadNotes` and `linkPortalLeadEdits`: one touch event each, 97 and 32, and the In conversation advance, which moves no entry time (§2.2). The historical copy events get no person (D7).

### 10.4 `backfillSlackTouches` / `assertSlackTouches` (PR 4)

Over `slackQualificationEvents`, batch 100: one `lead.slack_qualified` event per event with a `leadId`, about 8,400.

### 10.5 Narrow (PR 6)

- `leadGenProspects.leadId` becomes required. The schema push itself checks every row.
- `linkPortalCopyEvents.leadId` stays optional: copies name no person after PR 7 (§4.3), and the 10 made while PR 3 was live keep theirs.
- The Prospect evidence reads prospects only; the audit match evidence goes.
- `linkProspectPeople`, `backfillCaptureEvents`, `backfillPortalTouches` and `backfillSlackTouches` go, with their asserts. `assertLeadLifecycle` stays as a health check.
- The ADR's Phase 2 status and the review's Phase 2 card are updated.

### 10.6 Commands

Every run uses `--env-file .env.vercel.production`. Poll `npx convex run --component migrations lib:getStatus '{"names":["migrations:<name>"]}'` until `isDone`. Filter dry-run output with `grep -E '"processed"|"DryRun"|error'`.

```
npx convex run migrations:run '{"fn":"migrations:linkProspectPeople","dryRun":true}'
npx convex run migrations:run '{"fn":"migrations:linkProspectPeople"}'
npx convex run migrations:run '{"fn":"migrations:assertProspectPeople"}'
npx convex run migrations:run '{"fn":"migrations:backfillCaptureEvents"}'
npx convex run migrations:run '{"fn":"migrations:assertCaptureEvents"}'
npx convex run migrations:run '{"fn":"migrations:assertLeadLifecycle","reset":true}'
npx convex run leads/lifecycleChecks:stageTotals '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
npx convex run migrations:run '{"fn":"migrations:backfillPortalTouches"}'
npx convex run migrations:run '{"fn":"migrations:assertPortalTouches"}'
npx convex run migrations:run '{"fn":"migrations:backfillSlackTouches"}'
npx convex run migrations:run '{"fn":"migrations:assertSlackTouches"}'
npx convex run migrations:run '{"fn":"migrations:assertDomainEventLinks","reset":true}'
```

## 11. Decisions

Each has a recommendation. The tenant admin accepted all nine recommendations on 2026-10-19; the phase runs to the end on them.

- **D1. A prospect with a placeholder handle.** Recommended: a new person with no identifier, as a Calendly booking with only a placeholder email gets today. The 5 prospects and their 13 submissions are kept, and nothing can ever match them. The other option deletes the 5 prospects and voids their 13 submissions, which changes 3 workers' historical counts.
- **D2. A prospect whose handle belongs to a customer or a merged lead.** Recommended: link to that person, following a merge to the surviving lead. 121 prospects link to customers and none to a merged lead. The capture is a touch on the customer, and it can't move the stage back.
- **D3. First touch on a person who already has a Slack or Calendly history.** Recommended: first touch is the earliest touch in time, whatever the channel. A capture of someone already qualified is a later touch, not their first. Phase 2 stores no first-touch field: the capture event and the prospect's existing `firstCapturedByWorkerId` and `firstSource` hold it, and Phase 3 freezes it on the person from the timeline. The other option makes a lead gen capture always the first touch, which would credit a worker for a person Slack brought in earlier.
- **D4. A portal booking whose identifiers disagree with the link's person.** Moot since PR 7 (§4.4): links carry no person, and a booking joins whoever its identifiers find. While PR 3 was live, identifiers won and the link's person became the deal's `potentialDuplicateLeadId`.
- **D5. Where the conversion report lives.** Recommended: the lead gen operations page, beside the other per-worker numbers. The leads report keeps counting people who reached Qualified. The other option adds it to both pages, which means two copies to keep in step.
- **D6. Which stages credit the worker.** Recommended: a stage counts for a prospect only when the person reached it at or after the first capture; every captured prospect counts in Prospects. The other option counts every stage the person ever reached, which credits 1,205 captures of people who were already qualified when captured (1,176 identifier-only, 29 matched).
- **D7. The 5,227 copy events with no person.** Recommended: keep them, unlinked; `leadId` stays optional in the schema for them. The copy mutation required it from PR 3 until PR 7, and copies name no person after PR 7 (§4.3). The other option deletes them, which loses the DM closers' copy history from May to now.
- **D8. Touches in the event log.** Recommended: every capture, portal action and Slack qualification is a domain event, history included: about 147,000 events now and 1,000 a day. The timeline is then one read, and Phase 3 derives first and latest touch from it. Team actions reads closer events through a source index (§8); the activity summary's aggregate goes to Phase 6. The other option backfills only each prospect's first capture (84,075) and reads repeat captures from `leadGenSubmissions`, which leaves two sources for one timeline.
- **D9. Production runs.** Recommended: the order in §9, batch 50 for `linkProspectPeople` (about 1,700 batches) and 200 for `backfillCaptureEvents` (about 700), one migration at a time so the `leadStageEntries` and `prospectConversions` writes don't contend. No deletions. Dry run first for `linkProspectPeople`, then each run as soon as the previous assert passes, with no approval stop in between.

## 12. Rollback

Fix forward, reviewed, as the split's recovery was. No snapshot is held.

- **PR 1, 4, 5.** Revert. Nothing writes the new fields yet, or the PR only reads.
- **PR 2 code.** Revert. New prospects then have no `leadId` again until a fix ships; the persons already created stay, which is correct.
- **`linkProspectPeople`.** The 78,367 persons it creates are new rows with no deals. A wrong link is fixed per prospect with an internal repair mutation that moves the prospect, its events and its `prospectConversions` entries to the right person; a person created in error with nothing else on it is deleted through the same lead deletion path the split used, with its identifier, search row and stage entries. Each repair is a reviewed PR.
- **Touch events.** Each carries its source record ID in `metadata`, so a repair can find and delete exactly the events one backfill wrote.
- **PR 3.** Revert restores today's copy flow. Persons the portal created stay, at In conversation.
- **PR 6.** Revert makes `leadId` optional again; no data changes.

## 13. Production log

Empty until the first run.
