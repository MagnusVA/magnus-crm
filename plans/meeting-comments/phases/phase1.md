# Phase 1 — Schema & Backend: Comments Table + Mutations

**Goal:** Ship a dedicated `meetingComments` table with three mutations (`addComment`, `editComment`, `deleteComment`) and one query (`getComments`) under `convex/closer/meetingComments.ts`. After this phase, the backend can persist and retrieve threaded comments for any meeting, with author attribution, soft-delete, and tenant/role authorization. No UI consumes this yet.

**Prerequisite:** None. The existing `meetings` / `opportunities` / `users` / `tenants` schema already provides everything the new table references. `requireTenantUser` (`convex/requireTenantUser.ts`) and `loadMeetingContext` (`convex/closer/meetingActions.ts`) already exist and are reused here.

**Runs in PARALLEL with:** Nothing — every other phase imports types generated from this schema (`Id<"meetingComments">`) or calls these mutations. 1A (schema) is the hard gate; 1B–1E run in parallel after 1A deploys.

**Skills to invoke:**
- `convex-setup-auth` — confirms the `requireTenantUser` pattern is correctly applied to the new functions (tenant isolation + role check).
- `convex-performance-audit` — quick check that indexes on `meetingComments` are named `by_<field>_and_<field>` and every query uses `.withIndex(...)` + bounded `.take(n)`.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 → Phase 3). Start immediately. All downstream phases stall until 1A deploys.

---

## Acceptance Criteria

1. `npx convex dev` completes without schema validation errors after adding the `meetingComments` table.
2. The Convex dashboard shows the new `meetingComments` table with both indexes: `by_meetingId_and_createdAt` and `by_tenantId_and_createdAt`.
3. Calling `api.closer.meetingComments.addComment` with an empty or whitespace-only `content` throws `"Comment cannot be empty"`.
4. Calling `addComment` with `content.length > 5000` throws `"Comment exceeds 5000 character limit"`.
5. Calling `addComment` as a `closer` for a meeting whose `opportunity.assignedCloserId !== userId` throws `"Not your meeting"`.
6. Calling `editComment` as a user whose `userId !== comment.authorId` throws `"You can only edit your own comments"`.
7. Calling `editComment` on a comment whose `deletedAt` is set throws `"Cannot edit a deleted comment"`.
8. Calling `deleteComment` as a `closer` throws (role check excludes closers). Calling as `tenant_admin` or `tenant_master` sets `deletedAt` on the comment (soft delete).
9. Calling `deleteComment` twice on the same comment is idempotent (second call returns without error).
10. `getComments` returns an array of enriched records containing `{ _id, content, createdAt, editedAt, authorId, authorName, authorRole, isOwn }`, with soft-deleted comments filtered out.
11. `getComments` returns `[]` (never throws) when the caller cannot access the meeting (wrong tenant or closer with no assignment).
12. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (schema — BLOCKER) ─────────────┐
                                   │
                                   ├── 1B (addComment mutation) ───┐
                                   │                               │
                                   ├── 1C (editComment mutation) ──┤
                                   │                               ├── Phase 1 complete
                                   ├── 1D (deleteComment mutation) ┤
                                   │                               │
                                   └── 1E (getComments query) ─────┘
```

**Optimal execution:**
1. Complete **1A** first. Deploy with `npx convex dev` and verify dashboard shows the new table. Nothing else can start until the Convex type generator emits `Id<"meetingComments">`.
2. After 1A deploys, start **1B, 1C, 1D, and 1E in parallel** — they live in the same new file but touch independent `export` blocks, so conflicts are trivial to merge (or the file can be split per mutation temporarily and concatenated at commit time).
3. Run `pnpm tsc --noEmit` and smoke-test each mutation in the Convex dashboard's function runner before closing the phase.

**Estimated time:** 0.5–1 day total (one developer, sequentially), or ~3 hours if 1B–1E are run concurrently by agents/devs.

---

## Subphases

### 1A — `meetingComments` Table Schema

**Type:** Backend
**Parallelizable:** No — 1B, 1C, 1D, 1E all depend on the generated `Id<"meetingComments">` type and table reference.

**What:** Add the `meetingComments` table definition to `convex/schema.ts` with two indexes.

**Why:** A separate table is mandatory — the AGENTS.md schema guidelines prohibit unbounded arrays on existing tables. Once this table is declared and deployed, `convex/_generated/dataModel.ts` exposes `Id<"meetingComments">` and `Doc<"meetingComments">`, unblocking every other subphase.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Add the new table definition to the schema.**

Add after the existing `meetings` table definition (after line 428 — the end of the meetings indexes block):

```typescript
// Path: convex/schema.ts

