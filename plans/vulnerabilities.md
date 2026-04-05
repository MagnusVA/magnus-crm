# Security Vulnerability Report — MAGNUS CRM

**Audit date:** 2026-04-04
**Scope:** Full codebase (`/convex`, `/app`, `/lib`, `/components`, config files, environment variables)

---

## Executive Summary

The codebase demonstrates strong foundational security: proper auth checks on every client-callable Convex function, HMAC-SHA256 webhook verification with timing-safe comparison, PKCE for OAuth, tenant isolation, and role-based access control. However, there are several vulnerabilities ranging from critical to low that need attention before production hardening.

---

## Findings by Severity

### CRITICAL

#### VULN-01: Hardcoded System Admin Org ID in Source Code

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/lib/constants.ts:7` |
| **Severity**   | Critical |
| **Effort**     | 15 min |

```ts
export const SYSTEM_ADMIN_ORG_ID = "<SYSTEM_ADMIN_ORG_ID>";
```

**Description:** The single value that grants god-mode over the entire platform (create tenants, delete tenants, wipe all data) is committed to source code. Anyone who reads the repository — a public leak, a disgruntled contributor, a compromised CI artifact — learns the exact WorkOS org ID required to impersonate a system admin.

**Exploitation path:** An attacker who can create a WorkOS user within this org (or who compromises any existing member) immediately has full admin access to every tenant.

**Remediation:** Move to an environment variable (`SYSTEM_ADMIN_ORG_ID`) set only in the Convex deployment environment. Update `requireSystemAdmin.ts` and any imports to read from `process.env`.

---

#### VULN-02: OAuth Tokens and Signing Keys Stored in Plaintext in Database

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/schema.ts:26-38` |
| **Severity**   | Critical |
| **Effort**     | 3 hrs |

**Affected fields in the `tenants` table:**

- `calendlyAccessToken` (line 27)
- `calendlyRefreshToken` (line 28)
- `codeVerifier` (line 26)
- `webhookSigningKey` (line 38)

**Description:** All Calendly OAuth tokens and per-tenant webhook signing keys are stored as plaintext strings. A database breach (Convex admin access compromise, backup leak, support incident) exposes:

- Every tenant's Calendly account (access + refresh tokens allow full API access)
- Ability to forge valid webhook events for any tenant (signing keys)

**Remediation:** Implement application-level encryption using a key stored outside Convex (e.g., in a KMS or a dedicated env var). Encrypt on write, decrypt on read within `"use node"` actions. Consider using the `node:crypto` `createCipheriv`/`createDecipheriv` pattern with AES-256-GCM.

---

#### VULN-03: Invitation Callback Bypasses PKCE via Heuristic Detection

| Field          | Value |
| -------------- | ----- |
| **File**       | `app/callback/route.ts:40-46, 72-155` |
| **Severity**   | Critical |
| **Effort**     | 2 hrs |

```ts
function isInvitationCallback(request: NextRequest): boolean {
  const hasCode = request.nextUrl.searchParams.has("code");
  const hasState = request.nextUrl.searchParams.has("state");
  return hasCode && !hasState; // any request without `state` takes this path
}
```

**Description:** When `isInvitationCallback` returns `true`, the code exchanges the authorization code using the confidential-client flow (no PKCE verifier). The detection heuristic is fragile: **any** callback that arrives with `code` but without `state` — whether from a browser extension stripping params, a crafted malicious link, or a reflected redirect — bypasses PKCE entirely and uses the server-side confidential exchange.

**Exploitation path:** An attacker who obtains a valid authorization `code` (via referrer leakage, open redirect, or log exposure) can exchange it without needing the PKCE verifier by simply omitting the `state` parameter.

**Remediation options (pick one):**

1. **Distinct callback URL:** Use `/callback/invitation` for invitation flows, registered separately with WorkOS, so detection is URL-based rather than heuristic-based.
2. **Signed state marker:** Include a cryptographically signed `type: "invitation"` claim in the `state` parameter during invitation flows so the callback can distinguish them authoritatively.
3. **Store expected flow type:** Before redirecting to WorkOS, store the expected flow type (`invitation` vs `normal`) in a server-side session or signed cookie. Validate on callback.

---

### HIGH

