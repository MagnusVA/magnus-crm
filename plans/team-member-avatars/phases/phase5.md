# Phase 5 — Backfill and Verification

**Goal:** Backfill existing active CRM users' WorkOS `profilePictureUrl` values, verify custom upload/storage behavior, and prove every avatar surface keeps privacy and fallback guarantees. After this phase, the production test tenant can safely use avatars across the workspace.

**Prerequisite:** Phase 1 schema and WorkOS sync code are deployed. Phase 3 upload controls are complete. Phase 4 surface rollout is complete enough for route-level QA. `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` exist in the Convex environment used for backfill.

**Runs in PARALLEL with:** Phase 4 implementation for 5A/5B only. Production backfill execution and route QA wait for Phase 4 merge to avoid verifying stale surfaces.

**Skills to invoke:**
- `convex-migration-helper` — dry-run backfill, resumable batch planning, production verification, and rollback posture.
- `workos` — User API fetch behavior and rate-limit caution.
- `convex-performance-audit` — verify avatar enrichment does not create unacceptable read amplification.
- `web-design-guidelines` — final accessibility, responsive, and dark-mode avatar QA.
- `browser:browser` — local route smoke tests after implementation, if a dev server is running.

**Acceptance Criteria:**
1. Backfill action skips pending invite placeholder users and inactive/deleted users.
2. Backfill runs in bounded batches and schedules continuation with `ctx.scheduler.runAfter(0, ...)` when more rows remain.
3. Backfill supports `dryRun: true` and returns counts for scanned, skipped, updated, unchanged, failed, and next-cursor state.
4. WorkOS calls occur only in Node actions; mutations patch stored fields and never call WorkOS directly.
5. Running the backfill updates existing active users' `profilePictureUrl` and `profilePictureSyncedAt` where WorkOS returns data.
6. Existing and future lead-gen worker rows mirror avatar fields after profile sync/backfill.
7. Public DM portal verification proves no image URL or CRM email leaks in public bootstrap payloads.
8. Manual QA covers owner/admin, closer, lead_generator, Slack-only, linked DM closer, unlinked DM closer, pending invite, removed user, broken image, dark mode, and mobile fallback states.
9. Verification results and any deferred surfaces are recorded in a release checklist or rollout note.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
5A (backfill internals) ───────────┬── 5B (dry-run/run commands) ────────┐
                                   │                                     ├── 5E (production execution)
Phase 4 streams complete ──────────┼── 5C (static + privacy checks) ────┤
                                   └── 5D (manual QA matrix) ───────────┘