// ... existing meetings table ends at line 428 (.index("by_tenantId_and_assignedCloserId_and_scheduledAt", ...)) ...

// NEW — meetingComments table.
// Replaces the single-textarea meeting notes pattern with a multi-user
// threaded comment log. Soft-delete via `deletedAt`. URL auto-linking is
// applied at render time (plain text storage).
meetingComments: defineTable({
  tenantId: v.id("tenants"),
  meetingId: v.id("meetings"),
  authorId: v.id("users"),
  content: v.string(),
  createdAt: v.number(),
  editedAt: v.optional(v.number()),
  deletedAt: v.optional(v.number()),
})
  .index("by_meetingId_and_createdAt", ["meetingId", "createdAt"])
  .index("by_tenantId_and_createdAt", ["tenantId", "createdAt"]),
```

**Step 2: Deploy the schema.**

```bash
npx convex dev
```

Verify the Convex dashboard (or `npx convex dashboard`) shows `meetingComments` in the tables list with both indexes attached.

**Step 3: Confirm generated types exist.**

```bash
ls convex/_generated/dataModel.d.ts && pnpm tsc --noEmit
```

After the dev server reprocesses, `Id<"meetingComments">` and `Doc<"meetingComments">` should be importable from `@/convex/_generated/dataModel` without errors.

**Key implementation notes:**
- `tenantId` is required on every row — never trust client input; it is always copied from the authenticated user's resolved tenant in mutations.
- `content` is `v.string()` (not optional) — we enforce non-empty at the mutation level rather than the schema level, because "comment exists but is blank" is a meaningless state.
- `editedAt` is `v.optional(v.number())` — absence of this field means "never edited" and the UI uses its presence to render the `(edited)` indicator.
- `deletedAt` is `v.optional(v.number())` — the `getComments` query filters these out in memory after the indexed fetch (acceptable because we `.take(200)` and most meetings have < 20 comments).
- **Do not remove or modify** the `by_tenantId_and_meetingOutcome_and_scheduledAt` index on the `meetings` table in this phase — that cleanup is deferred to a future schema migration (see Phase 3 §3E and design §8.2).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `meetingComments` table + 2 indexes after line 428. No other tables touched. |

**Side effects (none):**
- No existing tables are modified.
- No data is migrated (Phase 4 handles notes migration).
- No indexes are dropped.

---

### 1B — `addComment` Mutation

**Type:** Backend
**Parallelizable:** Yes — depends only on 1A (schema). Independent of 1C, 1D, 1E (each is a separate `export const` in the same file).

**What:** Insert a new comment row. Validates content length, tenant isolation, and closer assignment.

**Why:** The primary write path for the entire feature. Every Phase 2 client component ultimately calls this mutation.

**Where:**
- `convex/closer/meetingComments.ts` (new)

**How:**

**Step 1: Create the file and implement the mutation.**

```typescript
// Path: convex/closer/meetingComments.ts

import { mutation, query } from "../_generated/server";
import { v } from "convex/values";
import { requireTenantUser } from "../requireTenantUser";
import { loadMeetingContext } from "./meetingActions";

const MAX_COMMENT_LENGTH = 5000;

/**
 * Append a new comment to a meeting's thread.
 *
 * Closers can only comment on their own assigned meetings (via
 * opportunity.assignedCloserId). Admins can comment on any meeting in
 * their tenant. tenantId is always derived from the authenticated user.
 */
