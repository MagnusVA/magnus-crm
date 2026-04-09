# Phase 7 — Critical Security & Logic Fixes

**Goal:** Address all HIGH and MEDIUM severity findings from the completeness audit to ensure security, data integrity, and core functionality reliability before expanding to new features.

**Prerequisite:** Phases 1–6 complete and deployed. All findings from `plans/sys-admin/finalization/completeness-report.md` are documented and prioritized.

**Acceptance Criteria:**
1. All HIGH-severity findings (2.1, 6.2) are remediated and tested.
2. All MEDIUM-severity findings (3.1, 4.1, 4.2, 2.3, 3.2, 4.5) have fixes merged or scheduled.
3. No regressions introduced: existing cron jobs, webhooks, and tenant flows continue to pass.
4. Code review checklist includes verification of fixes against original findings.

---

## Backend Fixes

### 7B.1 — Fix `requireSystemAdminSession` privilege escalation (FINDING 2.1)

**Type:** Backend
**Parallelizable:** No — blocks other security fixes.
**Severity:** HIGH

**What:** The `requireSystemAdminSession` guard allows any authenticated user without an org claim to pass as a system admin. Change the guard to require the org claim to be **present AND match** `SYSTEM_ADMIN_ORG_ID`.

**Where:** `convex/requireSystemAdmin.ts`, lines 16–22

**Current code:**
```typescript
const orgId =
  (identity.organization_id as string | undefined) ??
  (identity.organizationId as string | undefined) ??
  (identity.org_id as string | undefined);
if (orgId !== undefined && orgId !== SYSTEM_ADMIN_ORG_ID) {
  throw new Error("Not authorized");
}
```

**Fix:**
```typescript
const orgId =
  (identity.organization_id as string | undefined) ??
  (identity.organizationId as string | undefined) ??
  (identity.org_id as string | undefined);
if (orgId !== SYSTEM_ADMIN_ORG_ID) {
  throw new Error("Not authorized");
}
```

**Verification:**
- Existing admin unit tests still pass (if they exist).
- Call an admin function without a JWT (unauthenticated) → should throw.
- Call an admin function with a JWT that has no org claim → should throw.
- Call an admin function with a JWT with org claim matching `SYSTEM_ADMIN_ORG_ID` → should succeed.

**Files touched:** `convex/requireSystemAdmin.ts`

---

### 7B.2 — Fix reconnection flow missing tenantId cookie (FINDING 6.2)

**Type:** Frontend (callback routing) + Backend
**Parallelizable:** After 7B.1.
**Severity:** HIGH

**What:** The `CalendlyConnectionGuard` component calls `startOAuth` directly as a Convex action, bypassing the `/api/calendly/start` route that sets the `onboarding_tenantId` cookie. When Calendly redirects to the callback, the cookie is missing, causing auth failure.

**Where:**
- `components/calendly-connection-guard.tsx`, lines 121–127 (client action call)
- `app/callback/calendly/route.ts` (expects cookie)

**Current flow (broken):**
1. Guard calls `startOAuth({ tenantId })` Convex action directly
2. Calendly redirects to `/callback/calendly`
3. Callback route tries `request.cookies.get("onboarding_tenantId")` → undefined
4. Callback fails

**Fix:**
Replace the direct action call in the guard with a navigation to the server route:
```typescript
// Before:
const { authorizeUrl } = await startOAuth({
  tenantId: connectionStatus.tenantId,
});
window.location.href = authorizeUrl;

// After:
window.location.href = `/api/calendly/start?tenantId=${connectionStatus.tenantId}`;
```

**Verification:**
- Trigger the reconnection banner from an active logged-in session.
- Verify it redirects to `/api/calendly/start?tenantId=...`.
- Complete the Calendly OAuth flow.
- Verify the callback succeeds and sets tenant status to `provisioning_webhooks`.

**Files touched:**
- `components/calendly-connection-guard.tsx`

---

### 7B.3 — Fix PKCE code verifier leak on OAuth exchange error (FINDING 4.1)

