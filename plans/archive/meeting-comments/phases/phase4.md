# Phase 4 — Data Migration: Notes → Comments

**Goal:** Ship an idempotent, per-tenant internal mutation (`migrateNotesToComments`) that converts each meeting's legacy `notes` string into a first entry in the `meetingComments` table, attributed to a designated system/operator user with a `[Migrated from meeting notes]` header. Execution is **operational** (one `npx convex run` command per tenant) — not shipped on a cron. This phase is **optional** for MVP: without it, the Comments card simply appears empty on historical meetings; with it, historical notes show up as the first comment.

**Prerequisite:** Phase 1 deployed (schema + `meetingComments` table exists; `Id<"meetingComments">` type available).

**Runs in PARALLEL with:** **Phase 2** and **Phase 3** — Phase 4 only touches a new file in `convex/closer/` and never modifies any existing file. No conflicts possible.

**Skills to invoke:**
- `convex-migration-helper` — standard pattern for cursored batch migrations; confirm the widen-migrate-narrow workflow isn't needed (it isn't — we're only adding new rows, not changing the schema shape).
- `convex-performance-audit` — quick check that the batch query uses `.withIndex(...)` + `.take(BATCH_SIZE)` and the scheduler continuation pattern matches the existing `reporting/backfill.ts` style.

> **Not on the critical path.** Can ship any time after Phase 1. It is intentionally **optional**: the Comments feature works correctly on historical meetings without this migration (empty state shows "No comments yet").

---

## Acceptance Criteria

1. `convex/closer/meetingCommentsMigration.ts` exists and exports an `internalMutation` named `migrateNotesToComments`.
2. The mutation accepts `{ tenantId: v.id("tenants"), systemUserId: v.id("users"), cursor?: v.optional(v.string()) }`.
3. Running `npx convex run closer/meetingCommentsMigration:migrateNotesToComments --tenantId "<tenant>" --systemUserId "<user>"` on a tenant with N meetings produces one `meetingComments` row per meeting with a non-empty `notes` field, each prefixed with `[Migrated from meeting notes]\n\n`.
4. The mutation is **idempotent**: running it a second time on the same tenant produces zero additional rows (meetings with existing comments are skipped).
5. The mutation is **batched**: it processes up to `BATCH_SIZE` (100) meetings per invocation and schedules itself for continuation via `ctx.scheduler.runAfter(0, ...)` if the batch was full.
6. The continuation uses a cursor-based scan of the `meetings` table via `.paginate()` — no meetings are skipped or double-processed across batch boundaries.
7. The mutation logs progress to console with a `[Migration]` tag including `tenantId`, `migrated` count, and batch size.
8. `pnpm tsc --noEmit` passes.
9. An operational runbook exists at `plans/meeting-comments/phases/phase4.md` (this file, §Runbook) describing the exact commands to run per tenant.
10. If `meeting.notes` is whitespace-only or empty, the meeting is skipped (no empty comment created).

---

## Subphase Dependency Graph

```
Phase 1 deployed ──┐
                   │
                   ├── 4A (migration internal mutation) ──┐
                   │                                      │
                   └── 4B (operational runbook) ──────────┤── Phase 4 ✓ (optional)
                                                          │
                                                          │
                          (4C — future Calendly webhook redirect) ─── deferred, not in this phase
```

**Optimal execution:**
- 4A and 4B can be written in parallel.
- Actual **execution** of the migration per tenant is an operational step (one command per tenant) — not part of "shipping" the phase.
- Skip or run later as product needs dictate. Does not block Phase 3.

**Estimated time:** 0.5 day to write + test the mutation on a single tenant. Execution per tenant is minutes.

---

## Subphases

### 4A — `migrateNotesToComments` Internal Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of everything. Touches a new file only.

**What:** A cursored, idempotent `internalMutation` that scans `meetings` for a tenant, finds ones with non-empty `notes` and no existing comments, and inserts a "migrated from notes" comment authored by a caller-supplied `systemUserId`.