#### VULN-04: `validateInvite` Is Unauthenticated With No Rate Limiting

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/onboarding/invite.ts:9-82` |
| **Severity**   | High |
| **Effort**     | 1 hr |

**Description:** The `validateInvite` action is intentionally unauthenticated (anonymous users must validate invite tokens). However:

1. **No rate limiting** — an attacker can call this at scale to scan/enumerate tokens.
2. **Information leakage** — the response returns distinct error codes (`invalid_signature`, `not_found`, `already_redeemed`, `expired`) plus `workosOrgId` and `companyName` on failure paths (lines 55-60). An attacker learns which tokens have valid signatures (even if expired) and harvests company names.

While HMAC-SHA256 brute force is computationally infeasible, the information leakage and lack of rate limiting are still problematic.

**Remediation:**

1. Implement rate limiting using `@convex-dev/ratelimiter` or a custom `rateLimits` table keyed by client fingerprint.
2. Return a generic `{ valid: false, error: "invalid_or_expired" }` for all failure cases. Never return `workosOrgId` or `companyName` on failure paths.

---

#### VULN-05: Localhost Fallback URLs Reach Production

| Field          | Value |
| -------------- | ----- |
| **Files**      | `convex/admin/tenants.ts:58`, `convex/calendly/oauth.ts:17`, `app/callback/route.ts:54` |
| **Severity**   | High |
| **Effort**     | 10 min |

```ts
// Pattern found in multiple files:
process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
```

**Description:** If `NEXT_PUBLIC_APP_URL` is ever unset in a deployment (env var rotation, misconfiguration, Vercel rebuild without env), the app silently falls back to `http://localhost:3000`. Consequences:

- Invite links point to localhost (useless, but if a user clicks them the browser may resolve to a local service)
- Calendly OAuth redirect URIs point to localhost — if `localhost:3000` is registered as a valid redirect URI in Calendly (common during development), tokens could be captured by a local attacker
- WorkOS session redirect also falls back to localhost

**Remediation:** Replace all fallback patterns with a hard failure:

```ts
function getAppUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) throw new Error("Missing NEXT_PUBLIC_APP_URL");
  return url;
}
```

---

#### VULN-06: `convexSiteUrl` Accepted as Client-Supplied Argument

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/calendly/oauth.ts:114-119` |
| **Severity**   | High |
| **Effort**     | 15 min |

```ts
export const exchangeCodeAndProvision = action({
  args: {
    tenantId: v.id("tenants"),
    code: v.string(),
    convexSiteUrl: v.string(), // passed from the client
  },
  // ...
```

**Description:** The `convexSiteUrl` is passed from the Next.js callback route and used to construct the Calendly webhook subscription URL (via `provisionWebhookSubscription`). While the current caller is a server-side route (`/app/callback/calendly/route.ts`), the Convex action itself is client-callable. A malicious client could call `exchangeCodeAndProvision` directly with a `convexSiteUrl` pointing to their own server, causing all Calendly webhooks for that tenant to be delivered to an attacker-controlled endpoint.

**Exploitation path:**

1. Attacker authenticates as a tenant admin
2. Initiates Calendly OAuth flow normally to get a valid `code`
3. Calls `exchangeCodeAndProvision` directly via the Convex client with `convexSiteUrl: "https://evil.com"`
4. All future Calendly webhooks for this tenant are sent to `https://evil.com/webhooks/calendly?tenantId=...`

**Remediation:** Read `convexSiteUrl` from `process.env.NEXT_PUBLIC_CONVEX_SITE_URL` inside the action. Remove it from `args`.

---

### MEDIUM

#### VULN-07: No Security Headers Configured

| Field          | Value |
| -------------- | ----- |
| **File**       | `next.config.ts` |
| **Severity**   | Medium |
| **Effort**     | 30 min |

```ts
const nextConfig: NextConfig = {
  /* config options here */
};
```

**Description:** The Next.js config defines zero security headers. Missing:

- `Content-Security-Policy` — no XSS mitigation beyond React's auto-escaping
- `Strict-Transport-Security` — no HSTS enforcement
- `X-Frame-Options` — app can be embedded in iframes (clickjacking)
- `X-Content-Type-Options` — browsers may MIME-sniff responses
- `Referrer-Policy` — full URLs (including tokens in query params) may leak via Referer headers

**Remediation:** Add a `headers()` function to `next.config.ts`:

```ts
const nextConfig: NextConfig = {
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
        {
          key: "Content-Security-Policy",
          value: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.convex.cloud https://*.convex.site https://api.workos.com https://api.calendly.com;",
        },
      ],
    },
  ],
};
```

---

#### VULN-08: `customFields` Uses `v.any()` — Unbounded Schema

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/schema.ts:112` |
| **Severity**   | Medium |
| **Effort**     | 30 min |

```ts
customFields: v.optional(v.any()),
```

**Description:** The `leads.customFields` field accepts any value whatsoever. Data enters via Calendly webhook ingestion. An attacker who controls Calendly form fields (or forges a webhook if signing keys are compromised) could inject:

- Extremely large payloads (storage exhaustion / DoS)
- Deeply nested objects (query performance degradation)
- Unexpected types that cause downstream crashes when the data is read/displayed

**Remediation:** Replace with a bounded schema:

```ts
customFields: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean()))),
```

Or at minimum, add size validation during webhook ingestion before persisting.

---

#### VULN-09: Verbose Production Logging Exposes PII

| Field          | Value |
| -------------- | ----- |
| **Files**      | Throughout `convex/` and `app/` |
| **Severity**   | Medium |
| **Effort**     | 2 hrs |

**Examples:**

```ts
// app/callback/route.ts:91-97
console.log("[AuthDebug:Callback] invitation auth response", {
  userId: authResponse.user.id,
  email: authResponse.user.email,
  organizationId: authResponse.organizationId ?? null,
});