**Type:** Backend
**Parallelizable:** Yes — independent of other fixes.
**Severity:** MEDIUM

**What:** When `exchangeCodeAndProvision` fails, the `codeVerifier` is not cleared from the tenant record. It persists until the next successful exchange, creating a resource leak and a theoretical security window.

**Where:** `convex/calendly/oauth.ts`, lines 257–263 (catch block)

**Current code:**
```typescript
} catch (error) {
  await ctx.runMutation(internal.tenants.updateStatus, {
    tenantId,
    status: "pending_calendly",
  });
  throw error;
}
```

**Fix:**
```typescript
} catch (error) {
  await ctx.runMutation(internal.calendly.oauthMutations.clearCodeVerifier, {
    tenantId,
  });
  await ctx.runMutation(internal.tenants.updateStatus, {
    tenantId,
    status: "pending_calendly",
  });
  throw error;
}
```

**Verification:**
- Simulate an exchange failure (inject an error in the Calendly API call or mock 400 response).
- Verify the tenant's `codeVerifier` field is cleared.
- Verify the tenant status reverts to `pending_calendly`.

**Files touched:** `convex/calendly/oauth.ts`

---

### 7B.4 — Fix cross-tenant user record conflict on re-onboard (FINDING 3.1)

**Type:** Backend
**Parallelizable:** Yes — independent of other fixes.
**Severity:** MEDIUM

**What:** When a user re-onboards in a different tenant (after tenant deletion + re-invite), `redeemInviteAndCreateUser` checks for an existing user by `workosUserId` without scoping to the current tenant. If the user exists in the old deleted tenant (due to incomplete cleanup), the code reuses the old record pointing to the wrong tenant.

**Where:** `convex/onboarding/complete.ts`, lines 43–57

**Current code:**
```typescript
const existingUser = await ctx.db
  .query("users")
  .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
  .unique();
// ...
if (!existingUser) {
  await ctx.db.insert("users", { tenantId: tenant._id, ... });
}
```

**Fix:**
```typescript
const existingUser = await ctx.db
  .query("users")
  .withIndex("by_workosUserId", (q) => q.eq("workosUserId", workosUserId))
  .unique();
// ...
if (!existingUser) {
  await ctx.db.insert("users", { tenantId: tenant._id, ... });
} else if (existingUser.tenantId !== tenant._id) {
  // User exists in a different tenant — update to current tenant
  await ctx.db.patch(existingUser._id, { tenantId: tenant._id });
}
```

**Verification:**
- Create tenant A, add user.
- Delete tenant A (should clean up users).
- Create tenant B, invite the same user.
- Verify the user record points to tenant B (not A).

**Files touched:** `convex/onboarding/complete.ts`

---

### 7B.5 — Fix webhook signing key mismatch on 409 reuse (FINDING 4.2)

**Type:** Backend
**Parallelizable:** Yes — independent of other fixes.
**Severity:** MEDIUM

**What:** When a webhook already exists and is reused (409 conflict), the code returns a locally-generated `signingKey` but the existing Calendly webhook was created with a different key. All subsequent webhook signature validations fail because the keys don't match.

**Where:** `convex/calendly/webhookSetup.ts`, lines 200–209

**Current code:**
```typescript
if (existingWebhook.state === "active" && args.signingKey) {
  return {
    webhookUri: existingWebhook.uri,
    webhookSigningKey: signingKey, // ← mismatch: local var, not stored key
  };
}
```

**Fix:** Always delete and recreate the webhook to guarantee key consistency, OR fetch and return the actual signing key from Calendly. Recommended: delete + recreate.

```typescript
if (existingWebhook.state === "active" && args.signingKey) {
  // Don't reuse; delete and recreate to ensure key consistency
  await deleteExistingWebhook(existingWebhook.uri);
  // Fall through to creation logic
} else if (existingWebhook.state === "active") {
  // No signing key provided; return the webhook but note key mismatch risk
  return {
    webhookUri: existingWebhook.uri,
    webhookSigningKey: null, // Key unknown; webhook validation may fail
  };
}
```

