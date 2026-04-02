# Phase 12 — Admin Dashboard Enhancements

**Goal:** Elevate the admin dashboard from a basic tenant list to a full operational console with force-refresh capabilities, real-time health indicators, last refresh timestamps, and webhook state visibility. This phase gives the system admin the tools to diagnose and resolve issues without needing direct database access.

**Prerequisite:** Phase 11 complete (edge cases handled). Phase 9 `lastTokenRefreshAt` field (9B.4) deployed. Phase 10 pagination (10B.2, 10F.1) deployed.

**Acceptance Criteria:**
1. The admin dashboard shows a "Force Refresh Token" button for each active tenant. Clicking it triggers an immediate token refresh and shows success/failure feedback.
2. Each tenant row displays the `lastTokenRefreshAt` timestamp in a human-readable relative format ("2 minutes ago," "1 hour ago").
3. Webhook health state is displayed as a badge (`active`, `disabled`, `unknown`) with tooltip explanations.
4. An expandable detail panel for each tenant shows full connection health: token expiry, webhook URI, Calendly org URI, user count, and last sync time.
5. All new backend actions are protected by the `requireSystemAdminSession` guard.

---

## Backend Subphases

### 12B.1 — Expose `forceRefreshToken` Action for Admin Use

**Type:** Backend
**Parallelizable:** Yes — independent of 12B.2.
**Finding:** Finding 6.3 from completeness report

**What:** The `refreshTenantToken` internal action exists but is not exposed to the admin UI. Create a public action wrapper that validates system admin auth and delegates to the internal action. Return structured result for UI feedback.

**Where:** `convex/admin/tenants.ts` (add action)

**How:**

```typescript
// convex/admin/tenants.ts — add new action

import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { requireSystemAdminSession } from "../requireSystemAdmin";

/**
 * Admin action: force-refresh a tenant's Calendly access token.
 *
 * This is a manually-triggered version of the cron refresh.
 * Useful for diagnosing token issues or recovering from
 * a failed automatic refresh.
 */
export const forceRefreshToken = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Auth guard: only system admins can trigger this
    await requireSystemAdminSession(ctx);

    // Validate the tenant exists and is in a refreshable state
    const tenant = await ctx.runQuery(internal.tenants.getCalendlyTokens, {
      tenantId,
    });

    if (!tenant) {
      return {
        success: false,
        error: "Tenant not found.",
      };
    }

    if (!tenant.calendlyRefreshToken) {
      return {
        success: false,
        error: "No Calendly refresh token. Tenant may need to reconnect.",
      };
    }

    const refreshableStatuses = new Set([
      "active",
      "calendly_disconnected",
      "provisioning_webhooks",
    ]);

    if (!refreshableStatuses.has(tenant.status)) {
      return {
        success: false,
        error: `Cannot refresh token for tenant in "${tenant.status}" status.`,
      };
    }

    // Delegate to the internal refresh action
    try {
      const result = await ctx.runAction(
        internal.calendly.tokens.refreshTenantToken,
        { tenantId },
      );

      if (result.refreshed) {
        return {
          success: true,
          message: "Token refreshed successfully.",
        };
      } else {
        return {
          success: false,
          error: `Refresh skipped: ${result.reason}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error during token refresh.",
      };
    }
  },
});
```

> **Convex guideline note:** This is a public `action` (not `internalAction`) because it's called from the client. The `requireSystemAdminSession` guard ensures only authenticated system admins can invoke it. The structured return type avoids throwing errors for expected failure cases (tenant not found, wrong status) — only unexpected errors propagate.

**Verification:**
- As system admin, call `forceRefreshToken` for an active tenant → returns `{ success: true }`.
- Call for a `pending_signup` tenant → returns `{ success: false, error: "Cannot refresh..." }`.
- Call without admin auth → throws "Not authorized."
- Call with a non-existent tenant ID → returns `{ success: false, error: "Tenant not found." }`.

**Files touched:** `convex/admin/tenants.ts` (modify — add action)

---

### 12B.2 — Add Enriched Tenant Health Query

**Type:** Backend
**Parallelizable:** Yes — independent of 12B.1.

**What:** Create a query that returns detailed connection health data for a single tenant, including token expiry, last refresh time, webhook state, Calendly org URI, org member count, and last sync time. This powers the expandable detail panel in the admin UI.

**Where:** `convex/admin/tenantsQueries.ts` (add query)

**How:**

```typescript
// convex/admin/tenantsQueries.ts — add new query

