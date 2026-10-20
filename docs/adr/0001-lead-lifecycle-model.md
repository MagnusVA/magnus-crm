# 0001. One person record, deals with a stage and an outcome

Status: accepted, 14 October 2026. Amended 19 October 2026 with "How a phase runs" and the phase statuses.

Source: the [lead lifecycle review](../reviews/lead-lifecycle-review.html). Findings are in [§3](../reviews/lead-lifecycle-review.html#findings), the target model in [§6](../reviews/lead-lifecycle-review.html#target), the migration path in [§7](../reviews/lead-lifecycle-review.html#roadmap), and the locked decisions in [§9](../reviews/lead-lifecycle-review.html#decisions). Terms are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Context

The CRM has no record of a person until a Slack qualifier, a Calendly booking, or a side deal creates a lead. Lead gen captures live in `leadGenProspects` with no link to a lead, and the DM portal cannot create one. `opportunities.status` carries four jobs at once: funnel step, a copy of the meeting's state, a pending task, and the final result. The first payment copies the lead into a `customers` row with one program. The people who get credit live in four tables, and attribution sits in six copies.

Each new role arrived with its own person, staff, schedule, and attribution tables, and the next role would repeat the pattern. Identity is decided at booking time with heuristics, which put 68 people on 4 leads in production. The data model is the problem, not runtime capacity, so we change it in phases and do not rewrite it.

## Decision

### The target model

- **Person.** The `leads` row is the person. Every channel that brings a person in finds or creates it through one identity function before any deal exists: lead gen capture, Slack, Calendly, and side deals. The DM portal works people who already exist and creates no one. It has a lifecycle stage with an entry time per stage, and a disposition. `merged` stays a separate flag because it is identity housekeeping, not lifecycle.
- **Identity.** Only strong identifiers decide who someone is. Placeholder values never count, and no time-window heuristic joins a booking to another person's deal. An ambiguous match goes to a review queue, as `potentialDuplicateLeadId` does today.
- **Deal.** The `opportunities` row is the deal, one per buying attempt. It gets a deal stage (Qualified, Booked, Call held, Follow-up, Closed) and an outcome (open, won, lost with a reason). A no-show or cancellation happens to a meeting. It creates a rebook task and moves the deal to Follow-up, so no deal is ever "no_show".
- **Meeting.** A meeting records attendance only: scheduled, held, no-show, canceled. Today `completed` means "a closer recorded something", and no-show meetings get a `completedAt` too. In the target, held means the call happened, and the time a closer recorded the result is its own field.
- **Task.** Follow-ups, scheduling links, and reminders are tasks with due dates.
- **Team member.** One row per human who can get credit, linked to their user, lead gen worker, Slack user, and DM closer records. The existing tables keep their role-specific settings.
- **Deal attribution.** One row per deal, role, and team member, with its source and time. Roles are lead gen, setter, DM closer, and closer. Rows are written when a deal is created and when a booking joins it. Reassigning a meeting adds a row and never replaces one.
- **First and latest touch.** The person keeps a frozen first touch and an updating latest touch. Each deal snapshots both at creation, so later edits cannot change past credit.
- **Enrollment.** One row per person and program they bought, with its own active, paused, or churned status. Customer becomes a lifecycle stage, and contact fields stay on the person.
- **Timeline.** `domainEvents` gains a person ID and a team member ID and becomes the touch timeline. There is no second event log.
- **One write path per entity.** One function per entity, starting with `transitionOpportunity`, owns the state machine and the domain event. No other code patches opportunity status. Projections that only copy data may hang off `convex-helpers` triggers later.
- **Stage list.** Deal stages are literals defined once, in one module, each with an open, won, or lost category.

### The five decisions, locked 14 October

| Question | Decision | Effect on the plan |
| --- | --- | --- |
| Should every lead gen capture become a person? | Yes, by default. | Phase 2 creates a person for every capture and backfills every prospect. Phase 1 first makes lead counts stage-aware. |
| Who gets credit, and how much? | No commissions yet. Attribution must be tracked and shown correctly. | Phase 3 stores role-based attribution rows with no shares. A share can be added later as one optional field. |
| Is a second program a new deal? | Yes. | Phase 0 removes the Slack and side-deal rules that block it. Phase 4 adds enrollments. |
| Should setter activity be tracked per person? | Yes, through the DM portal setters already use. | Phase 2 records portal notes and edits as touches on the person, and each Slack qualification as a touch with the setter. Copied links name no person: the booking finds the person by the Instagram handle on the Calendly form, and the UTMs name the team and DM closer (revised 2026-10-20). |
| Will tenants run different funnels? | Not for now. The PT Domination funnel is locked. | Configurable pipelines are dropped. The stage list lives once in code. |

These are settled. Reopen one only with the product owner, and record the change as a new ADR that supersedes this one.

### Where each term lives today

| Term | Today | Target |
| --- | --- | --- |
| Person | `leads`, plus a copy in `customers` | `leads` with lifecycle stage and disposition |
| Identifier | `leadIdentifiers` | Unchanged, with placeholder rules |
| Prospect | A `leadGenProspects` row with no lead | A person at the Prospect stage; the prospect row keeps a `leadId` |
| Deal | `opportunities` | `opportunities` with stage and outcome |
| Deal stage and outcome | Both inside `opportunities.status` | Separate `stage` and `outcome` fields |
| Meeting | `meetings`, with its status copied onto the opportunity | `meetings`, attendance only |
| Task | `followUps`, plus the `follow_up_scheduled` and `reschedule_link_sent` statuses | `followUps` |
| Team member | `users`, `leadGenWorkers`, `slackUsers`, `dmClosers` | `teamMembers` linking all four |
| Attribution | `assignedCloserId`, `qualifiedBy`, `attributionTeamId`, `dmCloserId`, lead gen `workerId`, copied into projections | `dealAttributions` |
| Enrollment | One program on the `customers` row | `enrollments` |
| Touch | `domainEvents`, `leadNotes`, `meetingComments`, `leadGenSubmissions`, `slackQualificationEvents`, and others | `domainEvents` with a person ID |

### How today's opportunity statuses map

| `opportunities.status` | Deal stage | Outcome | Meeting | Task |
| --- | --- | --- | --- | --- |
| `qualified_pending` | Qualified | open | none | none |
| `scheduled` from Calendly | Booked | open | scheduled | none |
| `scheduled` from a side deal | Call held | open | none | none |
| `no_show` | Follow-up | open | no-show | rebook |
| `canceled` | Follow-up | open | canceled | rebook |
| `reschedule_link_sent` | Follow-up | open | no-show | rebook, link sent |
| `follow_up_scheduled` | Follow-up | open | usually held | scheduling link or reminder |
| `payment_received` | Closed | won | held | none |
| `lost` | Closed | lost, with reason | any | none |

## Rules for code written now

The migration runs one phase at a time, and the old model stays live until each phase narrows it. Until then, new code must not extend the old model.

1. **No new opportunity status.** Every literal costs 30 to 40 files and a backfill, and Phase 5 has to map it. If a feature seems to need one, it is probably a task, a meeting fact, or a deal stage. Raise it before adding it.
2. **Opportunity status changes go through one function.** `transitionOpportunity` in `convex/lib/opportunityActivity.ts` is that function. No code calls `ctx.db.patch` on an opportunity's `status`, and no code moves a status without the state machine in `convex/lib/statusTransitions.ts`. Exceptions are named transitions inside that function, not bypasses at the call site.
3. **No new person, staff, or schedule table.** A new channel finds or creates the person through `resolveLeadIdentity`. A new role becomes a team member role (Phase 1), not another table like `leadGenWorkers` or `dmClosers`.
4. **No new attribution column.** Don't add another `*CloserId`, `*TeamId`, or `qualifiedBy` shape. Until `dealAttributions` exists, extend the existing columns and say so in the PR.
5. **No new copies of person fields.** Read contact details from the lead. Don't add fields to `customers`, because customer is becoming a stage.
6. **Strong identifiers only.** Don't add a key that a placeholder value can satisfy, and don't add a time-window join between bookings and deals.
7. **A won deal never blocks a new one.** A second program is a new deal for the same person.
8. **Lifecycle never moves backwards on its own.** A lost deal does not make a customer a lead again in reports.
9. **One timeline.** A new kind of person event goes through `emitDomainEvent`, not into a new log table.

## Migration path

Every phase ships as widen, migrate, narrow, with a paired `assert*` migration, because production holds one live tenant. Detail per phase is in [§7 of the review](../reviews/lead-lifecycle-review.html#roadmap).

| Phase | What ships | Schema | Ends with | Status |
| --- | --- | --- | --- | --- |
| First | This record and the glossary | None | | Done, #93 |
| 0. Stabilize | Polluted-lead split, guards first ([plan](../plans/polluted-lead-split.md)). `transitionOpportunity` for every status change. Second programs unblocked. Slack opportunities that never booked expire after 30 days, and the Slack check runs before the 14-day reschedule heuristic. `mergeLead` repoints every lead-keyed table. | None | The split's staging tables and code gone; only the identity guards stay. | Done, #91 to #111 and #122 to #128 |
| 1. Foundations | Lifecycle stage, stage entry times, and disposition on leads. Stage-aware lead counts. `teamMembers`. Person and team member IDs on `domainEvents`. | Additive | The three lifecycle fields required; `leadTimeline` gone. | Done, #112 to #129 ([plan](../plans/phase-1-foundations.md)) |
| 2. Person first | Lead gen capture creates or finds the person through `resolveLeadIdentity`, at the Prospect stage. Backfill every prospect. Portal notes and edits move the person to In conversation. One timeline on the person page, and the Prospects view in the leads list. Prospect-to-customer conversion by lead gen worker as a report. | Widen, then narrow | `leadGenProspects.leadId` required, and no code path that creates a prospect without a person. | Done, #131 to #138 ([plan](../plans/phase-2-person-first.md)) |
| 3. Attribution | `dealAttributions`, one row per deal, role and team member. First and latest touch on the person, snapshotted on the deal. Booked Calls, qualifications and lead gen operations read the rows. | New table, then narrow | The copied `attributionTeamId` and `dmCloserId` columns and their projection copies gone. | Next |
| 4. Customers | `enrollments`, one per person and program bought. Customer pages read person plus enrollments. The conversion email requirement goes away, and an admin payment for a new program goes through a new deal. | New table, then narrow `customers` | The copied contact fields gone from `customers`, and `recordCustomerPayment` retired. | |
| 5. Deal status | `stage` and `outcome` beside `status`, written by `transitionOpportunity`. Every reader moves: aggregates, projections, reports, the closer pipeline. | Widen, dual-write, narrow | `opportunities.status` gone, and the stage list defined once in one module. | |
| 6. Runtime cleanup | The runtime fixes from the review's F11: `tenantStats` counters into aggregates, the open loops in `adminStats` and the closer dashboard bounded, the unused indexes and dead fields dropped, one definition of "day" per screen. The activity report's summary counts from an aggregate instead of reading up to 10,000 events: Phase 2's touch events (about 1,000 a day) cut it off for ranges longer than about nine days. | Narrow | No item from F11 open, and the activity summary counts every event in its range. | |

The split has to land before Phase 2, whose backfill matches prospects to leads by Instagram handle. Phase 1 has to land before Phase 2, or the leads report counts every capture as a new lead. Phases 4 and 5 can swap. Phase 6 runs last, because Phase 5 frees the status indexes it drops.

### How a phase runs

Decided by the tenant admin on 2026-10-19, after Phase 1 took longer than it needed to because work was left for later dates. Production holds one beta tenant that accepts the risk, and there are no paying customers, so the schedule bends to the work, not the other way round.

1. **One phase per thread, finished end to end.** A phase runs in its own thread and worktree, from plan to narrow, and the thread stops when the phase is done. It does not start the next phase. The next phase starts from a fresh thread with the finished phase's record.
2. **Nothing is deferred.** A phase ends when every item in its row above is live in production and the narrow has shipped. No item waits for a date, a soak period, a later phase, or "when the first rows exist". If a phase finds work that belongs to a later phase, it writes it into that phase's row here, in the same PR, and does not leave it in a "left for later" list.
3. **No waiting periods.** The 24-hour recheck and the 30-day hold before a narrow are gone. A narrow ships as soon as its backfill and assert pass in production and a read-only recheck agrees. Rollback is a reviewed fix-forward repair, as the split's recovery was, not a held snapshot. A production export taken before a destructive migration is deleted when the phase ends.
4. **Data changes stay deliberate.** The plan doc for the phase (`docs/plans/phase-<n>-<name>.md`) holds a read-only production snapshot, the schema change, the write paths, each backfill with its assert and expected counts, the deploy order, the decisions, and the rollback. The phase brings every design decision and every production run, including deletions, to the tenant admin in one batch with a recommendation for each. Once answered, the phase runs to the end without further approval stops. It stops again only for an assert that fails for a reason it can't explain, a deletion the plan didn't name, or a change to this record.
5. **Each PR deploys alone.** Merging deploys to production, so every PR is safe on its own: additive schema first, code that tolerates rows the backfill hasn't reached, and a required-field narrow only after its backfill and assert have passed in production.
6. **The record is part of the phase.** The plan doc's status line and production log are current when the phase ends, with IDs and counts only, and the status column above is updated in the same phase.

## Considered and rejected

- **A rewrite.** One live tenant with 10,800 opportunities and a reporting stack built on the current fields can't absorb one.
- **A separate qualification record**, like HubSpot's Leads object or iClosed's discovery call. Setters here qualify in one Slack step, so a deal that starts at Qualified plus touches covers it with one entity fewer.
- **Lead conversion that copies the person**, as Salesforce does. That is the `customers` problem; don't add another copy.
- **Appointment outcomes as deal stages.** A deal stage of No-show tracks the calendar instead of the sale, which is today's status field again.
- **Configurable pipelines.** Dropped by decision 5. Defining stages once in code keeps the option open.