Alternatively, if reuse is critical for performance, fetch the signing key from the existing webhook (if Calendly API exposes it in GET responses).

**Verification:**
- Set up a webhook in phase 4 (stores signing key K1).
- Simulate a reconnection (same webhook already exists in Calendly).
- Verify the returned signing key matches the one stored on the tenant and used for signature validation.
- Verify webhook events are successfully validated after reconnection.

**Files touched:** `convex/calendly/webhookSetup.ts`

---

### 7B.6 — Fix duplicate WorkOS org creation on retry (FINDING 2.3)

**Type:** Backend
**Parallelizable:** Yes — independent of other fixes.
**Severity:** MEDIUM

**What:** If `createTenantInvite` fails midway (e.g., WorkOS org created, Convex insert fails), a retry creates a second orphaned WorkOS organization. No deduplication logic exists.

**Where:** `convex/admin/tenants.ts`, lines 166–178

**Fix:** Add idempotency by querying for an existing tenant matching the company name/email before creating:

```typescript
// Before creating, check if a tenant already exists for this company
const existingTenant = await ctx.db
  .query("tenants")
  .filter((q) => q.eq(q.field("contactEmail"), args.contactEmail.trim().toLowerCase()))
  .unique();

if (existingTenant) {
  return {
    inviteUrl: `${process.env.NEXT_PUBLIC_APP_URL}/onboarding?token=${...}`,
    tenantId: existingTenant._id,
  };
}

// Create WorkOS org and tenant...
```

Alternatively, use a request deduplication key if Calendly and WorkOS APIs support idempotency keys.

**Verification:**
- Call `createTenantInvite` for the same company twice rapidly (or simulate failure + retry).
- Verify only one WorkOS org and one tenant record are created.
- Verify the second call returns the same invite URL.

**Files touched:** `convex/admin/tenants.ts`

---

### 7B.7 — Fix auth callback membership creation error handling (FINDING 3.2)

**Type:** Backend (callback route)
**Parallelizable:** Yes — independent of other fixes.
**Severity:** MEDIUM

**What:** If `createOrganizationMembership` fails in the auth callback, the entire auth fails with no retry option. Wrap in error handling.

**Where:** `app/callback/route.ts`, lines 31–41

**Current code:**
```typescript
const memberships = await workos.userManagement.listOrganizationMemberships({ ... });
const existingMembership = memberships.data[0];
if (!existingMembership) {
  await workos.userManagement.createOrganizationMembership({ ... });
}
```

**Fix:**
```typescript
const memberships = await workos.userManagement.listOrganizationMemberships({ ... });
const existingMembership = memberships.data[0];
if (!existingMembership) {
  try {
    await workos.userManagement.createOrganizationMembership({ ... });
  } catch (error) {
    console.error("[callback] Failed to create org membership:", error);
    // Don't fail the auth callback; the user can retry login
    // Or redirect to an error page: return NextResponse.redirect(...)
  }
}
```

**Verification:**
- Mock the `createOrganizationMembership` API to throw an error.
- Complete the auth callback.
- Verify the auth succeeds (user can log in) even if membership creation fails.

**Files touched:** `app/callback/route.ts`

---

### 7B.8 — Detect free-plan Calendly accounts (FINDING 4.5)

**Type:** Backend + Frontend
**Parallelizable:** Yes — independent of other fixes.
**Severity:** MEDIUM

**What:** Free-plan Calendly accounts cannot have org-scoped webhook subscriptions. When provisioning fails with HTTP 403, the error is generic. Add detection and friendly error message.

**Where:** `convex/calendly/webhookSetup.ts`, lines 151–159 (create webhook call)

**Fix:** Check for 403 specifically:

```typescript
const response = await fetch("https://api.calendly.com/webhook_subscriptions", {
  method: "POST",
  headers: { Authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ url: webhookUrl, events: ["invitee.created", ...] }),
});

if (response.status === 403) {
  throw new Error("calendly_free_plan_unsupported");
}
if (!response.ok) {
  throw new Error(`webhook_creation_failed: ${response.status}`);
}
```