**Why:** Operators can convert historical notepad data without manual SQL. Idempotency + cursor-based batching match the established pattern in `convex/reporting/backfill.ts`.

**Where:**
- `convex/closer/meetingCommentsMigration.ts` (new)

**How:**

**Step 1: Scaffold the file.**

```typescript
// Path: convex/closer/meetingCommentsMigration.ts

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalMutation } from "../_generated/server";

const BATCH_SIZE = 100;

/**
 * Backfill: convert legacy `meetings.notes` content into a first comment on
 * each meeting in the target tenant. Safe to run multiple times.
 *
 * Usage (per tenant):
 *   npx convex run closer/meetingCommentsMigration:migrateNotesToComments \
 *     --tenantId "<tenantId>" \
 *     --systemUserId "<userId>"
 *
 * Why `internalMutation`: prevents accidental calls from the client. Only
 * callable from the Convex CLI or another internal function.
 *
 * Design: see plans/meeting-comments/phases/phase4.md and design §7.
 */
export const migrateNotesToComments = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    systemUserId: v.id("users"),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { tenantId, systemUserId, cursor }) => {
    // Paginated scan of meetings for this tenant.
    const page = await ctx.db
      .query("meetings")
      .withIndex("by_tenantId_and_scheduledAt", (q) =>
        q.eq("tenantId", tenantId),
      )
      .paginate({
        cursor: cursor ?? null,
        numItems: BATCH_SIZE,
      });

    let migrated = 0;
    let skippedEmpty = 0;
    let skippedExisting = 0;

    for (const meeting of page.page) {
      const trimmed = meeting.notes?.trim();
      if (!trimmed || trimmed.length === 0) {
        skippedEmpty++;
        continue;
      }

      // Idempotency: skip if this meeting already has any comment.
      const existing = await ctx.db
        .query("meetingComments")
        .withIndex("by_meetingId_and_createdAt", (q) =>
          q.eq("meetingId", meeting._id),
        )
        .first();
      if (existing) {
        skippedExisting++;
        continue;
      }

      await ctx.db.insert("meetingComments", {
        tenantId,
        meetingId: meeting._id,
        authorId: systemUserId,
        content: `[Migrated from meeting notes]\n\n${trimmed}`,
        // Use the meeting's own createdAt so the migrated comment sits at
        // the top of the thread chronologically.
        createdAt: meeting.createdAt,
      });
      migrated++;
    }

    console.log(
      "[Migration] migrateNotesToComments | tenantId=%s batch=%d migrated=%d skippedEmpty=%d skippedExisting=%d isDone=%s",
      tenantId,
      page.page.length,
      migrated,
      skippedEmpty,
      skippedExisting,
      page.isDone,
    );

    // Schedule continuation if more pages remain.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(
        0,
        internal.closer.meetingCommentsMigration.migrateNotesToComments,
        {
          tenantId,
          systemUserId,
          cursor: page.continueCursor,
        },
      );
    }

    return {
      batchSize: page.page.length,
      migrated,
      skippedEmpty,
      skippedExisting,
      isDone: page.isDone,
    };
  },
});
```

**Step 2: Test on a single tenant in the test environment.**

```bash
# Set up a test meeting with notes first (either via the Calendly flow or
# manually in the dashboard), then run:
npx convex run closer/meetingCommentsMigration:migrateNotesToComments \
  --tenantId "<test-tenant-id>" \
  --systemUserId "<operator-user-id>"
```

**Step 3: Verify idempotency.**

Run the same command a second time. The log should show `migrated=0 skippedExisting=<N>`.

**Step 4: `pnpm tsc --noEmit`.**

