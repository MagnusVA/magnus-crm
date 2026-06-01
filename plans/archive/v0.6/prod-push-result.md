# v0.6 Reporting Production Push Result

**Date:** 2026-04-13  
**Operator:** Codex via Convex CLI  
**Reference plan:** [prod-push.md](./prod-push.md)  
**Target production deployment:** `usable-guineapig-697`

## Executive Summary

The Convex production push for v0.6 reporting was completed successfully. The backend deployed cleanly, the required reporting backfills were run, and the reporting aggregate verification query passed in production.

However, the rollout is **not fully complete** against the standard defined in [prod-push.md](./prod-push.md), because the v0.5b prerequisite datasets for Form Insights are still not present in production:

- `meetingFormResponses` is empty
- `eventTypeFieldCatalog` is empty

An attempt to run the existing historical form-response backfill succeeded operationally but produced **0 recovered rows**, exposing a production data/backfill bug rather than a deploy failure. Reporting aggregates for meetings, leads, and opportunities are correct, but **Form Insights should not be considered production-complete yet**.

## Outcome

### Completed successfully

- Local typecheck passed
- Local production build passed
- Convex backend deployed to production
- `backfillMeetingClassification` executed
- All 5 reporting aggregate backfills executed
- `reporting/verification:verifyBackfillCounts` passed

### Not completed

- Frontend production deployment was **not** performed as part of this task
- Browser smoke tests from the rollout plan were **not** run
- Live booking validation after release was **not** run
- Historical `meetingFormResponses` / `eventTypeFieldCatalog` recovery was **not** successful

## Commands Run

### Pre-deploy checks

```bash
pnpm tsc --noEmit
pnpm build
```

### Convex deploy

```bash
npx convex deploy --typecheck disable
```

### Reporting rollout backfills

```bash
npx convex run --prod --typecheck disable --codegen disable reporting/backfill:backfillMeetingClassification '{}'
npx convex run --prod --typecheck disable --codegen disable reporting/backfill:backfillMeetingsAggregate '{}'
npx convex run --prod --typecheck disable --codegen disable reporting/backfill:backfillPaymentsAggregate '{}'
npx convex run --prod --typecheck disable --codegen disable reporting/backfill:backfillOpportunitiesAggregate '{}'
npx convex run --prod --typecheck disable --codegen disable reporting/backfill:backfillLeadsAggregate '{}'
npx convex run --prod --typecheck disable --codegen disable reporting/backfill:backfillCustomersAggregate '{}'
npx convex run --prod --typecheck disable --codegen disable reporting/verification:verifyBackfillCounts '{}'
```

### Additional prerequisite verification and investigation

```bash
npx convex data meetingFormResponses --prod --limit 10000 --format json
npx convex data eventTypeFieldCatalog --prod --limit 10000 --format json
npx convex data domainEvents --prod --limit 10000 --format json
npx convex run --prod --typecheck disable --codegen disable \
  --identity '{...system admin identity...}' \
  admin/migrations:backfillMeetingFormResponses '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}'
npx convex logs --prod --history 40
```

## Deploy Result

The production deploy completed successfully.

### Deploy output highlights

- No indexes were deleted
- Schema validation completed
- All 5 reporting aggregate components installed:
  - `customerConversions`
  - `leadTimeline`
  - `meetingsByStatus`
  - `opportunityByStatus`
  - `paymentSums`
- Convex functions deployed to:
  - `https://usable-guineapig-697.convex.cloud`

## Pre-Deploy Validation Result

### `pnpm tsc --noEmit`

- Passed

### `pnpm build`

- Passed
- Reporting routes were included in the build:
  - `/workspace/reports`
  - `/workspace/reports/activity`
  - `/workspace/reports/leads`
  - `/workspace/reports/pipeline`
  - `/workspace/reports/revenue`
  - `/workspace/reports/team`

## Reporting Backfill Results

### 1. Meeting classification backfill

Initial invocation result:

```json
{
  "hasMore": true,
  "processed": 100,
  "updated": 100
}
```

This is the expected behavior for the implementation. The function paginates and schedules continuation work via `ctx.scheduler.runAfter(...)`.

