# Phase 1 — Decouple Outcome Actions + `markNoShow` End-Time Semantics

**Goal:** After this phase, the schema exposes attribution fields for every meeting timestamp (`startedAtSource`, `stoppedAtSource`) and for admin-entered manual times on reviews; `markNoShow` correctly pins `stoppedAt` / `completedAt` with `stoppedAtSource: "closer_no_show"`; and the three outcome mutations (`logPayment`, `markAsLost`, `transitionToFollowUp`) carry a header comment documenting the contract that they must never write meeting time fields. The system is in a state where Phases 2 and 3 can proceed in parallel without schema drift risk.

**Prerequisite:** v0.6 time-tracking schema already deployed (`meetings.startedAt`, `stoppedAt`, `completedAt`, `lateStartDurationMs`, `exceededScheduledDurationMs`, `overranDetectedAt`, `reviewId`, `fathomLink`) and the `meetingReviews` table exists with the current resolution fields. No outstanding schema migrations in flight.

**Runs in PARALLEL with:** Nothing. This is the foundation phase — Phases 2 and 3 both depend on the new schema fields added here.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 2 || Phase 3). Start 1A first because every other subphase in the feature transitively depends on the generated types from the schema deploy.

**Skills to invoke:**
- `convex-migration-helper` — only if the schema push rejects (new fields are optional, so a plain push *should* succeed; helper is a fallback if the deploy complains).
- `convex-performance-audit` — post-deploy spot-check on `meetings` indexes to confirm no degradation from the added optional columns (none expected).

**Acceptance Criteria:**
1. `npx convex dev` runs to a clean idle state without schema validation errors after 1A is deployed.
2. `ctx.db.get(meetingId)` on any existing meeting returns a document where the two new fields (`startedAtSource`, `stoppedAtSource`) are either absent or `undefined` — existing data is untouched.
3. Calling `markNoShow` on an `in_progress` meeting patches `stoppedAt` and `completedAt` to `Date.now()` and sets `stoppedAtSource: "closer_no_show"` — verified by reading the meeting document immediately after the mutation.
4. Calling `markNoShow` on a `meeting_overran` meeting (pending review) produces the same three writes as (3).
5. The header comment block defined in §4.3 of the design doc is present at the top of `convex/closer/payments.ts`, `convex/closer/meetingActions.ts` (above `markAsLost`), and `convex/closer/followUpMutations.ts`.
6. Static grep of outcome mutations (`logPayment`, `markAsLost`, `transitionToFollowUp`) shows zero references to `startedAt`, `stoppedAt`, `completedAt` in their handler bodies.
7. `meetingReviews` records created before this phase still validate (no required fields added — all new columns are optional).
8. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (schema additions) ──────────────────────┐
                                            │
                                            ├── 1B (markNoShow mutation — needs 1A generated types)
                                            │
1C (contract header comments) ──────────────┘  (independent of 1A, pure comments)

