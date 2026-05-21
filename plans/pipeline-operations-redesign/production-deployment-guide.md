# Pipeline Operations Redesign Production Deployment Guide

This guide covers the production rollout for
`plans/pipeline-operations-redesign/pipeline-operations-redesign-design.md`.

The release should be deployed as a Convex schema widen + dual-write release,
followed by production backfills, verification, and then UI enablement.

## Hard Stop Before Deploy

Before production, gate or remove `convex/attribution/backfills.ts` after use.
At the time this guide was written, these functions are public Convex functions
with no auth guard:

- `attribution/backfills:backfillMeetingAttribution`
- `attribution/backfills:backfillOpportunityAttribution`
- `attribution/backfills:verifyAttributionBackfill`

They are acceptable only as temporary migration helpers if production exposure
is tightly controlled. After the migration window, either remove them or add a
system-admin guard.

## Environment Variables

Pipeline Operations does not add new Calendly or Slack integration variables,
but the current implementation adds DM link portal secrets.

### Vercel / Next.js Production

Set these in the production Vercel environment:

```bash
NEXT_PUBLIC_APP_URL=https://magnus-crm-drab.vercel.app
NEXT_PUBLIC_CONVEX_URL=https://<prod-deployment>.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://<prod-deployment>.convex.site
NEXT_PUBLIC_WORKOS_REDIRECT_URI=https://magnus-crm-drab.vercel.app/callback
SYSTEM_ADMIN_ORG_ID=org_...

WORKOS_CLIENT_ID=...
WORKOS_API_KEY=...
WORKOS_COOKIE_PASSWORD=...

LINK_PORTAL_IP_HASH_SECRET=<openssl rand -hex 32>

NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=...
NEXT_PUBLIC_POSTHOG_HOST=...
POSTHOG_API_KEY=...
POSTHOG_PROJECT_ID=...
```

PostHog variables are only required if production analytics and source-map
upload are enabled.

### Convex Production

Set these in the production Convex deployment:

```bash
WORKOS_CLIENT_ID=...
WORKOS_API_KEY=...
WORKOS_COOKIE_PASSWORD=...
WORKOS_ENVIRONMENT_ID=...
WORKOS_WEBHOOK_SECRET=...
SYSTEM_ADMIN_ORG_ID=...

NEXT_PUBLIC_APP_URL=https://magnus-crm-drab.vercel.app
NEXT_PUBLIC_CONVEX_URL=https://<prod-deployment>.convex.cloud
NEXT_PUBLIC_CONVEX_SITE_URL=https://<prod-deployment>.convex.site
APP_URL=https://magnus-crm-drab.vercel.app

INVITE_SIGNING_SECRET=...

CALENDLY_CLIENT_ID=...
CALENDLY_CLIENT_SECRET=...
CALENDLY_WEBHOOK_SIGNING_KEY=...

SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_REDIRECT_URI=https://<prod-deployment>.convex.site/slack/oauth/callback
SLACK_SIGNING_SECRET=...
SLACK_STATE_SIGNING_SECRET=...
SLACK_SIGNING_SECRET_PREVIOUS=...

LINK_PORTAL_SESSION_SECRET=<openssl rand -hex 32>
LINK_PORTAL_PASSWORD_PEPPER=<openssl rand -hex 32>
```

`SLACK_SIGNING_SECRET_PREVIOUS` is only needed during Slack signing secret
rotation.

Example Convex env setup:

```bash
npx convex env set --prod --from-file .env.convex.production
npx convex env set --prod --from-file .env.slack
npx convex env set --prod NEXT_PUBLIC_APP_URL 'https://magnus-crm-drab.vercel.app'
npx convex env set --prod APP_URL 'https://magnus-crm-drab.vercel.app'
npx convex env set --prod LINK_PORTAL_SESSION_SECRET '<secret>'
npx convex env set --prod LINK_PORTAL_PASSWORD_PEPPER '<secret>'
```

## Pre-Deploy Checks