// app/callback/route.ts:79
console.log("[AuthDebug:Callback] invitation callback detected", {
  code: `${code.slice(0, 8)}...`,  // partial auth code logged
});
```

**Description:** `console.log` statements across the codebase emit user IDs, email addresses, organization IDs, partial authorization codes, and full error messages from external APIs. In production, these logs are visible in the Convex dashboard and Vercel logs. If a log aggregation service is compromised, this is a rich data source for identity theft or account takeover.

**Remediation:**

1. Implement a structured logger with log levels (`debug`, `info`, `warn`, `error`).
2. Set production log level to `warn` or above.
3. Never log auth codes, tokens, or email addresses — use hashed identifiers instead.
4. Consider the `[AuthDebug:*]` prefix logs as development-only and gate them behind `NODE_ENV !== "production"`.

---

#### VULN-10: No Audit Trail for Destructive Admin Operations

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/admin/tenants.ts:631-759` |
| **Severity**   | Medium |
| **Effort**     | 2 hrs |

**Description:** The `resetTenantForReonboarding` action deletes an entire tenant: all users, all webhook events, all org members, the WorkOS organization, and revokes all Calendly tokens. The only record is transient `console.log` output. There is no persistent audit record in the database.

Similarly, `createTenantInvite` and `regenerateInvite` have no persistent audit trail beyond logs.

**Remediation:** Create an `auditLog` table:

```ts
auditLog: defineTable({
  actorIdentity: v.string(),
  action: v.string(),        // e.g., "tenant.delete", "invite.create"
  targetTenantId: v.optional(v.id("tenants")),
  metadata: v.optional(v.string()), // JSON stringified context
  timestamp: v.number(),
})
```

Write an entry before executing each destructive operation.

---

#### VULN-11: Potential Data Over-Exposure to Closers

| Field          | Value |
| -------------- | ----- |
| **Files**      | `convex/opportunities/queries.ts`, `convex/closer/meetingDetail.ts` |
| **Severity**   | Medium |
| **Effort**     | 1 hr |

**Description:** While closers are correctly restricted to their own assigned opportunities, the enriched data returned includes lead email addresses and full names. Depending on business requirements, closers may not need to see contact emails for leads they haven't been assigned to (e.g., in aggregate dashboards).

The admin queries (`listOpportunitiesForAdmin`) return full opportunity data with closer details — this is expected for admins but should be verified as intentional.

**Remediation:** Review with product team whether closers should see lead email addresses. If not, strip them from query results for the `closer` role.

---

### LOW

#### VULN-12: Payment Link URL Validation Is Permissive

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/eventTypeConfigs/mutations.ts:44-53` |
| **Severity**   | Low |
| **Effort**     | 30 min |

**Description:** URL validation only checks for `http:` or `https:` protocol. Allows any domain, including `https://evil.com/phishing-page`, to be stored as a payment link. Closers and leads clicking these links could be phished.