**Key implementation notes:**
- **Why `.paginate()` not `.take(BATCH_SIZE)` with offset math**: Convex documents paginate reliably across scheduled continuations; `.take()` with manual cursor tracking is error-prone. The `reporting/backfill.ts` file uses the same pagination pattern — we're aligning with it.
- **`cursor` arg uses `v.union(v.string(), v.null())`** to match the shape Convex's `.paginate()` returns for `continueCursor`. Initial invocation passes `null` / `undefined`.
- **`internal.closer.meetingCommentsMigration.migrateNotesToComments` self-reference**: the `internal` import from `_generated/api` makes this type-safe and avoids the `@ts-expect-error` hack shown in the design (which was a placeholder — we can do better).
- **`createdAt: meeting.createdAt`** (not `Date.now()`) — anchors the migrated comment chronologically at the meeting's creation time, so the thread reads in historical order when other comments are added later.
- **Soft-delete check**: not needed here. The idempotency check (`.first()`) finds **any** existing comment, deleted or not. If an admin deletes the first comment and then re-runs migration, we intentionally do **not** recreate it — the delete was authoritative.
- **Rate limit**: 100 per batch × immediate scheduler continuation. For the current test tenant (expected dozens of meetings, not thousands) this completes in a single batch. Scales linearly for production tenants.
- **Not on the critical path**: can be deployed any time after Phase 1. Recommend shipping alongside Phase 3 so it's ready when operators want to run it.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingCommentsMigration.ts` | Create | Internal mutation only. Not exposed to clients. |

**Side effects:**
- **When executed**: inserts rows into `meetingComments`. No other tables touched. `meetings.notes` is **not** cleared — that cleanup belongs to the future schema-field-removal task.
- **When not executed**: zero effect. The migration just sits there until an operator runs it.

---

### 4B — Operational Runbook

**Type:** Documentation / Manual
**Parallelizable:** Yes — independent of 4A.

**What:** Document the exact commands to run per tenant when rolling out the migration, including how to identify the correct `systemUserId`.

**Why:** `internalMutation` can't be called from the UI. Operators need a precise script.

**Where:**
- Appended to `plans/meeting-comments/phases/phase4.md` (this file — see `## Runbook` section below)

**How:** See the `## Runbook` section at the bottom of this file.

**Key implementation notes:**
- The operator picks `systemUserId` from a tenant's existing `tenant_master` or `tenant_admin` user. The designated user becomes the "author" of every migrated comment in that tenant.
- **Alternative approach** (not implemented): create a dedicated `System` user per tenant with a special role. Rejected because it requires schema changes + RBAC updates and provides no real benefit for MVP.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/meeting-comments/phases/phase4.md` | Modify | The `## Runbook` section below. |

