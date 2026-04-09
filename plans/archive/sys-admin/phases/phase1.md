# Phase 1 — Schema, Dependencies & Environment Setup

**Goal:** Establish the foundation — Convex schema, package dependencies, environment variables, and external service configuration — so all subsequent phases can build on stable ground.

**Prerequisite:** None. This is the first phase.

**Acceptance Criteria:**
1. `npx convex dev` runs without schema errors.
2. `pnpm tsc --noEmit` passes with the new schema types available in `convex/_generated/dataModel`.
3. `@workos-inc/node` is importable in a Convex `"use node"` action file.
4. All required environment variables are set in both Convex and `.env.local`.
5. A Calendly OAuth app exists in sandbox with correct redirect URI and scopes.
6. A test Convex action can instantiate `new WorkOS(process.env.WORKOS_API_KEY)` without errors.

---

## Subphases

### 1A — Install Dependencies (no blockers)

**Type:** Backend
**Parallelizable:** Yes — independent of all other subphases.

**What:** Install the `@workos-inc/node` SDK as a direct dependency.

**Why:** It's a transitive dep of `@workos-inc/authkit-nextjs` but pnpm doesn't hoist it. We need direct access for Convex `"use node"` actions that call `workos.organizations.createOrganization()`.

**Where:** Project root.

**How:**

```bash
pnpm add @workos-inc/node
```

**Verify:**

```bash
ls node_modules/@workos-inc/node/package.json  # should exist
```

**Files touched:** `package.json`, `pnpm-lock.yaml`

---

### 1B — Calendly OAuth App Registration (MANUAL — no code)

**Type:** Manual developer task
**Parallelizable:** Yes — independent of all other subphases.

> **You must do this yourself in a browser.** This cannot be automated.

**What:** Register the CRM as a Calendly OAuth application.

**Why:** Every tenant will authorize this single app. We need the `client_id`, `client_secret`, and `webhook_signing_key` from the Calendly developer portal.

**Steps:**

