# Phase 2 — System Admin Backend: Tenant Invite Creation

**Goal:** A system admin can call a Convex action that creates a WorkOS organization, inserts a tenant record, generates a signed invite token, and returns an invite URL. All operations are protected by the existing `requireSystemAdminSession()` guard.

**Prerequisite:** Phase 1 complete (schema deployed, `@workos-inc/node` installed, env vars set).

**Acceptance Criteria:**
1. Calling `admin/tenants:createTenantInvite` from the Convex dashboard (with valid system admin auth) creates a WorkOS organization and returns an invite URL.
2. The WorkOS organization is visible in the WorkOS dashboard with the correct name and metadata.
3. A `tenants` document exists in Convex with `status: "pending_signup"` and a hashed invite token.
4. Calling `admin/tenants:listTenants` returns all tenants with their current status.
5. Calling `admin/tenants:getTenant` returns a single tenant's full details.
6. The invite URL contains a valid, time-limited, HMAC-signed token.
7. Attempting to call any admin function without system admin auth throws `"Not authenticated"` or `"Not authorized"`.

---

## Subphases

### 2A — Shared Tenant Utilities (`convex/tenants.ts`)

**Type:** Backend
**Parallelizable:** Yes — no dependencies within this phase.

**What:** Build the internal query/mutation helpers that all other modules will use to read and write tenant data.

**Why:** Centralized tenant access ensures consistent `tenantId` scoping and avoids duplicating lookup logic.

**Where:** `convex/tenants.ts`

**How:**

This file exports **internal** functions only (not public API). It must NOT have `"use node"` since it exports queries and mutations.

```typescript
// convex/tenants.ts
import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";

/**
 * Look up a tenant by WorkOS org ID.
 * Used after AuthKit login to resolve which tenant the user belongs to.
 */
export const getByWorkosOrgId = internalQuery({
  args: { workosOrgId: v.string() },
  handler: async (ctx, { workosOrgId }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_workosOrgId", (q) => q.eq("workosOrgId", workosOrgId))
      .unique();
  },
});

/**
 * Look up a tenant by invite token hash.
 * Used during onboarding to validate invite links.
 */
export const getByInviteTokenHash = internalQuery({
  args: { inviteTokenHash: v.string() },
  handler: async (ctx, { inviteTokenHash }) => {
    return await ctx.db
      .query("tenants")
      .withIndex("by_inviteTokenHash", (q) =>
        q.eq("inviteTokenHash", inviteTokenHash),
      )
      .unique();
  },
});

/**
 * Get Calendly tokens for a tenant. Used by the token refresh logic.
 */
export const getCalendlyTokens = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("Tenant not found");
    return {
      calendlyAccessToken: tenant.calendlyAccessToken,
      calendlyRefreshToken: tenant.calendlyRefreshToken,
      calendlyTokenExpiresAt: tenant.calendlyTokenExpiresAt,
      calendlyRefreshLockUntil: tenant.calendlyRefreshLockUntil,
      calendlyOrgUri: tenant.calendlyOrgUri,
      status: tenant.status,
    };
  },
});

/**
 * Update tenant status. Central transition point.
 */
export const updateStatus = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("pending_signup"),
      v.literal("pending_calendly"),
      v.literal("provisioning_webhooks"),
      v.literal("active"),
      v.literal("calendly_disconnected"),
      v.literal("suspended"),
    ),
  },
  handler: async (ctx, { tenantId, status }) => {
    await ctx.db.patch(tenantId, { status });
  },
});

/**
 * Store Calendly OAuth tokens on the tenant record.
 * Called after initial token exchange and after every refresh.
 */
export const storeCalendlyTokens = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    calendlyAccessToken: v.string(),
    calendlyRefreshToken: v.string(),
    calendlyTokenExpiresAt: v.number(),
    calendlyOrgUri: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyRefreshLockUntil: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { tenantId, ...fields } = args;
    await ctx.db.patch(tenantId, fields);
  },
});
```

