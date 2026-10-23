# Convex backend

Read `convex/_generated/ai/guidelines.md` before changing Convex code. It covers validators, internal functions, indexes, bounded queries, `"use node"` files, scheduling, and crons, and it overrides general Convex knowledge. This guide covers what's specific to this repo; auth guards are in `docs/agents/auth.md`.

## Modules worth knowing

Most folders under `convex/` are named for their table or feature. The ones whose names don't explain them:

- `pipeline/`: processes stored Calendly webhook events into leads, opportunities, and meetings
- `webhooks/`: Calendly HTTP ingestion and raw event cleanup
- `reporting/`: aggregates, write hooks, backfills, and business-time helpers
- `operations/`: operations dashboards, their projections, and `reports/`, the async report export job system
- `leadCustomers/`: the combined lead and customer search projection
- `attribution/`: DM teams and DM closers
- `linkPortal/`: the shared-password DM portal

## Schema

- Every tenant table has `tenantId: v.id("tenants")`, and status fields are `v.union(v.literal(...))`.
- Money is an integer in minor units (`amountMinor`) next to a `currency` code. Convert input with `toAmountMinor` and `validateCurrency` from `convex/lib/formatMoney.ts`.
- `convex/lib/statusTransitions.ts` defines the meeting and lead state machines; the deal's stage machine is in `convex/opportunities/stages.ts`. Its validators return a boolean and log, so the caller rejects the write on `false`.

## Lead lifecycle model

The lead and opportunity tables follow the model in `docs/adr/0001-lead-lifecycle-model.md`: one person record for life, deals with a stage and an outcome, meetings that hold attendance only, and attribution as its own record. `CONTEXT.md` defines the terms. Follow the ADR's "Rules for code":

- Don't add a deal stage, a meeting status, a person, staff, or schedule table, an attribution column, or a copy of a person field.
- Change a deal's stage only through `transitionOpportunity` (`convex/lib/opportunityActivity.ts`), never with a raw `ctx.db.patch`. "Write side effects" below covers it.
- Create or find the person through `resolveLeadIdentity`, and never let a placeholder value or a time window decide identity.
- A won deal doesn't block a new deal for the same person.

## Write side effects

The repo has no triggers. A mutation that inserts, updates, or deletes a meeting, opportunity, payment, lead, or enrollment also updates:

- reporting aggregates through `convex/reporting/writeHooks.ts` (`insert*`, `replace*`, and `delete*Aggregate`), which also update billing aggregates, Pipeline Health's `openDealAging` and `personLosses`, and enqueue operations meeting projections. `updateOpportunityMeetingRefs` replaces `openDealAging` itself, since it patches `nextMeetingAt` directly. Two more aggregates have their own hooks: `activityEventCounts` in `emitDomainEvent` (and wherever events are deleted), and `leadGenDealsByWorker` in the `dealAttributions` insert and delete helpers. All of them use the strict `insert` / `replace` / `delete`; a report reads an aggregate only while its tenant verification flag is set. To rebuild one, run its backfill, then its assert, then its mark mutation (`markPipelineHealthAggregatesVerified`, `markLeadGenDealsByWorkerVerified`, or `markActivityEventCountsVerified` for each of the last 30 business days); the mark sets the flag only when both succeeded, in that order
- the domain event log through `emitDomainEvent` (`convex/lib/domainEvents.ts`), which also keeps the person's first and latest touch current (`recordPersonTouch` in `convex/lib/touches.ts`) and writes the event's `activityEventCounts` entries
- a meeting's attendance through `completeMeetingForOutcome` (`convex/lib/meetingOutcomeCompletion.ts`): a recorded result sets `status: "held"` and `heldMarkedAt`; a no-show sets `noShowMarkedAt`. A meeting is `scheduled`, `held`, `no_show` or `canceled`. "Not recorded" is a display rule (`meetingAttendanceDisplay` in `lib/status-config.ts`), never a stored status
- credit rows in `dealAttributions` through `convex/lib/attribution/dealAttributions.ts`: `recordBookingAttribution` after every meeting a booking inserts, `recordDealCreation` once after the event that creates a deal (it also snapshots the person's touches onto the deal), `recordSetterAttribution` when a Slack qualification creates or joins a deal, `recordCloserReassignment` when a reassignment changes the closer, and `deleteDealAttributions`, `deleteMeetingAttributions` or `moveMeetingAttributions` when a deal or meeting is deleted or moved. A reassignment or a new host adds a row and never rewrites an earlier one; `assignedCloserId` is the working owner, not credit
- opportunity meeting refs through `updateOpportunityMeetingRefs` (`convex/lib/opportunityMeetingRefs.ts`), which also rebuilds the opportunity and lead/customer search rows
- qualification rows through `rebuildQualificationRowsForOpportunity` (`convex/operations/projections.ts`)
- the person's enrollments and customer state through `syncPersonEnrollments` (`convex/lib/enrollments.ts`), once after any write that adds a payment, disputes one, changes its program or time, or moves its deal to another person. It derives the enrollments from the payments, emits `enrollment.created` and `enrollment.removed`, moves `leads.status` between `active` and `converted` with a `lead.status_changed` event, and rebuilds the search row; pass the actor and source. Migrations use `writePersonEnrollments`, which writes only the enrollments. An admin's status change goes through `updateEnrollmentStatus`
- the person's lifecycle stage through the `record*` hooks in `convex/lib/leadLifecycle.ts`: `recordMeeting` after a meeting is booked or completed, `recordPayment` after a payment insert, `recordOpportunity`, `recordSlackQualification` and `recordProspectCapture`. The Customer stage comes from payments only. Each reads the record and applies the same rule the backfill uses, so stage times always come from the record, never the write time. Creating a lead through `resolveLeadIdentity` needs `initialLifecycle`. Corrections that may move a stage back use `correctLeadLifecycle`, and an admin moves it back or sets the disposition through `convex/leads/lifecycleAdmin.ts`; nothing else moves it back.

Opportunity writes have two entry points in `convex/lib/opportunityActivity.ts`, and they make the calls above for you:

- `transitionOpportunity` is the only way to change a deal's stage. It takes the target stage, with the outcome when the deal closes (`{ stage: "closed", outcome: "lost" }`), checks the move against the stage machine in `convex/opportunities/stages.ts`, writes the stage, the outcome and the fields, and updates the aggregates (`opportunityByStage` on its strict methods), the search and qualification rows, and the domain event (`opportunity.stage_changed`, or `opportunity.marked_lost` for a loss, with the stages in `fromStatus` and `toStatus` and the outcomes in the metadata). Don't add those calls next to it. Deals have no status field: the meetings, search rows and meeting buckets carry no copy of the deal's stage, so a stage change re-projects no meeting. A move the stage machine forbids needs a named entry in its `STAGE_TRANSITION_EXCEPTIONS`, which also names the loss it reopens, not a bypass at the call site. A missed meeting closes the deal with `missedMeetingLoss` (the reason `no_show` or `canceled`, no `lostByUserId`). ESLint rejects a raw `ctx.db.patch("opportunities", id, { stage })`, and the same for `outcome`.
- `patchOpportunityLifecycle` writes every other field, such as `assignedCloserId` or `leadId`, and re-keys the aggregates and projections that read them. Its type doesn't accept `stage` or `outcome`. Calendly turning a no-show into a cancellation, or the reverse, goes through `changeMissedMeetingLoss`, which also records the deal event.

Meeting updates should use `patchMeetingLifecycle` with an ID so the mutation reads its own current snapshot. Reporting jobs must carry IDs and read source state, never caller-provided before/after snapshots. Deleting a meeting must request its projection before deleting the source row. Opportunity changes use the paginated projection sweep; never replace it with a capped first-page loop.

Find an existing mutation that writes the same table and match its side-effect calls. A missed call leaves dashboards and counts wrong without any error.

## Team members

`teamMembers` holds one row per human, and `users`, `leadGenWorkers`, `slackUsers` and `dmClosers` point at it through `teamMemberId` (`convex/lib/teamMembers.ts`). A new role record gets its team member when it is created: a lead gen worker or a linked DM closer shares its user's, and an unlinked DM closer or Slack user gets its own. Only explicit links join records, never names. Don't add another staff table; a new role points at a team member.

## Reads

- Bound live reads with `readLiveQueryRows` or `readLiveDocuments` (`convex/lib/liveQueryBounds.ts`). They stop at a 512 KB budget and return `capped` so the UI can say the data is partial. A `for await` loop over a query has no bound.
- Counts and sums come from `@convex-dev/aggregate` instances defined in `reporting/aggregates.ts` and `billing/aggregates.ts` and mounted in `convex/convex.config.ts`.

## Dates

- The business day is a tenant setting, `tenants.businessDay` (a time zone and a start hour; when it's absent, America/Tegucigalpa from 01:00). Every server-side day uses it through `lib/businessDay.ts`, the meeting projections and Sales Calls included; `convex/reporting/lib/hondurasBusinessTime.ts` calls it. Accept dashboard ranges with `overviewRangeValidator` (`convex/dashboard/overviewRange.ts`).
- Changing the setting (`updateBusinessDay`) bumps `businessDayVersion` and runs a tracked rebuild (`businessDayRebuilds`). Meeting-bucket readers and reports wait until `businessDayAppliedVersion` matches; lead gen has its own readiness.
- Convex runs in UTC, so `setHours(0, 0, 0, 0)` returns UTC midnight, not a business-day boundary.

## Migrations

- Change the schema with widen, migrate, narrow, following the `convex-migration-helper` skill.
- Define migrations in `convex/migrations.ts` with `migrations.define`, each paired with an `assert*` migration that verifies the result. Run one with `npx convex run migrations:run '{"fn":"migrations:<name>"}'`.
- One-off backfills are `internalMutation`s, or guarded by system admin when they must be callable from the admin UI.

## Webhooks and integrations

- **Calendly**: `convex/webhooks/calendly.ts` verifies the HMAC signature against the tenant's secret, and `persistRawEvent` dedupes and stores the event in `rawWebhookEvents`. It atomically writes a permanent `webhookDeliveries` receipt, provider facts, and a webhook Workpool job. `pipeline/processor` commits booking changes and the receipt outcome together. Raw payload retention is 30 days for resolved deliveries; unresolved payloads are retained. Recovery previews and retries live in `pipeline/recovery`; destructive replay is retired. A booking whose identifiers name more than one person opens a `bookingReviews` row and a Slack alert (`pipeline/bookingReviewRecords.ts`); admins decide it in `pipeline/bookingReviews.ts`. See `runbooks/booking-workpool-rollout.md` before deploying or repairing this pipeline.
- **Calendly credentials**: OAuth tokens and the webhook secret live in `tenantCalendlyConnections`, not `tenants`. Read them through `convex/lib/tenantCalendlyConnection.ts`.
- **Slack**: `convex/lib/slackSignature.ts` verifies requests and accepts `SLACK_SIGNING_SECRET_PREVIOUS` during secret rotation. Events are stored redacted in `rawSlackEvents`, and the tenant comes from `team_id` through `slackInstallations`. CI requires token rotation to stay on in `slack-manifest.prod.yaml`; `runbooks/slack-token-refresh-write-failure.md` covers failed token refreshes.
- **WorkOS**: `authKit.registerRoutes(http)` in `convex/http.ts` mounts the AuthKit component's routes.

## Environment variables

Read environment variables through `env` from `_generated/server`, not `process.env`; ESLint enforces this. Declare each variable in `convex/convex.config.ts`. A deploy fails if a required variable isn't set, so set a new required variable on every deployment before deploying code that declares it. `convex/auth.config.ts` and `convex/lib/constants.ts`, which Next.js also imports, still read `process.env`.

## Logging and errors

Use `log` and `reportError` from `convex/lib/observability/log.ts` for process steps and handled failures, and `rejectRequest` from `convex/lib/observability/errors.ts` for errors the caller caused. They reach PostHog through the Convex log stream; `docs/agents/observability.md` covers the rules. Prefix any remaining `console` calls with a PascalCase `[Domain:Sub]` tag, such as `[Pipeline]`, `[Slack:OAuth]`, or `[WorkOS:Users]`.

`emitDomainEvent` also sends each domain event to PostHog, so a new event type needs no extra analytics call. It derives the event's `leadId` from its entity and its `teamMemberId` from `actorUserId` (`convex/lib/domainEventLinks.ts`); pass either one only to override it, as the Slack deal's `opportunity.created` does to credit the setter.

## Tests

Backend tests use `convex-test` with `convexTestModules` from `convex/test.setup.ts`; see `convex/operations/reports/jobs.test.ts` for the setup. Booking/Workpool integration tests use `tests/bookingHarness.ts` to register both pools and aggregate components. Keep test helpers outside `convex/` so Convex codegen does not bundle `convex-test` into a deployment. Coverage also includes operations reports, lead gen reporting, and live query bounds.