1A complete + 1B complete + 1C complete ──→ Phase 1 done → unblocks Phase 2 || Phase 3
```

**Optimal execution:**
1. Start 1A and 1C in parallel. 1A deploys schema; 1C is pure comment insertion in three existing files, zero compile-impact.
2. Once 1A deploy is green (generated types updated), start 1B — it references `stoppedAtSource` which is introduced in 1A.
3. Confirm all three subphases green, then run `pnpm tsc --noEmit` + acceptance checks.

**Estimated time:** 0.5–1 day

---

## Subphases

### 1A — Schema Additions (Attribution + Audit Fields)

**Type:** Backend
**Parallelizable:** Yes with 1C (pure comments in unrelated files); **blocks** 1B and the entire Phase 2 and Phase 3. Must deploy first.

**What:** Add two optional fields to the `meetings` table (`startedAtSource`, `stoppedAtSource`) and four optional fields to the `meetingReviews` table (`manualStartedAt`, `manualStoppedAt`, `timesSetByUserId`, `timesSetAt`).

**Why:** Every downstream mutation (Phase 1B, Phase 2A, Phase 3B) writes to these columns. Without the schema, those mutations fail validation. Because all new fields are `v.optional(...)`, existing documents validate against the new schema unchanged — no data migration required.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Locate the `meetings` table definition in `convex/schema.ts`.**

Currently near line 290, ending around line 428 with the indexes. Find the `stoppedAt` field (optional, v.number()) and add the two new source fields directly after it. Keep the block ordering: "existing time-tracking fields" → "new attribution fields" → "remaining fields" so diffs are easy to review.

```typescript
// Path: convex/schema.ts
// (inside meetings: defineTable({ ... }))
  startedAt: v.optional(v.number()),
  stoppedAt: v.optional(v.number()),

  // NEW — Phase 1A: attribution for each timestamp.
  //   "closer"           → closer pressed Start (or End) button
  //   "closer_no_show"   → closer marked no-show; stoppedAt pinned automatically
  //   "admin_manual"     → admin entered actual times during overran-review resolution
  //   "system"           → reserved for future auto-close cron (Phase 4)
  startedAtSource: v.optional(
    v.union(
      v.literal("closer"),
      v.literal("admin_manual"),
    ),
  ),
  stoppedAtSource: v.optional(
    v.union(
      v.literal("closer"),
      v.literal("closer_no_show"),
      v.literal("admin_manual"),
      v.literal("system"),
    ),
  ),

  lateStartDurationMs: v.optional(v.number()),
  exceededScheduledDurationMs: v.optional(v.number()),
  // ... existing fields continue unchanged ...
```

**Step 2: Locate the `meetingReviews` table definition** (currently ~line 471–525 in `convex/schema.ts`). Add four optional audit fields after `resolvedByUserId`. These power Phase 3's manual-time entry flow.

```typescript
// Path: convex/schema.ts
// (inside meetingReviews: defineTable({ ... }))
  status: v.union(v.literal("pending"), v.literal("resolved")),
  resolutionAction: v.optional(
    v.union(
      v.literal("log_payment"),
      v.literal("schedule_follow_up"),
      v.literal("mark_no_show"),
      v.literal("mark_lost"),
      v.literal("acknowledged"),
      v.literal("disputed"),
    ),
  ),
  resolutionNote: v.optional(v.string()),
  resolvedAt: v.optional(v.number()),
  resolvedByUserId: v.optional(v.id("users")),

  // NEW — Phase 1A: admin-entered actual meeting times.
  // Populated only when resolutionAction === "acknowledged" AND
  // closerResponse === "forgot_to_press" (see Phase 3 design §6.2).
  manualStartedAt: v.optional(v.number()),      // Unix ms
  manualStoppedAt: v.optional(v.number()),      // Unix ms
  timesSetByUserId: v.optional(v.id("users")),  // typically == resolvedByUserId
  timesSetAt: v.optional(v.number()),           // typically == resolvedAt

  // ... existing fields continue unchanged ...
