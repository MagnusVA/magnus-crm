# Phase 2 — Tenant Portal Access Configuration

**Goal:** Add tenant-scoped portal configuration, campaign presets, password hashing, session token issuance, and failed-login rate limiting. After this phase, tenant admins can generate secure portal access material through backend APIs, but the public portal UI does not need to exist yet.

**Prerequisite:** Phase 1A readiness decision is complete. Read `convex/_generated/ai/guidelines.md`; new tables are safe, but any later narrowing must use `convex-migration-helper`. Convex env vars `LINK_PORTAL_SESSION_SECRET` and optional `LINK_PORTAL_PASSWORD_PEPPER` must be available before password/session actions are exercised.

**Runs in PARALLEL with:** Phase 1 after the alias deletion path is known. Phase 3 and Phase 4 can start against these API contracts once 2A-2D compile.

**Skills to invoke:**
- `convex-migration-helper` — Confirm new tables and optional fields do not require a data migration; use it if any required field is introduced to an existing table.
- `convex-performance-audit` — Ensure portal config, campaign, and auth-attempt reads are index-backed and bounded.
- `workos` — Confirm workspace settings APIs continue to use WorkOS identity through `requireTenantUser()` and public portal APIs do not call WorkOS.

**Acceptance Criteria:**
1. `convex/schema.ts` defines `linkPortalConfigs`, `linkPortalCampaignPresets`, and `linkPortalAuthAttempts` with tenant-first indexes.
2. `eventTypeConfigs.linkPortalEnabled` is added as an optional boolean and does not force a backfill.
3. Tenant owner/admin callers can read portal config, rotate public slug, enable/disable the portal, update session TTL, and ensure default campaign presets for their own tenant only.
4. Portal passwords are generated server-side, returned once as plaintext, and stored only as salted `scrypt` hashes.
5. Password rotation increments `sessionVersion`, updates password timestamps, and revokes older sessions.
6. Password verification returns a signed session token only when the portal is enabled, password is set, slug matches, and rate limit allows the attempt.
7. Failed password attempts lock a tenant+IP hash bucket after 5 failures in 15 minutes and clear the bucket on successful login.
8. Unknown slugs and disabled portals return generic failures that do not reveal whether a tenant exists.
9. `npx convex dev --once` passes without schema or function registration errors.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
2A (schema widen) ───────────────┬── 2B (config authz + mutations)
                                ├── 2C (session token helpers)
                                └── 2E (rate limit mutations)

2B + 2C + 2E complete ───────────→ 2D (password rotate/verify actions)

2B complete ─────────────────────→ 2F (campaign defaults + verification)
```

**Optimal execution:**
1. Complete 2A and regenerate Convex types.
2. Implement config APIs, session token helpers, and auth attempt helpers in parallel.
3. Add password actions once the internal mutations and token helper compile.
4. Seed default campaigns and run static verification.

**Estimated time:** 2-3 days

---

## Subphases

### 2A — Portal Schema Widen

**Type:** Backend  
**Parallelizable:** No — generated types are required for all other subphases.

**What:** Add portal config, campaign preset, and auth attempt tables. Add optional `eventTypeConfigs.linkPortalEnabled`.

**Why:** Portal access needs durable tenant settings, credential metadata, rate-limit state, and tenant-configurable campaigns before any public route can unlock.

**Where:**
- `convex/schema.ts` (modify)
- `convex/lib/linkPortal/validators.ts` (create)

**How:**

**Step 1: Create shared validators.**

```typescript
// Path: convex/lib/linkPortal/validators.ts
import { v } from "convex/values";

export const portalPasswordHashParamsValidator = v.object({
  algorithm: v.literal("scrypt"),
  keyLength: v.number(),
  N: v.number(),
  r: v.number(),
  p: v.number(),
});
```

**Step 2: Add portal tables.**

```typescript
// Path: convex/schema.ts
import { portalPasswordHashParamsValidator } from "./lib/linkPortal/validators";

