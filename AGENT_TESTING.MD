# AGENT_TESTING.md — agent E2E testing guide

> **Audience:** AI agents (Cursor, Claude Code, Codex, Playwright fixtures) and
> human developers running browser UI tests against the dev or test tenant.
>
> **Companion docs:**
>
> - `TESTING.MD` — manual Calendly + Convex validation rules. Still authoritative
>   for backend assertions and lead-identifier hygiene.
> - `brainstorming/AGENT_E2E_TESTING.md` — architecture, threat model, and the
>   reasoning behind this workflow.

This guide explains **how to use** the test-only AuthKit session bridge that
lets an agent sign into the app as a chosen role without driving WorkOS's
hosted login UI. It covers the env vars, CLI, Convex helpers, and the
recommended end-to-end loop.

---

## What got built

| File | Purpose |
| --- | --- |
| `lib/testing/e2e-auth.ts` | Server-only HMAC-SHA256 sign/verify of short-lived login tokens. Source of truth for the token shape. |
| `app/api/testing/auth/login/route.ts` | Test-only Next.js route. Verifies a signed token, runs WorkOS password auth + org-scoped refresh, saves the AuthKit cookie, and redirects. Returns 404 unless `E2E_AUTH_ENABLED=1`. |
| `app/api/testing/auth/logout/route.ts` | Optional cleanup route. Clears the WorkOS session cookie and redirects to `/`. Navigate the browser directly to `http://localhost:3000/api/testing/auth/logout` to invoke it. |
| `scripts/e2e-login-url.mjs` | Local CLI that prints a signed login URL. Loads `.env.local` automatically. |
| `convex/testing/e2e.ts` | Internal queries for tenant lookup, user mapping, and focused booking/opportunity/meeting snapshots. |
| `package.json` scripts | `pnpm e2e:login-url <role> [returnTo]`. |

Nothing in this list mutates schema or production code paths. The login route
is gated behind `E2E_AUTH_ENABLED=1` and an origin allow-list.

---

## Prerequisites

### Required env in `.env.local`

The login route and CLI both refuse to run unless these are set:

```bash
# Master switch. Without this, the route returns 404 and the CLI errors out.
E2E_AUTH_ENABLED=1

# Long random secret. Generate with: openssl rand -base64 48
E2E_AUTH_TOKEN_SECRET="..."

# WorkOS organization id of the tenant your test users belong to.
# MUST start with "org_". Avoid stray quotes; the CLI parses .env.local
# the same way Next.js does and ignores anything past a closing quote.
E2E_TEST_TENANT_WORKOS_ORG_ID="org_..."

# Test users.
E2E_TENANT_OWNER_EMAIL="vas.claudio15+tenantowner@icloud.com"
E2E_CLOSER1_EMAIL="vas.claudio15+closer1@icloud.com"

# Shared password for the test accounts.
TEST_USERS_PASSWORD="..."

# Optional. Defaults to localhost + 127.0.0.1 on :3000 if omitted.
E2E_AUTH_ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000"
```