```

**Step 3: Deploy.**

```bash
npx convex dev
```

Watch the terminal for any schema validation error. Because every new field is `v.optional(...)`, the deploy should succeed immediately on the test tenant's existing data. Confirm in the Convex dashboard that the `meetings` and `meetingReviews` tables show the new columns.

**Step 4: Verify generated types.**

Open `convex/_generated/dataModel.ts` after the deploy and confirm the new fields surface in the `Doc<"meetings">` and `Doc<"meetingReviews">` types. Without this, 1B will fail to typecheck.

**Key implementation notes:**
- **No existing indexes change.** Source fields are not indexed — they're attribution metadata, never queried as a filter. Adding indexes later (e.g., `by_tenantId_and_stoppedAtSource`) is a non-goal.
- **No new table created.** All additions are columns on existing tables.
- **Deploy order matters.** 1B and everything in Phases 2 and 3 reference types generated by this schema. If the push fails, all downstream work is blocked.
- **Backfill:** Not needed. Existing documents keep their current fields; the new optional columns read as `undefined` until a writer populates them.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 2 optional fields on `meetings`, 4 optional fields on `meetingReviews`. |

---

### 1B — `markNoShow` Sets End-Time + Attribution

**Type:** Backend
**Parallelizable:** No — must wait on 1A generated types. Independent of 1C (different file).

**What:** Update the `markNoShow` mutation in `convex/closer/noShowActions.ts` so that the patch that transitions the meeting to `"no_show"` also pins `stoppedAt`, `completedAt`, and `stoppedAtSource: "closer_no_show"`.

**Why:** Currently (`convex/closer/noShowActions.ts:87–95`) the mutation writes only `status`, `noShowMarkedAt`, `noShowWaitDurationMs`, `noShowReason`, `noShowNote`, `noShowMarkedByUserId`, `noShowSource`. The meeting-level time-tracking columns are left `undefined`. The design §4.2 specifies that no-show is the single legitimate case for programmatic end-time: the closer was physically waiting in the meeting for the full duration, so `stoppedAt = now` is a faithful record. Without this change, aggregations that rely on `stoppedAt` show nulls for every no-show, and Phase 3's admin review UI cannot display a meaningful duration for resolved no-shows.

**Where:**
- `convex/closer/noShowActions.ts` (modify — `markNoShow` handler only)

**How:**

**Step 1: Locate the patch block.** In `markNoShow` (starting at line 39), find the `ctx.db.patch(meetingId, { ... })` call around line 87. It currently looks like:

```typescript
// Path: convex/closer/noShowActions.ts — BEFORE
await ctx.db.patch(meetingId, {
  status: "no_show",
  noShowMarkedAt: now,
  noShowWaitDurationMs: waitDurationMs,
  noShowReason: reason,
  noShowNote: normalizedNote,
  noShowMarkedByUserId: userId,
  noShowSource: "closer",
});
```

**Step 2: Add the three new fields.** Replace the block above with:

```typescript
// Path: convex/closer/noShowActions.ts — AFTER
await ctx.db.patch(meetingId, {
  status: "no_show",
  // NEW — Phase 1B: pin end-time attribution.
  // The closer waited in the meeting the entire duration, so stoppedAt = now
  // is an accurate record. This is the single exception to the "outcome
  // mutations MUST NOT write meeting time fields" contract (see header comment
  // block in payments.ts / meetingActions.ts / followUpMutations.ts).
  stoppedAt: now,
  completedAt: now,
  stoppedAtSource: "closer_no_show" as const,
  // (startedAtSource is not touched here — it was set by startMeeting if the
  // closer pressed Start, or stays undefined for webhook-driven no-shows.)
  noShowMarkedAt: now,
  noShowWaitDurationMs: waitDurationMs,
  noShowReason: reason,
  noShowNote: normalizedNote,
  noShowMarkedByUserId: userId,
  noShowSource: "closer",
});
```

**Step 3: Confirm the log line.** The final `console.log` already includes `waitDurationMs`. Optionally extend to include the new attribution so the Phase 1 behaviour is auditable at a glance:

```typescript
// Path: convex/closer/noShowActions.ts — near line 138
console.log("[Closer:NoShow] markNoShow completed", {
  meetingId,
  opportunityId: opportunity._id,
  closerId: userId,
  reason,
  waitDurationMs,
  stoppedAt: now,                    // NEW
  stoppedAtSource: "closer_no_show", // NEW
});
```

**Step 4: Regenerate types + verify.**

```bash
# Convex dev is typically already running; it re-generates on save.
pnpm tsc --noEmit
```

**Step 5: Manual smoke test** (optional but recommended). In the Convex dashboard:
1. Find a test meeting in `in_progress` status.
2. Run `markNoShow` with args `{ meetingId: "...", reason: "no_response", note: "smoke test" }`.
3. Re-fetch the meeting. Confirm `stoppedAt` ≈ `Date.now()`, `completedAt` == `stoppedAt`, `stoppedAtSource === "closer_no_show"`.

**Key implementation notes:**
- **Why not also set `startedAtSource`?** If the closer pressed Start before waiting, `startMeeting` already set `startedAt` and will set `startedAtSource: "closer"` in Phase 2A. For webhook-driven no-shows (rare path where `meeting.status === "scheduled"` → `"no_show"` direct via Calendly), `startedAt` stays undefined — correct behaviour. Do not touch `startedAtSource` in this subphase.
- **The `waitDurationMs` computation is unchanged.** It still uses `meeting.startedAt` as the anchor when set. This is correct — the wait duration is "time between the closer pressing Start and marking no-show", not "time between `scheduledAt` and marking".
- **The `as const` type assertion on `stoppedAtSource`** is required because the validator uses `v.union(v.literal(...))` and TypeScript widens string literals to `string` by default. Without `as const`, the patch fails typecheck.
- **No new domain event type is needed** — the existing `meeting.no_show` event is emitted after this patch. The event metadata could be extended to include `stoppedAtSource`, but that is out of scope for this subphase (add in Phase 3 if the analytics need it).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/noShowActions.ts` | Modify | Add `stoppedAt`, `completedAt`, `stoppedAtSource` to the `markNoShow` patch block. Extend log. |

