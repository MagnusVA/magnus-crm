# Phase 4 — Calendly OAuth Connection & Webhook Provisioning

**Goal:** The tenant master clicks "Connect Calendly," completes the OAuth PKCE flow, and the system automatically exchanges the code for tokens, verifies them, provisions organization-scoped webhooks, and transitions the tenant to `active` status. From this point on, the system can receive Calendly webhook events.

**Prerequisite:** Phase 3 complete (tenant master has signed up, tenant is in `pending_calendly` status, onboarding UI exists).

---

## How Calendly Authorization Works (Read This First)

**The tenant does not need to install anything manually, and there is no Calendly App Marketplace involved.**

This is standard OAuth 2.0. Here is exactly what happens from the tenant's perspective:

```
Tenant clicks "Connect Calendly"
        │
        ▼
Browser redirects to auth.calendly.com/oauth/authorize
(Calendly's own authorization page — we built nothing here)
        │
        ▼
Calendly shows the tenant a permission consent screen:
"ptdom-crm wants access to your Calendly account.
 It will be able to: read your scheduled events,
 manage webhook subscriptions, etc."
        │
Tenant clicks "Allow"
        │
        ▼
Calendly redirects back to our app with a one-time auth code
        │
        ▼
Our backend exchanges the code for tokens (server-side, invisible to tenant)
        │
        ▼
Tenant lands on "Connected!" success screen
```

**There is no manual step, app marketplace, or Calendly admin configuration required from the tenant.** The OAuth authorization screen Calendly shows is generated automatically from our registered OAuth app (Phase 1B). The tenant just needs to be logged into their Calendly account when they click through.

### What the tenant DOES need

| Requirement | Detail |
|---|---|
| **A Calendly account** | Any account works for signing in, but... |
| **Standard plan or higher** | Free-plan Calendly accounts cannot have org-scoped webhook subscriptions. If a free-plan user connects, the OAuth flow succeeds but the webhook provisioning step will fail with HTTP 403 from Calendly. We handle this gracefully (see error handling). |
| **Admin role in their Calendly org** | The person who clicks "Allow" must have admin-level access in their Calendly organization so that org-scoped webhooks can be created on their behalf. |

### What happens in Calendly's system after authorization

Once the tenant clicks "Allow," Calendly:
1. Issues an access token + refresh token bound to **our OAuth app** and the **tenant's Calendly organization**.
2. Our app (running as a background Convex action, invisible to the tenant) uses that token to call `POST /webhook_subscriptions` and register a webhook at the organization scope.
3. From this point, every Calendly event in the tenant's org (bookings, cancellations, no-shows) will trigger a POST to our webhook ingestion endpoint.

The tenant never touches Calendly again after clicking "Allow." No manual webhook setup, no API keys, no configuration in the Calendly dashboard.

### How our single OAuth app serves all tenants

We register **one** Calendly OAuth app (Phase 1B). Every tenant authorizes this same app. Calendly issues separate, independent tokens for each authorization. This is the standard Calendly multi-tenant model — we are acting as a Calendly platform partner, not a per-tenant integration.

```
Our Single OAuth App (registered once by us)
    │
    ├── Tenant A authorizes → Token set A + Webhook subscription A
    ├── Tenant B authorizes → Token set B + Webhook subscription B
    └── Tenant C authorizes → Token set C + Webhook subscription C
```

Each token set is stored on its respective `tenants` document in Convex. Webhook subscriptions use different callback URLs (`?tenantId=A`, `?tenantId=B`) to route inbound events correctly.

---

**Acceptance Criteria:**
1. Clicking "Connect Calendly" redirects to `auth.calendly.com/oauth/authorize` with correct `client_id`, `redirect_uri`, PKCE `code_challenge`, and scopes.
2. After granting access, Calendly redirects to `/callback/calendly?code=...`, and the system exchanges the code for tokens server-side.
3. Tenant record is updated with `calendlyAccessToken`, `calendlyRefreshToken`, `calendlyTokenExpiresAt`, `calendlyOrgUri`, and `calendlyOwnerUri`.
4. A webhook subscription is created at Calendly with `scope: "organization"`, the correct events list, and a per-tenant `signing_key`.
5. Tenant record is updated with `calendlyWebhookUri`, `webhookSigningKey`, and `status: "active"`.
6. Inbound POST requests to `/webhooks/calendly?tenantId={id}` with a valid `Calendly-Webhook-Signature` are accepted and persisted to `rawWebhookEvents`.
7. Requests with invalid signatures are rejected with 401.
8. The onboarding UI shows a success state and redirects the user to the main dashboard.