**Remediation:** Consider domain whitelisting for known payment providers, or at minimum add a warning indicator in the UI for unrecognized domains.

---

#### VULN-13: Webhook `tenantId` Query Parameter Is Enumerable

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/http.ts:9`, `convex/webhooks/calendly.ts:96-113` |
| **Severity**   | Low |
| **Effort**     | N/A (accepted risk) |

**Description:** The webhook endpoint at `POST /webhooks/calendly?tenantId={tenantId}` uses the Convex document ID as the tenant identifier. Convex IDs are somewhat predictable. An attacker can enumerate values and distinguish:

- 404 → unknown tenant
- 401 → known tenant, invalid signature

This confirms which tenant IDs exist, leaking business information.

**Remediation:** This is mitigated by the signature verification (no data is leaked beyond existence). For additional hardening, use an opaque random token instead of the Convex document ID in the webhook URL.

---

#### VULN-14: Excessive Calendly OAuth Scope

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/calendly/oauth.ts:80-88` |
| **Severity**   | Low |
| **Effort**     | 5 min |

```ts
const scopes = [
  "scheduled_events:read",
  "event_types:read",
  "users:read",
  "organizations:read",
  "webhooks:read",
  "webhooks:write",
  "routing_forms:read", // not used in the codebase
];
```

**Description:** The `routing_forms:read` scope is requested but there is no code that reads routing forms from the Calendly API. This violates the principle of least privilege.

**Remediation:** Remove `routing_forms:read` from the scopes array.

---

#### VULN-15: Unsafe Type Cast in Token State

| Field          | Value |
| -------------- | ----- |
| **File**       | `convex/calendly/tokens.ts:66` |
| **Severity**   | Low |
| **Effort**     | 10 min |

```ts
return tenant as TenantTokenState | null;
```

**Description:** Bypasses TypeScript type safety. If the schema evolves and fields are renamed or removed, this cast silently masks the mismatch, potentially causing runtime errors in token refresh logic.

**Remediation:** Use a proper type guard or let TypeScript infer the type from the query result.

---

## VULN-16: Unnecessary `NEXT_PUBLIC_` Prefix Leaks Server-Only Variables to Client Bundle

| Field          | Value |
| -------------- | ----- |
| **Files**      | See per-variable trace below |
| **Severity**   | Medium |
| **Effort**     | 1 hr |

### Overview

Next.js inlines any environment variable prefixed with `NEXT_PUBLIC_` into the browser JavaScript bundle at build time. This means every user who opens DevTools can read these values. **4 out of 5 `NEXT_PUBLIC_` variables in this project are never read by client-side code** — they are only consumed in server-side Route Handlers and Convex actions. The prefix unnecessarily exposes them.

### Per-Variable Trace

#### `NEXT_PUBLIC_CONVEX_URL` — Correctly `NEXT_PUBLIC_`

| File | Line | Runtime Environment |
| ---- | ---- | ------------------- |
| `app/ConvexClientProvider.tsx` | 10 | **Browser** (`"use client"` component) |
| `app/api/calendly/start/route.ts` | 9 | Server (Next.js Route Handler) |
| `app/callback/calendly/route.ts` | 9 | Server (Next.js Route Handler) |
| `convex/calendly/healthCheck.ts` | 21 | Server (Convex action) |

**Verdict: Keep as `NEXT_PUBLIC_`.** `ConvexClientProvider.tsx` is a `"use client"` component that instantiates `ConvexReactClient` in the browser. This variable genuinely must be in the client bundle.

---

#### `NEXT_PUBLIC_CONVEX_SITE_URL` — Should NOT Be `NEXT_PUBLIC_`

| File | Line | Runtime Environment |
| ---- | ---- | ------------------- |
| `app/callback/calendly/route.ts` | 18 | Server (Next.js Route Handler) |
| `convex/calendly/healthCheck.ts` | 20 | Server (Convex action) |

**Verdict: Rename to `CONVEX_SITE_URL`.** Read exclusively in server-side route handlers and Convex actions. Never touches the browser. Currently exposes the internal Convex HTTP actions endpoint (`.convex.site`) to every client bundle for no reason.

**Files to update on rename:**
- `app/callback/calendly/route.ts` (lines 18, 21)
- `convex/calendly/healthCheck.ts` (line 20)
- `.env.local`
- Vercel environment variables
- Convex deployment environment variables