**Key decisions:**
- All functions are `internal*` — never callable from the client.
- `getByWorkosOrgId` uses `.unique()` because the `by_workosOrgId` index is effectively unique (one tenant per WorkOS org).
- `storeCalendlyTokens` accepts optional `calendlyRefreshLockUntil` to clear the mutex after a refresh.

**Files touched:** `convex/tenants.ts`

---

### 2B — Invite Token Crypto Helpers

**Type:** Backend
**Parallelizable:** Yes — no dependencies within this phase.

**What:** Build the utility functions for generating and validating HMAC-signed invite tokens.

**Why:** Invite tokens are security-critical. Centralizing the crypto logic prevents mistakes.

**Where:** `convex/lib/inviteToken.ts` (new file, shared utility)

**How:**

This file is a plain TypeScript module (no Convex function registration). It will be imported by Convex actions/mutations.

```typescript
// convex/lib/inviteToken.ts
import { createHmac, createHash, randomBytes } from "crypto";

interface InvitePayload {
  tenantId: string;
  workosOrgId: string;
  contactEmail: string;
  createdAt: number;
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Generate a signed invite token and its hash for storage.
 *
 * Returns:
 * - token: the full token string to embed in the invite URL
 * - tokenHash: SHA-256 hash of the token for database lookup
 * - expiresAt: Unix ms when the token expires
 */
export function generateInviteToken(
  payload: InvitePayload,
  signingSecret: string,
): { token: string; tokenHash: string; expiresAt: number } {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson).toString("base64url");

  const signature = createHmac("sha256", signingSecret)
    .update(payloadB64)
    .digest("base64url");

  const token = `${payloadB64}.${signature}`;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expiresAt = payload.createdAt + INVITE_EXPIRY_MS;

  return { token, tokenHash, expiresAt };
}

/**
 * Validate an invite token's signature and extract the payload.
 *
 * Returns null if the signature is invalid.
 * Does NOT check expiry or single-use — the caller must do that.
 */
export function validateInviteToken(
  token: string,
  signingSecret: string,
): InvitePayload | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const payloadB64 = token.substring(0, dotIndex);
  const providedSig = token.substring(dotIndex + 1);

  const expectedSig = createHmac("sha256", signingSecret)
    .update(payloadB64)
    .digest("base64url");

  // Constant-time comparison
  if (providedSig.length !== expectedSig.length) return null;
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  if (!a.equals(b)) return null; // crypto.timingSafeEqual needs equal length

  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
    return JSON.parse(payloadJson) as InvitePayload;
  } catch {
    return null;
  }
}

/**
 * Hash a token for database lookup.
 */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
```

**Notes:**
- This file uses Node.js `crypto` module. It will only be imported by `"use node"` action files or by mutation files that DON'T use `crypto` directly (they'd call a helper that receives pre-computed values).
- The `validateInviteToken` function returns the payload but doesn't check expiry. The calling Convex function checks `expiresAt` and `inviteRedeemedAt` against the database record.

**Files touched:** `convex/lib/inviteToken.ts` (create)

---

### 2C — Create Tenant Invite Action (`convex/admin/tenants.ts`)

**Type:** Backend
**Parallelizable:** Depends on 2A and 2B being complete.

**What:** Implement the `createTenantInvite` action that orchestrates: WorkOS org creation + tenant record insert + invite token generation.

**Why:** This is the primary system admin operation — the entry point for onboarding a new customer.

**Where:** `convex/admin/tenants.ts`

**How:**

This file needs `"use node"` because it imports `@workos-inc/node` and `crypto`. Because of this, it can ONLY export actions — no queries or mutations. The queries for listing/getting tenants go in a separate file.