linkPortalConfigs: defineTable({
  tenantId: v.id("tenants"),
  publicSlug: v.string(),
  isEnabled: v.boolean(),
  passwordHash: v.optional(v.string()),
  passwordSalt: v.optional(v.string()),
  passwordHashParams: v.optional(portalPasswordHashParamsValidator),
  passwordSetAt: v.optional(v.number()),
  passwordRotatedAt: v.optional(v.number()),
  sessionVersion: v.number(),
  sessionTtlSeconds: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_publicSlug", ["publicSlug"]),

linkPortalCampaignPresets: defineTable({
  tenantId: v.id("tenants"),
  slug: v.string(),
  label: v.string(),
  utmCampaign: v.string(),
  normalizedUtmCampaign: v.string(),
  isDefault: v.boolean(),
  isActive: v.boolean(),
  sortOrder: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
  .index("by_tenantId_and_normalizedUtmCampaign", [
    "tenantId",
    "normalizedUtmCampaign",
  ]),

linkPortalAuthAttempts: defineTable({
  tenantId: v.id("tenants"),
  publicSlug: v.string(),
  ipHash: v.string(),
  failedCount: v.number(),
  windowStartedAt: v.number(),
  lockedUntil: v.optional(v.number()),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_ipHash", ["tenantId", "ipHash"])
  .index("by_publicSlug_and_ipHash", ["publicSlug", "ipHash"]),
```

**Step 3: Add an optional portal flag to event types.**

```typescript
// Path: convex/schema.ts
eventTypeConfigs: defineTable({
  // Existing fields remain unchanged.
  bookingBaseUrl: v.optional(v.string()),
  bookingUrlSource: v.optional(
    v.union(v.literal("admin_entered"), v.literal("imported_sheet")),
  ),
  linkPortalEnabled: v.optional(v.boolean()),
  updatedAt: v.optional(v.number()),
});
```

**Step 4: Generate types.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
```

**Key implementation notes:**
- New tables are safe; no existing documents need migration.
- `linkPortalEnabled` is optional so existing event configs remain schema-valid.
- Do not add `linkPortalCopyEvents` yet; Phase 5 owns copy auditing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/linkPortal/validators.ts` | Create | Shared portal validators |
| `convex/schema.ts` | Modify | Portal tables and optional event type flag |

---

### 2B — Config Authz and Mutations

**Type:** Backend  
**Parallelizable:** Yes — depends on 2A generated types.

**What:** Create tenant-admin-only config reads and internal mutations for creating configs, rotating slugs, enabling/disabling the portal, updating TTL, and storing password hashes.

**Why:** Node actions cannot access `ctx.db` directly. They need small internal mutations to write hashed credentials and session version updates.

**Where:**
- `convex/linkPortal/authz.ts` (create)
- `convex/linkPortal/configQueries.ts` (create)
- `convex/linkPortal/configMutations.ts` (create)

**How:**

**Step 1: Add an internal authz query for actions.**

```typescript
// Path: convex/linkPortal/authz.ts
import { internalQuery } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const requireTenantAdminForPortal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const access = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    return {
      tenantId: access.tenantId,
      userId: access.userId,
      role: access.role,
    };
  },
});
```

**Step 2: Add a settings query that creates defaults lazily.**

```typescript
// Path: convex/linkPortal/configQueries.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const getPortalConfigForSettings = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();

    return config
      ? {
          publicSlug: config.publicSlug,
          isEnabled: config.isEnabled,
          sessionTtlSeconds: config.sessionTtlSeconds,
          passwordSetAt: config.passwordSetAt,
          passwordRotatedAt: config.passwordRotatedAt,
        }
      : null;
  },
});
```

**Step 3: Add internal and public config mutations.**

```typescript
// Path: convex/linkPortal/configMutations.ts
import { v } from "convex/values";
import { internalMutation, mutation } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";
import { portalPasswordHashParamsValidator } from "../lib/linkPortal/validators";

const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MIN_SESSION_TTL_SECONDS = 15 * 60;
const MAX_SESSION_TTL_SECONDS = 24 * 60 * 60;

