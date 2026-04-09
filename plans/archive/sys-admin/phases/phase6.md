# Phase 6 — End-to-End Testing & Reconnection Flow

**Goal:** Validate the entire onboarding pipeline from end to end using Calendly sandbox, and build the reconnection flow for when a tenant's Calendly connection is lost.

**Prerequisite:** Phases 1-5 complete.

**Acceptance Criteria:**
1. An end-to-end test can be executed manually: system admin creates tenant invite → copy URL → open in incognito → complete signup → connect Calendly sandbox account → tenant becomes `active` → send a test webhook → verify it lands in `rawWebhookEvents`.
2. A tenant whose Calendly connection is lost (status: `calendly_disconnected`) sees a reconnect banner in the UI and can re-authorize, resulting in new tokens and a new webhook subscription.
3. The admin dashboard shows tenant connection health (last token refresh time, webhook state).
4. Sample webhook payloads can be received and verified using `GET /sample_webhook_data` from the Calendly API.

---

## Subphases

### 6A — Calendly Sandbox Test Account (MANUAL — no code)

**Type:** Manual developer task
**Parallelizable:** Yes — can be done while building 6B-6D.

> **You must do this yourself.** This is a prerequisite for testing.

**Steps:**

1. Create a **Calendly sandbox account** (separate from your production account).
   - Go to the Calendly developer portal → Sandbox section.
   - If you already have a sandbox OAuth app from Phase 1B, use it.
2. In the sandbox, create at least one **Event Type** (e.g., "30 Minute Meeting").
3. Note the sandbox user's email — you'll use it to test the OAuth flow.
4. Verify that your sandbox OAuth app's redirect URI points to `http://localhost:3000/callback/calendly`.

**Acceptance:** You have a working sandbox Calendly account with at least one event type.

---

### 6B — Reconnection Flow Backend

**Type:** Backend
**Parallelizable:** Yes — independent of 6A.

**What:** When a tenant's Calendly connection is lost, they need a way to re-authorize. This reuses the Phase 4 OAuth flow but skips invite validation and WorkOS org creation.

**Where:** `convex/calendly/oauth.ts` (extend existing)

**How:**

The existing `startOAuth` and `exchangeCodeAndProvision` actions from Phase 4 are already generic enough — they take a `tenantId` and don't check for `pending_calendly` status specifically. We just need:

1. A query to check if a tenant needs reconnection.
2. UI that triggers the same OAuth flow for `calendly_disconnected` tenants.

Add a public query:

```typescript
// convex/calendly/oauthQueries.ts (new file)
import { query } from "../_generated/server";

/**
 * Check if the current user's tenant needs Calendly reconnection.
 * Returns the tenant's Calendly connection status.
 */
export const getConnectionStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    // Resolve tenant from the user's WorkOS org
    const orgId = (identity as any).organization_id
      ?? (identity as any).organizationId
      ?? (identity as any).org_id;

    if (!orgId) return null;

    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", orgId))
      .unique();

    if (!tenant) return null;

    return {
      tenantId: tenant._id,
      status: tenant.status,
      needsReconnect: tenant.status === "calendly_disconnected",
      lastTokenRefresh: tenant.calendlyTokenExpiresAt
        ? tenant.calendlyTokenExpiresAt - 7200 * 1000 // approximate: expiresAt - 2h
        : null,
    };
  },
});
```

**Files touched:** `convex/calendly/oauthQueries.ts` (create)

---

### 6C — Reconnection UI Banner

**Type:** Frontend (UI/UX)
**Parallelizable:** Yes — can be built alongside 6B.

**What:** A banner component that appears at the top of any page when the user's tenant has `status: "calendly_disconnected"`.

**Where:** New component + integration in layout or a shared wrapper.

**Design guidelines:**
- **Vercel composition patterns:** Create a `<CalendlyConnectionGuard>` wrapper component that sits inside the `ConvexProviderWithAuth`. It subscribes to the connection status query and conditionally renders a banner above `{children}`.
- **Web design guidelines:** The banner should be a `destructive` variant alert (red/warm), dismissible but persistent until the user reconnects. Use shadcn `Alert` with an action button.

**How:**