/**
 * Get detailed health information for a single tenant.
 * Used by the admin dashboard's expandable detail panel.
 */
export const getTenantHealth = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    await requireSystemAdminSession(ctx);

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;

    // Count org members for this tenant
    const orgMembers = await ctx.db
      .query("calendlyOrgMembers")
      .withIndex("by_tenantId_and_calendlyUserUri", (q) =>
        q.eq("tenantId", tenantId),
      )
      .take(500);

    const matchedMembers = orgMembers.filter((m) => m.matchedUserId);

    // Count webhook events (recent)
    const recentEvents = await ctx.db
      .query("rawWebhookEvents")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(10);

    const lastEventAt =
      recentEvents.length > 0 ? recentEvents[0].receivedAt : null;

    // Determine token health
    const now = Date.now();
    let tokenHealth: "valid" | "expiring_soon" | "expired" | "missing";

    if (!tenant.calendlyAccessToken) {
      tokenHealth = "missing";
    } else if (!tenant.calendlyTokenExpiresAt) {
      tokenHealth = "valid"; // No expiry info, assume valid
    } else if (tenant.calendlyTokenExpiresAt < now) {
      tokenHealth = "expired";
    } else if (tenant.calendlyTokenExpiresAt < now + 30 * 60 * 1000) {
      tokenHealth = "expiring_soon"; // Within 30 minutes
    } else {
      tokenHealth = "valid";
    }

    return {
      tenantId: tenant._id,
      companyName: tenant.companyName,
      status: tenant.status,

      // Calendly connection
      calendlyOrgUri: tenant.calendlyOrgUri ?? null,
      calendlyUserUri: tenant.calendlyUserUri ?? null,
      calendlyWebhookUri: tenant.calendlyWebhookUri ?? null,

      // Token health
      tokenHealth,
      tokenExpiresAt: tenant.calendlyTokenExpiresAt ?? null,
      lastTokenRefreshAt: tenant.lastTokenRefreshAt ?? null,
      hasRefreshToken: !!tenant.calendlyRefreshToken,
      refreshLockUntil: tenant.calendlyRefreshLockUntil ?? null,

      // Org members
      orgMemberCount: orgMembers.length,
      matchedMemberCount: matchedMembers.length,
      lastMemberSyncAt:
        orgMembers.length > 0
          ? Math.max(...orgMembers.map((m) => m.lastSyncedAt))
          : null,

      // Webhook events
      recentEventCount: recentEvents.length,
      lastWebhookEventAt: lastEventAt,

      // WorkOS
      workosOrgId: tenant.workosOrgId,
    };
  },
});
```

**Verification:**
- Call `getTenantHealth` for an active tenant → returns all fields populated.
- Call for a `pending_signup` tenant → returns with null Calendly fields.
- `tokenHealth` accurately reflects: valid (>30min), expiring_soon (<30min), expired, missing.
- `orgMemberCount` matches the actual number of records.

**Files touched:** `convex/admin/tenantsQueries.ts` (modify — add query)

---

## Frontend Subphases

### 12F.1 — Force-Refresh Token Button

**Type:** Frontend
**Parallelizable:** After 12B.1 (backend action must exist).

**What:** Add a "Refresh Token" button to each tenant row in the admin dashboard that triggers the `forceRefreshToken` action and shows real-time feedback (loading spinner → success/error toast).

**Where:** `app/admin/page.tsx` or extract to `app/admin/_components/tenant-actions.tsx`

**How:**

```typescript
// app/admin/_components/force-refresh-button.tsx
"use client";

import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useState } from "react";

interface ForceRefreshButtonProps {
  tenantId: Id<"tenants">;
  tenantStatus: string;
}

