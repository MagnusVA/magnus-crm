# Observability

Errors, logs, and server events all go to PostHog (US cloud). This guide covers where each signal comes from, how backend errors are triaged, and the setup each deployment needs.

## Signals

| Signal | Source | Lands in PostHog as |
| --- | --- | --- |
| Browser errors | posthog-js `capture_exceptions`, error boundaries, `reportClientError` | Error Tracking, with session replay |
| Browser copies of Convex failures | `before_send` in `lib/observability/client-exceptions.ts` | A `convex_call_failed` event with `convex_request_id`, not an issue |
| Next.js server errors | `onRequestError` in `instrumentation.ts` | Error Tracking, linked to the person and session through the `ph_…_posthog` cookie |
| Handled Next.js server errors | `reportServerError` in route handlers and server actions | Error Tracking, `error_origin: next_server_handled` |
| Convex failures | Convex webhook log stream → `app/api/observability/convex/route.ts` | Error Tracking (`bug`, `integration`, `platform`) or a `convex_request_rejected` event (`expected`) |
| Handled backend errors | `reportError` in Convex code | Error Tracking, `convex_handled: true` |
| Backend logs | `console.*` and `log.*` in Convex code | Logs, service `magnus-convex` |
| Slow functions, write conflicts, scheduler lag | log stream `function_execution` and `scheduler_stats` | Logs at `WARN` |
| Bookings stuck unprocessed for 15 minutes | `pipeline-stuck-events` cron | Error Tracking, `pipeline.events_stuck_unprocessed` |
| Business events | `emitDomainEvent` → `@posthog/convex` | Events named after the domain event (`payment.recorded`, `opportunity.status_changed`); free-text reasons and notes stay in Convex |
| Browser logs | `posthog.logger.*` | Logs, service `magnus-web` |

Every signal uses the raw WorkOS user id (`user_…`) as the distinct id and the WorkOS org id as the `company` group, matching `usePostHogIdentify`. Events with no acting user use `system:tenant:<tenantId>` and skip person profiles.

## Why Convex errors go through the log stream

`@posthog/convex` sends through `ctx.scheduler`. When a mutation throws, Convex discards everything it scheduled, so a mutation can't report its own failure, and queries can't schedule at all. The log stream reports every failed execution, including rolled-back mutations, with the function path, request id, run reason, and stack. The component is used only for business events, where "sent only if the mutation commits" is the behavior we want.

Log streams need the Convex Pro plan.

## Writing Convex code

Import from `convex/lib/observability/`:

- `log.info|warn|error(event, attrs)` writes `[obs] <event> <json>`. The ingest route turns the JSON into log attributes, so you can filter PostHog Logs by `attr.tenantId` or `attr.reason`. Name events domain first, dotted and lowercase (`pipeline.event.processed`), and keep reasons stable snake_case.
- `reportError(event, error, { severity, fingerprint, integration, ...attrs })` reports an error the code caught and handled. Use it where an error is swallowed, turned into a status field, or retried later, and where data is dropped on purpose. Uncaught errors are already reported, so don't catch and rethrow just to report.
- `rejectRequest(code, message, attrs)` and `expectedError(code, message)` return a `ConvexError` for failures the caller caused (signed out, no access, invalid input). These count as rejections, not bugs, and the browser shows `error.data.message` unredacted in production. Throw a plain `Error` when the code is wrong.
- The auth helpers call `logRequestContext`, which attributes the rest of the request's logs and failures to the user and tenant. Actions that authorize by hand, webhooks, and portal actions call it themselves once they know the caller or tenant. Anything else reports under `convex:<deployment>`.
- When a third-party call fails, throw `<Vendor> <operation> failed: HTTP <status>`, with a short machine error code if the vendor sent one, and never the response body. The classifier reads the vendor and status from that shape.
- Give every external `fetch` a timeout with `timeoutSignal(ms)` from `convex/lib/timeoutSignal.ts`.

## Writing Next.js code

- Route handlers and server actions that catch an error and redirect or return an error state call `reportServerError(error, { event, request, fingerprint, expected, integration })` from `lib/observability/report-server-error.ts`. Uncaught server errors are already reported by `onRequestError`.
- Client code that catches an error outside a Convex call (an upload, a download, a file export) calls `reportClientError(error, { flow, httpStatus })` from `lib/observability/report-client-error.ts`. Both helpers skip Convex errors, which the backend reports.
- Show users `getErrorMessage(error, fallback)` from `lib/errors.ts`: a `ConvexError`'s `error.message` is raw JSON. Branch on `getErrorCode(error)` rather than matching message text, which production redacts for plain `Error`s.
- Sign out through `useSignOut()` (`hooks/use-sign-out.ts`), which resets PostHog so the next person on the browser isn't merged into the last.