Run these locally before production:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
npx convex deploy --dry-run
```

If any generated Convex types are stale, regenerate them before committing and
deploying.

## Deploy Order

Deploy Convex first. The Next.js UI calls new Convex functions and expects new
tables, fields, and indexes to exist.

```bash
npx convex deploy
```

After Convex deploy succeeds, deploy the Next.js app through the normal Vercel
production pipeline.

Do not rely on Operations filters or portal reporting until the post-deploy
backfills complete.

## Tenant Setup Before Backfills

Perform this setup in the production admin UI before running the cache and stats
backfills:

1. Settings -> Programs: confirm active `tenantPrograms`.
2. Settings -> Event Types: map relevant Calendly event types to booked programs.
3. Settings -> Event Types: add booking base URLs for mapped event types.
4. Settings -> Attribution: create canonical DM teams matching production
   `utm_source` values.
5. Settings -> Attribution: create canonical DM closers matching production
   `utm_medium` values.
6. Settings -> Portal: seed campaign presets.
7. Settings -> Portal: rotate or generate the portal password.
8. Keep the portal disabled until verification passes.

This ordering matters because meeting attribution and
`operationsMeetingDailyStats` cache the current mappings. If mappings change
after stats are built, run a repair or rebuild before trusting filtered stats.

## Post-Deploy Migrations

Run commands from the repo root:

```bash
cd /Users/nimbus/dev/ptdom-crm
```

### 1. Backfill Meeting Attribution

This backfills meeting-level booked program, attribution, and sold-program
caches.

```bash
npx convex run --prod attribution/backfills:backfillMeetingAttribution '{"dryRun":true,"limit":500}'
npx convex run --prod attribution/backfills:backfillMeetingAttribution '{"dryRun":false,"limit":500}'
```

### 2. Backfill Opportunity Attribution

This backfills opportunity-level first-booking fields, attribution, sold-program
caches, and `qualifiedAt`.

```bash
npx convex run --prod attribution/backfills:backfillOpportunityAttribution '{"dryRun":true,"limit":500}'
npx convex run --prod attribution/backfills:backfillOpportunityAttribution '{"dryRun":false,"limit":500}'
```

### 3. Backfill Slack Qualification Events

This creates `slackQualificationEvents` and `operationsQualificationRows` for
historical Slack-sourced opportunities.

```bash
npx convex run --prod migrations:run '{"fn":"migrations:backfillSlackQualificationEvents","dryRun":true,"reset":true}'
npx convex run --prod migrations:run '{"fn":"migrations:backfillSlackQualificationEvents"}'
```

### 4. Backfill Meeting Status Cache And Operations Stats

This backfills `meetings.opportunityStatus` and
`operationsMeetingDailyStats`.

```bash
npx convex run --prod migrations:run '{"fn":"migrations:backfillMeetingOpportunityStatusAndOperationsStats","dryRun":true,"reset":true}'
npx convex run --prod migrations:run '{"fn":"migrations:backfillMeetingOpportunityStatusAndOperationsStats"}'
```

### 5. Monitor Migration Status

Use the migrations component status view while migrations are running:

```bash
npx convex run --prod --component migrations lib:getStatus --watch
```

### 6. Optional Aggregate Repair

If Slack qualification aggregate counts are stale, run the existing aggregate
repair:

```bash
npx convex run --prod reporting/backfill:backfillSlackQualificationAggregates '{}'
```

## Verification

### Attribution Verification

Run:

```bash
npx convex run --prod attribution/backfills:verifyAttributionBackfill '{"limit":500}'
```

Expected sample result:

- `meetingsMissingAttributionResolution` is `0`.
- `meetingsMissingBookingProgramStatus` is `0`.
- `opportunitiesMissingQualifiedAt` is `0`.
- Any unmapped attribution corresponds to real unmapped production UTMs, not
  missing registry setup.

### Qualification Projection Verification

Run with a system-admin identity:

```bash
npx convex run --prod \
  --identity '{"subject":"manual-prod-migration","organization_id":"<SYSTEM_ADMIN_ORG_ID>"}' \
  admin/migrations:getQualificationProjectionReadiness
```

Expected result:

- `qualificationEvents` and `projectionRows` match for backfilled
  Slack-sourced opportunities.
- `rowsWithoutLead` is explainable and not caused by migration failure.
- `rowsWithoutOpportunity` is explainable. Duplicate or already-booked Slack
  qualification attempts can legitimately be event-only rows.

### Manual Smoke Tests

Verify these flows in production:

1. `/workspace/pipeline` redirects correctly.
2. `/workspace/operations` loads Qualification, Scheduling, and Phone Sales.
3. New Slack `/qualify` creates a qualification event and Operations row.
4. New Calendly booking with UTM sets meeting and opportunity attribution.
5. Booked program and sold program show separately on opportunity, customer,
   and meeting detail pages.
6. Operations filters work for booked program, sold program, phone closer, DM
   team, and DM closer.
7. Settings -> Attribution shows unmapped UTMs when expected.
8. Settings -> Event Types blocks portal publishing when a booked program or
   booking URL is missing.
9. DM link portal unlocks with the generated password.
10. Generated DM link URLs contain canonical `utm_source`, `utm_medium`, and
    `utm_campaign`.
11. Generated DM link URLs preserve non-UTM query params already present on the
    base Calendly URL.
12. Generated DM link URLs overwrite any existing UTM params on the base URL
    with canonical values.

## Enablement

After verification passes:

1. Leave Operations visible in the sidebar.
2. Enable the DM link portal only after mapped event types, teams, closers, and
   campaigns are verified.
3. Share the portal URL and current one-time password only through the intended
   operator channel.
4. Monitor recent webhook processing, Operations health banners, and Slack
   qualification reports during the first operating window.

## Rollback

If UI issues appear:

1. Hide or revert the Next.js navigation/page changes.
2. Leave Convex fields, tables, and indexes in place.
3. Keep dual-write code running unless webhook processing itself is failing.
4. Do not delete migration-created rows during the incident response window.

If webhook processing fails:

1. Revert the specific webhook-processing change.
2. Keep additive schema fields in place.
3. Replay or repair affected raw webhook events after the fix.

Rollback should be UI-level by default. The schema changes are additive, and
removing fields or tables is riskier than hiding the new surfaces.

## Post-Migration Cleanup

After production has run successfully for at least one full operating window:

1. Remove or system-admin-gate temporary public backfill functions.
2. Document any unmapped UTM values that should become canonical teams or
   closers.
3. Capture final migration outputs in the deployment notes.
4. Keep optional schema fields optional until production has dual-written and
   verified data over a longer period.