Surface in the frontend:
```typescript
catch (error) {
  if (error.message === "calendly_free_plan_unsupported") {
    setError("This Calendly account is on a free plan. Organization-scoped webhooks require a paid plan.");
  } else {
    setError("Failed to provision webhooks...");
  }
}
```

**Verification:**
- Try to onboard with a free-plan Calendly account (or mock 403 response).
- Verify the user sees the specific error message about upgrading.

**Files touched:**
- `convex/calendly/webhookSetup.ts`
- `app/onboarding/connect/page.tsx` (or relevant callback handler)

---

## Frontend Fixes

### 7F.1 — Fix Calendly reconnection flow (FINDING 6.2 — same as 7B.2)

**Already covered in 7B.2.**

---

### 7F.2 — Improve webhook 409 error messaging in UI

**Type:** Frontend
**Parallelizable:** Yes — after 7B.5 backend fix is merged.
**Severity:** LOW

**What:** When reconnection encounters the webhook key mismatch (or webhook 409 conflict), the UI should explain what happened and offer next steps.

**Where:** `app/onboarding/connect/page.tsx` (or callback handler)

**Fix:** Add error state:

```typescript
if (error.includes("webhook")) {
  return (
    <div className="error-card">
      <h3>Webhook reconnection failed</h3>
      <p>We tried to reconnect your Calendly account but ran into a technical issue.</p>
      <button onClick={() => retryReconnect()}>Retry</button>
      <button onClick={() => contactSupport()}>Contact Support</button>
    </div>
  );
}
```

**Files touched:** `app/onboarding/connect/page.tsx` or relevant error boundary

---

## Testing Strategy

### Unit Tests

- Add test for `requireSystemAdminSession` with and without org claim.
- Add test for `redeemInviteAndCreateUser` with cross-tenant user scenario.
- Add test for webhook signing key consistency after 409 reuse.

### Integration Tests

- Full onboarding flow with reconnection triggered by guard.
- Tenant deletion + re-invite for same user (tests 7B.4).
- OAuth exchange failure + retry (tests 7B.3).

### Manual QA

- Each finding should have a documented test case (listed in **Verification** sections above).

---

## Parallelization Summary

```
7B.1 (requireSystemAdminSession) ─────────────┐
                                              ├─→ 7B.2 (reconnection cookie)
7B.3 (PKCE leak)  ────────────────────────────┤
7B.4 (cross-tenant user)  ────────────────────┤
7B.5 (webhook key mismatch)  ──────────────────┤
7B.6 (duplicate WorkOS org)  ──────────────────┤
7B.7 (membership creation error)  ─────────────┤
7B.8 (free-plan detection)  ───────────────────┘

7F.1 (reconnection flow) ──→ depends on 7B.2
7F.2 (webhook error messaging) ──→ after 7B.5
```

Tasks 7B.3–7B.8 can run in parallel. 7B.1 should complete first (foundational security). 7B.2 depends on 7B.1 being merged. 7F tasks depend on corresponding backend fixes.

---

## Files Modified/Created Summary

| File | Action | Task |
|---|---|---|
| `convex/requireSystemAdmin.ts` | Modified (fix guard logic) | 7B.1 |
| `components/calendly-connection-guard.tsx` | Modified (use server route) | 7B.2, 7F.1 |
| `convex/calendly/oauth.ts` | Modified (clear verifier on error) | 7B.3 |
| `convex/onboarding/complete.ts` | Modified (handle cross-tenant user) | 7B.4 |
| `convex/calendly/webhookSetup.ts` | Modified (delete + recreate webhook, add free-plan detection) | 7B.5, 7B.8 |
| `convex/admin/tenants.ts` | Modified (add idempotency check) | 7B.6 |
| `app/callback/route.ts` | Modified (error handling for membership) | 7B.7 |
| `app/onboarding/connect/page.tsx` | Modified (free-plan error message) | 7B.8, 7F.2 |