---

#### `NEXT_PUBLIC_WORKOS_REDIRECT_URI` — Should NOT Be `NEXT_PUBLIC_`

| File | Line | Runtime Environment |
| ---- | ---- | ------------------- |
| `app/callback/route.ts` | 53, 231 | Server (Next.js Route Handler) |
| `convex.json` | 12 | Build-time config (not runtime) |

**Verdict: Rename to `WORKOS_REDIRECT_URI`.** Only read server-side in the WorkOS callback Route Handler. The `convex.json` reference is build-time tooling that writes to `.env.local`, not client runtime. Currently exposes the app's callback URL structure to every client bundle for no reason.

**Files to update on rename:**
- `app/callback/route.ts` (lines 53, 231)
- `convex.json` `localEnvVars` block (line 12)
- `.env.local`
- Vercel environment variables

---

#### `NEXT_PUBLIC_APP_URL` — Should NOT Be `NEXT_PUBLIC_`

| File | Line | Runtime Environment |
| ---- | ---- | ------------------- |
| `app/callback/route.ts` | 148 | Server (Next.js Route Handler) |
| `convex/admin/tenants.ts` | 58 | Server (Convex action) |
| `convex/calendly/oauth.ts` | 17 | Server (Convex action) |

**Verdict: Rename to `APP_URL`.** Read exclusively in server-side route handlers and Convex actions. Never touches the browser. The project's own deployment docs already note: *"`NEXT_PUBLIC_APP_URL` is misleadingly named — it's used server-side in Convex functions."* Currently exposes the app's canonical domain to every client bundle for no reason.

**Files to update on rename:**
- `app/callback/route.ts` (line 148)
- `convex/admin/tenants.ts` (line 58)
- `convex/calendly/oauth.ts` (line 17)
- `.env.local`
- Vercel environment variables
- Convex deployment environment variables

---

#### `NEXT_PUBLIC_CALENDLY_CLIENT_ID` — Should NOT Be `NEXT_PUBLIC_`

| File | Line | Runtime Environment |
| ---- | ---- | ------------------- |
| `convex/admin/tenants.ts` | 72 | Server (Convex action) |
| `convex/calendly/oauth.ts` | 12 | Server (Convex action) |
| `convex/calendly/tokens.ts` | 44 | Server (Convex action) |
| `convex/calendly/healthCheck.ts` | 28 | Server (Convex action) |

Zero hits in `app/` client components. Zero hits in `components/`. Zero hits in `hooks/`. Zero hits in `lib/`.

**Verdict: Delete entirely.** Used only as a fallback for `CALENDLY_CLIENT_ID` inside Convex server actions via the pattern `process.env.CALENDLY_CLIENT_ID ?? process.env.NEXT_PUBLIC_CALENDLY_CLIENT_ID`. No browser code ever reads it. Just use `CALENDLY_CLIENT_ID` everywhere and drop this variable. Currently exposes the Calendly OAuth client ID to every client bundle — an attacker can use this to craft phishing OAuth authorization flows.

**Files to update:**
- `convex/admin/tenants.ts` (line 72) — remove fallback, use only `CALENDLY_CLIENT_ID`
- `convex/calendly/oauth.ts` (line 12) — remove fallback, use only `CALENDLY_CLIENT_ID`
- `convex/calendly/tokens.ts` (line 44) — remove fallback, use only `CALENDLY_CLIENT_ID`
- `convex/calendly/healthCheck.ts` (line 28) — remove fallback, use only `CALENDLY_CLIENT_ID`
- `.env.local` — remove `NEXT_PUBLIC_CALENDLY_CLIENT_ID` line
- Vercel environment variables — remove

### What's Visible in the Browser Today

Any user who opens DevTools → Sources (or views the page source) can see these values inlined in the JavaScript bundle:

| Value Exposed | Risk |
| ------------- | ---- |
| Convex `.site` URL | Reveals the internal webhook ingestion endpoint |
| WorkOS redirect URI | Reveals callback URL structure and app domain |
| App canonical URL | Reveals production domain (minor) |
| Calendly OAuth client ID | Enables crafting phishing OAuth authorization flows |

While none are *secrets*, each gives attackers reconnaissance information. The principle of least privilege applies: **don't expose what you don't need to**.

### Summary