**Side effects:** None (documentation only).

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/closer/meetingCommentsMigration.ts` | Create | 4A |
| `plans/meeting-comments/phases/phase4.md` | Modify | 4B (the Runbook section) |

---

## Cross-Phase Side Effects

| System | Effect (when migration is executed) | Mitigation |
|---|---|---|
| `meetingComments` table | One new row per non-empty `meetings.notes` per tenant. | Idempotent; safe to re-run. |
| `meetings.notes` field | **Not cleared.** Remains populated. | Intentional — the field is cleared only when the schema field is formally removed in a future migration. |
| Convex function execution limits | The scheduled-continuation pattern stays well under the 1s transaction bound. | `BATCH_SIZE = 100` matches existing `reporting/backfill.ts`. If a tenant has >10k meetings, multiple continuations chain automatically. |
| Calendly `invitee.created` webhook | Continues writing to `meetings.notes` for **new** meetings. These new notes will **not** be auto-migrated — only the one-time backfill runs. | Design Open Question #2 flags long-term redirection of the webhook to create a system comment directly. Deferred. Operators can re-run migration periodically if desired (idempotent), but this is not the intended workflow. |
| UI during execution | Reactive `getComments` queries fire on every affected meeting → users viewing a detail page during migration see the comment pop in live. | Harmless. Convex subscriptions are designed for exactly this. |
| Audit trail | Migrated comments are indistinguishable from manually-authored comments except for the `[Migrated from meeting notes]` prefix in `content`. | Accept — design decision §7.2. If a distinct `source: "migration"` field is desired later, add it via `convex-migration-helper` follow-up. |
| Existing `deletedAt` comments | Idempotency check only looks at `by_meetingId_and_createdAt` index (not filtering by `deletedAt`). | Intentional — if an admin manually deleted the only comment on a meeting, re-running migration won't resurrect the note. Respects the delete as authoritative. |
| `authorId` on migrated comments | Set to whatever user the operator passes as `systemUserId`. | Document in the runbook that this user will appear as the author on every migrated comment; pick a user representative of the tenant (usually the `tenant_master`). |

---

## Runbook

### Pre-flight checklist (per tenant)

1. **Confirm Phase 1 is deployed** on the target tenant: `meetingComments` table is visible in the Convex dashboard.
2. **Identify the operator user** for attribution. Typically the `tenant_master`. Find via:
   ```bash
   npx convex run users/queries:listByTenant --tenantId "<tenantId>"
   ```
   (Or open the Convex dashboard → `users` table → filter by `tenantId` → pick one with `role = "tenant_master"`.)
3. **Count the meetings with notes** (optional sanity check):
   ```bash
   # In the Convex dashboard function runner, run a quick query or use a
   # one-shot internal function that counts meetings where notes is non-empty.
   # For MVP: rely on the post-migration `migrated` log count.
   ```

### Execute the migration

```bash
npx convex run closer/meetingCommentsMigration:migrateNotesToComments \
  --tenantId "<tenantId>" \
  --systemUserId "<operatorUserId>"
```

Watch the logs in the Convex dashboard. Expected output:

```
[Migration] migrateNotesToComments | tenantId=<id> batch=100 migrated=87 skippedEmpty=12 skippedExisting=1 isDone=false
[Migration] migrateNotesToComments | tenantId=<id> batch=100 migrated=75 skippedEmpty=24 skippedExisting=1 isDone=false
[Migration] migrateNotesToComments | tenantId=<id> batch=43 migrated=40 skippedEmpty=3 skippedExisting=0 isDone=true
```

The `isDone=true` on the final batch indicates the scheduler chain has terminated.

### Post-migration verification

1. Open a known meeting in the UI that had notes. Confirm:
   - A single comment exists, authored by the operator.
   - Content begins with `[Migrated from meeting notes]`.
   - Timestamp matches the meeting's creation time (not "just now").
2. Re-run the migration command. Verify the logs show `migrated=0 skippedExisting=<N>` — confirms idempotency.
3. Spot-check that new comments added post-migration appear **below** the migrated one (because migrated comments are timestamped at `meeting.createdAt`).

### Rollback (if needed)

Because migration only **inserts** rows (no update/delete of existing data), rollback is straightforward:

```bash
# In the Convex dashboard function runner, bulk-delete all meetingComments
# rows where content starts with "[Migrated from meeting notes]" for the
# target tenant. This requires writing a small internalMutation at rollback
# time — not pre-shipped because rollback is unlikely.
```

No `meetings.notes` data is lost at any point — the original field remains populated for the lifetime of this phase.

---

## Verification Checklist (before closing Phase 4)

- [ ] `pnpm tsc --noEmit` passes.
- [ ] `npx convex dev` deploys cleanly with the new file.
- [ ] Test-tenant smoke run: one meeting with notes → one migrated comment visible in UI.
- [ ] Idempotency smoke: re-run on same tenant → zero new comments.
- [ ] Batch continuation smoke: seed 250+ meetings (or verify on an existing large tenant) → scheduler chains through 3 batches, final log shows `isDone=true`.
- [ ] Runbook reviewed and archived alongside the phase plan.
- [ ] Deferred task filed: "Redirect Calendly `invitee.created` webhook to create a system comment instead of writing to `meetings.notes` directly" (see Open Question #2 in design doc).