function normalizeTtl(ttlSeconds: number) {
  if (ttlSeconds < MIN_SESSION_TTL_SECONDS || ttlSeconds > MAX_SESSION_TTL_SECONDS) {
    throw new Error("Session duration must be between 15 minutes and 24 hours.");
  }
  return Math.floor(ttlSeconds);
}

export const ensureConfigForTenant = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
  },
  handler: async (ctx, { tenantId, publicSlug }) => {
    const existing = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    if (existing) return existing;

    const now = Date.now();
    const configId = await ctx.db.insert("linkPortalConfigs", {
      tenantId,
      publicSlug,
      isEnabled: false,
      sessionVersion: 1,
      sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(configId);
  },
});

export const rotatePasswordHash = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    passwordHash: v.string(),
    passwordSalt: v.string(),
    passwordHashParams: portalPasswordHashParamsValidator,
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", args.tenantId))
      .unique();

    if (!config) {
      const configId = await ctx.db.insert("linkPortalConfigs", {
        tenantId: args.tenantId,
        publicSlug: args.publicSlug,
        isEnabled: false,
        passwordHash: args.passwordHash,
        passwordSalt: args.passwordSalt,
        passwordHashParams: args.passwordHashParams,
        passwordSetAt: now,
        passwordRotatedAt: now,
        sessionVersion: 1,
        sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
        createdAt: now,
        updatedAt: now,
      });
      return await ctx.db.get(configId);
    }

    await ctx.db.patch(config._id, {
      passwordHash: args.passwordHash,
      passwordSalt: args.passwordSalt,
      passwordHashParams: args.passwordHashParams,
      passwordSetAt: config.passwordSetAt ?? now,
      passwordRotatedAt: now,
      sessionVersion: config.sessionVersion + 1,
      updatedAt: now,
    });
    return await ctx.db.get(config._id);
  },
});

export const setPortalEnabled = mutation({
  args: { isEnabled: v.boolean() },
  handler: async (ctx, { isEnabled }) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const config = await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .unique();
    if (!config) throw new Error("Generate a portal password first.");

    await ctx.db.patch(config._id, {
      isEnabled,
      sessionVersion: isEnabled ? config.sessionVersion : config.sessionVersion + 1,
      updatedAt: Date.now(),
    });
  },
});
```

**Key implementation notes:**
- Public mutations still derive `tenantId` from WorkOS-backed Convex auth; never accept tenant IDs from the client.
- Internal mutations accept `tenantId` only from an already-authenticated action.
- Rotating slug should use the same pattern as password rotation and increment `sessionVersion`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/authz.ts` | Create | Internal auth guard for actions |
| `convex/linkPortal/configQueries.ts` | Create | Settings-safe portal config reads |
| `convex/linkPortal/configMutations.ts` | Create | Config writes and password hash storage |

---

### 2C — Portal Session Token Helper

**Type:** Backend  
**Parallelizable:** Yes — depends on 2A types but not password hashing.

**What:** Implement HMAC-signed session token helpers that encode `tenantId`, `publicSlug`, `sessionVersion`, `iat`, `exp`, and `jti`.

**Why:** The public portal cannot use WorkOS. It needs a scoped, short-lived session token that Next.js can store in an HttpOnly cookie.

**Where:**
- `convex/linkPortal/sessionToken.ts` (create)

**How:**

**Step 1: Create signing and verification helpers.**

```typescript
// Path: convex/linkPortal/sessionToken.ts
"use node";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Id } from "../_generated/dataModel";

export type PortalSessionPayload = {
  tenantId: Id<"tenants">;
  publicSlug: string;
  sessionVersion: number;
  iat: number;
  exp: number;
  jti: string;
};

function secret() {
  const value = process.env.LINK_PORTAL_SESSION_SECRET;
  if (!value) {
    throw new Error("LINK_PORTAL_SESSION_SECRET is not configured.");
  }
  return value;
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(data: string) {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function issuePortalSessionToken(args: {
  tenantId: Id<"tenants">;
  publicSlug: string;
  sessionVersion: number;
  ttlSeconds: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: PortalSessionPayload = {
    tenantId: args.tenantId,
    publicSlug: args.publicSlug,
    sessionVersion: args.sessionVersion,
    iat: now,
    exp: now + args.ttlSeconds,
    jti: randomBytes(18).toString("base64url"),
  };
  const body = base64urlJson(payload);
  return `${body}.${sign(body)}`;
}

export function verifyPortalSessionToken(token: string) {
  const [body, signature] = token.split(".");
  if (!body || !signature) {
    throw new Error("Invalid portal session.");
  }
  const expected = sign(body);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid portal session.");
  }
  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8"),
  ) as PortalSessionPayload;
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Portal session expired.");
  }
  return payload;
}
```