| Variable | Needs `NEXT_PUBLIC_`? | Action |
| -------- | --------------------- | ------ |
| `NEXT_PUBLIC_CONVEX_URL` | **Yes** | Keep — genuinely needed in browser for `ConvexReactClient` |
| `NEXT_PUBLIC_CONVEX_SITE_URL` | **No** | Rename to `CONVEX_SITE_URL` |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | **No** | Rename to `WORKOS_REDIRECT_URI` |
| `NEXT_PUBLIC_APP_URL` | **No** | Rename to `APP_URL` |
| `NEXT_PUBLIC_CALENDLY_CLIENT_ID` | **No** | Delete entirely — use `CALENDLY_CLIENT_ID` |

---

## Environment Variable Audit

### Convex Deployment Variables

| Variable                        | In Your List | Used in Code | Status                                                                        |
| ------------------------------- | ------------ | ------------ | ----------------------------------------------------------------------------- |
| `CALENDLY_CLIENT_ID`            | Yes          | Yes          | **Required** — OAuth flows, token refresh, revocation                         |
| `CALENDLY_CLIENT_SECRET`        | Yes          | Yes          | **Required** — token exchange, refresh, revocation                            |
| `CALENDLY_WEBHOOK_SIGNING_KEY`  | Yes          | **No**       | **NOT USED** — app uses per-tenant keys stored in DB, not a global env var    |
| `INVITE_SIGNING_SECRET`         | Yes          | Yes          | **Required** — HMAC signing of invite tokens                                  |
| `WORKOS_API_KEY`                | Yes          | Yes          | **Required** — WorkOS SDK initialization in Convex actions                    |
| `WORKOS_CLIENT_ID`              | Yes          | Yes          | **Required** — JWT validation, OAuth, user management                         |
| `WORKOS_ENVIRONMENT_ID`         | Yes          | **No**       | **Not directly referenced** — auto-set by Convex AuthKit integration          |
| `WORKOS_WEBHOOK_SECRET`         | Yes          | **No**       | **NOT USED** — no WorkOS webhook handler exists in the codebase               |

### .env.local / Vercel Production Variables

| Variable                          | In Your List | Used in Code | Status                                                                     |
| --------------------------------- | ------------ | ------------ | -------------------------------------------------------------------------- |
| `CONVEX_DEPLOYMENT`               | Yes          | Yes          | **Required** — Convex CLI (`npx convex dev`)                               |
| `NEXT_PUBLIC_CONVEX_URL`          | Yes          | Yes          | **Required** — Convex client + HTTP client. Correctly `NEXT_PUBLIC_` (used in browser `ConvexReactClient`) |
| `NEXT_PUBLIC_CONVEX_SITE_URL`     | Yes          | Yes          | **Required** — but should be renamed to `CONVEX_SITE_URL` (see VULN-16: server-only, never read client-side) |
| `WORKOS_CLIENT_ID`                | Yes          | Yes          | **Required** — AuthKit callback handler                                    |
| `WORKOS_API_KEY`                  | Yes          | Yes          | **Required** — AuthKit session management                                  |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | Yes          | Yes          | **Required** — but should be renamed to `WORKOS_REDIRECT_URI` (see VULN-16: server-only, never read client-side) |
| `WORKOS_COOKIE_PASSWORD`          | Yes          | Yes          | **Required** — session cookie encryption (`@workos-inc/authkit-nextjs`)    |
| `NEXT_PUBLIC_CALENDLY_CLIENT_ID`  | Yes          | Yes          | **Should be deleted** — only used as fallback for `CALENDLY_CLIENT_ID` in Convex server actions, never read client-side (see VULN-16) |
| `NEXT_PUBLIC_APP_URL`             | Yes          | Yes          | **Required** — but should be renamed to `APP_URL` (see VULN-16: server-only, never read client-side. Also see VULN-05 on fallback risk) |
| `NODE_ENV`                        | Implicit     | Yes          | Set automatically by Next.js — controls cookie `secure` flag               |

### Key Findings

1. **`CALENDLY_WEBHOOK_SIGNING_KEY`** — Set in Convex env but **nothing reads it**. The codebase generates per-tenant signing keys dynamically during webhook provisioning and stores them in the `tenants` table. This env var can be removed from the Convex deployment.

2. **`WORKOS_WEBHOOK_SECRET`** — Set in Convex env but **no handler exists**. There is no WorkOS webhook endpoint in `convex/http.ts`. Either implement the handler or remove this variable.