The standard WorkOS app envs (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`,
`WORKOS_COOKIE_PASSWORD`, `NEXT_PUBLIC_APP_URL`) must already be present —
they're required by the rest of the app.

> **Restart the dev server after editing `.env.local`.** Next.js only reloads
> env at process boot. The login route reads these on every request, but
> changes won't take effect until `pnpm dev` is restarted.

### Tenant prerequisites

Before any login URL works, the tenant referenced by
`E2E_TEST_TENANT_WORKOS_ORG_ID` must:

1. Have a Convex `tenants` row with a matching `workosOrgId` and
   `status: "active"` (or `"provisioning_webhooks"` if you only need data
   queries, not browser auth).
2. Have CRM `users` rows for each test email, with `isActive: true` and the
   correct CRM role:
   - `E2E_TENANT_OWNER_EMAIL` → `tenant_master` or `tenant_admin`
   - `E2E_CLOSER1_EMAIL` → `closer`
3. Have those WorkOS users as members of the WorkOS org. If a user has never
   accepted the org invitation,
   `authenticateWithRefreshToken({ organizationId })` will fail and the
   login route returns 403.

You can verify (1) and (2) in one call:

```bash
npx convex run testing/e2e:getTenantByWorkosOrgId '{"workosOrgId":"org_..."}'
npx convex run testing/e2e:getTestUserMap '{"tenantId":"<tenantId>"}'
```

---

## Quick start

The full happy-path loop for a single Calendly-driven test case.

### 1. Start local services

```bash
pnpm convex:dev    # Terminal A
pnpm dev           # Terminal B
```

### 2. Discover tenant + event type

The dedicated test event type for the agent E2E flow is:

```
https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm
```

That is the **scheduling URL** (the public Calendly URL). The booking
helper needs the **API URI** (`https://api.calendly.com/event_types/<uuid>`),
so the agent has to resolve one to the other exactly once per tenant. The
resolved API URI is stable and can be reused across runs.

```bash
npx convex run testing/e2e:getTenantByWorkosOrgId \
  '{"workosOrgId":"<E2E_TEST_TENANT_WORKOS_ORG_ID value>"}'

# Lists every active event type for the tenant. Find the entry where
# schedulingUrl equals "https://calendly.com/d/cvmm-vy4-696/test-meeting-for-crm"
# and read its `uri` — that's the eventTypeUri the rest of the flow needs.
npx convex run testing/calendly:listEventTypes \
  '{"tenantId":"<tenantId>"}'

# Custom questions can change as the event type is edited in Calendly, so
# refresh this every run to get the current question names.
npx convex run testing/calendly:getEventTypeDetailsForTesting \
  '{"tenantId":"<tenantId>","eventTypeUri":"<eventTypeUri>"}'
```

Capture the `tenantId`, the resolved API `eventTypeUri`, and the exact
custom question names from `getEventTypeDetailsForTesting`.

### 3. Pick a fresh lead identity

The pipeline merges leads by email and phone. Reusing values across runs
silently updates an old lead instead of creating a new one. Increment the
suffix every run:

```bash
# Should both return nothing for a new run.
npx convex data leads | rg 'vas\.claudio15\+lead123@icloud\.com'
npx convex data leadIdentifiers | rg '\+15005550123'
```

### 4. Book a real Calendly invitee

```bash
npx convex run testing/calendly:bookTestInvitee '{
  "tenantId": "<tenantId>",
  "eventTypeUri": "<eventTypeUri>",
  "inviteeEmail": "vas.claudio15+lead123@icloud.com",
  "inviteeName": "Agent E2E Lead 123",
  "inviteeTimezone": "America/Tegucigalpa",
  "textReminderNumber": "+15005550123",
  "questionAnswers": {
    "Instagram Handle": "agent_e2e_lead_123",
    "Phone Number": "+15005550123",
    "Message": "Agent E2E booking"
  },
  "tracking": {
    "utm_source": "dm_team",
    "utm_medium": "claudio_vasquez",
    "utm_campaign": "organic"
  }
}'
```

### 5. Wait for the webhook to land

```bash
npx convex run testing/e2e:getBookingResultByInviteeEmail '{
  "tenantId": "<tenantId>",
  "inviteeEmail": "vas.claudio15+lead123@icloud.com"
}'
```

Poll until `opportunity` and `meeting` are non-null. If after ~10s nothing
shows up, inspect:

```bash
npx convex logs --history 100
npx convex data rawWebhookEvents --limit 10
```

Capture the `assignedCloser.email` from the result. That dictates which role
alias you log in as.

### 6. Snapshot before any UI action

Run `getOpportunitySnapshot` (or save the booking-result output) so you can
diff state before vs after the closer's action.

### 7. Generate a login URL and open it

```bash
pnpm e2e:login-url closer1 /workspace/closer
# or:
node scripts/e2e-login-url.mjs closer1 /workspace/closer/meetings/<meetingId>
```

The script prints a single URL on stdout. Open it in Browser/Chrome. The
route exchanges the token for a real AuthKit cookie and redirects to
`returnTo`. Tokens expire 60 seconds after generation.

| Assigned closer email | Role alias |
| --- | --- |
| `vas.claudio15+closer1@icloud.com` | `closer1` |

If the assigned closer email is not the configured alias, fix
`users.calendlyUserUri` mapping or your env before opening the browser.

> Only one closer alias is currently wired up. If a future test tenant has
> multiple closers, add the new alias to both `E2ERoleAlias` in
> `lib/testing/e2e-auth.ts` and `VALID_ROLES` in `scripts/e2e-login-url.mjs`,
> then add the matching `E2E_<ALIAS>_EMAIL` env var.

### 8. Run UI steps and re-snapshot

Drive the closer dashboard and meeting detail page. After every mutating
action (Mark Lost, Record Payment, Start Meeting, Schedule Follow-Up,
Mark No Show), re-run `getOpportunitySnapshot` or `getMeetingSnapshot`:

```bash
npx convex run testing/e2e:getOpportunitySnapshot \
  '{"opportunityId":"<oppId>"}'

npx convex run testing/e2e:getMeetingSnapshot \
  '{"meetingId":"<meetingId>"}'
```

### 9. Switch to the tenant owner

Preferred: open a fresh browser context (Playwright `browser.newContext()`,
or a separate Chrome profile / incognito window) and run:

```bash
pnpm e2e:login-url tenant_owner /workspace/pipeline
```

Acceptable single-context fallback:

1. Navigate the browser to `http://localhost:3000/api/testing/auth/logout`
   (this clears the `wos-session` cookie and redirects to `/`).
2. Generate and open a fresh login URL:

   ```bash
   pnpm e2e:login-url tenant_owner /workspace/pipeline
   ```

Verify the admin views reflect the closer's actions, then take the final
backend snapshot to compare against the expected state from your test plan.

---

## CLI reference

### `pnpm e2e:login-url <role> [returnTo]`

Prints a signed login URL on stdout. No other output goes to stdout, so it's
safe to capture in shell scripts and Playwright fixtures.

- `role` — one of `tenant_owner`, `closer1`.
- `returnTo` — app-relative path, defaults to `/workspace`. Must start with
  `/` and must not start with `//`.

Errors:

- `E2E_AUTH_ENABLED must be '1'` — turn it on in `.env.local` and restart the
  dev server.
- `E2E_AUTH_TOKEN_SECRET is missing or shorter than 32 chars` — generate one
  with `openssl rand -base64 48`.
- `E2E_TEST_TENANT_WORKOS_ORG_ID is missing or not a WorkOS org id` — check
  for stray quotes or concatenated values in `.env.local`. The parser only
  takes what's inside the first matching pair of quotes.

### Logout

There is no npm script for logout — `open` would launch the system default
browser, which may not match the browser the agent is driving. Instead,
have the agent navigate its current browser session to:

```
http://localhost:3000/api/testing/auth/logout
```

The route clears the `wos-session` cookie and redirects to `/`. Returns 404
unless E2E auth is enabled and the origin is in
`E2E_AUTH_ALLOWED_ORIGINS`.

### `node scripts/e2e-login-url.mjs ...`

Same as `pnpm e2e:login-url`, useful when you want to invoke from a sibling
script or a Playwright fixture without going through pnpm. Example:

```ts
import { execFileSync } from "node:child_process";
const url = execFileSync(
  "node",
  ["scripts/e2e-login-url.mjs", "closer1", "/workspace/closer"],
  { encoding: "utf8" },
).trim();
```

---

## Convex helper reference

All four helpers are `internalQuery` — invoke via `npx convex run` or via
`internal.testing.e2e.*` from a Convex action.

### `testing/e2e:getTenantByWorkosOrgId`

Args: `{ workosOrgId: string }`. Returns the tenant identity + lifecycle
fields, or `null`. Use to bootstrap every test.

### `testing/e2e:getTestUserMap`

Args: `{ tenantId: Id<"tenants"> }`. Returns up to 100 users for the tenant
with their email, role, `calendlyUserUri`, and `isActive` flag. Use to
verify role-alias mappings.

### `testing/e2e:getBookingResultByInviteeEmail`

Args: `{ tenantId: Id<"tenants">, inviteeEmail: string }`. Returns the
latest lead, opportunity, meeting, and assigned closer for the given
invitee. The polling target right after `testing/calendly:bookTestInvitee`.

### `testing/e2e:getOpportunitySnapshot`

Args: `{ opportunityId: Id<"opportunities"> }`. Returns the opportunity
plus up to 20 meetings, follow-ups, and payment records. The diff target
for assertions after a UI action.

### `testing/e2e:getMeetingSnapshot`

Args: `{ meetingId: Id<"meetings"> }`. Lighter-weight than
`getOpportunitySnapshot` when a test only cares about a single meeting.

---

## Role switching

Recommended order, strictest to loosest isolation:

1. **Separate browser contexts** (Playwright `browser.newContext()`).
   Each context gets its own cookie jar — no race conditions.
2. **Separate Chrome profiles or incognito windows.** Same idea, manual.
3. **Navigate to `/api/testing/auth/logout` + open a fresh login URL** in
   the same window. Works, but a stale tab still mounted with the previous
   role can cause confusing reactive state.

Never rely on clicking the in-app sign-out button as part of test setup —
that turns auth setup into another UI dependency you'd have to debug if it
ever breaks.

---

## Failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Login URL returns 404 | `E2E_AUTH_ENABLED` is not `1`, dev server was started before `.env.local` was updated, or origin is not in the allow list | Set the env, restart `pnpm dev`, hit the URL on `http://localhost:3000` |
| Login URL returns 401 | Token expired (60s TTL), `E2E_AUTH_TOKEN_SECRET` differs between CLI and dev server, or the URL was truncated | Generate a fresh URL, confirm the secret matches in `.env.local` |
| Login URL returns 403 | `E2E_TEST_TENANT_WORKOS_ORG_ID` does not match the token's `orgId`, or the user is not a member of that WorkOS org | Confirm tenant org id in `.env.local` and that the user has accepted the WorkOS invitation |
| Login URL returns 500 | `TEST_USERS_PASSWORD` or `WORKOS_CLIENT_ID` missing | Add them to `.env.local`, restart |
| Browser lands on `/` instead of `/workspace/...` | AuthKit session created but no Convex CRM user exists for that WorkOS user | Run `getTestUserMap` and confirm the WorkOS user is provisioned in Convex |
| Closer cannot see the meeting | Calendly assigned the other closer; you logged in as the wrong alias | Read `assignedCloser.email` from the booking result and use the matching alias |
| Backend data missing after booking | Webhook didn't arrive or failed processing | Check `npx convex logs --history 100` and `npx convex data rawWebhookEvents --limit 10` |

---

## Security notes

- The login route is **only** safe to enable on local dev or a throwaway
  preview deployment. Never set `E2E_AUTH_ENABLED=1` in a production env.
- The route enforces:
  - `E2E_AUTH_ENABLED=1` (else 404)
  - origin in `E2E_AUTH_ALLOWED_ORIGINS` (else 404)
  - HMAC-SHA256 signature with constant-time compare (else 401)
  - 60s token TTL (else 401)
  - configured `orgId` matches `E2E_TEST_TENANT_WORKOS_ORG_ID` (else 403)
  - `returnTo` is app-relative (else 401 from token verification)
- Tokens carry only a role alias, not raw credentials. Even if a token leaks,
  it expires in 60 seconds and only works against the configured tenant org.
- Do not paste signed login URLs, raw `.env.local`, or `TEST_USERS_PASSWORD`
  into commit messages, agent transcripts, screenshots, or PR descriptions.
- The route logs role + user id + org id but never the token, password, or
  refresh token.

---

## When something doesn't fit

- The Calendly booking helper (`testing/calendly:bookTestInvitee`) and the
  legacy QA workflow described in `TESTING.MD` continue to be the source of
  truth for **how** to produce test data. This guide only covers how to
  authenticate and how to read the focused snapshots.
- If you need a Convex helper that doesn't exist yet, add it to
  `convex/testing/e2e.ts` as a narrow `internalQuery` with a clear
  return shape — never call `.collect()` without a bound, never query
  without a `withIndex` clause.
- If you need to log in as a role alias that doesn't exist yet, add it to
  `E2ERoleAlias` and `ROLE_EMAIL_ENV` in `lib/testing/e2e-auth.ts` and to
  `VALID_ROLES` in `scripts/e2e-login-url.mjs`, then set the matching
  `E2E_<ALIAS>_EMAIL` env var. All three locations must agree.
