# Phase 11 — Edge Case Hardening

**Goal:** Handle all documented-but-unimplemented edge cases from the completeness audit: different Calendly accounts on reconnection, webhooks for suspended tenants, invite signing secret rotation, and external WorkOS org deletion. This phase turns theoretical failure modes into gracefully-handled states.

**Prerequisite:** Phase 10 complete (cron fan-out in place, pagination implemented). Phase 7 reconnection fix (6.2) merged.

**Acceptance Criteria:**
1. When a tenant reconnects with a **different** Calendly organization, the system detects the change, warns the user, and cleans up stale org members from the old Calendly org.
2. Webhooks received for suspended or deleted tenants are logged but not processed — they do not cause errors or create orphaned data.
3. Invite signing secret rotation supports multiple valid signing keys; outstanding invites remain valid after rotation.
4. If a WorkOS organization is deleted externally (via WorkOS dashboard), the health check detects this and marks the tenant accordingly.
5. Each edge case surfaces an appropriate error or warning in the UI where applicable.

---

## Backend Subphases

### 11B.1 — Detect Different Calendly Organization on Reconnection

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Edge Case 1 from completeness report

**What:** If a tenant disconnects and reconnects with a different Calendly account (different person, different Calendly org), the new `calendlyOrgUri` overwrites the old one. Existing `calendlyOrgMembers` records reference the old org's user URIs and become stale. Detect this case, clean up stale data, and warn the user.

**Where:**
- `convex/calendly/oauth.ts` — inside `exchangeCodeAndProvision`, after obtaining the new org URI
- `convex/calendly/orgMembersMutations.ts` — add `deleteAllMembersForTenant`

**How:**

After the token exchange succeeds and before webhook provisioning, compare the new Calendly org URI with the stored one:

```typescript
// convex/calendly/oauth.ts — inside exchangeCodeAndProvision,
// after fetching /users/me to get calendlyOrgUri

// Fetch the current tenant record to compare org URIs
const currentTenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
  tenantId,
});

const isOrgChange =
  currentTenant?.calendlyOrgUri &&
  currentTenant.calendlyOrgUri !== newCalendlyOrgUri;

if (isOrgChange) {
  console.warn(
    `[oauth] Tenant ${tenantId}: Calendly org changed from ` +
    `${currentTenant.calendlyOrgUri} to ${newCalendlyOrgUri}. ` +
    `Cleaning up stale org members.`,
  );

  // Delete all org members from the old Calendly org
  await ctx.runMutation(
    internal.calendly.orgMembersMutations.deleteAllMembersForTenant,
    { tenantId },
  );

  // Delete old webhook subscription (it belongs to the old org)
  if (currentTenant.calendlyWebhookUri) {
    try {
      await fetch(currentTenant.calendlyWebhookUri, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${newAccessToken}`,
        },
      });
    } catch {
      // Old webhook may already be gone — safe to ignore
      console.warn(
        `[oauth] Could not delete old webhook for tenant ${tenantId}`,
      );
    }
  }
}

// Store the new org URI and tokens
await ctx.runMutation(internal.tenants.storeCalendlyTokens, {
  tenantId,
  calendlyAccessToken: newAccessToken,
  calendlyRefreshToken: newRefreshToken,
  calendlyTokenExpiresAt: Date.now() + expiresIn * 1000,
  calendlyOrgUri: newCalendlyOrgUri,
  calendlyUserUri: newCalendlyUserUri,
  // Clear old webhook fields — will be reprovisioned below
  ...(isOrgChange
    ? {
        calendlyWebhookUri: undefined,
        webhookSigningKey: undefined,
      }
    : {}),
});

// Proceed with webhook provisioning (creates new webhook for new org)
```

Add the bulk delete mutation:

```typescript
// convex/calendly/orgMembersMutations.ts

export const deleteAllMembersForTenant = internalMutation({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    let deleted = 0;
    let hasMore = true;

    while (hasMore) {
      const members = await ctx.db
        .query("calendlyOrgMembers")
        .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
          q.eq("tenantId", tenantId),
        )
        .take(128);

      for (const member of members) {
        await ctx.db.delete(member._id);
        deleted++;
      }

      hasMore = members.length === 128;
    }

    return { deleted };
  },
});
```

To propagate the org-change information to the frontend, add a field to the response or set a flag:

```typescript
// After successful reconnection with org change, store a flag
await ctx.runMutation(internal.tenants.updateStatus, {
  tenantId,
  status: "active",
  // Optional: store metadata about the org change for UI display
});