### What to log

PostHog already gets each function's path, duration, and failure from the log stream, each domain event from `emitDomainEvent`, and the caller from the auth helpers. A log line has to add something those don't.

Log:

- one outcome line for a critical write with no domain event, carrying the branch the code took
- skips, no-ops, idempotent repeats, and fallbacks, with a stable `reason`
- cron, backfill, and migration runs, as a start or batch line plus a summary with counts and `durationMs`
- security events such as failed portal logins, lockouts, and bad signatures
- outcomes of third-party API calls, with the HTTP status

Don't log:

- inside queries, which re-run on every subscription update. A real data-integrity anomaly is the exception.
- "called", "auth passed", "found", or "patch applied" trail lines
- the message you're about to throw
- once per row inside a loop. Log one summary after it.
- the same state change a domain event in the same mutation already records

Never log tokens, secrets, signatures, emails, names, phone numbers, message text, or raw webhook payloads. Log ids. The ingest route also replaces email addresses with `<email>` in everything it forwards, since older log lines interpolate them, but don't rely on that.

## Triage

`lib/observability/error-rules.ts` decides what becomes an issue, in this order:

1. A `ConvexError`, or a request that logged `request.rejected`, is `expected`.
2. Convex limits and timeouts are `platform`.
3. A message naming Calendly, Slack, or WorkOS with an HTTP status is `integration`, grouped by vendor and status.
4. A request no client started (cron, scheduler, webhook) is a `bug`, whatever the message says.
5. From a client call, a short allowlist of older messages is `expected`: auth failures, "Not your …", portal sessions, "<record> not found" for records a page can link to, and input validation. Messages that name an environment variable or an internal invariant stay bugs.
6. Everything else is a `bug`, fingerprinted by function, error name, and the message with ids, numbers, and quoted values stripped.

Write-conflict failures become a `WARN` log, not an issue, because Convex retries them. Repeats of one fingerprint in a batch collapse into one exception with `occurrences_in_batch`, and a batch sends at most 50. Exceptions and events carry deterministic ids, so when the route returns 5xx and Convex resends the batch, PostHog doesn't count them twice.

The route redacts emails, phone numbers, Calendly name slugs, double-quoted values, and Convex argument dumps from everything it forwards (`lib/observability/redact.ts`).

When an issue turns out to be expected, convert the throw to `rejectRequest` (preferred) or add a rule, then resolve the issue in PostHog. Because the legacy rules match on message text, alert on spikes in `convex_request_rejected` by `error_rule` and `convex_function` too: a bug hidden by a rule shows up there. Tests are in `lib/observability/convex-log-stream.test.ts`.

In the browser, `before_send` drops `ConvexError`s, lost connections, deploy chunk errors, ResizeObserver noise, aborted fetches, offline network errors, and Next's redacted server-render errors, which `onRequestError` reports with the real message. Other Convex failures become `convex_call_failed` events: search by `convex_request_id` to go from the backend issue to the browser session and its replay. The SDK masks `token`, `code`, and `state` URL parameters, so invite tokens and OAuth codes never reach PostHog.

Useful properties for filters, assignment rules, and alerts: `error_kind`, `error_code`, `error_rule`, `integration`, `convex_function`, `convex_run_reason`, `tenant_id`, `error_origin`, `environment`.

## Setup

Per Convex deployment:

1. `npx convex env set POSTHOG_PROJECT_TOKEN phc_…`, or `disabled` on deployments that shouldn't send events. The variable is required, so set it before deploying.
2. In the Convex dashboard, under Settings → Integrations, add a Webhook log stream pointing at `https://<app>/api/observability/convex`, JSON format. Copy its secret.

Per Vercel environment:

1. `CONVEX_LOG_STREAM_SECRET` set to the webhook secret.
2. `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST`, which already exist.

In PostHog:

1. Enable Logs and Error Tracking for the project.
2. Add alerts for new and reopened issues, filtered to `environment` = `production` (or `prod` for Convex), sent to Slack.
3. Add a trend alert on `convex_request_rejected` grouped by `error_rule`, for a spike that would mean a misclassified bug.
4. Optional: assignment rules on `integration` and `convex_function`, and suppression rules for any noise the browser filter misses. Suppression rules apply without a deploy.

PostHog only runs when `NODE_ENV` is production, so `pnpm dev` sends nothing. To test the ingest locally, run `pnpm build && pnpm start`, expose it with `pnpm expose`, and point a dev deployment's log stream at the tunnel.