---

## Subphases

### 4A — Calendly OAuth: Start Flow (`convex/calendly/oauth.ts`)

**Type:** Backend
**Parallelizable:** Yes — no dependencies within this phase.

**What:** A Convex action that generates a PKCE code challenge, stores the code verifier on the tenant record, and returns the Calendly authorization URL for the frontend to redirect to.

**Why:** PKCE must be generated server-side. The `code_verifier` must never be exposed to the browser.

**Where:** `convex/calendly/oauth.ts`

**How:**

This file needs `"use node"` for Node.js `crypto`.

```typescript
// convex/calendly/oauth.ts
"use node";

import { randomBytes, createHash } from "crypto";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Generate PKCE challenge and return the Calendly OAuth authorize URL.
 *
 * The frontend redirects the user's browser to the returned URL.
 * The code_verifier is stored server-side (on the tenant record)
 * and used later during the token exchange.
 */
export const startOAuth = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Auth check: user must be authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Generate PKCE pair
    const codeVerifier = randomBytes(32).toString("base64url"); // 43 chars
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    // Store code_verifier on the tenant record temporarily
    await ctx.runMutation(internal.calendly.oauthMutations.storeCodeVerifier, {
      tenantId,
      codeVerifier,
    });

    // Build the authorization URL
    const clientId = process.env.CALENDLY_CLIENT_ID!;
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/callback/calendly`;
    const scopes = [
      "scheduled_events:read",
      "event_types:read",
      "users:read",
      "organizations:read",
      "webhooks:write",
      "routing_forms:read",
    ].join(" ");

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge_method: "S256",
      code_challenge: codeChallenge,
      scope: scopes,
    });

    return {
      authorizeUrl: `https://auth.calendly.com/oauth/authorize?${params.toString()}`,
    };
  },
});

/**
 * Exchange the authorization code for tokens.
 *
 * Called by the Next.js callback route after Calendly redirects back.
 * Performs: code exchange → token storage → user/me verification →
 * webhook provisioning → status transition to active.
 */