---

### 1C — Contract Header Comments on Outcome Mutations

**Type:** Backend (documentation)
**Parallelizable:** Yes with 1A and 1B — pure comment additions, zero TypeScript impact.

**What:** Add the "OUTCOME MUTATION CONTRACT" header comment block (design §4.3) to the top of three files: `convex/closer/payments.ts`, `convex/closer/meetingActions.ts` (immediately above the `markAsLost` handler), and `convex/closer/followUpMutations.ts`.

**Why:** The current code is correct — none of these mutations write meeting time fields — but the invariant is only implicit. A future contributor looking at `logPayment` might reasonably think "we should also stamp `completedAt` here since the closer is done with the call". The header comment makes the contract explicit, documents the single exception (`markNoShow`), and names the one legitimate end-of-call UI affordance (`stopMeeting` — wired in Phase 2). This subphase is cheap insurance against regression.

**Where:**
- `convex/closer/payments.ts` (modify — header)
- `convex/closer/meetingActions.ts` (modify — comment above `markAsLost`, NOT at file top, since this file also contains `startMeeting`/`stopMeeting` which *do* write time fields)
- `convex/closer/followUpMutations.ts` (modify — header)

**How:**

**Step 1: `convex/closer/payments.ts` — top of file.**

Insert immediately after the `import` block (currently lines 1–18), above the `generateUploadUrl` mutation:

```typescript
// Path: convex/closer/payments.ts — top-of-file comment block

/**
 * OUTCOME MUTATION CONTRACT
 *
 * Outcome mutations in this file operate on the opportunity only.
 * They MUST NOT write to the following meeting fields:
 *   - meetings.startedAt / startedAtSource
 *   - meetings.stoppedAt / stoppedAtSource
 *   - meetings.completedAt
 *   - meetings.status
 *
 * Rationale: a closer may log a payment mid-call and continue the meeting
 * for several more minutes (customer follow-up question, goodbyes, etc.).
 * Only the closer knows when the meeting truly ends — that's what the
 * explicit "End Meeting" button (stopMeeting mutation) is for.
 *
 * The single exception is markNoShow (convex/closer/noShowActions.ts) —
 * because the closer was physically waiting in the meeting for the full
 * duration, stoppedAt = now is a faithful record, tagged
 * stoppedAtSource = "closer_no_show".
 */
```