3. **`WORKOS_ENVIRONMENT_ID`** — Not directly referenced in application code. It is auto-configured by the Convex AuthKit integration. Harmless to keep, but not strictly necessary unless future features use the WorkOS Events API.

4. **`.env.local` is properly gitignored** — Confirmed via `git ls-files --cached`. The `.gitignore` includes `.env*`. No secret files are tracked in version control.

5. **Duplicate `WORKOS_CLIENT_ID` and `WORKOS_API_KEY`** — These appear in both the Convex env vars and the `.env.local`/Vercel vars. This is correct — Convex server-side actions and the Next.js app each need their own copy.

---

## Positive Security Practices (What's Working Well)

| Area                                | Assessment |
| ----------------------------------- | ---------- |
| Auth on all client-callable functions | Every `query`, `mutation`, and `action` (except `validateInvite` by design) calls `requireTenantUser()` or `requireSystemAdminSession()` |
| Tenant isolation                     | All data queries filter by `tenantId`; org ID cross-checked against JWT claims |
| Closer data isolation                | Every closer function validates `assignedCloserId === userId` |
| Webhook signature verification       | HMAC-SHA256 with timing-safe comparison and 180s timestamp window |
| PKCE for Calendly OAuth              | Proper S256 code challenge, verifier stored server-side, cleared after use |
| Invite token cryptography            | HMAC-SHA256 signing with timing-safe verification, 7-day expiry, hash-based lookup |
| Cookie security                      | `httpOnly`, `sameSite: "lax"`, `secure` in production, short `maxAge` |
| Role-based access control            | Three-tier model (`tenant_master` > `tenant_admin` > `closer`) with escalation prevention |
| Token refresh locking                | Distributed lock prevents concurrent refresh race conditions |
| Input validation                     | Email regex, company name length, URL protocol checks, required string validation |
| PKCE verifier cleanup                | Code verifier cleared from DB after use (both success and error paths) |
| OAuth error rollback                 | Status rolled back to `pending_calendly` on any failure during code exchange |

---

## Remediation Priority Matrix

| Priority | ID       | Action                                                                                  | Effort |
| -------- | -------- | --------------------------------------------------------------------------------------- | ------ |
| P0       | VULN-01  | Move `SYSTEM_ADMIN_ORG_ID` to environment variable                                      | 15 min |
| P0       | VULN-06  | Read `convexSiteUrl` from env instead of accepting as client argument                   | 15 min |
| P0       | VULN-05  | Fail hard on missing `NEXT_PUBLIC_APP_URL` instead of defaulting to localhost            | 10 min |
| P1       | VULN-04  | Rate-limit `validateInvite`; stop leaking `companyName`/`workosOrgId` on errors         | 1 hr   |
| P1       | VULN-07  | Add security headers to `next.config.ts`                                                | 30 min |
| P1       | VULN-03  | Use a distinct callback route for invitation flow instead of heuristic detection         | 2 hrs  |
| P2       | VULN-02  | Encrypt OAuth tokens and signing keys at rest in Convex                                 | 3 hrs  |
| P2       | VULN-08  | Replace `v.any()` with bounded schema for `customFields`                                | 30 min |
| P2       | VULN-10  | Add `auditLog` table for destructive admin operations                                   | 2 hrs  |
| P2       | VULN-09  | Strip PII from production logs; implement structured log levels                         | 2 hrs  |
| P2       | VULN-11  | Review data exposure to closer role with product team                                   | 1 hr   |
| P2       | VULN-16  | Remove unnecessary `NEXT_PUBLIC_` prefixes; rename 3 vars, delete 1                    | 1 hr   |
| P3       | VULN-14  | Remove unused `routing_forms:read` OAuth scope                                          | 5 min  |
| P3       | VULN-12  | Add domain whitelisting or warnings for payment link URLs                               | 30 min |
| P3       | ENV      | Remove unused env vars (`CALENDLY_WEBHOOK_SIGNING_KEY`, `WORKOS_WEBHOOK_SECRET`)        | 5 min  |
| P3       | VULN-15  | Fix unsafe type cast in token state                                                     | 10 min |
| P3       | VULN-13  | Consider opaque webhook tenant identifiers (accepted risk if not implemented)            | N/A    |