**Key implementation notes:**
- Keep this helper imported only by Node actions.
- Validate `publicSlug` and `sessionVersion` against the current config after decoding; signature alone is not enough after rotation.
- Never log tokens or full payloads.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/sessionToken.ts` | Create | HMAC session token helper |

---

### 2D — Password Rotate and Verify Actions

**Type:** Backend  
**Parallelizable:** No — depends on config mutations, token helper, and rate-limit helpers.

**What:** Add Node actions for password rotation and password verification using `crypto.scrypt`.

**Why:** Password hashing uses Node built-ins and must stay out of Convex queries/mutations. The plaintext password is returned exactly once from rotation.

**Where:**
- `convex/linkPortal/passwordActions.ts` (create)

**How:**

**Step 1: Implement hashing helpers and rotation.**

```typescript
// Path: convex/linkPortal/passwordActions.ts
"use node";

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { v } from "convex/values";
import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { issuePortalSessionToken } from "./sessionToken";

const scrypt = promisify(scryptCallback);
const HASH_PARAMS = { algorithm: "scrypt" as const, keyLength: 32, N: 32768, r: 8, p: 1 };

async function hashPortalPassword(password: string, salt: string) {
  const pepper = process.env.LINK_PORTAL_PASSWORD_PEPPER ?? "";
  const derived = (await scrypt(`${password}${pepper}`, salt, HASH_PARAMS.keyLength, {
    N: HASH_PARAMS.N,
    r: HASH_PARAMS.r,
    p: HASH_PARAMS.p,
  })) as Buffer;
  return derived.toString("base64url");
}

export const rotatePortalPassword = action({
  args: {},
  handler: async (ctx) => {
    const access = await ctx.runQuery(
      internal.linkPortal.authz.requireTenantAdminForPortal,
      {},
    );

    const plainPassword = randomBytes(18).toString("base64url");
    const publicSlug = `lp_${randomBytes(18).toString("base64url")}`;
    const passwordSalt = randomBytes(16).toString("base64url");
    const passwordHash = await hashPortalPassword(plainPassword, passwordSalt);

    const config = await ctx.runMutation(
      internal.linkPortal.configMutations.rotatePasswordHash,
      {
        tenantId: access.tenantId,
        publicSlug,
        passwordHash,
        passwordSalt,
        passwordHashParams: HASH_PARAMS,
      },
    );
    if (!config) throw new Error("Portal configuration could not be saved.");

    return {
      portalUrlPath: `/dm-links/${config.publicSlug}`,
      plainPassword,
      passwordSetAt: config.passwordSetAt,
      passwordRotatedAt: config.passwordRotatedAt,
    };
  },
});
```

**Step 2: Verify password and issue a session.**

```typescript
// Path: convex/linkPortal/passwordActions.ts
export const verifyPassword = action({
  args: {
    portalSlug: v.string(),
    password: v.string(),
    ipHash: v.string(),
  },
  handler: async (ctx, { portalSlug, password, ipHash }) => {
    const config = await ctx.runQuery(
      internal.linkPortal.configQueries.getConfigByPublicSlug,
      { publicSlug: portalSlug },
    );
    if (!config || !config.isEnabled || !config.passwordHash || !config.passwordSalt) {
      throw new Error("Portal unavailable or password invalid.");
    }

    await ctx.runMutation(internal.linkPortal.rateLimitMutations.assertNotLocked, {
      tenantId: config.tenantId,
      publicSlug: portalSlug,
      ipHash,
    });

    const attemptedHash = await hashPortalPassword(password, config.passwordSalt);
    const attemptedBuffer = Buffer.from(attemptedHash);
    const expectedBuffer = Buffer.from(config.passwordHash);
    const valid =
      attemptedBuffer.length === expectedBuffer.length &&
      timingSafeEqual(attemptedBuffer, expectedBuffer);

    if (!valid) {
      await ctx.runMutation(internal.linkPortal.rateLimitMutations.recordFailedAttempt, {
        tenantId: config.tenantId,
        publicSlug: portalSlug,
        ipHash,
      });
      throw new Error("Portal unavailable or password invalid.");
    }

    await ctx.runMutation(internal.linkPortal.rateLimitMutations.clearFailedAttempts, {
      tenantId: config.tenantId,
      ipHash,
    });

    return {
      sessionToken: issuePortalSessionToken({
        tenantId: config.tenantId,
        publicSlug: config.publicSlug,
        sessionVersion: config.sessionVersion,
        ttlSeconds: config.sessionTtlSeconds,
      }),
      maxAgeSeconds: config.sessionTtlSeconds,
    };
  },
});
```

**Key implementation notes:**
- `verifyPassword` must use a generic error for unknown slug, disabled portal, missing password, rate limit, and wrong password.
- Do not let `plainPassword` cross into Convex mutations.
- Keep action files separate from queries/mutations because of `"use node"`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/passwordActions.ts` | Create | Password rotation and verification |