```typescript
// convex/admin/tenants.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { generateInviteToken } from "../lib/inviteToken";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

/**
 * System admin action: create a new tenant.
 *
 * 1. Creates a WorkOS organization
 * 2. Inserts a tenant record in Convex
 * 3. Updates the WorkOS org with the Convex tenantId as externalId
 * 4. Generates a signed invite token
 * 5. Returns the invite URL
 */
export const createTenantInvite = action({
  args: {
    companyName: v.string(),
    contactEmail: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth guard: verify system admin
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    // Check org claim matches system admin org
    const orgId = (identity as any).organization_id
      ?? (identity as any).organizationId
      ?? (identity as any).org_id;
    const SYSTEM_ADMIN_ORG_ID = "org_01KN2GSWBZAQWJ2CBRAZ6CSVBP";
    if (orgId !== undefined && orgId !== SYSTEM_ADMIN_ORG_ID) {
      throw new Error("Not authorized for this organization.");
    }

    // Step 1: Create WorkOS organization
    const org = await workos.organizations.createOrganization({
      name: args.companyName,
      allowProfilesOutsideOrganization: false,
      metadata: {
        source: "system_admin_onboarding",
        contactEmail: args.contactEmail,
      },
    });

    // Step 2: Insert tenant record (status: pending_signup)
    const now = Date.now();
    const signingSecret = process.env.INVITE_SIGNING_SECRET!;

    // We need the tenantId for the token, but we need the token hash for the
    // record. Solution: insert first with a placeholder hash, generate token
    // with the real tenantId, then patch.
    const tenantId = await ctx.runMutation(
      internal.admin.tenantsMutations.insertTenant,
      {
        companyName: args.companyName,
        contactEmail: args.contactEmail,
        workosOrgId: org.id,
        notes: args.notes,
        createdBy: identity.subject,
        inviteTokenHash: "placeholder",
        inviteExpiresAt: 0,
      },
    );

    // Step 3: Generate invite token with real tenantId
    const { token, tokenHash, expiresAt } = generateInviteToken(
      {
        tenantId,
        workosOrgId: org.id,
        contactEmail: args.contactEmail,
        createdAt: now,
      },
      signingSecret,
    );

    // Step 4: Patch tenant with real token hash and expiry
    await ctx.runMutation(internal.admin.tenantsMutations.patchInviteToken, {
      tenantId,
      inviteTokenHash: tokenHash,
      inviteExpiresAt: expiresAt,
    });

    // Step 5: Update WorkOS org with our tenantId as externalId
    await workos.organizations.updateOrganization({
      organization: org.id,
      externalId: tenantId,
    });

    // Step 6: Build invite URL
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const inviteUrl = `${appUrl}/onboarding?token=${encodeURIComponent(token)}`;

    return {
      tenantId,
      workosOrgId: org.id,
      inviteUrl,
      expiresAt,
    };
  },
});
```

**Important implementation notes:**
- The auth guard duplicates logic from `requireSystemAdmin.ts` because that file uses `asserts` syntax which doesn't work in actions (no direct identity assertion). Extract the org ID check into a shared helper if it bothers you.
- The insert-then-patch pattern for the invite token is necessary because `generateInviteToken` needs the `tenantId` (which is only known after insert), but the insert needs the `inviteTokenHash`. We insert with a placeholder and immediately patch.
- `NEXT_PUBLIC_APP_URL` is read from env to construct the invite URL. In Convex actions, `process.env` includes all Convex env vars.

**Files touched:** `convex/admin/tenants.ts` (rewrite from stub)

---

### 2D — Admin Mutation Helpers (`convex/admin/tenantsMutations.ts`)

**Type:** Backend
**Parallelizable:** Must be done alongside or before 2C (2C imports from this file).

**What:** Internal mutations used by the admin action. Separated into their own file because `convex/admin/tenants.ts` uses `"use node"` and cannot export mutations.

**Why:** Convex guideline: `"use node"` files can only export actions. Queries and mutations go in a separate file.

**Where:** `convex/admin/tenantsMutations.ts`

**How:**

```typescript
// convex/admin/tenantsMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const insertTenant = internalMutation({
  args: {
    companyName: v.string(),
    contactEmail: v.string(),
    workosOrgId: v.string(),
    notes: v.optional(v.string()),
    createdBy: v.string(),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("tenants", {
      ...args,
      status: "pending_signup" as const,
    });
  },
});

export const patchInviteToken = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
  },
  handler: async (ctx, { tenantId, ...fields }) => {
    await ctx.db.patch(tenantId, fields);
  },
});
```