export function ForceRefreshButton({
  tenantId,
  tenantStatus,
}: ForceRefreshButtonProps) {
  const forceRefresh = useAction(api.admin.tenants.forceRefreshToken);
  const [state, setState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [message, setMessage] = useState("");

  const isRefreshable = ["active", "calendly_disconnected"].includes(
    tenantStatus,
  );

  if (!isRefreshable) return null;

  async function handleClick() {
    setState("loading");
    try {
      const result = await forceRefresh({ tenantId });
      if (result.success) {
        setState("success");
        setMessage(result.message);
      } else {
        setState("error");
        setMessage(result.error);
      }
    } catch (err) {
      setState("error");
      setMessage("Failed to refresh token.");
    }

    // Reset after 3 seconds
    setTimeout(() => {
      setState("idle");
      setMessage("");
    }, 3000);
  }

  return (
    <div className="relative inline-flex items-center gap-2">
      <button
        onClick={handleClick}
        disabled={state === "loading"}
        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium
          bg-blue-50 text-blue-700 hover:bg-blue-100
          disabled:opacity-50 disabled:cursor-not-allowed
          transition-colors"
        title="Force refresh this tenant's Calendly token"
      >
        {state === "loading" ? (
          <>
            <svg
              className="h-3 w-3 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                cx="12" cy="12" r="10"
                stroke="currentColor" strokeWidth="4"
                className="opacity-25"
              />
              <path
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                className="opacity-75"
              />
            </svg>
            Refreshing...
          </>
        ) : (
          <>
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={2}
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
              />
            </svg>
            Refresh Token
          </>
        )}
      </button>

      {/* Feedback toast */}
      {state === "success" && (
        <span className="text-xs text-green-600 font-medium animate-in fade-in">
          {message}
        </span>
      )}
      {state === "error" && (
        <span className="text-xs text-red-600 font-medium animate-in fade-in">
          {message}
        </span>
      )}
    </div>
  );
}
```

Integrate into the tenant row actions column:

```typescript
// app/admin/page.tsx — in the TenantRow actions cell

<td className="flex items-center gap-2">
  <ForceRefreshButton tenantId={tenant._id} tenantStatus={tenant.status} />
  {/* ... existing regenerate invite, delete buttons ... */}
</td>
```

**Verification:**
- Active tenant → "Refresh Token" button visible.
- Click → spinner shown → "Token refreshed successfully." for ~3 seconds.
- `pending_signup` tenant → button not visible.
- If refresh fails (e.g., token revoked) → error message shown in red.

**Files touched:**
- `app/admin/_components/force-refresh-button.tsx` (create)
- `app/admin/page.tsx` (modify — add button to actions column)

---

### 12F.2 — Last Token Refresh Time Display

**Type:** Frontend
**Parallelizable:** Yes — uses `lastTokenRefreshAt` from Phase 9B.4.

**What:** Add a "Last Refresh" column to the admin tenant table showing when each tenant's Calendly token was last refreshed, in a relative time format ("2m ago," "1h ago," "3d ago").

**Where:** `app/admin/page.tsx`

**How:**

Add a relative-time formatting utility:

```typescript
// lib/format-relative-time.ts

/**
 * Format a timestamp as a human-readable relative time string.
 * Returns "just now", "2m ago", "3h ago", "1d ago", "2w ago", etc.
 */
export function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "—";

  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return `${Math.floor(diff / 604_800_000)}w ago`;
}
```

Add the column to the table:

```typescript
// app/admin/page.tsx — in the table header
<th>Last Refresh</th>

// In the tenant row
<td className="text-sm text-muted-foreground">
  {formatRelativeTime(tenant.lastTokenRefreshAt)}