export const addComment = mutation({
  args: {
    meetingId: v.id("meetings"),
    content: v.string(),
  },
  handler: async (ctx, { meetingId, content }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("Comment cannot be empty");
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(
        `Comment exceeds ${MAX_COMMENT_LENGTH} character limit`,
      );
    }

    // Reuses the existing helper from meetingActions.ts — same pattern as
    // updateMeetingNotes / startMeeting / stopMeeting. Throws if the
    // meeting or its opportunity are not found / wrong tenant.
    const { opportunity } = await loadMeetingContext(ctx, meetingId, tenantId);

    if (role === "closer" && opportunity.assignedCloserId !== userId) {
      throw new Error("Not your meeting");
    }

    const commentId = await ctx.db.insert("meetingComments", {
      tenantId,
      meetingId,
      authorId: userId,
      content: trimmed,
      createdAt: Date.now(),
    });

    console.log(
      "[Comments] addComment | meetingId=%s authorId=%s commentId=%s",
      meetingId,
      userId,
      commentId,
    );

    return commentId;
  },
});
```

**Step 2: Verify via the Convex dashboard function runner.**

Call `addComment` with `{ meetingId: "<valid id>", content: "hello" }` — should return a `commentId`. Call again with `content: ""` — should throw `"Comment cannot be empty"`.

**Key implementation notes:**
- We reuse `loadMeetingContext` from `meetingActions.ts` rather than re-implementing the `ctx.db.get(meeting) + ctx.db.get(opportunity) + tenant match` dance shown in the design. The helper already enforces `meeting.tenantId === tenantId` and throws a consistent error — keeps this file aligned with the rest of the closer backend.
- `trimmed` is stored, not the raw `content` — prevents accidentally saving whitespace-only content.
- `Date.now()` is acceptable inside a mutation (it becomes deterministic for the transaction).
- Log line uses the codebase's `[Module] action | k=v k=v` convention (see `requireTenantUser` and `meetingActions.ts` logs for the pattern).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingComments.ts` | Create | New file. 1B inserts the `addComment` export; 1C/1D/1E append additional exports. |

**Side effects:**
- None on existing code. New file, no imports into other modules yet (Phase 2 client components will import via `api.closer.meetingComments`).

---

### 1C — `editComment` Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of 1B, 1D, 1E. Same file, separate export.

**What:** Patch a comment's `content` + set `editedAt`. Authors only — no role elevation path.

**Why:** Users need to correct typos/mistakes. Closers especially need this because they cannot delete comments (see design §4.2) — editing is their only recovery mechanism.

**Where:**
- `convex/closer/meetingComments.ts` (modify — append)

**How:**

```typescript
// Path: convex/closer/meetingComments.ts (append after addComment)

export const editComment = mutation({
  args: {
    commentId: v.id("meetingComments"),
    content: v.string(),
  },
  handler: async (ctx, { commentId, content }) => {
    const { userId, tenantId } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    const comment = await ctx.db.get(commentId);
    if (!comment || comment.tenantId !== tenantId) {
      throw new Error("Comment not found");
    }
    if (comment.deletedAt !== undefined) {
      throw new Error("Cannot edit a deleted comment");
    }
    if (comment.authorId !== userId) {
      throw new Error("You can only edit your own comments");
    }

    const trimmed = content.trim();
    if (trimmed.length === 0) {
      throw new Error("Comment cannot be empty");
    }
    if (trimmed.length > MAX_COMMENT_LENGTH) {
      throw new Error(
        `Comment exceeds ${MAX_COMMENT_LENGTH} character limit`,
      );
    }

    await ctx.db.patch(commentId, {
      content: trimmed,
      editedAt: Date.now(),
    });

    console.log(
      "[Comments] editComment | commentId=%s authorId=%s",
      commentId,
      userId,
    );
  },
});
```

