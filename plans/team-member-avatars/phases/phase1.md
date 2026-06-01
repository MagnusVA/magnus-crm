# Phase 1 — Profile Data Contract

**Goal:** Widen the Convex data model and establish one tenant-safe member identity contract for CRM users, lead generators, Slack users, DM closers, system actors, and removed users. After this phase, backend queries can return avatar-ready identity objects without exposing raw storage IDs or accepting user identity from the client.

**Prerequisite:** `plans/team-member-avatars/team-member-avatars-design.md` is accepted for MVP scope. Read `convex/_generated/ai/guidelines.md` before implementation. This phase is a widen-only schema change: all new fields stay optional and no narrow deploy is planned.

**Runs in PARALLEL with:** Phase 2 after 1B publishes the `MemberAvatarIdentity` shape. Phase 3 and Phase 4 wait for 1A, 1B, and generated Convex types. Phase 5 backfill implementation can start after 1C exists, but production execution waits for the verification gate.

**Skills to invoke:**
- `convex-migration-helper` — optional fields, index addition, WorkOS backfill planning, and production verification.
- `convex` — validators, internal mutations/actions, indexed reads, and `ctx.storage.getUrl()` usage.
- `workos` — User API profile picture fetches and AuthKit identity gotchas.
- `convex-dev-workos-authkit` — only if AuthKit event/sync code is extended beyond the existing claim flow.

**Acceptance Criteria:**
1. `convex/schema.ts` contains optional avatar fields on `users` and `leadGenWorkers`, plus optional `dmClosers.userId`.
2. `dmClosers` has a `by_tenantId_and_userId` index and every new index name follows `by_<field>_and_<field>`.
3. `convex/lib/memberIdentity.ts` exports helpers for CRM users, lead-gen workers, Slack users, DM closers, and system/unknown actors.
4. CRM identity helpers resolve `customProfilePictureStorageId` with `ctx.storage.getUrl()` and fall back to `profilePictureUrl`, then initials-only UI fallback.
5. Public portal helpers cannot return WorkOS image URLs, Slack image URLs, Convex signed storage URLs, or CRM emails.
6. WorkOS profile sync runs in Node actions and never accepts `tenantId`, `userId`, `role`, or `profilePictureUrl` from browser arguments.
7. Invite claiming stores `profilePictureUrl` when WorkOS returns one, while pending invite rows remain initials-only.
8. `syncWorkerProfileForUser` dual-writes lead-gen worker avatar fields when the linked CRM user changes.
9. DM closer linking validates that `dmClosers.userId`, when present, belongs to the caller's tenant.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (schema widen) ────────────────┬── 1C (WorkOS sync actions/mutations) ───┐
                                  ├── 1D (lead-gen denormalization) ───────┤
                                  └── 1E (DM closer link contract) ────────┤
                                                                           ├── 1F (contract verification)
1B (member identity helpers) ─────┬── Phase 2 can start after 1B ──────────┘
                                  └── 1C/1D/1E consume helper types