---

### 2E — Rate Limit Helpers

**Type:** Backend  
**Parallelizable:** Yes — depends on 2A generated types.

**What:** Add internal mutations that check, increment, lock, and clear failed login buckets per tenant and IP hash.

**Why:** Public password entry needs brute-force protection without storing raw IP addresses in Convex.

**Where:**
- `convex/linkPortal/rateLimitMutations.ts` (create)
- `convex/linkPortal/configQueries.ts` (modify)

**How:**

**Step 1: Add config lookup by public slug.**

```typescript
// Path: convex/linkPortal/configQueries.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

export const getConfigByPublicSlug = internalQuery({
  args: { publicSlug: v.string() },
  handler: async (ctx, { publicSlug }) => {
    return await ctx.db
      .query("linkPortalConfigs")
      .withIndex("by_publicSlug", (q) => q.eq("publicSlug", publicSlug))
      .unique();
  },
});
```

**Step 2: Add attempt bucket mutations.**

```typescript
// Path: convex/linkPortal/rateLimitMutations.ts
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

export const assertNotLocked = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    ipHash: v.string(),
  },
  handler: async (ctx, { tenantId, ipHash }) => {
    const attempt = await ctx.db
      .query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) =>
        q.eq("tenantId", tenantId).eq("ipHash", ipHash),
      )
      .unique();
    if (attempt?.lockedUntil && attempt.lockedUntil > Date.now()) {
      throw new Error("Portal unavailable or password invalid.");
    }
  },
});

export const recordFailedAttempt = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    publicSlug: v.string(),
    ipHash: v.string(),
  },
  handler: async (ctx, { tenantId, publicSlug, ipHash }) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) =>
        q.eq("tenantId", tenantId).eq("ipHash", ipHash),
      )
      .unique();

    const inWindow = existing && now - existing.windowStartedAt < WINDOW_MS;
    const failedCount = inWindow ? existing.failedCount + 1 : 1;
    const lockedUntil = failedCount >= MAX_FAILURES ? now + LOCK_MS : undefined;

    if (!existing) {
      await ctx.db.insert("linkPortalAuthAttempts", {
        tenantId,
        publicSlug,
        ipHash,
        failedCount,
        windowStartedAt: now,
        lockedUntil,
        updatedAt: now,
      });
      return;
    }

    await ctx.db.patch(existing._id, {
      publicSlug,
      failedCount,
      windowStartedAt: inWindow ? existing.windowStartedAt : now,
      lockedUntil,
      updatedAt: now,
    });
  },
});

export const clearFailedAttempts = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    ipHash: v.string(),
  },
  handler: async (ctx, { tenantId, ipHash }) => {
    const existing = await ctx.db
      .query("linkPortalAuthAttempts")
      .withIndex("by_tenantId_and_ipHash", (q) =>
        q.eq("tenantId", tenantId).eq("ipHash", ipHash),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
```