1. Go to [developer.calendly.com](https://developer.calendly.com) and sign in with your **developer account** (GitHub or Google — this is NOT your Calendly user account).
2. Click **"Create OAuth App"**.
3. Fill in:
   | Field | Value |
   |---|---|
   | Name | `ptdom-crm` (or your preferred name) |
   | Kind | **Web** |
   | Environment | **Sandbox** (create a separate Production app later) |
   | Redirect URI | `http://localhost:3000/callback/calendly` (HTTP allowed for sandbox) |
4. Select **scopes**:
   - `scheduled_events:read`
   - `event_types:read`
   - `users:read`
   - `organizations:read`
   - `webhooks:write`
   - `routing_forms:read`
5. Click **Create**.
6. **IMMEDIATELY copy** the following values (they are shown only once):
   - `Client ID`
   - `Client Secret`
   - `Webhook Signing Key`
7. Store these securely — you'll set them as env vars in subphase 1C.

**Acceptance:** You have `CALENDLY_CLIENT_ID`, `CALENDLY_CLIENT_SECRET`, and `CALENDLY_WEBHOOK_SIGNING_KEY` values saved.

---

### 1C — Environment Variables (depends on 1B for Calendly values)

**Type:** Manual developer task + CLI
**Parallelizable:** Partially — can set WorkOS vars immediately, Calendly vars after 1B.

**What:** Set all required environment variables in both Convex (server-side) and `.env.local` (client-side).

**Why:** Convex actions access env vars via `process.env`. Next.js client components need `NEXT_PUBLIC_*` prefixed vars.

**How — Convex environment variables:**

```bash
# WorkOS (you should already have these from initial setup)
npx convex env set WORKOS_API_KEY "sk_test_..."
npx convex env set WORKOS_CLIENT_ID "client_..."

# Calendly (from subphase 1B)
npx convex env set CALENDLY_CLIENT_ID "your_calendly_client_id"
npx convex env set CALENDLY_CLIENT_SECRET "your_calendly_client_secret"
npx convex env set CALENDLY_WEBHOOK_SIGNING_KEY "your_webhook_signing_key"

# Invite token signing (generate a random 32-byte secret)
npx convex env set INVITE_SIGNING_SECRET "$(openssl rand -base64 32)"
```

**How — `.env.local`:**

```bash
# These should already exist:
# NEXT_PUBLIC_CONVEX_URL=...
# WORKOS_API_KEY=...
# WORKOS_CLIENT_ID=...
# WORKOS_COOKIE_PASSWORD=...

# Add Calendly client ID (needed by the frontend for OAuth redirect)
NEXT_PUBLIC_CALENDLY_CLIENT_ID=your_calendly_client_id

# App domain for constructing redirect URIs
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

**Files touched:** `.env.local` (not committed), Convex dashboard env vars

---

### 1D — Convex Schema Update (no blockers)

**Type:** Backend
**Parallelizable:** Yes — independent of 1A, 1B, 1C.

**What:** Replace the placeholder `todos` schema with the full multi-tenant schema from the design doc.

**Why:** Every subsequent phase depends on these tables and indexes existing.

**Where:** `convex/schema.ts`

**How:** Replace the entire file contents. The current schema is a placeholder:

```typescript
// CURRENT (to be replaced):
export default defineSchema({
  todos: defineTable({
    text: v.string(),
    completed: v.boolean(),
  }),
});
```

**New schema:**

```typescript
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  tenants: defineTable({
    // Identity
    companyName: v.string(),
    contactEmail: v.string(),
    workosOrgId: v.string(),
    status: v.union(
      v.literal("pending_signup"),
      v.literal("pending_calendly"),
      v.literal("provisioning_webhooks"),
      v.literal("active"),
      v.literal("calendly_disconnected"),
      v.literal("suspended"),
    ),

    // Invite
    inviteTokenHash: v.string(),
    inviteExpiresAt: v.number(),
    inviteRedeemedAt: v.optional(v.number()),

    // Calendly OAuth
    calendlyAccessToken: v.optional(v.string()),
    calendlyRefreshToken: v.optional(v.string()),
    calendlyTokenExpiresAt: v.optional(v.number()),
    calendlyOrgUri: v.optional(v.string()),
    calendlyOwnerUri: v.optional(v.string()),
    calendlyRefreshLockUntil: v.optional(v.number()),

    // Webhooks
    calendlyWebhookUri: v.optional(v.string()),
    webhookSigningKey: v.optional(v.string()),

    // Metadata
    notes: v.optional(v.string()),
    createdBy: v.string(),
    onboardingCompletedAt: v.optional(v.number()),
  })
    .index("by_workosOrgId", ["workosOrgId"])
    .index("by_status", ["status"])
    .index("by_inviteTokenHash", ["inviteTokenHash"]),

  users: defineTable({
    tenantId: v.id("tenants"),
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    role: v.union(
      v.literal("tenant_master"),
      v.literal("tenant_admin"),
      v.literal("closer"),
    ),
    calendlyUserUri: v.optional(v.string()),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_workosUserId", ["workosUserId"])
    .index("by_tenantId_and_email", ["tenantId", "email"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"]),

  rawWebhookEvents: defineTable({
    tenantId: v.id("tenants"),
    calendlyEventUri: v.string(),
    eventType: v.string(),
    payload: v.string(),
    processed: v.boolean(),
    receivedAt: v.number(),
  })
    .index("by_tenantId_and_eventType", ["tenantId", "eventType"])
    .index("by_calendlyEventUri", ["calendlyEventUri"])
    .index("by_processed", ["processed"]),

  calendlyOrgMembers: defineTable({
    tenantId: v.id("tenants"),
    calendlyUserUri: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    calendlyRole: v.optional(v.string()),
    matchedUserId: v.optional(v.id("users")),
    lastSyncedAt: v.number(),
  })
    .index("by_tenantId", ["tenantId"])
    .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"]),
});
```

**Important notes for the implementer:**
- The old `todos` table is removed. You must also **delete** `convex/todos.ts` and remove the `api.todos.*` references from `app/page.tsx` in the same change, or `npx convex dev` will fail with broken references.
- Don't worry about the `page.tsx` cleanup being pretty — Phase 3 will replace the entire frontend. Just remove the `TodoList` component and its imports, and render a placeholder.
- All index names follow the Convex guideline: include all index fields in the name (e.g., `by_tenantId_and_email` for `["tenantId", "email"]`).

**Files touched:** `convex/schema.ts`, `convex/todos.ts` (delete), `app/page.tsx` (remove todo references)

---

### 1E — Stub Convex Function Files (depends on 1D for schema types)

**Type:** Backend
**Parallelizable:** Can run after 1D completes.

**What:** Create the directory structure and empty stub files for all Convex functions that will be built in later phases. This validates that the file-based routing and imports resolve correctly.

**Why:** Later phases can work in parallel on different files without merge conflicts. Having stubs also validates the `internal.*` and `api.*` references compile.

**Where:** `convex/` directory.

**How:** Create these directories and files:

```
convex/
├── admin/
│   └── tenants.ts          # Phase 2: system admin CRUD
├── onboarding/
│   ├── invite.ts           # Phase 3: validate + redeem invites
│   └── complete.ts         # Phase 3: finalize onboarding
├── calendly/
│   ├── oauth.ts            # Phase 4: PKCE + token exchange
│   ├── tokens.ts           # Phase 5: refresh, mutex, getValidToken
│   ├── webhookSetup.ts     # Phase 4: provision webhook subscriptions
│   └── orgMembers.ts       # Phase 5: sync org members
├── webhooks/
│   └── calendly.ts         # Phase 4: HTTP action for inbound webhooks
└── tenants.ts              # Shared internal queries/mutations for tenant data
```

Each stub should export nothing but validate it can import schema types:

```typescript
// Example stub: convex/admin/tenants.ts
import { v } from "convex/values";
import { query, mutation, action, internalQuery, internalMutation, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

// Functions will be implemented in Phase 2.
```

For `"use node"` files (anything that will import `@workos-inc/node` or use Node.js crypto):

```typescript
// Example stub: convex/calendly/oauth.ts
"use node";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";

// Functions will be implemented in Phase 4.
```

> **Convex guideline:** Files with `"use node"` CANNOT also export queries or mutations. Only actions can run in the Node.js runtime. If a file needs both queries and actions, split them across separate files.

**Files touched:** All new files listed above (create)

---

### 1F — Verify WorkOS SDK Connectivity (depends on 1A + 1C)

**Type:** Backend
**Parallelizable:** Runs after 1A and 1C complete.

**What:** Write a throwaway Convex action that instantiates the WorkOS client and calls `listOrganizations` to verify credentials work.

**Why:** Fail fast if env vars are wrong or the SDK doesn't load in the Convex Node.js runtime.

**Where:** `convex/admin/tenants.ts` (add a temporary test action)

**How:**

```typescript
"use node";
import { WorkOS } from "@workos-inc/node";
import { internalAction } from "../_generated/server";
import { v } from "convex/values";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

// TEMPORARY — remove after verifying
export const testWorkosConnection = internalAction({
  args: {},
  handler: async () => {
    const orgs = await workos.organizations.listOrganizations({ limit: 1 });
    console.log("WorkOS connection OK. Orgs found:", orgs.data.length);
    return { ok: true, orgCount: orgs.data.length };
  },
});
```

Run it from the Convex dashboard or CLI:

```bash
npx convex run admin/tenants:testWorkosConnection
```

**After verification:** Remove the `testWorkosConnection` export or leave it as an internal diagnostic. It's `internalAction` so it's not publicly exposed.

**Files touched:** `convex/admin/tenants.ts` (temporary addition)

---

## Parallelization Summary

```
1A (install deps)  ──────────────────────────────┐
1B (Calendly app — MANUAL)  ─────────────────────┤
1D (schema update)  ─────────────────────────┐    ├── 1F (verify WorkOS SDK)
                                             │    │
1C (env vars — partial wait on 1B)  ─────────┘────┘
                                             │
1E (stub files — wait on 1D)  ───────────────┘
```

Tasks 1A, 1B, 1D can all start simultaneously. 1C can partially start (WorkOS vars) but needs 1B for Calendly vars. 1E needs 1D. 1F needs 1A + 1C.

---

## Files Modified/Created Summary

| File | Action | Subphase |
|---|---|---|
| `package.json` | Modified (add dep) | 1A |
| `pnpm-lock.yaml` | Modified | 1A |
| `.env.local` | Modified (add vars) | 1C |
| `convex/schema.ts` | **Rewritten** | 1D |
| `convex/todos.ts` | **Deleted** | 1D |
| `app/page.tsx` | Modified (remove todos) | 1D |
| `convex/admin/tenants.ts` | Created | 1E, 1F |
| `convex/onboarding/invite.ts` | Created | 1E |
| `convex/onboarding/complete.ts` | Created | 1E |
| `convex/calendly/oauth.ts` | Created | 1E |
| `convex/calendly/tokens.ts` | Created | 1E |
| `convex/calendly/webhookSetup.ts` | Created | 1E |
| `convex/calendly/orgMembers.ts` | Created | 1E |
| `convex/webhooks/calendly.ts` | Created | 1E |
| `convex/tenants.ts` | Created (or repurposed) | 1E |