5C + 5D + 5E complete ─────────────────────────────────────────────────── 5F (release decision)
```

**Optimal execution:**
1. Build 5A and 5B while Phase 4 is still in progress; they touch `convex/workos/*` and planning docs, not UI files.
2. Start 5C after Phase 4 merges so searches inspect the final public/workspace payloads.
3. Run 5D manual QA in parallel with 5E production test-tenant backfill, but keep a single owner for data verification.
4. Finish with 5F, recording ship/hold evidence and rollback notes.

**Estimated time:** 1.5-3 days

---

## Subphases

### 5A — Resumable WorkOS Profile Backfill

**Type:** Backend
**Parallelizable:** Yes — can run while Phase 4 UI streams continue because it owns WorkOS backfill files.

**What:** Add a bounded internal action and internal mutation pair for existing active CRM user profile picture sync.

**Why:** Production currently has users without `profilePictureUrl`. Backfill should be dry-runnable, resumable, and rate-limit aware even though the test tenant is small.

**Where:**
- `convex/workos/profileBackfill.ts` (new)
- `convex/workos/profileBackfillQueries.ts` (new)
- `convex/workos/profileMutations.ts` (modify)

**How:**

**Step 1: Add a patch mutation that is safe for batched backfill.**

```typescript
// Path: convex/workos/profileMutations.ts
import { internal } from "../_generated/api";

export const patchBackfilledProfile = internalMutation({
  args: {
    userId: v.id("users"),
    profilePictureUrl: v.optional(v.string()),
    syncedAt: v.number(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.isActive === false) return { status: "skipped" as const };
    if (user.workosUserId.startsWith("pending:")) return { status: "skipped" as const };

    if (args.dryRun) {
      return {
        status: user.profilePictureUrl === args.profilePictureUrl ? "unchanged" : "would_update",
      } as const;
    }

    await ctx.db.patch(user._id, {
      profilePictureUrl: args.profilePictureUrl,
      profilePictureSyncedAt: args.syncedAt,
    });

    await ctx.runMutation(internal.leadGen.workers.syncWorkerProfileForUser, {
      userId: user._id,
    });

    return { status: "updated" as const };
  },
});
```

**Step 2: Add a V8 internal query that pages through users.**

```typescript
// Path: convex/workos/profileBackfillQueries.ts
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";

const batchSize = 10;

export const listUsersForProfileBackfill = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_tenantId_and_isActive", (q) =>
        q.eq("tenantId", args.tenantId).eq("isActive", true),
      )
      .paginate({ cursor: args.cursor, numItems: batchSize });
  },
});
```

**Step 3: Add a Node action that calls WorkOS and schedules continuation.**

```typescript
// Path: convex/workos/profileBackfill.ts
"use node";

import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import { getRawWorkosUserId } from "../lib/workosUserId";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID!,
});

export const backfillUserProfilePictures = internalAction({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const page = await ctx.runQuery(
      internal.workos.profileBackfillQueries.listUsersForProfileBackfill,
      { tenantId: args.tenantId, cursor: args.cursor },
    );

    const result = {
      scanned: 0,
      skipped: 0,
      updated: 0,
      unchanged: 0,
      failed: 0,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };

    for (const user of page.page) {
      result.scanned += 1;
      if (user.workosUserId.startsWith("pending:")) {
        result.skipped += 1;
        continue;
      }

      try {
        const workosUser = await workos.userManagement.getUser(
          getRawWorkosUserId(user.workosUserId),
        );
        const patch = await ctx.runMutation(
          internal.workos.profileMutations.patchBackfilledProfile,
          {
            userId: user._id,
            profilePictureUrl: workosUser.profilePictureUrl ?? undefined,
            syncedAt: Date.now(),
            dryRun: args.dryRun,
          },
        );
        if (patch.status === "updated" || patch.status === "would_update") result.updated += 1;
        if (patch.status === "unchanged") result.unchanged += 1;
        if (patch.status === "skipped") result.skipped += 1;
      } catch (error) {
        console.warn("[WorkOS:ProfileBackfill] failed user", {
          userId: user._id,
          error: error instanceof Error ? error.message : String(error),
        });
        result.failed += 1;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.workos.profileBackfill.backfillUserProfilePictures,
        {
          tenantId: args.tenantId,
          cursor: page.continueCursor,
          dryRun: args.dryRun,
        },
      );
    }

    return result;
  },
});
```

**Key implementation notes:**
- Actions cannot use `ctx.db`; use an internal query for paging and an internal mutation for patching.
- Do not export queries or mutations from the `"use node"` action file.
- `paginate` returns a cursor and keeps batches bounded.
- Keep `dryRun` and production execution using the same code path.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/workos/profileBackfill.ts` | Create | Bounded WorkOS profile backfill action. |
| `convex/workos/profileBackfillQueries.ts` | Create | V8 internal query for bounded user pages. |
| `convex/workos/profileMutations.ts` | Modify | Add backfill patch mutation. |

---

### 5B — Backfill Runbook and Dry-Run Commands

**Type:** Manual / Backend
**Parallelizable:** Yes — can be written while 5A is implemented.

**What:** Document exact dry-run, production run, monitoring, and verification commands.

**Why:** The production tenant is small but real. Backfill should be reproducible and auditable before it modifies profile fields.

**Where:**
- `plans/team-member-avatars/phases/profile-backfill-runbook.md` (new)

**How:**

**Step 1: Create the runbook.**

```bash
# Path: terminal
pnpm exec convex run internal.workos.profileBackfill.backfillUserProfilePictures \
  '{"tenantId":"<tenantId>","cursor":null,"dryRun":true}'
```

**Step 2: Production execution command.**

```bash
# Path: terminal
pnpm exec convex run internal.workos.profileBackfill.backfillUserProfilePictures \
  '{"tenantId":"<tenantId>","cursor":null,"dryRun":false}'
```

**Step 3: Data spot checks.**

```bash
# Path: terminal
pnpm exec convex data users
pnpm exec convex data leadGenWorkers
pnpm exec convex logs
```

**Key implementation notes:**
- Record dry-run counts before running `dryRun: false`.
- Do not run against all tenants unless product explicitly asks; the app currently has one production test tenant.
- If failures repeat for the same WorkOS user, skip that user and record it in release notes rather than blocking all rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/profile-backfill-runbook.md` | Create | Operational runbook and evidence template. |

---

### 5C — Static, Privacy, and Performance Checks

**Type:** Full-Stack / QA
**Parallelizable:** Yes — can run after Phase 4 merges and in parallel with manual role QA.

**What:** Run typecheck/codegen, targeted static searches, public payload privacy checks, and Convex read-cost review.

**Why:** Avatar rollout touches many modules. Static searches catch accidental raw storage exposure, public image leaks, and leftover one-off avatar rendering.

**Where:**
- `convex/**` (verify)
- `app/workspace/**` (verify)
- `app/dm-links/**` (verify)

**How:**

**Step 1: Run generated and static checks.**

```bash
# Path: terminal
pnpm exec convex codegen
pnpm tsc --noEmit
```

**Step 2: Search for public leaks.**

```bash
# Path: terminal
rg "profilePictureUrl|customProfilePictureStorageId|avatarUrl|email" convex/linkPortal app/dm-links
```

**Step 3: Search for duplicate manual avatar code.**

```bash
# Path: terminal
rg "AvatarImage|AvatarFallback|rounded-full.*initial|authorName|actorName|closerName" app/workspace
```

**Step 4: Audit high-read routes.**

```bash
# Path: terminal
pnpm exec convex logs
```

**Key implementation notes:**
- Some `AvatarImage`/`AvatarFallback` references are expected inside shared components only.
- Report any query that calls `ctx.storage.getUrl()` for more rows than the page actually renders.
- If a public portal search result includes image URLs or CRM email, block release.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/profile-backfill-runbook.md` | Modify | Record static/privacy evidence. |

---

### 5D — Manual Role and Surface QA Matrix

**Type:** Manual / Frontend
**Parallelizable:** Yes — can run in parallel with 5C and 5E after Phase 4 merges.

**What:** Verify avatar behavior by role, identity source, fallback state, viewport, and theme.

**Why:** Automated checks will not catch most layout and fallback regressions in dense operational UI.

**Where:**
- `/workspace/**` routes (manual)
- `/dm-links/[portalSlug]` (manual)

**How:**

**Step 1: Role matrix.**

```bash
# Path: terminal
# Verify:
# - tenant_master: all admin workspace surfaces
# - tenant_admin: all admin workspace surfaces
# - closer: closer dashboard, closer pipeline, meeting comments
# - lead_generator: capture and my-activity surfaces
```

**Step 2: Identity source matrix.**

```bash
# Path: terminal
# Verify:
# - CRM user with custom Convex image
# - CRM user with WorkOS image only
# - CRM user with initials only
# - Lead generator mirrored from CRM user
# - Slack-only user with slackUsers.avatarUrl
# - Linked DM closer
# - Unlinked DM closer
# - Pending invited user
# - Removed/historical user
# - System actor
```

**Step 3: Visual matrix.**

```bash
# Path: terminal
# Verify:
# - 390x844 mobile viewport
# - 1440px desktop viewport
# - dark mode
# - broken image fallback
# - no table row layout shift after image failure
```

**Key implementation notes:**
- Public DM portal should show initials-only circles if avatars are visible there.
- Exports/spreadsheets should remain text-only.
- Record any deferred select-menu avatar work separately from required table/card rollout.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/profile-backfill-runbook.md` | Modify | Record manual QA evidence. |

---

### 5E — Production Test-Tenant Backfill Execution

**Type:** Manual / Backend
**Parallelizable:** Yes — can run in parallel with UI QA after dry-run evidence is accepted.

**What:** Execute the backfill for the production test tenant and verify stored profile data.

**Why:** Existing active users should show WorkOS pictures where available without waiting for their next login or profile sync.

**Where:**
- Convex production deployment (manual)
- `users` and `leadGenWorkers` data (verify)

**How:**

**Step 1: Capture dry-run evidence.**

```bash
# Path: terminal
pnpm exec convex run internal.workos.profileBackfill.backfillUserProfilePictures \
  '{"tenantId":"<tenantId>","cursor":null,"dryRun":true}'
```

**Step 2: Run production backfill.**

```bash
# Path: terminal
pnpm exec convex run internal.workos.profileBackfill.backfillUserProfilePictures \
  '{"tenantId":"<tenantId>","cursor":null,"dryRun":false}'
```

**Step 3: Verify data.**

```bash
# Path: terminal
pnpm exec convex data users
pnpm exec convex data leadGenWorkers
```

**Key implementation notes:**
- If continuation is scheduled, wait for logs to show final `isDone: true` before signing off.
- Profile picture values can legitimately remain empty.
- Do not delete any WorkOS-derived fields during rollback; the fallback logic tolerates absent or stale URLs.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/profile-backfill-runbook.md` | Modify | Record production execution evidence. |

---

### 5F — Release Decision and Rollback Notes

**Type:** Manual / Full-Stack
**Parallelizable:** No — final quality gate after static checks, manual QA, and backfill complete.

**What:** Record ship/hold decision, known gaps, rollback posture, and deferred follow-ups.

**Why:** This feature touches identity presentation and persistent storage. The release record should make privacy and fallback decisions explicit.

**Where:**
- `plans/team-member-avatars/phases/release-checklist.md` (new)

**How:**

**Step 1: Create release checklist.**

```markdown
<!-- Path: plans/team-member-avatars/phases/release-checklist.md -->
# Team Member Avatars Release Checklist

## Decision

- Status: Ship / Hold
- Date:
- Tenant:

## Evidence

- Typecheck:
- Convex codegen:
- Backfill dry run:
- Backfill production run:
- Public portal privacy:
- Role QA:
- Responsive QA:

## Rollback

- Hide upload controls if storage upload has issues.
- Revert UI rendering to text labels if a surface regresses.
- Leave optional schema fields in place; do not narrow or delete data.
```

**Step 2: Document rollback behavior.**

```typescript
// Path: convex/schema.ts
// Rollback does not require removing optional avatar fields. Leaving them
// deployed is safer than deleting storage references or WorkOS metadata.
```

**Key implementation notes:**
- The rollback should not delete uploaded storage unless product asks for data removal.
- If public portal privacy fails, hold release even if workspace surfaces look correct.
- Deferred select/avatar polish should not block release if required table/card surfaces pass.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/team-member-avatars/phases/release-checklist.md` | Create | Final release evidence and rollback notes. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/workos/profileBackfill.ts` | Create | 5A |
| `convex/workos/profileBackfillQueries.ts` | Create | 5A |
| `convex/workos/profileMutations.ts` | Modify | 5A |
| `plans/team-member-avatars/phases/profile-backfill-runbook.md` | Create / Modify | 5B, 5C, 5D, 5E |
| `plans/team-member-avatars/phases/release-checklist.md` | Create | 5F |