// Return org change info to the caller
return {
  success: true,
  orgChanged: isOrgChange,
  previousOrgUri: isOrgChange ? currentTenant.calendlyOrgUri : undefined,
};
```

**Verification:**
- Onboard tenant with Calendly org A → active, org members synced.
- Disconnect tenant (set status to `calendly_disconnected`).
- Reconnect with Calendly org B (different account).
- Verify: old org members deleted, new webhook provisioned, new org members synced.
- Verify: no orphaned data from org A in `calendlyOrgMembers` table.

**Files touched:**
- `convex/calendly/oauth.ts` (modify — add org change detection and cleanup)
- `convex/calendly/orgMembersMutations.ts` (modify — add `deleteAllMembersForTenant`)

---

### 11B.2 — Handle Webhooks for Suspended/Deleted Tenants

**Type:** Backend
**Parallelizable:** Yes — independent of 11B.1.
**Finding:** Edge Case 3 from completeness report

**What:** If a tenant is suspended (or deleted but the Calendly webhook is still active), webhook events continue arriving. The HTTP action persists them to `rawWebhookEvents` without checking tenant status. Add a status check to reject events for non-active tenants.

**Where:** `convex/webhooks/calendly.ts` — the HTTP action handler

**How:**

Update the webhook ingestion to check tenant status after verifying the signature:

```typescript
// convex/webhooks/calendly.ts — after signature verification and tenant lookup

// Lookup returns tenant record including status
const tenantRecord = await ctx.runQuery(
  internal.webhooks.calendlyQueries.getTenantBySigningKey,
  { signingKey: webhookSigningKey },
);

if (!tenantRecord) {
  return new Response("Unknown signing key", { status: 401 });
}

// NEW: Check tenant status — only process events for active tenants
const PROCESSABLE_STATUSES = new Set([
  "active",
  "provisioning_webhooks",
]);

if (!PROCESSABLE_STATUSES.has(tenantRecord.status)) {
  console.warn(
    `[webhook] Ignoring event for tenant ${tenantRecord._id} ` +
    `(status: ${tenantRecord.status}): ${eventType}`,
  );
  // Return 200 to acknowledge receipt — we don't want Calendly to retry.
  // The event is intentionally NOT persisted.
  return new Response("Accepted (tenant inactive)", { status: 200 });
}

// Continue with normal event persistence...
```

Update the `getTenantBySigningKey` query to return the tenant status:

```typescript
// convex/webhooks/calendlyQueries.ts

export const getTenantBySigningKey = internalQuery({
  args: { signingKey: v.string() },
  handler: async (ctx, { signingKey }) => {
    const tenant = await ctx.db
      .query("tenants")
      .filter((q) => q.eq(q.field("webhookSigningKey"), signingKey))
      .unique();

    if (!tenant) return null;

    return {
      _id: tenant._id,
      status: tenant.status,
      // Include any other fields needed by the webhook handler
    };
  },
});
```

> **Design decision:** We return HTTP 200 even for inactive tenants. Returning 4xx would cause Calendly to retry, which is wasteful since the tenant is intentionally inactive. We also skip persisting the event — if the tenant is reactivated later, historical events during suspension are lost. This is acceptable; the alternative (persisting + flagging) adds storage overhead for events that will never be processed.

**Verification:**
- Set a tenant to `suspended` status.
- Send a webhook with that tenant's signing key → HTTP 200, event NOT in `rawWebhookEvents`.
- Check logs → warning message about ignored event.
- Set tenant back to `active` → subsequent webhooks are processed normally.

**Files touched:**
- `convex/webhooks/calendly.ts` (modify — add status check)
- `convex/webhooks/calendlyQueries.ts` (modify — return status in response)

---

### 11B.3 — Implement Invite Signing Secret Rotation (Multi-Key Support)

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Edge Case 4 from completeness report

**What:** If `INVITE_SIGNING_SECRET` is rotated, all outstanding invite tokens become invalid. Implement multi-key support: accept a comma-separated list of secrets, validate against all of them, generate new tokens with the newest key.

**Where:**
- `convex/lib/inviteToken.ts` (modify — multi-key validation)

**How:**

```typescript
// convex/lib/inviteToken.ts

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Get the list of valid signing secrets.
 * Supports rotation: INVITE_SIGNING_SECRET can be a comma-separated list.
 * The FIRST secret is the "active" one used for generation.
 * All secrets are valid for verification (supporting outstanding invites
 * signed with the previous key).
 */
function getSigningSecrets(): string[] {
  const raw = process.env.INVITE_SIGNING_SECRET;
  if (!raw) throw new Error("INVITE_SIGNING_SECRET is not set");

  const secrets = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (secrets.length === 0) {
    throw new Error("INVITE_SIGNING_SECRET contains no valid secrets");
  }

  return secrets;
}

/** Get the active (newest) signing secret for token generation. */
function getActiveSecret(): string {
  return getSigningSecrets()[0];
}

/**
 * Generate an invite token. Always uses the active (first) secret.
 */