```

**Optimal execution:**
1. Start 1A first. It changes generated Convex types and should be deployed as a widen-only schema update.
2. Start 1B as soon as the intended fields are known; it can run while schema codegen is being verified.
3. Run 1C, 1D, and 1E in parallel after generated types exist. They touch `convex/workos`, `convex/leadGen`, and `convex/attribution`.
4. Start Phase 2 component work immediately after 1B publishes the frontend-compatible identity contract.
5. Finish with 1F before Phase 3 or Phase 4 relies on the contract.

**Estimated time:** 2-3 days

---

## Subphases

### 1A — Widen Avatar Schema

**Type:** Backend
**Parallelizable:** No — generated Convex types from this subphase unblock all backend writers and most frontend query typing.

**What:** Add optional avatar fields to `users` and `leadGenWorkers`, add optional CRM user linking to `dmClosers`, and add the index needed for linked DM closer lookups.

**Why:** Optional fields are safe for the production test tenant and let the app dual-read old and new rows during rollout. Making these fields required would block deployment because existing documents do not have avatar data.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add optional fields to `users`.**

```typescript
// Path: convex/schema.ts
users: defineTable({
  tenantId: v.id("tenants"),
  workosUserId: v.string(),
  email: v.string(),
  fullName: v.optional(v.string()),
  role: v.union(
    v.literal("tenant_master"),
    v.literal("tenant_admin"),
    v.literal("closer"),
    v.literal("lead_generator"),
  ),
  calendlyUserUri: v.optional(v.string()),
  calendlyMemberName: v.optional(v.string()),
  invitationStatus: v.optional(
    v.union(v.literal("pending"), v.literal("accepted")),
  ),
  workosInvitationId: v.optional(v.string()),
  personalEventTypeUri: v.optional(v.string()),
  customProfilePictureStorageId: v.optional(v.id("_storage")),
  customProfilePictureUploadedAt: v.optional(v.number()),
  profilePictureUrl: v.optional(v.string()),
  profilePictureSyncedAt: v.optional(v.number()),
  deletedAt: v.optional(v.number()),
  isActive: v.boolean(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_workosUserId", ["workosUserId"])
  .index("by_tenantId_and_email", ["tenantId", "email"])
  .index("by_tenantId_and_calendlyUserUri", ["tenantId", "calendlyUserUri"])
  .index("by_tenantId_and_isActive", ["tenantId", "isActive"]),
```

**Step 2: Add optional fields to `leadGenWorkers`.**

```typescript
// Path: convex/schema.ts
leadGenWorkers: defineTable({
  tenantId: v.id("tenants"),
  userId: v.id("users"),
  workosUserId: v.string(),
  displayName: v.optional(v.string()),
  email: v.string(),
  teamId: v.optional(v.id("attributionTeams")),
  customProfilePictureStorageId: v.optional(v.id("_storage")),
  profilePictureUrl: v.optional(v.string()),
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_userId", ["tenantId", "userId"])
  .index("by_tenantId_and_workosUserId", ["tenantId", "workosUserId"])
  .index("by_tenantId_and_isActive", ["tenantId", "isActive"])
  .index("by_tenantId_and_teamId", ["tenantId", "teamId"]),
```

**Step 3: Add optional CRM link to `dmClosers`.**

```typescript
// Path: convex/schema.ts
dmClosers: defineTable({
  tenantId: v.id("tenants"),
  teamId: v.id("attributionTeams"),
  slug: v.string(),
  displayName: v.string(),
  utmMedium: v.string(),
  normalizedUtmMedium: v.string(),
  userId: v.optional(v.id("users")),
  isActive: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_tenantId_and_teamId", ["tenantId", "teamId"])
  .index("by_tenantId_and_slug", ["tenantId", "slug"])
  .index("by_tenantId_and_normalizedUtmMedium", [
    "tenantId",
    "normalizedUtmMedium",
  ])
  .index("by_tenantId_and_userId", ["tenantId", "userId"]),
```

**Step 4: Generate Convex types.**

```bash
# Path: terminal
pnpm exec convex codegen
```

**Key implementation notes:**
- This is a widen-only deploy. Do not require any new field in this feature.
- Do not index `profilePictureUrl` or `customProfilePictureStorageId`; they are display metadata.
- Keep the new `dmClosers.userId` optional because not every DM attribution person authenticates into the CRM.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add optional avatar fields and DM closer user link/index. |

---

### 1B — Normalized Member Identity Helpers

**Type:** Backend
**Parallelizable:** Yes — can run after 1A field names are agreed, and Phase 2 can start from this contract before all backend writers are complete.

**What:** Create helper functions that turn existing documents into one `MemberAvatarIdentity` payload.

**Why:** Every surface should receive an already-authorized identity object. Client components should not make extra user lookups or know whether a picture came from Convex storage, WorkOS, Slack, or no image.

**Where:**
- `convex/lib/memberIdentity.ts` (new)
- `app/workspace/_components/member-avatar.tsx` (type mirror in Phase 2)

**How:**

**Step 1: Define the identity type and CRM user helper.**

```typescript
// Path: convex/lib/memberIdentity.ts
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export type MemberAvatarIdentity = {
  id: string;
  name: string | null;
  email?: string | null;
  imageUrl?: string | null;
  imageSource: "custom_storage" | "workos" | "slack" | "none";
  secondaryLabel?: string | null;
  isActive?: boolean | null;
  source: "crm_user" | "slack" | "dm_closer" | "system" | "unknown";
};

export async function userMemberIdentity(
  ctx: QueryCtx,
  user: Doc<"users"> | null | undefined,
): Promise<MemberAvatarIdentity> {
  if (!user) return unknownMemberIdentity("Removed user", "unknown");

  const customUrl = user.customProfilePictureStorageId
    ? await ctx.storage.getUrl(user.customProfilePictureStorageId)
    : null;

  return {
    id: user._id,
    name: user.fullName ?? user.email,
    email: user.email,
    imageUrl: customUrl ?? user.profilePictureUrl ?? null,
    imageSource: customUrl ? "custom_storage" : user.profilePictureUrl ? "workos" : "none",
    secondaryLabel: user.email,
    isActive: user.isActive,
    source: "crm_user",
  };
}
```

**Step 2: Add Slack, lead-gen, DM closer, and system helpers.**

```typescript
// Path: convex/lib/memberIdentity.ts
export async function leadGenWorkerMemberIdentity(
  ctx: QueryCtx,
  worker: Doc<"leadGenWorkers"> | null | undefined,
): Promise<MemberAvatarIdentity> {
  if (!worker) return unknownMemberIdentity("Removed lead generator", "unknown");
  const customUrl = worker.customProfilePictureStorageId
    ? await ctx.storage.getUrl(worker.customProfilePictureStorageId)
    : null;

  return {
    id: worker._id,
    name: worker.displayName ?? worker.email,
    email: worker.email,
    imageUrl: customUrl ?? worker.profilePictureUrl ?? null,
    imageSource: customUrl ? "custom_storage" : worker.profilePictureUrl ? "workos" : "none",
    secondaryLabel: worker.email,
    isActive: worker.isActive,
    source: "crm_user",
  };
}

export function slackMemberIdentity(
  slackUser: Doc<"slackUsers"> | null | undefined,
  fallbackId = "slack:unknown",
): MemberAvatarIdentity {
  const name =
    slackUser?.displayName ?? slackUser?.realName ?? slackUser?.name ?? "Slack user";

  return {
    id: slackUser?._id ?? fallbackId,
    name,
    email: null,
    imageUrl: slackUser?.avatarUrl ?? null,
    imageSource: slackUser?.avatarUrl ? "slack" : "none",
    isActive: slackUser ? !slackUser.isDeleted : null,
    source: "slack",
  };
}

export async function dmCloserMemberIdentity(
  ctx: QueryCtx,
  dmCloser: Doc<"dmClosers">,
  linkedUser: Doc<"users"> | null,
): Promise<MemberAvatarIdentity> {
  if (linkedUser) {
    return await userMemberIdentity(ctx, linkedUser);
  }

  return {
    id: dmCloser._id,
    name: dmCloser.displayName,
    email: null,
    imageUrl: null,
    imageSource: "none",
    isActive: dmCloser.isActive,
    source: "dm_closer",
  };
}

export function unknownMemberIdentity(
  label: string,
  source: "system" | "unknown",
): MemberAvatarIdentity {
  return {
    id: source,
    name: label,
    email: null,
    imageUrl: null,
    imageSource: "none",
    isActive: null,
    source,
  };
}
```

**Step 3: Add a public-portal-safe helper.**

```typescript
// Path: convex/lib/memberIdentity.ts
export function publicDmCloserIdentity(
  dmCloser: Pick<Doc<"dmClosers">, "_id" | "displayName" | "isActive">,
): MemberAvatarIdentity {
  return {
    id: dmCloser._id,
    name: dmCloser.displayName,
    email: null,
    imageUrl: null,
    imageSource: "none",
    isActive: dmCloser.isActive,
    source: "dm_closer",
  };
}
```

**Key implementation notes:**
- Do not store signed Convex file URLs. Generate them only in authorized queries.
- Batch user loads in calling queries where possible; avoid helper-level unbounded reads.
- Public link portal queries must call `publicDmCloserIdentity`, not `dmCloserMemberIdentity`.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/memberIdentity.ts` | Create | Shared identity contract and source-priority helpers. |

---

### 1C — WorkOS Profile Picture Sync

**Type:** Backend
**Parallelizable:** Yes — can run after 1A. It owns `convex/workos/*` and does not need Phase 2 UI.

**What:** Store WorkOS `profilePictureUrl` during invite claim and add a current-user sync action for missing or stale profile metadata.

**Why:** WorkOS is the external profile source for CRM users. Fetching it inside ordinary queries would add external latency and violate Convex query constraints, so sync must happen through Node actions and internal mutations.

**Where:**
- `convex/workos/userActions.ts` (modify)
- `convex/workos/userMutations.ts` (modify)
- `convex/workos/profileActions.ts` (new)
- `convex/workos/profileMutations.ts` (new)

**How:**

**Step 1: Pass WorkOS `profilePictureUrl` through invite claim.**

```typescript
// Path: convex/workos/userActions.ts
return await ctx.runMutation(
  internal.workos.userMutations.claimInvitedAccountByEmail,
  {
    workosUserId,
    orgId,
    email,
    fullName: getDisplayName(workosUser),
    profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
    profilePictureSyncedAt: Date.now(),
  },
);
```

**Step 2: Accept and patch the optional profile fields.**

```typescript
// Path: convex/workos/userMutations.ts
export const claimInvitedAccountByEmail = internalMutation({
  args: {
    workosUserId: v.string(),
    orgId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    profilePictureUrl: v.optional(v.string()),
    profilePictureSyncedAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { workosUserId, orgId, email, fullName, profilePictureUrl, profilePictureSyncedAt },
  ) => {
    // Existing tenant + pending-user lookup stays unchanged.
    await ctx.db.patch(pendingUser._id, {
      workosUserId,
      invitationStatus: "accepted",
      fullName: pendingUser.fullName ?? fullName,
      profilePictureUrl,
      profilePictureSyncedAt,
      isActive: true,
      deletedAt: undefined,
    });

    await syncLeadGenWorkerProfile(ctx, pendingUser._id);
    return await ctx.db.get(pendingUser._id);
  },
});
```

**Step 3: Add current-user profile sync.**

```typescript
// Path: convex/workos/profileActions.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { internal } from "../_generated/api";
import { action } from "../_generated/server";
import {
  getCanonicalIdentityWorkosUserId,
  getRawWorkosUserId,
} from "../lib/workosUserId";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export const syncCurrentProfile = action({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const workosUserId = getCanonicalIdentityWorkosUserId(identity);
    if (!workosUserId) throw new Error("Missing WorkOS user ID");

    const workosUser = await workos.userManagement.getUser(
      getRawWorkosUserId(workosUserId),
    );

    return await ctx.runMutation(internal.workos.profileMutations.patchCurrentProfile, {
      workosUserId,
      email: workosUser.email,
      fullName: [workosUser.firstName, workosUser.lastName].filter(Boolean).join(" ") || undefined,
      profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
      syncedAt: Date.now(),
    });
  },
});
```

**Step 4: Patch only the authenticated user's CRM row.**

```typescript
// Path: convex/workos/profileMutations.ts
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";
import { canonicalizeWorkosUserId } from "../lib/workosUserId";

export const patchCurrentProfile = internalMutation({
  args: {
    workosUserId: v.string(),
    email: v.string(),
    fullName: v.optional(v.string()),
    profilePictureUrl: v.optional(v.string()),
    syncedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const canonicalWorkosUserId = canonicalizeWorkosUserId(args.workosUserId);
    const user = await ctx.db
      .query("users")
      .withIndex("by_workosUserId", (q) => q.eq("workosUserId", canonicalWorkosUserId))
      .unique();
    if (!user || user.isActive === false) return null;

    await ctx.db.patch(user._id, {
      email: args.email.trim().toLowerCase(),
      fullName: args.fullName ?? user.fullName,
      profilePictureUrl: args.profilePictureUrl,
      profilePictureSyncedAt: args.syncedAt,
    });

    await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
      userId: user._id,
    });

    return user._id;
  },
});
```

**Key implementation notes:**
- Keep `"use node"` isolated to action files. Do not put queries or mutations in those files.
- Do not call WorkOS from Convex queries.
- `profilePictureUrl` may be absent; absence is a normal initials fallback state.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/workos/userActions.ts` | Modify | Pass WorkOS profile image during invite claim. |
| `convex/workos/userMutations.ts` | Modify | Persist optional profile fields and resync lead-gen worker. |
| `convex/workos/profileActions.ts` | Create | Auth-derived current-user WorkOS fetch. |
| `convex/workos/profileMutations.ts` | Create | Internal CRM user profile patch. |

---

### 1D — Lead-Gen Worker Avatar Denormalization

**Type:** Backend
**Parallelizable:** Yes — independent of WorkOS action code after 1A. It owns `convex/leadGen/workers.ts`.

**What:** Include avatar fields in `syncWorkerProfileForUser` inserts and patches.

**Why:** Lead-gen reports often read `leadGenWorkers` directly. Denormalizing the avatar fields keeps those queries simple and avoids extra user reads for every worker row.

**Where:**
- `convex/leadGen/workers.ts` (modify)

**How:**

**Step 1: Dual-write avatar fields on worker insert and patch.**

```typescript
// Path: convex/leadGen/workers.ts
if (!existing) {
  return await ctx.db.insert("leadGenWorkers", {
    tenantId: user.tenantId,
    userId: user._id,
    workosUserId: user.workosUserId,
    email: user.email,
    displayName: displayNameForUser(user),
    customProfilePictureStorageId: user.customProfilePictureStorageId,
    profilePictureUrl: user.profilePictureUrl,
    isActive: shouldBeActive,
    createdAt: now,
    updatedAt: now,
  });
}

await ctx.db.patch(existing._id, {
  workosUserId: user.workosUserId,
  email: user.email,
  displayName: displayNameForUser(user),
  customProfilePictureStorageId: user.customProfilePictureStorageId,
  profilePictureUrl: user.profilePictureUrl,
  isActive: shouldBeActive,
  updatedAt: now,
});
```

**Step 2: Keep list queries stable.**

```typescript
// Path: convex/leadGen/workers.ts
export const listWorkers = query({
  args: {
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const rows = await ctx.db
      .query("leadGenWorkers")
      .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
      .take(250);

    return rows
      .filter((worker) => args.includeInactive || worker.isActive)
      .sort((a, b) => a.email.localeCompare(b.email));
  },
});
```

**Key implementation notes:**
- Do not make `leadGenWorkers` the source of truth. It mirrors CRM user profile fields.
- Existing workers pick up avatar fields when profile sync, role change, custom upload, or backfill touches their user row.
- Phase 5 can optionally run a small resync for existing lead generators after WorkOS profile backfill.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/leadGen/workers.ts` | Modify | Add avatar fields to worker profile sync. |

---

### 1E — DM Closer CRM User Link Contract

**Type:** Backend
**Parallelizable:** Yes — independent after 1A. It owns attribution settings code and can finish before UI uses the link selector.

**What:** Allow authenticated admins to link or clear a `dmClosers.userId`, while validating tenant ownership.

**Why:** DM closer rows are attribution records. Optional linking lets authenticated reports use a CRM user's avatar when there is a known match, without forcing every DM attribution person to have a login.

**Where:**
- `convex/attribution/dmClosers.ts` (modify)

**How:**

**Step 1: Add `userId` to update validators and validate tenancy.**

```typescript
// Path: convex/attribution/dmClosers.ts
export const updateDmCloser = mutation({
  args: {
    dmCloserId: v.id("dmClosers"),
    displayName: v.string(),
    utmMedium: v.string(),
    teamId: v.id("attributionTeams"),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { tenantId } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const dmCloser = await ctx.db.get(args.dmCloserId);
    if (!dmCloser || dmCloser.tenantId !== tenantId) {
      throw new Error("DM closer not found");
    }

    const linkedUser = args.userId ? await ctx.db.get(args.userId) : null;
    if (linkedUser && linkedUser.tenantId !== tenantId) {
      throw new Error("Linked user not found");
    }

    await ctx.db.patch(dmCloser._id, {
      displayName: args.displayName.trim(),
      utmMedium: args.utmMedium.trim(),
      teamId: args.teamId,
      userId: linkedUser?._id,
      updatedAt: Date.now(),
    });
  },
});
```

**Step 2: Include linked identities in authenticated list queries.**

```typescript
// Path: convex/attribution/dmClosers.ts
const linkedUser = dmCloser.userId ? await ctx.db.get(dmCloser.userId) : null;
return {
  ...dmCloser,
  identity: await dmCloserMemberIdentity(
    ctx,
    dmCloser,
    linkedUser && linkedUser.tenantId === tenantId ? linkedUser : null,
  ),
};
```

**Key implementation notes:**
- Never accept `tenantId` from the client for link validation.
- Public portal queries stay initials-only even if `userId` is set.
- Avoid retroactively auto-linking by name in this phase; that belongs in a reviewed data migration, not a hidden write.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/attribution/dmClosers.ts` | Modify | Add optional linked CRM user writes and authenticated identity payloads. |

---

### 1F — Contract Verification Gate

**Type:** Backend / Manual
**Parallelizable:** No — this closes Phase 1 and verifies the shared contract before dependent phases rely on it.

**What:** Run codegen/typecheck, inspect generated API references, and document the migration posture.

**Why:** Phase 2, Phase 3, and Phase 4 will fan out across many files. The identity contract must be stable before that parallel work starts.

**Where:**
- `plans/team-member-avatars/phases/phase1.md` (reference)
- `convex/_generated/*` (generated)

**How:**

**Step 1: Generate Convex types and run static checks.**

```bash
# Path: terminal
pnpm exec convex codegen
pnpm tsc --noEmit
```

**Step 2: Validate the widen-only migration stance.**

```typescript
// Path: convex/schema.ts
// All avatar fields remain optional permanently:
// - WorkOS users may not have profilePictureUrl.
// - Custom uploads are user-driven future state.
// - DM closers can remain attribution-only people without CRM logins.
```

**Step 3: Confirm public privacy helpers are used only in public code.**

```bash
# Path: terminal
rg "publicDmCloserIdentity|dmCloserMemberIdentity" convex/linkPortal convex/attribution convex/reporting
```

**Key implementation notes:**
- Treat any required-field change as a new migration branch with `convex-migration-helper`.
- If `ctx.storage.getUrl()` introduces unacceptable query cost later, address that in Phase 4/5 by limiting avatar display, not by persisting signed URLs.
- Record any contract changes before Phase 4 agents begin surface rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/*` | Generate | Generated by Convex codegen, not manually edited. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/lib/memberIdentity.ts` | Create | 1B |
| `convex/workos/userActions.ts` | Modify | 1C |
| `convex/workos/userMutations.ts` | Modify | 1C |
| `convex/workos/profileActions.ts` | Create | 1C |
| `convex/workos/profileMutations.ts` | Create | 1C |
| `convex/leadGen/workers.ts` | Modify | 1D |
| `convex/attribution/dmClosers.ts` | Modify | 1E |
| `convex/_generated/*` | Generate | 1F |
