# Slack Bot v1 - Production Pass

**Status:** Draft runbook  
**Audience:** Engineer/operator preparing Vercel, Convex, and Slack for production launch  
**Last verified:** 2026-05-11  
**Primary sources:** `slackbot-design.md`, `slackbot-deferred.md`, `phases/phase1.md`, `phases/phase6.md`, `slack-manifest.prod.yaml`, `.docs/slack/`*, `plans/archive/deployment/production.md`, and the official docs linked in [Source Links](#source-links).

## Purpose

This document is the production pass for Slack Bot v1. It starts where `slackbot-deferred.md` left off: the production Slack app was intentionally not created during dev implementation, and production launch now requires a controlled setup across Vercel, Convex, and Slack.

The intended launch model is:

- One production Slack app named `Magnus CRM`.
- One production Convex deployment that owns all Slack HTTP endpoints at `https://<convex-prod>.convex.site`.
- One production Vercel app that owns the CRM UI and authenticated install entry point at `https://<app-prod>/api/slack/start`.
- Tenants install Slack from CRM settings after authenticating as a `tenant_master` or `tenant_admin`.
- Slack Public Distribution is activated only after prod QA and a dogfood window. Until then, third-party workspaces cannot install the production Slack app.

## Non-Negotiables

- Do not create the production Slack app until dev QA is complete.
- Do not activate Slack Public Distribution until the final go-live checklist passes.
- Do not share Slack's raw generated install URL as the tenant install path. The CRM install path is `/api/slack/start` because it creates the signed, one-time OAuth `state`.
- Do not put Slack secrets in Vercel. Slack secrets belong in Convex env vars only.
- Do not change `settings.token_rotation_enabled: true` in `slack-manifest.prod.yaml`.
- Do not point Slack manifest URLs at Vercel routes. Slack inbound routes are Convex HTTP Actions.
- Do not use `team_id` alone as the tenant join key. The implementation joins inbound Slack payloads by `(team_id, api_app_id)`.
- Treat any production schema/data change as a migration exercise. If the production pass requires schema or data changes beyond already-deployed Slack v1 tables, use the `convex-migration-helper` skill and a widen-migrate-narrow rollout.

## Launch Sequence Summary

1. Prove dev is done.
2. Freeze the production URL map.
3. Prepare Vercel production env vars and build configuration.
4. Prepare Convex production env vars, deploy keys, crons, logs, and migration state.
5. Create the production Slack app from a bootstrap manifest with token rotation enabled.
6. Store Slack prod credentials and set Convex Slack env vars.
7. Deploy production Convex + Next through Vercel.
8. Smoke-test production Slack HTTP endpoints.
9. Render and paste the production Slack manifest.
10. Install the prod app into one dogfood tenant.
11. Run production QA and observe at least one token refresh path.
12. Run a one-week dogfood.
13. Activate Public Distribution.
14. Monitor for the first 48 hours.

## 0. Dev Exit Gate

Do not start the prod Slack app until all of this is true.

### Code Health

Run from the repo root:

```bash
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

If `pnpm build` requires production env values locally, run it through the same environment Vercel will use or validate on a Vercel preview deployment.

Confirm the production Slack files are present and still aligned:

```bash
rg -n "token_rotation_enabled|/slack/(oauth_redirect|commands|interactivity|events)|/qualify-lead" \
  slack-manifest.prod.yaml convex/http.ts convex/slack app/api/slack/start/route.ts
```

Expected:

- `slack-manifest.prod.yaml` has `token_rotation_enabled: true`.
- `convex/http.ts` registers:
  - `GET /slack/oauth_redirect`
  - `POST /slack/commands`
  - `POST /slack/interactivity`
  - `POST /slack/events`
- `app/api/slack/start/route.ts` exists and calls `api.slack.oauth.startInstall`.

### Dev End-to-End QA

Run this against the dev Slack app and dev Convex deployment before touching prod:

- Tenant admin can click **Connect Slack** from `/workspace/settings?tab=integrations`.
- OAuth returns to `/workspace/settings?tab=integrations&slack=connected`.
- `slackInstallations` has one `status: "active"` row with a future `tokenExpiresAt`.
- `/qualify-lead` opens the modal within Slack's 3-second interaction budget.
- Modal submission creates or reuses a lead and creates a `source: "slack_qualified"` opportunity with `status: "qualified_pending"`.
- Duplicate modal submissions do not create duplicate open opportunities.
- Channel picker can set both notify and stale-reminder channels.
- Confirmation messages post to the notify channel.
- Calendly booking joins to the Slack-qualified opportunity and transitions it to `scheduled`.
- A booking outside the `SLACK_JOIN_LOOKBACK_MS` window creates a new opportunity instead of joining.
- `app_uninstalled`, `tokens_revoked`, and reconnect flow behave correctly.
- Metrics cards render for admin users and not for closer users.

### Performance and Operations Gate

Before broad launch, run a focused Convex performance audit on:

- `convex/slack/commands.ts` slash-command route latency.
- `convex/slack/interactivity.ts` modal submission path.
- `convex/slack/staleReminders.ts` fan-out behavior.
- `convex/slack/metrics.ts` query read amplification.

The launch can proceed with v1 bounded queries only if the audit confirms the current expected tenant volume is safe. If production data volume has grown beyond the v1 assumptions, launch must pause for aggregates or denormalization.

## 1. Freeze the Production URL Map

Fill this table before configuring anything:


| Name                         | Value                                                                                                       | Owner                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------- |
| Production app URL           | [https://magnus-crm-drab.vercel.app/](https://magnus-crm-drab.vercel.app/)                                  | Vercel                  |
| Production WorkOS callback   | `https://magnus-crm-drab.vercel.app/callback`                                                               | Vercel / Convex AuthKit |
| Production Calendly callback | `https://magnus-crm-drab.vercel.app/callback/calendly`                                                      | Vercel / Calendly       |
| Production Convex cloud URL  | `https://usable-guineapig-697.convex.cloud`                                                                 | Convex                  |
| Production Convex site URL   | [https://usable-guineapig-697.convex.site](https://usable-guineapig-697.convex.site)                        | Convex                  |
| Slack OAuth redirect URL     | [https://usable-guineapig-697.convex.site](https://usable-guineapig-697.convex.site)`/slack/oauth_redirect` | Convex / Slack          |
| Slack command URL            | [https://usable-guineapig-697.convex.site](https://usable-guineapig-697.convex.site)`/slack/commands`       | Convex / Slack          |
| Slack interactivity URL      | [https://usable-guineapig-697.convex.site](https://usable-guineapig-697.convex.site)`/slack/interactivity`  | Convex / Slack          |
| Slack events URL             | [https://usable-guineapig-697.convex.site](https://usable-guineapig-697.convex.site)`/slack/events`         | Convex / Slack          |
| Privacy policy URL           | `https://magnus-crm-drab.vercel.app/privacy`                                                                | Legal/product           |
| Support URL                  | `https://magnus-crm-drab.vercel.app/support` or support email URL accepted by Slack                         | Support/product         |


Current repo note: `convex.json` production AuthKit config is hardcoded to `https://magnus-crm-drab.vercel.app`. If the production URL has changed or a custom domain is being used, update `convex.json` and production env vars before launching Slack.

### URL Rules

- `SLACK_REDIRECT_URI` in Convex must match `oauth_config.redirect_urls[0]` in the Slack manifest exactly, including trailing slash behavior.
- `APP_URL` in Convex must be the production CRM URL and is used by Slack notifications and OAuth redirects.
- `NEXT_PUBLIC_APP_URL` is still used by existing Convex Calendly/admin code and by Next.js callback code. Set it to the same production CRM URL until the codebase is refactored.
- Slack endpoints must be public HTTPS URLs. Slack will verify Events API request URLs when the manifest is saved.

## 2. Prepare Vercel Production

Vercel owns the CRM UI, WorkOS AuthKit browser/server session flow, and `/api/slack/start`.

### Project Settings

In Vercel Dashboard -> Project Settings:

- Production branch: `main`.
- Framework: Next.js.
- Build command: `npx convex deploy --cmd 'pnpm build'`.
- Install command: use the project default unless Vercel is not detecting pnpm correctly.
- Node version: use the project/Vercel default compatible with Next.js 16 and this repo.

The build command matters. It deploys Convex functions first, injects Convex build env, then builds Next.js against the correct backend.

### Vercel Production Environment Variables

Set these with **Production** scope:


| Variable                                        | Value                             | Notes                                                              |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| `CONVEX_DEPLOY_KEY`                             | Production deploy key from Convex | Required for `npx convex deploy --cmd 'pnpm build'`.               |
| `WORKOS_CLIENT_ID`                              | Production AuthKit client ID      | From Convex Dashboard AuthKit production environment.              |
| `WORKOS_API_KEY`                                | Production AuthKit API key        | Must be `sk_live_...` for prod.                                    |
| `WORKOS_COOKIE_PASSWORD`                        | Strong 32+ char secret            | Generate with `openssl rand -base64 32`; do not reuse preview/dev. |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI`               | `${APP_URL}/callback`             | Must match `convex.json` production AuthKit config.                |
| `NEXT_PUBLIC_APP_URL`                           | Production app URL                | Used by Next.js callback flow.                                     |
| `NEXT_PUBLIC_CALENDLY_CLIENT_ID`                | Production Calendly client ID     | Existing Calendly setup.                                           |
| `CALENDLY_CLIENT_SECRET`                        | Production Calendly client secret | Existing Calendly setup if used by Next runtime/build.             |
| `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`             | PostHog project token             | If analytics is enabled.                                           |
| `NEXT_PUBLIC_POSTHOG_HOST`                      | PostHog host                      | This repo rewrites `/ingest/`* to PostHog.                         |
| `POSTHOG_API_KEY` or `POSTHOG_PERSONAL_API_KEY` | PostHog personal API key          | Enables production source map upload.                              |
| `POSTHOG_PROJECT_ID`                            | PostHog project ID                | Enables production source map upload.                              |


Do not set Slack secrets in Vercel. The browser and Next.js route handlers do not need them.

After changing Vercel env vars, trigger a fresh production deployment. Vercel environment variable changes apply to new deployments, not already-built immutable deployments.

### Vercel Preview Environment

Keep Preview configured separately:

- Preview `CONVEX_DEPLOY_KEY`.
- Preview/test `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`.
- Preview `WORKOS_COOKIE_PASSWORD`.
- Preview `NEXT_PUBLIC_WORKOS_REDIRECT_URI`.
- Preview `NEXT_PUBLIC_APP_URL`.

Do not point preview deploys at the production Slack app. Preview can keep using the dev Slack app or no Slack app.

## 3. Prepare Convex Production

Convex owns all Slack secrets, all Slack inbound HTTP routes, token refresh, raw Slack event audit rows, and Slack crons.

### Production Deployment Checks

In Convex Dashboard:

- Production deployment exists.
- Production AuthKit environment exists and is configured.
- Production deploy key exists.
- `convex.json` production AuthKit settings point at the production app URL.
- Existing production tenant works before Slack changes.
- Backups are understood and available if a data issue appears.

If Slack schema is not already in production, stop here and run a migration plan. Slack v1 includes existing table and enum additions such as:

- `slackInstallations`
- `slackOAuthStates`
- `slackUsers`
- `rawSlackEvents`
- `source: "slack_qualified"`
- `status: "qualified_pending"`

Use a widen-only deploy first, verify production schema, then enable writes.

### Convex Production Environment Variables

Set existing non-Slack variables first. These are required for the production app independent of Slack:


| Variable                       | Value                                   | Notes                                                       |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------- |
| `WORKOS_CLIENT_ID`             | Production AuthKit client ID            | Usually managed by Convex AuthKit integration.              |
| `WORKOS_API_KEY`               | Production AuthKit API key              | Usually managed by Convex AuthKit integration.              |
| `WORKOS_ENVIRONMENT_ID`        | Production WorkOS environment ID        | Usually managed by Convex AuthKit integration.              |
| `SYSTEM_ADMIN_ORG_ID`          | System admin WorkOS org ID              | Required by admin guards.                                   |
| `INVITE_SIGNING_SECRET`        | Strong random secret                    | Existing tenant invite signing.                             |
| `CALENDLY_CLIENT_ID`           | Production Calendly client ID           | Server-side Calendly OAuth.                                 |
| `CALENDLY_CLIENT_SECRET`       | Production Calendly client secret       | Server-side Calendly OAuth/token refresh.                   |
| `CALENDLY_WEBHOOK_SIGNING_KEY` | Production Calendly webhook signing key | Webhook verification.                                       |
| `NEXT_PUBLIC_APP_URL`          | Production app URL                      | Existing Convex Calendly/admin code reads this.             |
| `APP_URL`                      | Production app URL                      | Slack OAuth redirects and Slack message CTA URLs read this. |


Then set Slack production variables after the prod Slack app exists:


| Variable                        | Value                                        | Notes                                       |
| ------------------------------- | -------------------------------------------- | ------------------------------------------- |
| `SLACK_CLIENT_ID`               | Prod Slack app Client ID                     | From Slack App Config -> Basic Information. |
| `SLACK_CLIENT_SECRET`           | Prod Slack app Client Secret                 | Convex only.                                |
| `SLACK_SIGNING_SECRET`          | Prod Slack app Signing Secret                | Verifies all inbound Slack requests.        |
| `SLACK_SIGNING_SECRET_PREVIOUS` | Previous signing secret during rotation only | Optional. Clear after rotation overlap.     |
| `SLACK_STATE_SIGNING_SECRET`    | Fresh `openssl rand -hex 32` value           | Ours, not Slack's. Used for OAuth state.    |
| `SLACK_REDIRECT_URI`            | `${CONVEX_SITE_URL}/slack/oauth_redirect`    | Must match manifest exactly.                |


CLI pattern:

```bash
export CONVEX_DEPLOY_KEY="prod:<redacted>"

npx convex env set APP_URL "https://<app-prod>"
npx convex env set NEXT_PUBLIC_APP_URL "https://<app-prod>"

npx convex env set SLACK_CLIENT_ID "<prod client_id>"
npx convex env set SLACK_CLIENT_SECRET "<prod client_secret>"
npx convex env set SLACK_SIGNING_SECRET "<prod signing_secret>"
npx convex env set SLACK_STATE_SIGNING_SECRET "<openssl-rand-hex-32>"
npx convex env set SLACK_REDIRECT_URI "https://<convex-prod>.convex.site/slack/oauth_redirect"

npx convex env list | rg 'APP_URL|SLACK|CALENDLY|WORKOS|SYSTEM_ADMIN|INVITE'
```

Use the Convex Dashboard instead of CLI if that is the team's normal production control point. Store secret values only in the password manager and provider dashboards.

### Convex Crons to Verify

`convex/crons.ts` must be deployed with:

- `refresh-slack-tokens`, hourly, calls `internal.slack.tokens.refreshExpiringTokens`.
- `cleanup-slack-oauth-states`, every 24 hours.
- `cleanup-slack-raw-events`, every 24 hours.
- `slack-stale-qualified-leads-reminder`, hourly cron expression, internally gates to the stale reminder schedule.

After deployment, verify these exist in Convex Dashboard -> Functions / Schedules, or by watching logs during the dogfood window.

## 4. Create the Production Slack App

Do this only after the URL map is frozen and the production Convex route host is known.

### Ownership

Create the app while logged into a shared/company Slack admin account, not a personal account. Document:

- Registering Slack account.
- Owning Slack workspace.
- App ID.
- Creation date.
- Password manager item path.
- Public Distribution status.

### Bootstrap Manifest

In Slack API Apps -> Create New App -> From a manifest, select the company/admin workspace and paste a minimal bootstrap manifest. Use the real production Convex site URL.

```yaml
display_information:
  name: "Magnus CRM"
  description: "Qualify leads from Slack into your CRM."
  background_color: "#0b1020"
features:
  bot_user:
    display_name: "Magnus"
    always_online: true
oauth_config:
  redirect_urls:
    - "https://<convex-prod>.convex.site/slack/oauth_redirect"
  scopes:
    bot:
      - commands
settings:
  socket_mode_enabled: false
  token_rotation_enabled: true
```

Before clicking create/save, verify `token_rotation_enabled: true`. Slack token rotation cannot be disabled after it is enabled for an app. If the app is accidentally created without token rotation, discard it and create a new Slack app before any tenant installs it.

### Credentials to Capture

From Slack App Config -> Basic Information -> App Credentials:

- App ID
- Client ID
- Client Secret
- Signing Secret

Generate the state signing secret locally:

```bash
openssl rand -hex 32
```

Store it as `SLACK_STATE_SIGNING_SECRET` for production. It is separate from Slack's Signing Secret.

### Branding and Legal

Before Public Distribution:

- Upload the 512x512 app icon.
- Confirm display name `Magnus`.
- Confirm app name `Magnus CRM`.
- Confirm short description.
- Add privacy policy URL.
- Add support URL.
- Keep Public Distribution disabled.

Slack requires valid HTTPS URLs for distributed apps, and production launch should not proceed with placeholder legal/support URLs.

## 5. Deploy Production Code

Use the team's normal release process. The safe path is:

1. Merge the release branch to `main`.
2. Vercel production deploy starts.
3. Vercel runs `npx convex deploy --cmd 'pnpm build'`.
4. Convex production functions deploy.
5. Next.js production build completes.
6. Vercel promotes the deployment.

Watch the Vercel deployment log for:

- Convex deploy success.
- Next.js build success.
- No missing env var errors.
- No PostHog source map errors that fail the build.
- No Next.js 16 deprecation errors.

After deploy:

```bash
curl -I "https://<app-prod>"
curl -I "https://<app-prod>/workspace/settings?tab=integrations"
```

Then sign in as a production admin and verify the normal CRM still works before testing Slack.

## 6. Smoke-Test Production Slack HTTP Routes

Before pasting the full Slack manifest, prove the Convex HTTP Action routes are live.

Set local helper variables:

```bash
export CONVEX_SITE_URL="https://<convex-prod>.convex.site"
export SLACK_SIGNING_SECRET="<prod signing secret from password manager>"
```

### OAuth Redirect Route

```bash
curl -i "$CONVEX_SITE_URL/slack/oauth_redirect"
```

Current implementation should redirect to the production app's workspace settings URL with `slack=oauth_failed`, because no `code` or `state` is present. A 302 is expected. A 404 is a blocker.

### Signed `ssl_check` Command Probe

This verifies the command route exists and can validate the prod signing secret without needing a real install row.

```bash
body='ssl_check=1'
ts=$(date +%s)
sig="v0=$(printf "v0:%s:%s" "$ts" "$body" \
  | openssl dgst -sha256 -hmac "$SLACK_SIGNING_SECRET" -hex \
  | awk '{print $2}')"

curl -i -X POST "$CONVEX_SITE_URL/slack/commands" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Slack-Request-Timestamp: $ts" \
  -H "X-Slack-Signature: $sig" \
  --data "$body"
```

Expected: HTTP 200 with an empty body.

### Bad Signature Probe

```bash
curl -i -X POST "$CONVEX_SITE_URL/slack/commands" --data 'ssl_check=1'
```

Expected: HTTP 401. If unsigned requests succeed, launch is blocked.

Do not run a fake production `url_verification` event unless you are comfortable creating a harmless `rawSlackEvents` audit row. Slack will run the real URL verification when you save the manifest.

## 7. Render and Paste the Production Slack Manifest

Render the manifest locally with the production Convex site host.

```bash
export CONVEX_SITE_HOST="<convex-prod>.convex.site"
sed "s#<convex-prod>.convex.site#$CONVEX_SITE_HOST#g; s#<convex-prod>#$CONVEX_SITE_HOST#g" \
  slack-manifest.prod.yaml > /tmp/slack-manifest.prod.rendered.yaml

rg -n '<convex-prod>|token_rotation_enabled|/slack/' /tmp/slack-manifest.prod.rendered.yaml
```

Expected:

- No `<convex-prod>` placeholders remain.
- `settings.token_rotation_enabled: true`.
- OAuth redirect URL is exactly `https://${CONVEX_SITE_HOST}/slack/oauth_redirect`.
- Slash command URL is exactly `https://${CONVEX_SITE_HOST}/slack/commands`.
- Interactivity request URL is exactly `https://${CONVEX_SITE_HOST}/slack/interactivity`.
- Events request URL is exactly `https://${CONVEX_SITE_HOST}/slack/events`.

Then in Slack App Config -> App Manifest:

1. Paste `/tmp/slack-manifest.prod.rendered.yaml`.
2. Review the rendered preview line by line.
3. Confirm scopes:
  - `commands`
  - `chat:write`
  - `chat:write.public`
  - `channels:read`
  - `groups:read`
  - `users:read`
4. Confirm bot events:
  - `app_uninstalled`
  - `tokens_revoked`
  - `user_change`
5. Confirm `socket_mode_enabled: false`.
6. Confirm `token_rotation_enabled: true`.
7. Save.

If Slack rejects the Events API URL:

- Verify `SLACK_SIGNING_SECRET` in Convex is the production app's signing secret.
- Verify the production functions are deployed.
- Verify `/slack/events` is registered in `convex/http.ts`.
- Verify the route returns the raw challenge string for `url_verification`.
- Re-save only after the issue is fixed.

After save, go to Manage Distribution and confirm Public Distribution is still disabled.

## 8. First Production Install: Dogfood Tenant

Pick one real dogfood tenant before public launch.

Required dogfood tenant properties:

- Tenant has an active production CRM workspace.
- Tenant has a Slack workspace where an admin can install apps.
- Tenant has at least one admin who can access `/workspace/settings`.
- Tenant can make test Calendly bookings without contaminating important production reporting.
- Tenant agrees to one week of monitoring and feedback.

### Install Flow

As the dogfood tenant admin:

1. Open `https://<app-prod>/workspace/settings?tab=integrations`.
2. Click **Connect Slack**.
3. Confirm the browser first hits `/api/slack/start`, not a direct Slack share URL.
4. Approve the Slack OAuth prompt.
5. Return to `/workspace/settings?tab=integrations&slack=connected`.
6. Pick notification and stale-reminder channels.

If the Slack workspace requires app approval, the OAuth install may pause in Slack's approval workflow. That is not a code failure. Coordinate with the workspace admin.

### Verify Installation Row

In Convex production data, verify the `slackInstallations` row:

- `tenantId` belongs to the dogfood tenant.
- `teamId` is the dogfood Slack workspace.
- `appId` matches the production Slack App ID.
- `status` is `"active"`.
- `botAccessToken` and `refreshToken` are non-empty.
- `tokenExpiresAt` is about 12 hours in the future.
- `notifyChannelId` and `staleReminderChannelId` are set after channel selection.
- No dev Slack App ID or dev workspace values are present.

CLI or dashboard:

```bash
export CONVEX_DEPLOY_KEY="prod:<redacted>"
npx convex data slackInstallations
```

Do not paste access tokens into tickets, docs, or chat.

## 9. Production QA Matrix

Run every item against production with the dogfood tenant.

### OAuth and Settings

- Non-authenticated user hitting `/api/slack/start` is redirected to sign-in.
- `closer` role cannot start Slack install.
- `tenant_master` can start Slack install.
- `tenant_admin` can start Slack install.
- Install success redirects to settings with `slack=connected`.
- Canceling Slack OAuth redirects with a non-success status and does not create an active install row.
- Reconnect over an existing inactive row reactivates the same tenant row.
- Cross-tenant attempt for an already-linked `(teamId, appId)` is rejected.

### Slash Command and Modal

- `/qualify-lead` opens the modal.
- Modal validates required name and handle.
- Modal has no email or phone questions.
- Valid submission closes the modal.
- Submission creates/reuses lead identity correctly.
- Submission creates one `slack_qualified` / `qualified_pending` opportunity.
- Duplicate submission for the same open lead is blocked.
- `slackUsers` has a row for the submitter.
- Raw Slack events are redacted; email, phone, names, trigger IDs, and response URLs are not stored in plaintext.

### Notifications and Channels

- Confirmation message posts in the selected notify channel.
- Private channel failure copy is understandable if the bot is not invited.
- Archived or invalid channel status appears in the Integrations card.
- Channel picker can recover by selecting a new channel.
- `slack.notify.failed` domain events are not emitted during healthy posting.

### Calendly Join

- Submit Slack qualification with a known social handle.
- Book a Calendly meeting whose custom handle answer matches that lead inside the 30-day lookback.
- Existing Slack-qualified opportunity transitions to `scheduled`.
- Meeting attaches to that opportunity.
- No duplicate Calendly-only opportunity is created.
- Backdate or seed a test Slack-qualified opportunity older than 30 days and book a matching meeting.
- Out-of-window booking creates a fresh opportunity and leaves the old qualified-pending row open.

Use clearly labeled test leads for backdated/out-of-window production checks, and record any manual data patches in the launch log.

### Stale Digest

- A controlled test `qualified_pending` opportunity older than the stale threshold appears in the digest.
- Digest posts to the stale-reminder channel, not necessarily the notify channel.
- Digest respects tenant isolation.
- Digest does not post when there are no stale leads.

Because the normal stale threshold is longer than the dogfood window, use one controlled backdated test lead or a staging-like dogfood tenant record.

### Lifecycle

- Uninstall the app from the dogfood Slack workspace.
- Convex marks the row `uninstalled` or `revoked`, with `uninstalled` winning if both events arrive.
- The Integrations card shows reconnect state.
- `/qualify-lead` returns a useful disconnected message while inactive.
- Reconnect restores the row to `active` with a fresh token tuple.
- `user_change` updates a known `slackUsers` row after Slack profile change.

### Metrics

- Admin dashboard shows Slack-qualified total.
- Admin dashboard shows conversion ratio.
- Admin dashboard shows per-user breakdown.
- Closer dashboard does not expose admin-only Slack metrics.
- If metrics query returns `truncated: true`, the UI does not present partial numbers as complete.

## 10. Token Refresh Production Validation

Slack rotated bot access tokens expire on a 12-hour cycle. v1 relies on:

- JIT refresh via `getValidSlackBotToken`.
- Hourly proactive refresh via `refresh-slack-tokens`.
- Single-use refresh token persistence in `completeRefresh`.
- P1 alerting on `[Slack:Tokens] CATASTROPHIC refresh-write-fail`.

During dogfood, prove at least one token refresh path:

Preferred:

- Let the dogfood install run long enough for natural proactive refresh.
- Verify `lastRefreshedAt` is set and `tokenExpiresAt` advances.

Controlled alternative:

- In a scheduled dogfood window, patch only the dogfood row's `tokenExpiresAt` near expiry.
- Trigger one Slack API path or wait for the hourly cron.
- Verify `tokenExpiresAt` advances and row remains `active`.
- Have the tenant admin available to reconnect if the refresh token is accidentally stranded.

Do not run controlled force-expiry on a production tenant that is not explicitly part of dogfood.

## 11. Alerting and Monitoring

Set these before Public Distribution.

### P1 Alert

Create a paging alert on the exact log signature:

```text
[Slack:Tokens] CATASTROPHIC refresh-write-fail
```

Response runbook: `runbooks/slack-token-refresh-write-failure.md`.

Verify the alert in dev or a non-production deployment. If verifying in prod, mark the test clearly and remove any temporary code immediately.

### Secondary Alerts

Create lower-severity alerts or daily checks for:

- Any `slackInstallations.status = "token_expired"`.
- Any `token_expired` row older than 24 hours.
- Spike in `[Slack:Cmd] bad signature`.
- Spike in `[Slack:Int] bad signature`.
- Spike in `[Slack:Cmd] expired_trigger_id`.
- `slack.notify.failed` domain events.
- `slack.stale.failed` domain events.
- `rawSlackEvents.processed = false`.
- Missing hourly `[Slack:Tokens] cron tick` logs.

### Dashboards or Manual Checks

During dogfood and the first 48 hours after Public Distribution:

```bash
export CONVEX_DEPLOY_KEY="prod:<redacted>"
npx convex data slackInstallations
npx convex data rawSlackEvents
npx convex data domainEvents
```

Check:

- Active installs count.
- Token expirations.
- Refresh lock fields stuck for more than 30 seconds.
- Notification failure event volume.
- Unexpected uninstall/revoke volume.

## 12. Dogfood Window

Minimum dogfood duration: one calendar week with one real tenant.

Daily checks:

- Ask dogfood tenant whether `/qualify-lead` is understandable and fast.
- Confirm no CATASTROPHIC token logs.
- Confirm no stuck `token_expired` row.
- Confirm channel posts are not rate-limited.
- Confirm Slack-qualified leads appear in pipeline views.
- Confirm Calendly joins happen without duplicates.
- Confirm metrics update.
- Review logs for `[Slack:Cmd]`, `[Slack:Int]`, `[Slack:Notify]`, `[Slack:Stale]`, `[Slack:Events]`, `[Slack:Tokens]`.

Triage policy:

- P0/P1 correctness, data isolation, auth, token, or duplicate-opportunity issues block launch.
- Persistent Slack API posting failures block launch.
- Copy and minor UI polish can move to v1.1 if they do not hide operational failures.
- Any schema/data fix during dogfood must follow migration rules.

## 13. Final Go-Live Checklist

Before activating Public Distribution:

- Dev QA complete.
- Production URL map frozen.
- Vercel production env vars set and redeployed.
- Convex production non-Slack env vars set.
- Production Slack app created with `token_rotation_enabled: true`.
- Prod Slack credentials stored in password manager.
- Convex production Slack env vars set.
- Production deployment completed successfully.
- Production Slack HTTP routes smoke-tested.
- Prod manifest pasted and saved.
- Prod manifest preview confirms `token_rotation_enabled: true`.
- Public Distribution still disabled before final gate.
- Privacy policy URL configured.
- Support URL configured.
- App icon and display copy configured.
- P1 token refresh alert configured and verified.
- Refresh write failure runbook published.
- Dogfood tenant installed production app.
- Dogfood ran at least one week.
- Dogfood found no unresolved P0/P1 issues.
- Token refresh observed successfully.
- Calendly join tested in production.
- Stale digest tested with controlled data.
- Uninstall/reconnect lifecycle tested.
- Metrics cards verified.
- Convex performance audit accepted for launch volume.

## 14. Activate Slack Public Distribution

Only after every final checklist item passes:

1. Open Slack App Config -> production app -> Manage Distribution.
2. Review the distribution checklist.
3. Confirm app is not being submitted to the Slack Marketplace/App Directory. This launch needs Public Distribution, not Marketplace listing.
4. Activate Public Distribution.
5. Record timestamp, operator, and Slack app ID in the launch log.
6. Confirm a tenant outside the owning Slack workspace can install through CRM `/api/slack/start`.

Important: Slack's distribution controls are high impact. Do not use "Deactivate Public Distribution" as a casual rollback lever after external installs exist. Slack's docs warn that deactivating unlisted distribution can remove the app from workspaces other than the owning workspace. Prefer disabling the CRM install entry point or fixing forward unless there is a severe incident that justifies removing installs.

## 15. First 48 Hours After Public Distribution

For the first two days:

- Watch logs hourly during business hours.
- Check `slackInstallations` at least twice daily.
- Verify no `token_expired` rows.
- Verify no CATASTROPHIC token logs.
- Verify new installs map to the correct tenant.
- Verify `appId` is the production Slack App ID.
- Watch bad-signature logs for configuration drift.
- Watch `slack.notify.failed` and `slack.stale.failed`.
- Check support channels for Slack workspace admin approval questions.
- Keep a direct owner assigned for incident response.

After 48 clean hours, move to normal monitoring.

## 16. Rollback and Incident Response

### Frontend-Only Issue

Use Vercel rollback:

- Promote the last known-good production deployment from Vercel Dashboard.
- Or revert the offending commit and merge to `main`.

This does not roll back Convex data or schema.

### Convex Function Issue

Preferred: fix forward.

If a previous function version is needed:

```bash
git checkout <known-good-commit>
CONVEX_DEPLOY_KEY="prod:<redacted>" npx convex deploy
git checkout -
```

Do not revert schema blindly after Slack rows have been written. Convex schema must match production data.

### Slack Manifest Issue

If a URL/scope/event setting is wrong:

1. Fix `slack-manifest.prod.yaml`.
2. Render with production host.
3. Re-paste in Slack App Config.
4. Re-run URL verification and smoke tests.

If `token_rotation_enabled` was ever saved false on the prod app before launch:

- Discard that app.
- Create a new production Slack app with token rotation enabled.
- Replace credentials and manifest.
- Do not allow any tenant to install the bad app.

If this happened after tenant installs, treat as a launch-blocking incident and plan a forced re-OAuth migration to a new Slack app.

### Token Refresh Write Failure

Use `runbooks/slack-token-refresh-write-failure.md`.

Summary:

1. Identify `tenantId`, `installationId`, and `teamId` from the log.
2. Confirm row is `status: "token_expired"`.
3. Ask tenant admin to reconnect Slack.
4. Confirm row returns to `active`.

Do not try to reuse an old refresh token after Slack has rotated it.

### Need to Pause New Installs

Preferred options:

- Temporarily hide or disable the Connect Slack CTA in CRM and deploy.
- Temporarily make `/api/slack/start` return a controlled maintenance redirect.
- Communicate to support/sales that Slack installs are paused.

Avoid deactivating Slack Public Distribution unless the incident requires removing the app from external workspaces.

## 17. Source Links

Local project references:

- `plans/slackbot-v1/slackbot-design.md`
- `plans/slackbot-v1/slackbot-deferred.md`
- `plans/slackbot-v1/phase-summary.md`
- `plans/slackbot-v1/phases/phase1.md`
- `plans/slackbot-v1/phases/phase6.md`
- `slack-manifest.prod.yaml`
- `runbooks/slack-token-refresh-write-failure.md`
- `.docs/slack/installing-with-oauth.md`
- `.docs/slack/using-token-rotation.md`
- `.docs/slack/verifying-requests-from-slack.md`
- `.docs/slack/implementing-slash-commands.md`
- `.docs/slack/handling-user-interaction.md`
- `.docs/slack/events-api.md`
- `.docs/slack/rate-limits.md`
- `plans/archive/deployment/production.md`

Official references checked for this production pass:

- Slack OAuth v2 and token rotation: [https://docs.slack.dev/authentication/installing-with-oauth/](https://docs.slack.dev/authentication/installing-with-oauth/)
- Slack token rotation: [https://docs.slack.dev/authentication/using-token-rotation/](https://docs.slack.dev/authentication/using-token-rotation/)
- Slack request signing: [https://docs.slack.dev/authentication/verifying-requests-from-slack/](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
- Slack slash commands: [https://docs.slack.dev/interactivity/implementing-slash-commands/](https://docs.slack.dev/interactivity/implementing-slash-commands/)
- Slack interactions: [https://docs.slack.dev/interactivity/handling-user-interaction/](https://docs.slack.dev/interactivity/handling-user-interaction/)
- Slack app distribution: [https://docs.slack.dev/distribution/](https://docs.slack.dev/distribution/)
- Slack rate limits: [https://docs.slack.dev/apis/web-api/rate-limits/](https://docs.slack.dev/apis/web-api/rate-limits/)
- Convex environment variables: [https://docs.convex.dev/production/environment-variables/](https://docs.convex.dev/production/environment-variables/)
- Convex Vercel hosting: [https://docs.convex.dev/production/hosting/vercel/](https://docs.convex.dev/production/hosting/vercel/)
- Vercel environment variables: [https://vercel.com/docs/environment-variables](https://vercel.com/docs/environment-variables)