```tsx
// components/calendly-connection-guard.tsx
"use client";

import { useQuery, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

export function CalendlyConnectionGuard({ children }: { children: React.ReactNode }) {
  const status = useQuery(api.calendly.oauthQueries.getConnectionStatus);
  const startOAuth = useAction(api.calendly.oauth.startOAuth);

  const handleReconnect = async () => {
    if (!status?.tenantId) return;
    const { authorizeUrl } = await startOAuth({ tenantId: status.tenantId });
    window.location.href = authorizeUrl;
  };

  return (
    <>
      {status?.needsReconnect && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertCircle className="size-4" />
          <AlertTitle>Calendly disconnected</AlertTitle>
          <AlertDescription className="flex items-center justify-between">
            <span>
              Your Calendly connection was lost. Reconnect to resume receiving meeting data.
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={handleReconnect}
              className="ml-4 shrink-0"
            >
              Reconnect Calendly
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {children}
    </>
  );
}
```

**Integration:** Wrap the main content area in `app/layout.tsx` or in a shared layout:

```tsx
// Inside the provider chain in layout.tsx or ConvexClientProvider.tsx:
<CalendlyConnectionGuard>
  {children}
</CalendlyConnectionGuard>
```

**Files touched:** `components/calendly-connection-guard.tsx` (create), `app/layout.tsx` or `app/ConvexClientProvider.tsx` (modify)

---

### 6D — Admin Dashboard: Tenant Health Indicators

**Type:** Frontend (UI/UX)
**Parallelizable:** Yes — independent of 6B/6C.

**What:** Enhance the admin dashboard (Phase 3E) to show each tenant's Calendly connection health: last refresh time, webhook state, and a manual "refresh token" button.

**Where:** `app/admin/page.tsx` (modify)

**Design guidelines:**
- Add columns to the tenant table: "Last Refresh" (relative time, e.g., "12 min ago"), "Webhook" (active/disabled badge).
- Add a row action: "Force Refresh Token" (calls `refreshTenantToken` via action).
- Use `Tooltip` to show exact timestamps on hover.

**Files touched:** `app/admin/page.tsx` (modify)

---

### 6E — End-to-End Test Script (MANUAL — guided walkthrough)

**Type:** Manual developer task
**Parallelizable:** Depends on all prior subphases and phases.

> **This is a manual test, not automated.** Follow these steps in order.

**Test procedure:**

1. **Start local dev servers:**
   ```bash
   pnpm dev          # Next.js
   npx convex dev    # Convex (in another terminal)
   ```

2. **Create a tenant invite (as system admin):**
   - Navigate to `http://localhost:3000/admin`
   - Sign in with your system admin account
   - Click "Create New Tenant"
   - Enter: Company Name = "Test Tenant", Email = your test email
   - Copy the invite URL

3. **Onboard as tenant master (incognito browser):**
   - Open incognito window
   - Paste the invite URL
   - Should redirect to WorkOS AuthKit signup
   - Complete signup with the test email
   - Should land on `/onboarding/connect`
   - Click "Connect Calendly"
   - Authorize with your Calendly sandbox account

4. **Verify in Convex dashboard:**
   - Tenant record should show `status: "active"`
   - `calendlyAccessToken`, `calendlyRefreshToken` should be populated
   - `calendlyWebhookUri` should be populated
   - `calendlyOrgMembers` should have at least one entry

5. **Test webhook delivery:**
   - Use the Calendly API to get a sample webhook payload:
     ```bash
     curl -H "Authorization: Bearer {sandbox_access_token}" \
       "https://api.calendly.com/sample_webhook_data?event=invitee.created&organization={org_uri}&scope=organization"
     ```
   - Or create a test booking on the sandbox Calendly account
   - Check `rawWebhookEvents` in the Convex dashboard for the event

6. **Test token refresh:**
   - In the Convex dashboard, run: `npx convex run calendly/tokens:refreshTenantToken --args '{"tenantId":"YOUR_TENANT_ID"}'`
   - Verify the tenant's `calendlyAccessToken` changed

7. **Test reconnection flow:**
   - Manually set the tenant's status to `calendly_disconnected` in the Convex dashboard
   - Refresh the tenant's browser — reconnect banner should appear
   - Click "Reconnect Calendly" and re-authorize
   - Tenant should return to `active`

**Acceptance:** All 7 steps complete successfully.

---

## Parallelization Summary

```
6A (sandbox setup — MANUAL) ─────────────────
6B (reconnect backend) ──────────────────────┐
6C (reconnect UI) ───────────────────────────┤
6D (admin health indicators) ────────────────┤
                                             ├── 6E (end-to-end test)
```

6A through 6D can all happen in parallel. 6E is the final manual validation.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/calendly/oauthQueries.ts` | Created | 6B |
| `components/calendly-connection-guard.tsx` | Created | 6C |
| `app/layout.tsx` or `app/ConvexClientProvider.tsx` | Modified | 6C |
| `app/admin/page.tsx` | Modified | 6D |