### 2. Aggregate backfills

Initial invocation results:

```json
backfillMeetingsAggregate
{
  "hasMore": true,
  "inserted": 200
}

backfillPaymentsAggregate
{
  "hasMore": false,
  "inserted": 0
}

backfillOpportunitiesAggregate
{
  "hasMore": true,
  "inserted": 200
}

backfillLeadsAggregate
{
  "hasMore": false,
  "inserted": 186
}

backfillCustomersAggregate
{
  "hasMore": false,
  "inserted": 0
}
```

As with classification, the `meetings` and `opportunities` backfills paged and scheduled continuation work. Final correctness was verified via the production verification query rather than assuming completion from the first invocation.

## Production Verification Result

Final result from `reporting/verification:verifyBackfillCounts`:

```json
{
  "customers": {
    "aggregate": 0,
    "match": true,
    "table": 0
  },
  "leads": {
    "aggregate": 186,
    "match": true,
    "table": 186
  },
  "meetings": {
    "aggregate": 216,
    "match": true,
    "table": 216,
    "unclassified": 0
  },
  "opportunities": {
    "aggregate": 214,
    "match": true,
    "table": 214
  },
  "paymentRecords": {
    "aggregate": 0,
    "match": true,
    "table": 0
  },
  "tenantCount": 1
}
```

### Interpretation

- Reporting aggregate state is internally consistent with production source tables
- Historical meetings are fully classified for reporting purposes
- There are no payment or customer records in production at the current dataset size
- The reporting backend for meetings, leads, and opportunities is safe to treat as deployed and backfilled

## Additional Findings

## 1. v0.5b Form Insights prerequisites are still missing in production

Direct table inspection showed:

- `meetingFormResponses`: no documents
- `eventTypeFieldCatalog`: no documents
- `domainEvents`: 30 documents

This means:

- domain event emission is live in production
- the Form Insights datasets were **not** historically backfilled into prod, or the previous backfill did not succeed

Per [prod-push.md](./prod-push.md), this means reporting should **not** be treated as fully complete for Form Insights.

## 2. Existing historical form-response backfill did not recover data

After discovering the missing prerequisite tables, the existing admin backfill was run against the production tenant.

Final result:

```json
{
  "eventTypeConfigResolutions": 0,
  "eventsProcessed": 0,
  "eventsScanned": 242,
  "eventsSkippedInvalidJson": 0,
  "eventsSkippedInvalidPayload": 0,
  "eventsSkippedMissingMeeting": 229,
  "eventsSkippedMissingOpportunity": 0,
  "eventsSkippedNoQuestions": 13,
  "fieldCatalogCreated": 0,
  "fieldCatalogUpdated": 0,
  "responsesCreated": 0,
  "responsesUpdated": 0,
  "tenantId": "k57dqjfyf8qqy31bq375ng8gb984b24q"
}
```

### Interpretation

- The backfill action itself ran successfully
- The problem is not malformed raw data
- The main failure mode is `skipped_missing_meeting`
- A smaller subset of retained events had no `questions_and_answers`

This is a production data recovery issue, not a Convex deployment issue.

## 3. Likely bug in the historical form-response backfill lookup

The strongest root-cause candidate is a URI mismatch between:

- what the raw webhook record stores
- what the historical backfill uses for meeting lookup
- what the meeting pipeline actually stores on `meetings.calendlyEventUri`

### Evidence

The historical backfill matches meetings using:

- [convex/admin/migrations.ts](/Users/nimbus/dev/ptdom-crm/convex/admin/migrations.ts:418)

That code queries:

```ts
.withIndex("by_tenantId_and_calendlyEventUri", (q) =>
  q.eq("tenantId", rawEvent.tenantId).eq("calendlyEventUri", rawEvent.calendlyEventUri)
)
```

Webhook ingestion determines `rawWebhookEvents.calendlyEventUri` from:

- [convex/webhooks/calendly.ts](/Users/nimbus/dev/ptdom-crm/convex/webhooks/calendly.ts:62)