**Key implementation notes:**
- Authorship is enforced at the mutation level, not by re-checking the meeting's assignment — a closer whose meeting is reassigned can still edit historical comments they wrote.
- Tenant isolation is double-enforced: `requireTenantUser` resolves `tenantId`, then we verify `comment.tenantId === tenantId` to block cross-tenant ID guessing.
- We intentionally do **not** re-check the meeting's assignment here — an admin who wrote a comment and later lost admin role (unlikely but possible) should still be able to edit within the allowed roles.
- Returns `void`. The client relies on Convex's reactive query to re-render with the new content.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingComments.ts` | Modify | Append `editComment` export. |

**Side effects:**
- None. Pure additive backend logic.

---

### 1D — `deleteComment` Mutation

**Type:** Backend
**Parallelizable:** Yes — independent of 1B, 1C, 1E.

**What:** Soft-delete a comment by setting `deletedAt`. Only admins can call.

**Why:** Design decision (§4.2): the thread is an audit trail. Closers cannot delete (must edit to correct). Admins can remove any comment for moderation.

**Where:**
- `convex/closer/meetingComments.ts` (modify — append)

**How:**

```typescript
// Path: convex/closer/meetingComments.ts (append after editComment)

export const deleteComment = mutation({
  args: {
    commentId: v.id("meetingComments"),
  },
  handler: async (ctx, { commentId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const comment = await ctx.db.get(commentId);
    if (!comment || comment.tenantId !== tenantId) {
      throw new Error("Comment not found");
    }
    if (comment.deletedAt !== undefined) {
      return; // Idempotent: already deleted.
    }

    await ctx.db.patch(commentId, {
      deletedAt: Date.now(),
    });

    console.log(
      "[Comments] deleteComment | commentId=%s deletedBy=%s role=%s",
      commentId,
      userId,
      role,
    );
  },
});
```

**Key implementation notes:**
- The role list `["tenant_master", "tenant_admin"]` — closers are excluded by `requireTenantUser` throwing before the handler runs. This is the single source of truth; the frontend `isAdmin` check (`useRole().isAdmin`) is **UI visibility only**.
- Idempotency on `deletedAt !== undefined` prevents a wasted DB write when two admins click delete at the same time.
- We do **not** hard-delete — the row remains in the table, just filtered out by `getComments`. This preserves the audit trail (and allows a future "restore deleted comment" feature without data loss).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingComments.ts` | Modify | Append `deleteComment` export. |

**Side effects:**
- None. No existing queries or mutations reference `meetingComments` yet.

---

### 1E — `getComments` Query

**Type:** Backend
**Parallelizable:** Yes — independent of 1B, 1C, 1D.

**What:** Return all non-deleted comments for a meeting, enriched with author display name, role, and `isOwn` flag.

**Why:** The read path driving the Phase 2 UI. Convex reactive queries automatically push updates to all subscribed clients when `addComment` / `editComment` / `deleteComment` run, so no extra plumbing is needed for real-time sync.

**Where:**
- `convex/closer/meetingComments.ts` (modify — append)

**How:**

```typescript
// Path: convex/closer/meetingComments.ts (append after deleteComment)

import { getUserDisplayName } from "../reporting/lib/helpers";