**Key implementation notes:**
- Next.js computes `ipHash`; Convex never receives the raw IP.
- Use tenant ID from portal config, never client input.
- Rate-limit errors should remain indistinguishable from password failures.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/rateLimitMutations.ts` | Create | Failed attempt and lockout state |
| `convex/linkPortal/configQueries.ts` | Modify | Internal slug lookup |

---

### 2F — Campaign Defaults and Verification

**Type:** Backend / Manual  
**Parallelizable:** Yes — depends on 2B and generated campaign types.

**What:** Add campaign preset list and default seeding APIs, then run Convex and TypeScript checks.

**Why:** The portal needs a bounded, tenant-configurable campaign list before Phase 3 can build links.

**Where:**
- `convex/linkPortal/campaignQueries.ts` (create)
- `convex/linkPortal/campaignMutations.ts` (create)

**How:**

**Step 1: Add default campaign seeding.**

```typescript
// Path: convex/linkPortal/campaignMutations.ts
import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { normalizeUtmValue, slugifyAttributionLabel } from "../lib/attribution/normalize";
import { requireTenantUser } from "../requireTenantUser";

const DEFAULT_CAMPAIGNS = [
  { label: "Organic", utmCampaign: "organic" },
  { label: "Paid", utmCampaign: "paid" },
  { label: "Story", utmCampaign: "story" },
  { label: "DM", utmCampaign: "dm" },
] as const;

export const ensureDefaultCampaignPresets = mutation({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    const existing = await ctx.db
      .query("linkPortalCampaignPresets")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);
    if (existing.length > 0) return existing.map((row) => row._id);

    const now = Date.now();
    const ids = [];
    for (const [index, preset] of DEFAULT_CAMPAIGNS.entries()) {
      const normalized = normalizeUtmValue(preset.utmCampaign);
      if (!normalized) throw new Error("Campaign preset is invalid.");
      ids.push(
        await ctx.db.insert("linkPortalCampaignPresets", {
          tenantId,
          slug: slugifyAttributionLabel(preset.label),
          label: preset.label,
          utmCampaign: preset.utmCampaign,
          normalizedUtmCampaign: normalized,
          isDefault: index === 0,
          isActive: true,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        }),
      );
    }
    return ids;
  },
});
```

**Step 2: List active campaigns.**

```typescript
// Path: convex/linkPortal/campaignQueries.ts
import { query } from "../_generated/server";
import { requireTenantUser } from "../requireTenantUser";

export const listCampaignPresetsForSettings = query({
  args: {},
  handler: async (ctx) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);
    return await ctx.db
      .query("linkPortalCampaignPresets")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(100);
  },
});
```

**Step 3: Run verification.**

```bash
# Path: /Users/nimbus/dev/ptdom-crm
npx convex dev --once
pnpm tsc --noEmit
```

**Key implementation notes:**
- Enforce one default in create/update mutations in Phase 4 when editing is exposed.
- Use normalized uniqueness by tenant for `utmCampaign`.
- Keep campaign values to 40 characters in all public mutations.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/linkPortal/campaignMutations.ts` | Create | Seed and later manage campaign presets |
| `convex/linkPortal/campaignQueries.ts` | Create | Settings reads |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/linkPortal/validators.ts` | Create | 2A |
| `convex/schema.ts` | Modify | 2A |
| `convex/linkPortal/authz.ts` | Create | 2B |
| `convex/linkPortal/configQueries.ts` | Create / Modify | 2B, 2E |
| `convex/linkPortal/configMutations.ts` | Create | 2B |
| `convex/linkPortal/sessionToken.ts` | Create | 2C |
| `convex/linkPortal/passwordActions.ts` | Create | 2D |
| `convex/linkPortal/rateLimitMutations.ts` | Create | 2E |
| `convex/linkPortal/campaignMutations.ts` | Create | 2F |
| `convex/linkPortal/campaignQueries.ts` | Create | 2F |
| `convex/_generated/*` | Generate | 2A, 2F |