export function generateInviteToken(tenantId: string): {
  token: string;
  hash: string;
  expiresAt: number;
} {
  const secret = getActiveSecret();
  // ... existing generation logic using `secret` ...
}

/**
 * Validate an invite token against ALL valid secrets.
 * This supports rotation: tokens signed with the previous secret
 * remain valid until they expire naturally.
 */
export function validateInviteToken(
  token: string,
  storedHash: string,
): boolean {
  const secrets = getSigningSecrets();

  for (const secret of secrets) {
    const computedHash = createHmac("sha256", secret)
      .update(token)
      .digest("base64url");

    const hashBuffer = Buffer.from(computedHash, "base64url");
    const storedBuffer = Buffer.from(storedHash, "base64url");

    if (
      hashBuffer.length === storedBuffer.length &&
      timingSafeEqual(hashBuffer, storedBuffer)
    ) {
      return true; // Valid against this secret
    }
  }

  return false; // No secret produced a matching hash
}

/**
 * Hash a token for storage. Always uses the active secret.
 */
export function hashInviteToken(token: string): string {
  const secret = getActiveSecret();
  return createHmac("sha256", secret).update(token).digest("base64url");
}
```

> **Rotation procedure:**
> 1. Generate a new secret.
> 2. Set `INVITE_SIGNING_SECRET=newSecret,oldSecret` (new first, old second).
> 3. Deploy. Outstanding invites (signed with old secret) continue to validate.
> 4. After all outstanding invites expire (7 days by default), remove the old secret.
> 5. Set `INVITE_SIGNING_SECRET=newSecret`.

**Verification:**
- Generate an invite with secret A.
- Rotate to `B,A` in the environment variable.
- Validate the old invite → succeeds (checked against A).
- Generate a new invite → signed with B.
- Remove A from the env var: `INVITE_SIGNING_SECRET=B`.
- Old invite → fails (A no longer in the list). Expected.
- New invite → succeeds (checked against B).

**Files touched:**
- `convex/lib/inviteToken.ts` (modify — multi-key generation and validation)

---

### 11B.4 — Add WorkOS Org Health Verification to Health Check

**Type:** Backend
**Parallelizable:** Yes — independent of other subphases.
**Finding:** Edge Case 5 from completeness report

**What:** If a WorkOS organization is deleted externally (via the WorkOS dashboard), the tenant record still references it. Users can't log in, but the CRM doesn't detect this. Add a WorkOS org existence check to the daily health check.

**Where:**
- `convex/calendly/healthCheck.ts` — extend `checkSingleTenant` (or create a dedicated WorkOS health check)

**How:**

Add a WorkOS org check to the per-tenant health check action:

```typescript
// convex/calendly/healthCheck.ts — inside checkSingleTenant,
// after the Calendly token/webhook checks

// 3. Check WorkOS organization existence
if (tenant.workosOrgId) {
  try {
    const { WorkOS } = await import("@workos-inc/node");
    const workos = new WorkOS(process.env.WORKOS_API_KEY!);

    await workos.organizations.getOrganization(tenant.workosOrgId);
    // If no error, org exists — all good
  } catch (error: unknown) {
    const isNotFound =
      error instanceof Error &&
      (error.message.includes("not_found") ||
        error.message.includes("404"));

    if (isNotFound) {
      console.error(
        `[health-check] WorkOS org ${tenant.workosOrgId} for tenant ` +
        `${tenantId} no longer exists! Marking as suspended.`,
      );
      await ctx.runMutation(internal.tenants.updateStatus, {
        tenantId,
        status: "suspended",
      });
    } else {
      // API error (rate limit, network) — don't change status, just log
      console.warn(
        `[health-check] Could not verify WorkOS org for tenant ${tenantId}:`,
        error,
      );
    }
  }
}
```

> **Note:** This requires the health check to run in a `"use node"` context, which it already does. The `@workos-inc/node` import is dynamic to avoid issues if the package isn't loaded.

> **Rate limiting consideration:** The WorkOS API rate limit for `getOrganization` is generous (~1000 requests/minute). With 500 tenants checked daily, this is ~0.3 requests/minute — well within limits.

**Verification:**
- Delete a WorkOS org via the WorkOS dashboard (in sandbox).
- Run health check → tenant status changes to `suspended`.
- Verify logs contain the specific error message.
- With a valid WorkOS org → no status change.

**Files touched:**
- `convex/calendly/healthCheck.ts` (modify — add WorkOS org check in `checkSingleTenant`)

---

## Frontend Subphases

### 11F.1 — Calendly Account Change Warning UI

**Type:** Frontend
**Parallelizable:** After 11B.1 (backend detection must exist).

**What:** When a tenant reconnects with a different Calendly org, the UI should display a warning explaining what happened and confirming the switch. This prevents confusion when org members change unexpectedly.

**Where:**
- `app/onboarding/connect/page.tsx` (or `app/callback/calendly/route.ts` redirect)
- Potentially a new component: `app/workspace/_components/org-change-notice.tsx`

**How:**

After the reconnection callback completes with an org change, redirect to a confirmation page:

```typescript
// app/callback/calendly/route.ts — after successful exchange