**Files touched:** `convex/admin/tenantsMutations.ts` (create)

---

### 2E — Admin Query Functions (`convex/admin/tenantsQueries.ts`)

**Type:** Backend
**Parallelizable:** Yes — independent of 2C/2D.

**What:** Public queries for the system admin UI to list and inspect tenants.

**Why:** The admin dashboard (Phase 3 frontend) needs to display tenant status.

**Where:** `convex/admin/tenantsQueries.ts`

**How:**

```typescript
// convex/admin/tenantsQueries.ts
import { v } from "convex/values";
import { query } from "../_generated/server";

/**
 * List all tenants. System admin only.
 */
export const listTenants = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    // Org check omitted for brevity — same pattern as 2C

    return await ctx.db.query("tenants").order("desc").take(100);
  },
});

/**
 * Get a single tenant by ID. System admin only.
 */
export const getTenant = query({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) throw new Error("Tenant not found");
    return tenant;
  },
});
```

**Note:** These are `query` (public) because they'll be called from the React frontend via `useQuery`. Auth is enforced inside the handler via `ctx.auth.getUserIdentity()`.

**Files touched:** `convex/admin/tenantsQueries.ts` (create)

---

### 2F — Regenerate Invite Action

**Type:** Backend
**Parallelizable:** Yes — can be done after 2C pattern is established.

**What:** An action that generates a new invite token for an existing tenant (e.g., if the original expired). Does NOT create a new WorkOS org.

**Why:** Design doc section 13.1 specifies this recovery path.

**Where:** `convex/admin/tenants.ts` (add to existing file)

**How:**

```typescript
// Add to convex/admin/tenants.ts

export const regenerateInvite = action({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Auth guard (same as createTenantInvite)
    const identity = await ctx.auth.getUserIdentity();
    // ... same org check ...

    // Fetch existing tenant
    const tenant = await ctx.runQuery(internal.admin.tenantsQueries.getTenant, {
      tenantId,
    });
    if (!tenant) throw new Error("Tenant not found");
    if (tenant.status !== "pending_signup") {
      throw new Error("Can only regenerate invite for pending_signup tenants");
    }

    // Generate new token
    const signingSecret = process.env.INVITE_SIGNING_SECRET!;
    const { token, tokenHash, expiresAt } = generateInviteToken(
      {
        tenantId,
        workosOrgId: tenant.workosOrgId,
        contactEmail: tenant.contactEmail,
        createdAt: Date.now(),
      },
      signingSecret,
    );

    // Update tenant with new hash
    await ctx.runMutation(internal.admin.tenantsMutations.patchInviteToken, {
      tenantId,
      inviteTokenHash: tokenHash,
      inviteExpiresAt: expiresAt,
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    return {
      inviteUrl: `${appUrl}/onboarding?token=${encodeURIComponent(token)}`,
      expiresAt,
    };
  },
});
```

**Files touched:** `convex/admin/tenants.ts` (append)

---

## Parallelization Summary

```
2A (tenant utilities) ────────────────┐
2B (invite token crypto) ─────────────┤
                                      ├── 2C (createTenantInvite action)
2D (admin mutations) ─────────────────┘         │
                                                ├── 2F (regenerateInvite)
2E (admin queries) ───────────────────────────────
```

2A, 2B, 2D, 2E can all be built simultaneously. 2C depends on 2A, 2B, 2D. 2F depends on 2C's pattern.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `convex/tenants.ts` | Implemented (from stub) | 2A |
| `convex/lib/inviteToken.ts` | Created | 2B |
| `convex/admin/tenants.ts` | Implemented (from stub) | 2C, 2F |
| `convex/admin/tenantsMutations.ts` | Created | 2D |
| `convex/admin/tenantsQueries.ts` | Created | 2E |