That resolution prefers top-level / payload-level event URIs that, for `invitee.created`, resolve to an invitee-scoped URI such as:

```text
https://api.calendly.com/scheduled_events/<event>/invitees/<invitee>
```

The meeting pipeline, however, stores the scheduled event URI on the meeting:

- [convex/pipeline/inviteeCreated.ts](/Users/nimbus/dev/ptdom-crm/convex/pipeline/inviteeCreated.ts:951)

That path extracts:

```ts
const scheduledEvent = payload.scheduled_event;
const calendlyEventUri = getString(scheduledEvent, "uri");
```

which is of the form:

```text
https://api.calendly.com/scheduled_events/<event>
```

### Production sample confirming the mismatch

Observed raw webhook rows in production showed:

- `storedUri`: invitee URI
- `payloadScheduledEventUri`: scheduled-event URI

Example:

```json
{
  "storedUri": "https://api.calendly.com/scheduled_events/4c1e4d42-6f44-441a-83ef-906262e88f0c/invitees/727e4479-d362-41aa-a1e6-631fcb3f40f8",
  "payloadScheduledEventUri": "https://api.calendly.com/scheduled_events/4c1e4d42-6f44-441a-83ef-906262e88f0c"
}
```

This explains why the historical backfill cannot locate meetings for most retained `invitee.created` events.

## 4. AuthKit deploy warning in production

The Convex deploy emitted this warning:

- AuthKit skipped production URL-derived settings because `VERCEL_PROJECT_PRODUCTION_URL` is not set in the Convex production environment

Skipped values included:

- Redirect URI template
- App homepage URL template
- CORS origin template

### Impact

- This did **not** block the deploy
- It may still cause environment/config drift for AuthKit-generated settings
- It should be corrected separately in production environment configuration

## 5. Operational note: system admin org differs between local and production

An initial attempt to run the admin backfill failed with:

- `Not authorized`
- production logs showed a mismatch between the provided org ID and prod `SYSTEM_ADMIN_ORG_ID`

This happened because the first identity used the local/default environment value instead of the production environment value. After switching to `npx convex env list --prod`, the admin backfill executed correctly.

This is not an application bug, but it is worth documenting because it can confuse future CLI-based admin operations.

## What Was Not Done

The following rollout-plan items remain open:

- frontend production deploy
- manual UI smoke tests on `/workspace/reports/*`
- authorization verification that closers cannot access report routes
- live booking validation after release

Those steps were outside the Convex-only scope of this task or were blocked by the unresolved Form Insights prerequisite issue.

## Release Assessment

## Reporting backend status

**Green for:**

- aggregate deployment
- aggregate backfills
- meeting classification
- reporting data correctness for meetings, leads, and opportunities

## Reporting product status

**Yellow / not fully complete for:**

- Form Insights
- any report surface that depends on `meetingFormResponses` or `eventTypeFieldCatalog`

## Overall recommendation

Do **not** declare the full v0.6 reporting rollout complete yet.

It is accurate to say:

- the Convex production deploy succeeded
- the reporting aggregate backend is live and verified

It is **not** accurate to say:

- all reporting prerequisites are satisfied
- Form Insights historical data is available in production

## Recommended Next Actions

1. Fix the historical form-response backfill lookup so it resolves meetings by the scheduled-event URI from the raw payload, not the stored invitee URI.
2. Redeploy Convex after that fix.
3. Re-run `admin/migrations:backfillMeetingFormResponses` for the production tenant.
4. Verify that `meetingFormResponses` and `eventTypeFieldCatalog` now contain rows.
5. Re-run targeted prod verification for Form Insights.
6. Set `VERCEL_PROJECT_PRODUCTION_URL` in the Convex production environment if AuthKit should derive production URLs from that variable.
7. Only after the above, deploy the frontend and run the smoke-test steps from [prod-push.md](./prod-push.md).

## Final Status

**Convex production push:** Successful  
**Reporting aggregate backfills:** Successful  
**Aggregate verification:** Passed  
**Form Insights prerequisite data:** Failed / still missing in prod  
**Full rollout sign-off:** Not yet approved