if (result.orgChanged) {
  const successUrl = new URL("/workspace", request.url);
  successUrl.searchParams.set("notice", "calendly_org_changed");
  return NextResponse.redirect(successUrl);
}
```

In the workspace page, display a dismissible notice:

```typescript
// app/workspace/_components/org-change-notice.tsx
"use client";

import { useSearchParams } from "next/navigation";
import { useState } from "react";

export function OrgChangeNotice() {
  const searchParams = useSearchParams();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || searchParams.get("notice") !== "calendly_org_changed") {
    return null;
  }

  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 mb-4">
      <div className="flex items-start gap-3">
        <svg
          className="h-5 w-5 text-amber-600 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={1.5}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
          />
        </svg>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-amber-800">
            Calendly Account Changed
          </h3>
          <p className="text-sm text-amber-700 mt-1">
            You reconnected with a different Calendly organization.
            Previous team member mappings have been cleared and will
            be re-synced from the new organization.
          </p>
        </div>
        <button
          onClick={() => setDismissed(true)}
          className="text-amber-500 hover:text-amber-700"
          aria-label="Dismiss notice"
        >
          &times;
        </button>
      </div>
    </div>
  );
}
```

**Verification:**
- Reconnect tenant with a different Calendly account.
- Verify the workspace page shows the amber notice.
- Click dismiss → notice disappears.
- Refresh page → notice does not reappear (query param cleared).

**Files touched:**
- `app/callback/calendly/route.ts` (modify — add org-change redirect param)
- `app/workspace/_components/org-change-notice.tsx` (create)
- `app/workspace/page.tsx` (modify — render `OrgChangeNotice`)

---

### 11F.2 — Suspended Tenant Status Handling in Workspace UI

**Type:** Frontend
**Parallelizable:** After 11B.4 (backend suspension on WorkOS org deletion must exist).

**What:** When a tenant is suspended (e.g., WorkOS org deleted externally), the workspace UI should show a clear status page instead of a broken experience. The user should see an explanation and contact instructions.

**Where:** `app/workspace/page.tsx` or a layout-level guard

**How:**

Check tenant status at the workspace layout level:

```typescript
// app/workspace/page.tsx — at the top of the component

const tenant = useQuery(api.tenants.getCurrentTenant);

if (tenant?.status === "suspended") {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
          <svg
            className="h-6 w-6 text-red-600"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636"
            />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-gray-900">
          Account Suspended
        </h2>
        <p className="mt-2 text-sm text-gray-600">
          Your organization's account has been suspended. This may be
          due to an administrative action or a configuration issue.
          Please contact your system administrator.
        </p>
      </div>
    </div>
  );
}
```

**Verification:**
- Set a tenant to `suspended` status via Convex dashboard.
- Navigate to the workspace → see the suspension notice.
- Set status back to `active` → workspace renders normally (Convex subscription updates in real-time).

**Files touched:**
- `app/workspace/page.tsx` (modify — add suspended status check)

---

## Parallelization Summary

```
11B.1 (Calendly org change detection) ─────┐
11B.2 (suspended tenant webhook handling) ──┤
11B.3 (invite secret rotation) ─────────────┤── all independent backend
11B.4 (WorkOS org health check) ────────────┘
                                            │
11B.1 ─────────────────────────────────────→ 11F.1 (org change warning UI)
11B.4 ─────────────────────────────────────→ 11F.2 (suspended tenant UI)
```

All four backend subphases can be built simultaneously. Frontend subphases depend on their corresponding backend changes.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/oauth.ts` | Modify (org change detection + cleanup) | 11B.1 |
| `convex/calendly/orgMembersMutations.ts` | Modify (add `deleteAllMembersForTenant`) | 11B.1 |
| `convex/webhooks/calendly.ts` | Modify (tenant status check) | 11B.2 |
| `convex/webhooks/calendlyQueries.ts` | Modify (return status) | 11B.2 |
| `convex/lib/inviteToken.ts` | Modify (multi-key support) | 11B.3 |
| `convex/calendly/healthCheck.ts` | Modify (WorkOS org check) | 11B.4 |
| `app/callback/calendly/route.ts` | Modify (org change redirect) | 11F.1 |
| `app/workspace/_components/org-change-notice.tsx` | Create | 11F.1 |
| `app/workspace/page.tsx` | Modify (render notice + suspended guard) | 11F.1, 11F.2 |