**Step 2: `convex/closer/followUpMutations.ts` — top of file.**

Same comment block, inserted after the imports. Phrasing can reference follow-ups specifically:

```typescript
// Path: convex/closer/followUpMutations.ts — top-of-file comment block

/**
 * OUTCOME MUTATION CONTRACT
 *
 * Follow-up mutations in this file operate on the opportunity (and the
 * followUps table). They MUST NOT write to meeting time fields:
 *   - meetings.startedAt / startedAtSource
 *   - meetings.stoppedAt / stoppedAtSource
 *   - meetings.completedAt
 *   - meetings.status
 *
 * A closer may schedule a follow-up mid-call; the meeting itself continues
 * until the closer explicitly ends it via stopMeeting. See
 * convex/closer/payments.ts for the full contract rationale.
 */
```

**Step 3: `convex/closer/meetingActions.ts` — immediately above `markAsLost`.**

NOT at the top of this file. `startMeeting` and `stopMeeting` live here and DO write meeting time fields — that's legitimate. Put the comment directly above the `markAsLost` handler (currently around line 242):

```typescript
// Path: convex/closer/meetingActions.ts — comment immediately above markAsLost

/**
 * OUTCOME MUTATION CONTRACT (applies to markAsLost below)
 *
 * markAsLost writes only to the opportunity. It MUST NOT write to meeting
 * time fields (startedAt, stoppedAt, completedAt, startedAtSource,
 * stoppedAtSource) or change meetings.status.
 *
 * If a closer marks lost mid-call and later presses End Meeting, both
 * actions succeed correctly: the opportunity transitions to "lost",
 * then the meeting transitions to "completed" at the true end-of-call time.
 *
 * See convex/closer/payments.ts for the full contract rationale.
 */
export const markAsLost = mutation({
  // ... existing handler ...
});
```

**Step 4: Verify.**

```bash
pnpm tsc --noEmit
```

Should pass — comments have zero compile impact.

Then grep to confirm coverage:

```bash
# From Grep tool or shell:
grep -l "OUTCOME MUTATION CONTRACT" convex/closer/
# Expect three files: payments.ts, meetingActions.ts, followUpMutations.ts
```

**Key implementation notes:**
- **Do not paste a single comment block at the top of `meetingActions.ts`.** That file contains `startMeeting`, `stopMeeting` (which *do* write time fields legitimately), plus `updateMeetingNotes`, `updateMeetingOutcome`, `saveFathomLink`, and `markAsLost`. A top-of-file comment saying "never write time fields" would be inaccurate for the startMeeting/stopMeeting handlers. The comment belongs **per-handler** for `markAsLost` only.
- **Wording consistency.** All three blocks reference `convex/closer/payments.ts` as the canonical location of the full rationale. Pick one file as the source of truth so the rule isn't duplicated-and-drifted.
- **No ESLint / automated check is added.** The contract is documented, not enforced at lint time. A future hardening task could add an ESLint custom rule ("mutations in these files that patch `meetings.*At` fail lint"), but it is non-goal for v0.1.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/payments.ts` | Modify | Add top-of-file contract header. |
| `convex/closer/meetingActions.ts` | Modify | Add comment above `markAsLost` handler (not top-of-file). |
| `convex/closer/followUpMutations.ts` | Modify | Add top-of-file contract header. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A |
| `convex/closer/noShowActions.ts` | Modify | 1B |
| `convex/closer/payments.ts` | Modify | 1C |
| `convex/closer/meetingActions.ts` | Modify | 1C |
| `convex/closer/followUpMutations.ts` | Modify | 1C |

**Total files changed:** 5 (1 schema, 1 mutation behavior change, 3 comment additions).
**Deploy cost:** 1 Convex schema push (optional-field additions — zero risk).
**Generated type impact:** `Doc<"meetings">` and `Doc<"meetingReviews">` gain optional fields — downstream phases depend on these.
