# Calendly documentation (local mirror) — index for exploration

This folder is an **offline / repo-local** copy of selected [Calendly Developer](https://developer.calendly.com) material. Use this file as the **entry point**: it maps topics to paths, states what each file covers, and suggests reading order for common integration tasks.

**Path note:** The directory is named `api-refrerence` (typo for “reference”). All paths below use the names on disk.

---

## Quick routing (task → start here)

| Goal | Start with |
|------|------------|
| Public app: register app, PKCE, redirect URIs, sandbox vs production | [oauth/creating-an-oauth-app.md](./oauth/creating-an-oauth-app.md) |
| Internal/private script: token from Calendly UI | [oauth/pat-overview.md](./oauth/pat-overview.md) |
| Which OAuth scopes / which endpoints they unlock | [oauth/scopes.md](./oauth/scopes.md) |
| OAuth 2.1 refresh token rotation (single-use refresh tokens) | [oauth/refresh-token.md](./oauth/refresh-token.md) |
| Authorization URL, code exchange, PKCE query params | [oauth/api/get-authorization-code.md](./oauth/api/get-authorization-code.md), [oauth/api/get-accesstoken.md](./oauth/api/get-accesstoken.md) |
| Introspect or revoke tokens | [oauth/api/introspect-access-refresh-token.md](./oauth/api/introspect-access-refresh-token.md), [oauth/api/revoke-token.md](./oauth/api/revoke-token.md) |
| URIs vs IDs, pagination, API behavior | [api-refrerence/api-conventions.md](./api-refrerence/api-conventions.md) |
| Rate limits, 429 headers, backoff | [api-refrerence/api-limits.md](./api-refrerence/api-limits.md) |
| Resolve `user` / `organization` URIs for API calls | [organization/organization-or-user-uri.md](./organization/organization-or-user-uri.md) |
| Create webhook subscriptions, scopes, event matrix | [api-refrerence/webhooks/pure-api/create-webhook.md](./api-refrerence/webhooks/pure-api/create-webhook.md) |
| List webhook subscriptions (`webhooks:read`, query filters) | [api-refrerence/webhooks/pure-api/list-webhook-subscriptions.md](./api-refrerence/webhooks/pure-api/list-webhook-subscriptions.md) |
| Get one webhook subscription by UUID (`webhooks:read`) | [api-refrerence/webhooks/pure-api/get-webhook-subscription.md](./api-refrerence/webhooks/pure-api/get-webhook-subscription.md) |
| Delete webhook subscription (`webhooks:write`, 204 No Content) | [api-refrerence/webhooks/pure-api/delete-webhook-subscription.md](./api-refrerence/webhooks/pure-api/delete-webhook-subscription.md) |
| Sample webhook JSON for testing (`GET /sample_webhook_data`, `webhooks:read`) | [api-refrerence/webhooks/pure-api/get-sample-webhook-data.md](./api-refrerence/webhooks/pure-api/get-sample-webhook-data.md) |
| Webhook resource shape | [api-refrerence/webhooks/webhook-subscription-object.md](./api-refrerence/webhooks/webhook-subscription-object.md) |
| Verify `Calendly-Webhook-Signature`, signing keys | [api-refrerence/webhooks/webhook-signature.md](./api-refrerence/webhooks/webhook-signature.md) |
| Delivery retries, disable after failures | [api-refrerence/webhooks/webhook-errrors.md](./api-refrerence/webhooks/webhook-errrors.md) |
| Connection/read timeouts for webhook delivery | [api-refrerence/webhooks/webhook-timeouts.md](./api-refrerence/webhooks/webhook-timeouts.md) |
| Webhook JSON envelope + invitee payload fields + examples | [api-refrerence/webhooks/webhook-events-samples/webhook-payload.md](./api-refrerence/webhooks/webhook-events-samples/webhook-payload.md) |
| Reference CRM sample app (GitHub) | [buzzword/calendlly-buzzword-crm.md](./buzzword/calendlly-buzzword-crm.md) |
| Machine-readable API outline | [postman/Calendly API.postman_collection (1).json](./postman/Calendly%20API.postman_collection%20(1).json) |

---

## Canonical endpoints (from mirrored docs)

| Use | Base URL |
|-----|----------|
| Calendly API v2 resources | `https://api.calendly.com` |
| OAuth authorize / token / introspect / revoke | `https://auth.calendly.com` (paths: `/oauth/authorize`, `/oauth/token`, `/oauth/introspect`, `/oauth/revoke`) |

Bearer token: `Authorization: Bearer <token>` for API calls. Web clients exchanging codes use Basic auth with `client_id`/`client_secret` on the token endpoint per [oauth/api/get-accesstoken.md](./oauth/api/get-accesstoken.md).

---

## Directory tree (all files)

```
.docs/calendly/
├── index.md                          ← this file
├── buzzword/
│   └── calendlly-buzzword-crm.md     # Link + note: Calendly’s BuzzwordCRM example
├── oauth/
│   ├── creating-an-oauth-app.md      # Developer account, app registration, PKCE, redirect rules
│   ├── pat-overview.md               # Personal access tokens (UI), scopes pointer
│   ├── refresh-token.md              # Single-use refresh token rotation (OAuth 2.1)
│   ├── scopes.md                     # Full scope catalog, webhooks vs API, troubleshooting
│   └── api/
│       ├── get-authorization-code.md # GET /oauth/authorize (incl. PKCE)
│       ├── get-accesstoken.md        # POST /oauth/token (authorization_code; token response)
│       ├── introspect-access-refresh-token.md
│       └── revoke-token.md
├── organization/
│   └── organization-or-user-uri.md # GET /users/me; PAT vs OAuth payload differences
├── api-refrerence/
│   ├── api-conventions.md            # Resource URIs, keyset pagination, deterministic responses
│   ├── api-limits.md                 # Per-user rate limits, 429, headers
│   └── webhooks/
│       ├── pure-api/
│       │   ├── create-webhook.md              # POST /webhook_subscriptions (detailed)
│       │   ├── list-webhook-subscriptions.md   # GET /webhook_subscriptions
│       │   ├── get-webhook-subscription.md     # GET /webhook_subscriptions/{uuid}
│       │   ├── delete-webhook-subscription.md  # DELETE /webhook_subscriptions/{uuid}
│       │   └── get-sample-webhook-data.md      # GET /sample_webhook_data
│       ├── webhook-subscription-object.md
│       ├── webhook-signature.md
│       ├── webhook-timeouts.md
│       ├── webhook-errrors.md        # filename spelling: errrors
│       ├── webhooks-example.md       # ⚠ duplicate of api-limits content; prefer api-limits.md
│       └── webhook-events-samples/
│           └── webhook-payload.md    # Envelope + invitee/routing/event_type payload notes + JSON samples
└── postman/
    └── Calendly API.postman_collection (1).json
```

---

## Deeper notes by area

### Authentication

- **OAuth (public apps):** [oauth/creating-an-oauth-app.md](./oauth/creating-an-oauth-app.md) — Sandbox vs Production, redirect URI rules (localhost HTTP allowed in sandbox; HTTPS in production), PKCE with `S256`, client secret and webhook signing key shown only at creation.
- **PAT (private/internal):** [oauth/pat-overview.md](./oauth/pat-overview.md) — Generated in Calendly Integrations → API & Webhooks; not retrievable after creation.
- **Token lifetime:** Access tokens ~2 hours ([oauth/api/get-accesstoken.md](./oauth/api/get-accesstoken.md)). Refresh behavior: [oauth/refresh-token.md](./oauth/refresh-token.md) — treat refresh tokens as **single-use**; persist the new refresh token from every successful refresh response.

### Scopes and permissions

- [oauth/scopes.md](./oauth/scopes.md) — `:write` implies `:read` in the same domain; webhook deliveries require related **read** scopes for the event family; `webhooks:write` / `webhooks:read` for subscription management.
- Webhook **create** and **delete** require `webhooks:write`; **list** and **get** require `webhooks:read` ([list-webhook-subscriptions.md](./api-refrerence/webhooks/pure-api/list-webhook-subscriptions.md), [get-webhook-subscription.md](./api-refrerence/webhooks/pure-api/get-webhook-subscription.md), [delete-webhook-subscription.md](./api-refrerence/webhooks/pure-api/delete-webhook-subscription.md)). Per-event **required auth scopes** for creation are tabulated in [create-webhook.md](./api-refrerence/webhooks/pure-api/create-webhook.md) (e.g. invitee events → `scheduled_events:read`).

### API design and limits

- [api-refrerence/api-conventions.md](./api-refrerence/api-conventions.md) — Resources identified by **URI** strings (not bare IDs); collections use **cursor/keyset** pagination via `pagination.next_page`.
- [api-refrerence/api-limits.md](./api-refrerence/api-limits.md) — Paid vs free per-user RPM; stricter limits for “Create Event Invitee”; `X-RateLimit-*` headers; max **8 OAuth token requests per user per minute**.

### Organization / user context

- [organization/organization-or-user-uri.md](./organization/organization-or-user-uri.md) — `GET /users/me` for PAT; OAuth token payload uses `owner` / `organization` for URIs; `/organization_memberships` for org-wide membership discovery.

### Webhooks

- **Subscription creation:** [api-refrerence/webhooks/pure-api/create-webhook.md](./api-refrerence/webhooks/pure-api/create-webhook.md) — `scope`: `organization` | `user` | `group`; `events` list; optional `signing_key`.
- **List subscriptions:** [api-refrerence/webhooks/pure-api/list-webhook-subscriptions.md](./api-refrerence/webhooks/pure-api/list-webhook-subscriptions.md) — `GET /webhook_subscriptions`; required `organization` + `scope`; optional `user` / `group`, `count`, `page_token`, `sort` (`created_at`); `collection` + `pagination` with `next_page` / page tokens.
- **Get subscription:** [api-refrerence/webhooks/pure-api/get-webhook-subscription.md](./api-refrerence/webhooks/pure-api/get-webhook-subscription.md) — `GET /webhook_subscriptions/{webhook_uuid}`; body `{ "resource": { ... } }`.
- **Delete subscription:** [api-refrerence/webhooks/pure-api/delete-webhook-subscription.md](./api-refrerence/webhooks/pure-api/delete-webhook-subscription.md) — `DELETE /webhook_subscriptions/{webhook_uuid}`; **`204`** with empty body on success.
- **Sample payload:** [api-refrerence/webhooks/pure-api/get-sample-webhook-data.md](./api-refrerence/webhooks/pure-api/get-sample-webhook-data.md) — `GET /sample_webhook_data`; query `event`, `organization`, `scope` (+ optional `user` / `group`); returns a **Webhook Payload** JSON body for local testing (not a signed delivery).
- **Resource schema:** [webhook-subscription-object.md](./api-refrerence/webhooks/webhook-subscription-object.md).
- **Security:** [webhook-signature.md](./api-refrerence/webhooks/webhook-signature.md) — Header format `t=...,v1=...`; HMAC-SHA256 over `t + '.' + raw_body`; replay window guidance.
- **Reliability:** [webhook-errrors.md](./api-refrerence/webhooks/webhook-errrors.md) — Retries up to ~24h with backoff; subscription **disabled** if no success; [webhook-timeouts.md](./api-refrerence/webhooks/webhook-timeouts.md) — 10s connect, 15s read.
- **Payloads:** [webhook-events-samples/webhook-payload.md](./api-refrerence/webhooks/webhook-events-samples/webhook-payload.md) — Root `event`, `created_at`, `created_by`, `payload` (invitee vs routing form vs event type variants); includes runnable JSON examples for invitee flows. Programmatic samples: [get-sample-webhook-data.md](./api-refrerence/webhooks/pure-api/get-sample-webhook-data.md).

### Postman collection

- [postman/Calendly API.postman_collection (1).json](./postman/Calendly%20API.postman_collection%20(1).json) — Use for endpoint names, folders, and variables when cross-checking against official OpenAPI/docs. Not a substitute for the markdown guides above for behavioral rules (pagination, signatures, token rotation).

### External reference sample

- [buzzword/calendlly-buzzword-crm.md](./buzzword/calendlly-buzzword-crm.md) — Points to [github.com/calendly/buzzwordcrm](https://github.com/calendly/buzzwordcrm) as a CRM-style integration reference (not necessarily event-driven).

---

## Gaps and official docs

This mirror is **incomplete** relative to the full Calendly API (many resources/endpoints are not copied here). For endpoints not listed in the tree, use [developer.calendly.com](https://developer.calendly.com) or the Postman collection, and keep behavioral rules from **api-conventions**, **scopes**, **api-limits**, and **refresh-token** in mind.

---

## Suggested reading order for a new integration

1. [oauth/creating-an-oauth-app.md](./oauth/creating-an-oauth-app.md) or [oauth/pat-overview.md](./oauth/pat-overview.md)  
2. [oauth/scopes.md](./oauth/scopes.md)  
3. [api-refrerence/api-conventions.md](./api-refrerence/api-conventions.md) + [api-refrerence/api-limits.md](./api-refrerence/api-limits.md)  
4. [organization/organization-or-user-uri.md](./organization/organization-or-user-uri.md)  
5. If using webhooks: [create-webhook.md](./api-refrerence/webhooks/pure-api/create-webhook.md) / [list-webhook-subscriptions.md](./api-refrerence/webhooks/pure-api/list-webhook-subscriptions.md) / [get-webhook-subscription.md](./api-refrerence/webhooks/pure-api/get-webhook-subscription.md) / [delete-webhook-subscription.md](./api-refrerence/webhooks/pure-api/delete-webhook-subscription.md) / [get-sample-webhook-data.md](./api-refrerence/webhooks/pure-api/get-sample-webhook-data.md) → [webhook-payload.md](./api-refrerence/webhooks/webhook-events-samples/webhook-payload.md) → [webhook-signature.md](./api-refrerence/webhooks/webhook-signature.md) → [webhook-errrors.md](./api-refrerence/webhooks/webhook-errrors.md)  
6. If using OAuth refresh: [oauth/refresh-token.md](./oauth/refresh-token.md) + [oauth/api/get-accesstoken.md](./oauth/api/get-accesstoken.md)