</td>
```

> **Note:** The `lastTokenRefreshAt` field must be included in the `listTenants` paginated query response. Since it's on the tenant document and the query returns the full document, it should already be available. Verify that the paginated query from Phase 10 returns this field.

**Verification:**
- Tenant with recent refresh → shows "2m ago" (updates reactively via Convex subscription).
- Tenant that never refreshed (new) → shows "—".
- Tenant refreshed 2 days ago → shows "2d ago".

**Files touched:**
- `lib/format-relative-time.ts` (create)
- `app/admin/page.tsx` (modify — add column + import)

---

### 12F.3 — Webhook Health State Badges

**Type:** Frontend
**Parallelizable:** Yes — independent of 12F.1 and 12F.2.

**What:** Add a "Webhook" column to the admin table showing the webhook subscription state as a color-coded badge. Since the webhook state is not directly stored on the tenant (it's on Calendly's side), infer it from available data:
- `active` (green): tenant has a `calendlyWebhookUri` and status is `active`
- `missing` (red): tenant is `active` but has no `calendlyWebhookUri`
- `n/a` (gray): tenant is not yet onboarded (no Calendly connection)

**Where:** `app/admin/page.tsx`

**How:**

```typescript
// app/admin/page.tsx — helper function

function getWebhookBadge(tenant: {
  status: string;
  calendlyWebhookUri?: string | null;
}): { label: string; variant: "default" | "destructive" | "outline" | "secondary" } {
  if (
    tenant.status === "pending_signup" ||
    tenant.status === "pending_calendly" ||
    tenant.status === "invite_expired"
  ) {
    return { label: "N/A", variant: "outline" };
  }

  if (tenant.status === "calendly_disconnected") {
    return { label: "Disconnected", variant: "destructive" };
  }

  if (!tenant.calendlyWebhookUri) {
    return { label: "Missing", variant: "destructive" };
  }

  return { label: "Active", variant: "default" };
}

// In the table header
<th>Webhook</th>

// In the tenant row
{(() => {
  const badge = getWebhookBadge(tenant);
  return (
    <td>
      <Badge variant={badge.variant} title={`Webhook status: ${badge.label}`}>
        {badge.label}
      </Badge>
    </td>
  );
})()}
```

**Verification:**
- Active tenant with webhook → green "Active" badge.
- Active tenant without webhook URI → red "Missing" badge.
- `pending_signup` tenant → gray "N/A" badge.
- `calendly_disconnected` → red "Disconnected" badge.

**Files touched:** `app/admin/page.tsx` (modify — add column)

---

### 12F.4 — Expandable Tenant Detail Panel

**Type:** Frontend
**Parallelizable:** After 12B.2 (health query must exist).

**What:** Each tenant row in the admin table becomes expandable. Clicking it reveals a detail panel showing full connection health data from the `getTenantHealth` query: token expiry, last refresh, webhook URI, Calendly org, org member count (total vs. matched), last sync, and recent webhook event count.

**Where:**
- `app/admin/_components/tenant-detail-panel.tsx` (create)
- `app/admin/page.tsx` (modify — add expand/collapse logic)

**How:**

```typescript
// app/admin/_components/tenant-detail-panel.tsx
"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { formatRelativeTime } from "@/lib/format-relative-time";

interface TenantDetailPanelProps {
  tenantId: Id<"tenants">;
}

