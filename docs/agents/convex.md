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
- `convex/lib/statusTransitions.ts` defines the opportunity, meeting, and lead state machines. Its validators return a boolean and log, so the caller rejects the write on `false`.

## Write side effects

The repo has no triggers. A mutation that inserts, updates, or deletes a meeting, opportunity, payment, lead, or customer also updates:

- reporting aggregates through `convex/reporting/writeHooks.ts` (`insert*`, `replace*`, and `delete*Aggregate`), which also update billing aggregates and operations meeting stats
- tenant counters through `updateTenantStats` or `applyPaymentStatsDelta` (`convex/lib/tenantStatsHelper.ts`)
- the domain event log through `emitDomainEvent` (`convex/lib/domainEvents.ts`)
- opportunity meeting refs through `updateOpportunityMeetingRefs` (`convex/lib/opportunityMeetingRefs.ts`), which also rebuilds the opportunity and lead/customer search rows
- qualification rows through `rebuildQualificationRowsForOpportunity` (`convex/operations/projections.ts`)

Find an existing mutation that writes the same table and match its side-effect calls. A missed call leaves dashboards and counts wrong without any error.

## Reads

- Bound live reads with `readLiveQueryRows` or `readLiveDocuments` (`convex/lib/liveQueryBounds.ts`). They stop at a 512 KB budget and return `capped` so the UI can say the data is partial. A `for await` loop over a query has no bound.
- Counts and sums come from `@convex-dev/aggregate` instances defined in `reporting/aggregates.ts` and `billing/aggregates.ts` and mounted in `convex/convex.config.ts`.

## Dates

- Business days use Honduras time (`America/Tegucigalpa`, UTC−6) and start at 01:00 local. Use `convex/reporting/lib/hondurasBusinessTime.ts`, and accept dashboard ranges with `overviewRangeValidator` (`convex/dashboard/overviewRange.ts`).
- Operations meeting stats are the exception: they key by UTC day (`convex/operations/meetingStats.ts`).
- Convex runs in UTC, so `setHours(0, 0, 0, 0)` returns UTC midnight, not a business-day boundary.

## Migrations

- Change the schema with widen, migrate, narrow, following the `convex-migration-helper` skill.
- Define migrations in `convex/migrations.ts` with `migrations.define`, each paired with an `assert*` migration that verifies the result. Run one with `npx convex run migrations:run '{"fn":"migrations:<name>"}'`.
- One-off backfills are `internalMutation`s, or guarded by system admin when they must be callable from the admin UI.

## Webhooks and integrations

- **Calendly**: `convex/webhooks/calendly.ts` verifies the HMAC signature against the tenant's secret, and `persistRawEvent` dedupes and stores the event in `rawWebhookEvents`. It then schedules `internal.pipeline.processor.processRawEvent`, which routes by event type and marks the event processed. Raw events are kept 30 days.
- **Calendly credentials**: OAuth tokens and the webhook secret live in `tenantCalendlyConnections`, not `tenants`. Read them through `convex/lib/tenantCalendlyConnection.ts`.
- **Slack**: `convex/lib/slackSignature.ts` verifies requests and accepts `SLACK_SIGNING_SECRET_PREVIOUS` during secret rotation. Events are stored redacted in `rawSlackEvents`, and the tenant comes from `team_id` through `slackInstallations`. CI requires token rotation to stay on in `slack-manifest.prod.yaml`; `runbooks/slack-token-refresh-write-failure.md` covers failed token refreshes.
- **WorkOS**: `authKit.registerRoutes(http)` in `convex/http.ts` mounts the AuthKit component's routes.

## Logging

Prefix `console` calls with a PascalCase `[Domain:Sub]` tag, such as `[Pipeline]`, `[Slack:OAuth]`, or `[WorkOS:Users]`.

## Tests

Backend tests use `convex-test` with `convexTestModules` from `convex/test.setup.ts`; see `convex/operations/reports/jobs.test.ts` for the setup. Coverage today is operations reports, lead gen reporting, and live query bounds.