export const getComments = query({
  args: {
    meetingId: v.id("meetings"),
  },
  handler: async (ctx, { meetingId }) => {
    const { userId, tenantId, role } = await requireTenantUser(ctx, [
      "closer",
      "tenant_master",
      "tenant_admin",
    ]);

    // Access gate: return [] (never throw) so the UI degrades gracefully
    // when a URL is deep-linked without permission.
    const meeting = await ctx.db.get(meetingId);
    if (!meeting || meeting.tenantId !== tenantId) {
      return [];
    }

    if (role === "closer") {
      const opportunity = await ctx.db.get(meeting.opportunityId);
      if (!opportunity || opportunity.assignedCloserId !== userId) {
        return [];
      }
    }

    // Indexed fetch, bounded to 200. Most meetings will have < 20 comments.
    const comments = await ctx.db
      .query("meetingComments")
      .withIndex("by_meetingId_and_createdAt", (q) =>
        q.eq("meetingId", meetingId),
      )
      .take(200);

    const activeComments = comments.filter((c) => c.deletedAt === undefined);

    // Batch-load author users to avoid N+1.
    const authorIds = [...new Set(activeComments.map((c) => c.authorId))];
    const authorDocs = await Promise.all(
      authorIds.map(async (id) => [id, await ctx.db.get(id)] as const),
    );
    const authorById = new Map(authorDocs);

    return activeComments.map((comment) => {
      const author = authorById.get(comment.authorId);
      return {
        _id: comment._id,
        content: comment.content,
        createdAt: comment.createdAt,
        editedAt: comment.editedAt,
        authorId: comment.authorId,
        authorName: getUserDisplayName(author),
        authorRole: author?.role,
        isOwn: comment.authorId === userId,
      };
    });
  },
});
```

**Key implementation notes:**
- Returns `[]` (not a thrown error) for unauthorized access — the parent meeting detail page already has its own "not found" handling; the comments card should degrade silently, not explode the page.
- `import { getUserDisplayName } from "../reporting/lib/helpers"` — this helper (confirmed at `convex/reporting/lib/helpers.ts` lines 11–18) returns `fullName || email || "Unknown"`. Reuse avoids duplicating the display logic across the codebase.
- `.withIndex("by_meetingId_and_createdAt", q => q.eq("meetingId", meetingId))` + `.take(200)` follows the AGENTS.md rule: always use an index, always bound. Results come back sorted by `createdAt` ascending (oldest → newest, matching conventional comment-thread order).
- In-memory `.filter(c => c.deletedAt === undefined)` is acceptable at this scale. If comment volume grows beyond ~500 per meeting we'd add a compound index; not worth it for MVP.
- `isOwn` is computed server-side — the client uses it to decide whether to show the "Edit" menu item. (Delete visibility still uses `useRole().isAdmin`.)

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingComments.ts` | Modify | Append `getComments` export + import `getUserDisplayName`. |

**Side effects:**
- None. No writes. The `reporting/lib/helpers.ts` import is read-only.

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A (add `meetingComments` table + 2 indexes) |
| `convex/closer/meetingComments.ts` | Create | 1B (`addComment`) |
| `convex/closer/meetingComments.ts` | Modify | 1C (`editComment` — append) |
| `convex/closer/meetingComments.ts` | Modify | 1D (`deleteComment` — append) |
| `convex/closer/meetingComments.ts` | Modify | 1E (`getComments` + `getUserDisplayName` import — append) |

---

## Cross-Phase Side Effects

| System | Effect | Mitigation |
|---|---|---|
| Convex schema | One new table, two new indexes | No existing tables touched. Zero migration risk. |
| `meetings.notes` field | Unchanged | Phase 4 handles migration; Calendly webhook keeps writing to it for now. |
| `meetings.meetingOutcome` field + index | Unchanged | Phase 3 deprecates the read/write code but leaves the field. |
| `_generated/api.d.ts` | Regenerated with new module `api.closer.meetingComments` | Automatic — no action needed. |
| Existing meeting queries | Unchanged | `getComments` is a standalone query; it does not modify the meeting record shape returned by other queries. |
| Reactive subscriptions | New subscription channel per meeting detail page | Only opens when Phase 2 ships `MeetingComments` — zero cost until then. |

---

## Verification Checklist (before closing Phase 1)

- [ ] `npx convex dev` completes cleanly; dashboard shows `meetingComments` table.
- [ ] `pnpm tsc --noEmit` passes.
- [ ] Function runner: `addComment` inserts a row; empty/oversized content is rejected.
- [ ] Function runner: `editComment` by non-author throws; by author succeeds; on deleted comment throws.
- [ ] Function runner: `deleteComment` by closer throws role error; by admin soft-deletes.
- [ ] Function runner: `getComments` returns enriched records with `authorName`, `authorRole`, `isOwn`, and no deleted rows.
- [ ] No linter errors on the new file.
- [ ] Commit and deploy to the test tenant before starting Phase 2.