export function TenantDetailPanel({ tenantId }: TenantDetailPanelProps) {
  const health = useQuery(api.admin.tenantsQueries.getTenantHealth, {
    tenantId,
  });

  if (!health) {
    return (
      <div className="p-4 text-sm text-muted-foreground animate-pulse">
        Loading health data...
      </div>
    );
  }

  return (
    <div className="grid grid-cols-3 gap-6 p-4 bg-muted/30 border-t">
      {/* Token Health */}
      <div>
        <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
          Token Health
        </h4>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Status</dt>
            <dd>
              <TokenHealthBadge health={health.tokenHealth} />
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Expires</dt>
            <dd>
              {health.tokenExpiresAt
                ? formatRelativeTime(health.tokenExpiresAt)
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Last Refresh</dt>
            <dd>
              {health.lastTokenRefreshAt
                ? formatRelativeTime(health.lastTokenRefreshAt)
                : "Never"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Has Refresh Token</dt>
            <dd>{health.hasRefreshToken ? "Yes" : "No"}</dd>
          </div>
        </dl>
      </div>

      {/* Calendly Integration */}
      <div>
        <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
          Calendly Integration
        </h4>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Org URI</dt>
            <dd className="truncate max-w-[200px]" title={health.calendlyOrgUri ?? ""}>
              {health.calendlyOrgUri
                ? health.calendlyOrgUri.split("/").pop()
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Webhook</dt>
            <dd>{health.calendlyWebhookUri ? "Provisioned" : "None"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Last Webhook Event</dt>
            <dd>
              {health.lastWebhookEventAt
                ? formatRelativeTime(health.lastWebhookEventAt)
                : "None"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Team Members */}
      <div>
        <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
          Org Members
        </h4>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Total</dt>
            <dd>{health.orgMemberCount}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Matched to CRM Users</dt>
            <dd>
              {health.matchedMemberCount} / {health.orgMemberCount}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Last Sync</dt>
            <dd>
              {health.lastMemberSyncAt
                ? formatRelativeTime(health.lastMemberSyncAt)
                : "Never"}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

function TokenHealthBadge({
  health,
}: {
  health: "valid" | "expiring_soon" | "expired" | "missing";
}) {
  const config = {
    valid: { label: "Valid", className: "bg-green-100 text-green-700" },
    expiring_soon: {
      label: "Expiring Soon",
      className: "bg-yellow-100 text-yellow-700",
    },
    expired: { label: "Expired", className: "bg-red-100 text-red-700" },
    missing: { label: "Missing", className: "bg-gray-100 text-gray-500" },
  };

  const { label, className } = config[health];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}
```

Add expand/collapse to the tenant table:

```typescript
// app/admin/page.tsx — in the TenantRow component

const [expanded, setExpanded] = useState(false);

return (
  <>
    <tr
      onClick={() => setExpanded(!expanded)}
      className="cursor-pointer hover:bg-muted/50 transition-colors"
    >
      {/* ... existing cells ... */}
      <td className="w-8">
        <svg
          className={`h-4 w-4 text-muted-foreground transition-transform ${
            expanded ? "rotate-90" : ""
          }`}
          fill="none"
          viewBox="0 0 24 24"
          strokeWidth={2}
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="m8.25 4.5 7.5 7.5-7.5 7.5"
          />
        </svg>
      </td>
    </tr>
    {expanded && (
      <tr>
        <td colSpan={99}>
          <TenantDetailPanel tenantId={tenant._id} />
        </td>
      </tr>
    )}
  </>
);
```

**Verification:**
- Click a tenant row → detail panel expands below with health data.
- Click again → panel collapses.
- Token health badge matches actual state (check against Convex dashboard).
- Org member count matches `calendlyOrgMembers` table.
- Webhook event count reflects recent events.
- Panel loads quickly (< 500ms) — the query is efficient.

**Files touched:**
- `app/admin/_components/tenant-detail-panel.tsx` (create)
- `app/admin/page.tsx` (modify — add expand/collapse + import)

---

## Parallelization Summary

```
12B.1 (forceRefreshToken action) ──────────→ 12F.1 (refresh button)
12B.2 (getTenantHealth query) ─────────────→ 12F.4 (detail panel)

12F.2 (last refresh column) ───────────────┐
12F.3 (webhook badges) ───────────────────┤── independent of each other
12F.1 (refresh button, after 12B.1) ───────┤
12F.4 (detail panel, after 12B.2) ─────────┘
```

Backend subphases (12B.1, 12B.2) can be built in parallel. Frontend subphases 12F.2 and 12F.3 need no backend changes (data already available). 12F.1 needs 12B.1. 12F.4 needs 12B.2.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/admin/tenants.ts` | Modify (add `forceRefreshToken` action) | 12B.1 |
| `convex/admin/tenantsQueries.ts` | Modify (add `getTenantHealth` query) | 12B.2 |
| `app/admin/_components/force-refresh-button.tsx` | Create | 12F.1 |
| `lib/format-relative-time.ts` | Create | 12F.2 |
| `app/admin/_components/tenant-detail-panel.tsx` | Create | 12F.4 |
| `app/admin/page.tsx` | Modify (columns, badges, expand/collapse) | 12F.1–12F.4 |