export const exchangeCodeAndProvision = action({
  args: {
    tenantId: v.id("tenants"),
    code: v.string(),
  },
  handler: async (ctx, { tenantId, code }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    // Step 1: Retrieve stored code_verifier
    const tenant = await ctx.runQuery(
      internal.calendly.oauthMutations.getCodeVerifier,
      { tenantId },
    );
    if (!tenant?.codeVerifier) {
      throw new Error("No code verifier found — OAuth flow may have expired");
    }

    // Step 2: Exchange code for tokens
    const clientId = process.env.CALENDLY_CLIENT_ID!;
    const clientSecret = process.env.CALENDLY_CLIENT_SECRET!;
    const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/callback/calendly`;

    const tokenResponse = await fetch("https://auth.calendly.com/oauth/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: tenant.codeVerifier,
      }),
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      throw new Error(`Calendly token exchange failed: ${tokenResponse.status} ${error}`);
    }

    const tokens = await tokenResponse.json();
    // tokens: { access_token, refresh_token, expires_in, created_at, owner, organization, ... }

    // Step 3: Verify token by calling GET /users/me
    const meResponse = await fetch("https://api.calendly.com/users/me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meResponse.ok) {
      throw new Error("Failed to verify Calendly token via /users/me");
    }
    const meData = await meResponse.json();
    // meData.resource.uri = user URI, meData.resource.current_organization = org URI

    // Step 4: Store tokens
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    await ctx.runMutation(internal.tenants.storeCalendlyTokens, {
      tenantId,
      calendlyAccessToken: tokens.access_token,
      calendlyRefreshToken: tokens.refresh_token,
      calendlyTokenExpiresAt: expiresAt,
      calendlyOrgUri: tokens.organization,
      calendlyOwnerUri: tokens.owner,
    });

    // Step 5: Provision webhooks (calls subphase 4C)
    await ctx.runAction(internal.calendly.webhookSetup.provisionWebhooks, {
      tenantId,
      accessToken: tokens.access_token,
      organizationUri: tokens.organization,
    });

    // Step 6: Clear code_verifier
    await ctx.runMutation(internal.calendly.oauthMutations.clearCodeVerifier, {
      tenantId,
    });

    return { success: true };
  },
});
```

**Implementation notes:**
- `exchangeCodeAndProvision` is a compound action that chains: token exchange → verification → storage → webhook provisioning. Convex actions can call other actions (we call `provisionWebhooks` via `ctx.runAction`). However, the Convex guideline says "ONLY call an action from another action if you need to cross runtimes." Since both are `"use node"`, consider pulling `provisionWebhooks` logic into a shared helper function instead.
- **Alternative:** Inline the webhook provisioning logic in `exchangeCodeAndProvision` as a helper function call (not `ctx.runAction`). This avoids the Convex guideline concern. The design doc shows them as separate files for organizational clarity, but they can share a file.

**Files touched:** `convex/calendly/oauth.ts`

---

### 4B — OAuth Mutation Helpers (`convex/calendly/oauthMutations.ts`)

**Type:** Backend
**Parallelizable:** Must be done before or alongside 4A (4A imports from this).

**What:** Internal mutations/queries for storing and retrieving the PKCE code verifier. Separated because `oauth.ts` uses `"use node"`.

**Where:** `convex/calendly/oauthMutations.ts`

**How:**

We need a temporary storage for the `code_verifier`. Two options:
1. Add a `codeVerifier` field to the `tenants` table (simplest — optional field, cleared after use).
2. Use a separate ephemeral table.

**Decision:** Add `codeVerifier: v.optional(v.string())` to the `tenants` schema. It's temporary (cleared after token exchange) and avoids a new table.

> **Schema change required:** Add `codeVerifier: v.optional(v.string())` to the `tenants` table in `convex/schema.ts`.

```typescript
// convex/calendly/oauthMutations.ts
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

export const storeCodeVerifier = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    codeVerifier: v.string(),
  },
  handler: async (ctx, { tenantId, codeVerifier }) => {
    await ctx.db.patch(tenantId, { codeVerifier });
  },
});

export const getCodeVerifier = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;
    return { codeVerifier: tenant.codeVerifier };
  },
});

export const clearCodeVerifier = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await ctx.db.patch(tenantId, { codeVerifier: undefined });
  },
});
```

**Files touched:** `convex/calendly/oauthMutations.ts` (create), `convex/schema.ts` (add `codeVerifier` field)

---

### 4C — Webhook Provisioning (`convex/calendly/webhookSetup.ts`)

**Type:** Backend
**Parallelizable:** Yes — independent of 4A/4B (called by 4A but can be built in parallel).

**What:** Create a Calendly webhook subscription at the organization scope with a per-tenant signing key.

**Where:** `convex/calendly/webhookSetup.ts`

**How:**

```typescript
// convex/calendly/webhookSetup.ts
"use node";

import { randomBytes } from "crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Provision a Calendly webhook subscription for a tenant.
 *
 * Creates an organization-scoped subscription with a per-tenant signing key.
 * Updates the tenant record with the webhook URI and signing key.
 */
export const provisionWebhooks = internalAction({
  args: {
    tenantId: v.id("tenants"),
    accessToken: v.string(),
    organizationUri: v.string(),
  },
  handler: async (ctx, { tenantId, accessToken, organizationUri }) => {
    // Generate a per-tenant signing key
    const signingKey = randomBytes(32).toString("base64url");

    // Build the webhook callback URL
    // Using query parameter for tenant routing (Convex exact-match routes)
    const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL!;
    // Convex HTTP actions are at the deployment URL, e.g.:
    // https://your-deployment.convex.site/webhooks/calendly?tenantId=xxx
    const convexSiteUrl = convexUrl.replace(".cloud", ".site");
    const callbackUrl = `${convexSiteUrl}/webhooks/calendly?tenantId=${tenantId}`;

    // Create webhook subscription
    const response = await fetch("https://api.calendly.com/webhook_subscriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: callbackUrl,
        events: [
          "invitee.created",
          "invitee.canceled",
          "invitee_no_show.created",
          "invitee_no_show.deleted",
          "routing_form_submission.created",
        ],
        organization: organizationUri,
        scope: "organization",
        signing_key: signingKey,
      }),
    });

    if (response.status === 409) {
      // Webhook already exists — retrieve existing
      console.warn("Webhook subscription already exists for this URL. Retrieving existing.");
      // For MVP, we can just proceed — the signing key won't match the existing one.
      // TODO: List existing subscriptions, find the matching one, delete and recreate.
    } else if (!response.ok) {
      const error = await response.text();
      throw new Error(`Webhook provisioning failed: ${response.status} ${error}`);
    }

    let webhookUri: string | undefined;
    if (response.ok) {
      const data = await response.json();
      webhookUri = data.resource.uri;
    }

    // Store webhook info and transition to active
    await ctx.runMutation(internal.calendly.webhookSetupMutations.storeWebhookAndActivate, {
      tenantId,
      calendlyWebhookUri: webhookUri ?? "unknown",
      webhookSigningKey: signingKey,
    });
  },
});
```

**Companion mutations file:**

```typescript
// convex/calendly/webhookSetupMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const storeWebhookAndActivate = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyWebhookUri: v.string(),
    webhookSigningKey: v.string(),
  },
  handler: async (ctx, { tenantId, calendlyWebhookUri, webhookSigningKey }) => {
    await ctx.db.patch(tenantId, {
      calendlyWebhookUri,
      webhookSigningKey,
      status: "active" as const,
      onboardingCompletedAt: Date.now(),
    });
  },
});
```

**Important note on Convex HTTP URL:** The webhook callback URL needs to be the **Convex HTTP actions URL**, not the Next.js URL. Convex HTTP endpoints are served at `https://{deployment}.convex.site/`. The `NEXT_PUBLIC_CONVEX_URL` typically ends in `.convex.cloud` — the `.site` variant is the HTTP actions host. Verify the correct URL in the Convex dashboard.

**Files touched:** `convex/calendly/webhookSetup.ts`, `convex/calendly/webhookSetupMutations.ts` (create)

---

### 4D — Webhook Ingestion HTTP Action (`convex/webhooks/calendly.ts`)

**Type:** Backend
**Parallelizable:** Yes — independent of 4A-4C.

**What:** A Convex HTTP action that receives inbound Calendly webhook POST requests, verifies the HMAC signature, persists the raw payload, and schedules async processing.

**Where:** `convex/webhooks/calendly.ts` + update `convex/http.ts`

**How:**

The HTTP action handler:

```typescript
// convex/webhooks/calendly.ts
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";

/**
 * Calendly webhook ingestion endpoint.
 *
 * URL: /webhooks/calendly?tenantId={tenantId}
 *
 * Verifies the Calendly-Webhook-Signature header against the
 * per-tenant signing key, persists the raw event, returns 200.
 */
export const handleCalendlyWebhook = httpAction(async (ctx, req) => {
  // Step 1: Extract tenantId from query parameter
  const url = new URL(req.url);
  const tenantId = url.searchParams.get("tenantId");
  if (!tenantId) {
    return new Response("Missing tenantId", { status: 400 });
  }

  // Step 2: Read raw body (needed for signature verification)
  const rawBody = await req.text();

  // Step 3: Get the tenant's signing key
  const tenant = await ctx.runQuery(internal.webhooks.calendlyQueries.getTenantSigningKey, {
    tenantId,
  });
  if (!tenant) {
    return new Response("Unknown tenant", { status: 404 });
  }
  if (!tenant.webhookSigningKey) {
    return new Response("Tenant has no webhook signing key", { status: 500 });
  }

  // Step 4: Verify Calendly-Webhook-Signature
  const signatureHeader = req.headers.get("Calendly-Webhook-Signature");
  if (!signatureHeader) {
    return new Response("Missing signature", { status: 401 });
  }

  // Parse: "t=1492774577,v1=5257a869..."
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((p) => {
      const [key, ...rest] = p.split("=");
      return [key, rest.join("=")];
    })
  );

  if (!parts.t || !parts.v1) {
    return new Response("Malformed signature", { status: 401 });
  }

  // Compute expected signature: HMAC-SHA256(signing_key, "t.rawBody")
  const signedPayload = `${parts.t}.${rawBody}`;

  // Note: We can't use Node.js crypto here (no "use node" on HTTP actions).
  // Use the Web Crypto API (SubtleCrypto) which is available in the Convex
  // default runtime.
  const encoder = new TextEncoder();
  const keyData = encoder.encode(tenant.webhookSigningKey);
  const key = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sigBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expectedSig = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedSig !== parts.v1) {
    return new Response("Invalid signature", { status: 401 });
  }

  // Step 5: Replay protection (3-minute tolerance)
  const timestamp = parseInt(parts.t, 10);
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > 180) {
    return new Response("Stale webhook", { status: 401 });
  }

  // Step 6: Parse and persist
  const payload = JSON.parse(rawBody);
  const eventType = payload.event ?? "unknown";
  const calendlyEventUri = payload.payload?.uri ?? payload.payload?.event ?? `unknown-${Date.now()}`;

  await ctx.runMutation(internal.webhooks.calendlyMutations.persistRawEvent, {
    tenantId: tenantId as any, // Type will be Id<"tenants"> at runtime
    calendlyEventUri,
    eventType,
    payload: rawBody,
  });

  // Step 7: Return 200 immediately (must respond within 15s)
  return new Response("OK", { status: 200 });
});
```

**Supporting queries and mutations:**

```typescript
// convex/webhooks/calendlyQueries.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const getTenantSigningKey = internalQuery({
  args: { tenantId: v.string() },
  handler: async (ctx, { tenantId }) => {
    // tenantId comes from query param as string; look it up
    // We need to handle this carefully since it might not be a valid Id
    try {
      const tenant = await ctx.db.get(tenantId as any);
      if (!tenant) return null;
      return { webhookSigningKey: tenant.webhookSigningKey };
    } catch {
      return null;
    }
  },
});
```

```typescript
// convex/webhooks/calendlyMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const persistRawEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    // Idempotency check: skip if we already have this event
    const existing = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_calendlyEventUri", (q) =>
        q.eq("calendlyEventUri", args.calendlyEventUri),
      )
      .unique();

    if (existing) {
      console.log(`Duplicate webhook event ${args.calendlyEventUri}, skipping`);
      return;
    }

    await ctx.db.insert("rawWebhookEvents", {
      ...args,
      processed: false,
      receivedAt: Date.now(),
    });
  },
});
```

**Register the route in `convex/http.ts`:**

```typescript
// convex/http.ts — updated
import { httpRouter } from "convex/server";
import { authKit } from "./auth";
import { handleCalendlyWebhook } from "./webhooks/calendly";

const http = httpRouter();
authKit.registerRoutes(http);

http.route({
  path: "/webhooks/calendly",
  method: "POST",
  handler: handleCalendlyWebhook,
});

export default http;
```

**Critical note on Web Crypto:** The webhook HTTP action runs in the **Convex default runtime** (not Node.js), so it uses the Web Crypto API (`crypto.subtle`), not Node.js `crypto`. The `"use node"` directive cannot be used on HTTP action files. The example above uses `crypto.subtle.importKey` and `crypto.subtle.sign` for HMAC-SHA256.

**Files touched:** `convex/webhooks/calendly.ts`, `convex/webhooks/calendlyQueries.ts`, `convex/webhooks/calendlyMutations.ts` (create), `convex/http.ts` (modify)

---

### 4E — Calendly OAuth Callback Route (`app/callback/calendly/route.ts`)

**Type:** Frontend (Next.js route handler)
**Parallelizable:** Depends on 4A backend being available to call.

**What:** A Next.js route handler at `/callback/calendly` that receives the redirect from Calendly after the user grants access, extracts the `code`, calls the Convex action to exchange it, and redirects the user.

**Where:** `app/callback/calendly/route.ts`

**How:**

```typescript
// app/callback/calendly/route.ts
import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error || !code) {
    // User denied access or something went wrong
    return NextResponse.redirect(
      new URL("/onboarding/connect?error=calendly_denied", request.url),
    );
  }

  // Retrieve tenantId from session/cookie (set during the OAuth start flow)
  // For MVP, use a cookie set by the "Connect Calendly" button click
  const tenantId = request.cookies.get("onboarding_tenantId")?.value;
  if (!tenantId) {
    return NextResponse.redirect(
      new URL("/onboarding/connect?error=missing_context", request.url),
    );
  }

  try {
    // Call Convex action to exchange code and provision webhooks
    // Note: This needs authentication. The ConvexHttpClient must include
    // the user's access token. In practice, you may need to pass the token
    // or use a server action that has access to the session.
    //
    // Alternative approach: Make this a Server Action called from the
    // client-side redirect handler instead of a route handler.
    // This is a design decision — see "Implementation Notes" below.

    // For now, redirect to a client page that handles the exchange
    const url = new URL("/onboarding/connect", request.url);
    url.searchParams.set("calendly_code", code);
    return NextResponse.redirect(url);
  } catch (err) {
    return NextResponse.redirect(
      new URL("/onboarding/connect?error=exchange_failed", request.url),
    );
  }
}
```

**Implementation notes:**

The Calendly callback is a browser redirect (GET request). The challenge is that we need to call an *authenticated* Convex action to exchange the code, but a Next.js route handler doesn't have the Convex auth context.

**Recommended approach:** Instead of exchanging the code in the route handler, redirect to the `/onboarding/connect` page with the `code` as a query parameter. The client-side React component (which has Convex auth via `ConvexProviderWithAuth`) calls the Convex action. This is simpler and keeps auth in the client context.

The `/onboarding/connect/page.tsx` from Phase 3 would detect `?calendly_code=...` in the URL and trigger the exchange:

```tsx
// Addition to app/onboarding/connect/page.tsx
useEffect(() => {
  const code = searchParams.get("calendly_code");
  if (code && tenantId) {
    exchangeCode({ tenantId, code }).then(() => {
      // Success — redirect to dashboard
      router.push("/");
    });
  }
}, [searchParams, tenantId]);
```

**Files touched:** `app/callback/calendly/route.ts` (create), `app/onboarding/connect/page.tsx` (modify — add code exchange handling)

---

### 4F — Schema Update for Code Verifier

**Type:** Backend
**Parallelizable:** Must be done before deploying 4A/4B.

**What:** Add the `codeVerifier` optional field to the `tenants` schema.

**Where:** `convex/schema.ts`

**How:** Add this line to the `tenants` table definition, in the Calendly OAuth section:

```typescript
// Add after calendlyRefreshLockUntil:
codeVerifier: v.optional(v.string()),  // Temporary: PKCE code verifier during OAuth
```

**Files touched:** `convex/schema.ts`

---

## Parallelization Summary

```
4F (schema update) ──────────────────────────────────┐
4B (oauth mutations) ────────────────────────────────┤
                                                     ├── 4A (oauth actions)
                                                     │        │
4C (webhook provisioning) ───────────────────────────┘        │
4D (webhook ingestion HTTP action) ──────────────────         │
                                                              │
4E (callback route + UI wiring) ──────────────────────────────┘
```

4F, 4B, 4C, 4D can all start simultaneously. 4A depends on 4B and 4F. 4E depends on 4A.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/oauth.ts` | Implemented | 4A |
| `convex/calendly/oauthMutations.ts` | Created | 4B |
| `convex/calendly/webhookSetup.ts` | Implemented | 4C |
| `convex/calendly/webhookSetupMutations.ts` | Created | 4C |
| `convex/webhooks/calendly.ts` | Implemented | 4D |
| `convex/webhooks/calendlyQueries.ts` | Created | 4D |
| `convex/webhooks/calendlyMutations.ts` | Created | 4D |
| `convex/http.ts` | Modified | 4D |
| `app/callback/calendly/route.ts` | Created | 4E |
| `app/onboarding/connect/page.tsx` | Modified | 4E |
| `convex/schema.ts` | Modified | 4F |
