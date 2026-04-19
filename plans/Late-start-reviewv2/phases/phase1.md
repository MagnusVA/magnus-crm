# Phase 1 — Schema & Status Transition Changes

**Goal:** Deploy the additive schema extensions (`meetings.fathomLink`, `meetings.fathomLinkSavedAt`, `meetingReviews.resolutionAction: "disputed"`) and the expanded `meeting_overran` meeting-status transitions so that every subsequent phase has typed, validated access to the new fields and transitions. After this phase, the Convex data plane is ready for v2 but no user-facing behavior has changed yet.

**Prerequisite:** Meeting Overran Review System v1 is fully deployed (`plans/late-start-review/late-start-review-design.md`) — `meetingReviews` table exists, detection scheduler is live, admin resolve pipeline is live. No prior v2 phase work required — **Phase 1 is the foundation phase; every other v2 phase depends on it.**

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on the new fields + transition map.

**Skills to invoke:**
- `convex-migration-helper` — Confirm (and document) that additive changes do NOT require a widen-migrate-narrow migration. All new fields are `v.optional`, and the `resolutionAction` change only adds a literal to an existing union — existing records remain valid.
- `convex-performance-audit` — Sanity-check that no new index is required (Fathom link is read per-meeting via the existing meeting document load; `disputed` resolutions read via existing `by_tenantId_and_status_and_createdAt` index).

**Acceptance Criteria:**
1. `npx convex dev` runs against the current deployment with **zero schema validation errors** after the new fields / union literal are added.
2. `convex/_generated/dataModel.d.ts` contains `fathomLink?: string | undefined` and `fathomLinkSavedAt?: number | undefined` on the `meetings` doc type.
3. `convex/_generated/dataModel.d.ts` `meetingReviews.resolutionAction` union type includes the literal `"disputed"`.
4. Importing `MEETING_VALID_TRANSITIONS` from `convex/lib/statusTransitions.ts` returns `meeting_overran: ["completed", "no_show"]`.
5. `validateMeetingTransition("meeting_overran", "no_show")` returns `true` in a fresh type-check.
6. `validateMeetingTransition("meeting_overran", "lost")` still returns `false` (confirms we did NOT accidentally add lost to the meeting transition map — lost is opportunity-level only).
7. Existing production `meetingReviews` records (with resolutionAction values `log_payment` / `schedule_follow_up` / `mark_no_show` / `mark_lost` / `acknowledged`) still validate against the new union — no schema push failures.
8. Existing production `meetings` records without `fathomLink` / `fathomLinkSavedAt` load cleanly — Convex treats missing optional fields as `undefined`.
9. No existing file that imports from `convex/_generated/api` or `convex/_generated/dataModel` has a type regression (`pnpm tsc --noEmit` still passes after regeneration).
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (meetings: fathomLink fields) ──────────┐
                                           │
1B (meetingReviews: disputed literal) ─────┼── 1D (deploy + regenerate types + verify)
                                           │
1C (statusTransitions: meeting_overran→no_show) ─┘
```

**Optimal execution:**
1. Start `1A`, `1B`, and `1C` in parallel — three edits against two different files (`schema.ts` for 1A+1B, `statusTransitions.ts` for 1C). 1A and 1B touch different table definitions within the same file, so they can be batched in a single commit to avoid rebase friction but are authored independently.
2. After all three edits are saved, run `1D` (single deploy + typegen + verification step) — this is the only subphase that produces cross-phase effects (new generated types).

**Estimated time:** 0.5 days (4 hours total, including Convex schema push wait time and verification).

---

## Subphases

### 1A — `meetings` Table: Add `fathomLink` and `fathomLinkSavedAt`

**Type:** Backend (schema)
**Parallelizable:** Yes — independent edit within `convex/schema.ts` but in a different table block than 1B. Does NOT depend on 1B or 1C.

**What:** Add two optional fields on the `meetings` table definition: `fathomLink: v.optional(v.string())` and `fathomLinkSavedAt: v.optional(v.number())`. No new index. No change to any existing field, status union, or index.

**Why:** The Fathom recording link is v2's primary attendance artifact for **every** meeting — not just flagged ones. Storing it on the `meetings` table (alongside `notes`, `meetingOutcome`) makes it a first-class meeting attribute. The admin review pipeline reads it from the meeting doc it already fetches; no join needed. Without these fields, `saveFathomLink` (Phase 3) and the `FathomLinkField` component (Phase 4) cannot be typed, and the admin `ReviewContextCard` (Phase 5) cannot display Fathom evidence.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Locate the `meetings` table block**

The `meetings` table is defined in `convex/schema.ts`. The `meetingOutcome` field is a stable landmark — insert the new fields directly after the `meetingOutcome` block to keep the v2 additions grouped.

**Step 2: Add the two optional fields**

```typescript
// Path: convex/schema.ts — inside the meetings table, after the meetingOutcome field

  // Feature I: Meeting outcome classification tag (existing)
  meetingOutcome: v.optional(
    v.union(
      v.literal("interested"),
      v.literal("needs_more_info"),
      v.literal("price_objection"),
      v.literal("not_qualified"),
      v.literal("ready_to_buy"),
    ),
  ),

  // v2: Fathom recording link — proof of attendance.
  // Available on ALL meetings (not just flagged ones). The admin review
  // pipeline reads this when reviewing flagged meetings. Written by
  // convex/closer/meetingActions.ts::saveFathomLink (Phase 3).
  fathomLink: v.optional(v.string()),
  fathomLinkSavedAt: v.optional(v.number()),

  // (remaining existing fields: reassignedFromCloserId, startedAt, etc. — unchanged)
```

**Key implementation notes:**
- **Both fields are `v.optional`** — legacy meetings created before v2 simply have `undefined` for these fields, which Convex accepts on read without migration.
- **No new index.** The field is always read via the meeting document (`ctx.db.get(meetingId)` in `getMeetingDetail`, `getReviewDetail`, etc.), never queried by Fathom link value. Adding an unused index wastes storage and slows writes.
- **Do NOT add a URL-validator.** The design decision (Section 13.4 of `overhaul-v2.md`) is: Fathom links are plain strings. URL validation adds complexity without security value because any valid URL could still be non-Fathom. Admin inspection is the enforcement layer.
- **Do NOT remove or rename any existing fields.** v1 `meetingReviews` fields (`closerResponse`, `closerNote`, etc.) are being deprecated in behavior only — production data lives there.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add 2 optional fields in `meetings` table block, no index changes |

---

### 1B — `meetingReviews` Table: Add `"disputed"` Literal to `resolutionAction` Union

**Type:** Backend (schema)
**Parallelizable:** Yes — independent edit within `convex/schema.ts`, in a different table block than 1A. Batched with 1A in a single schema push for deployment efficiency.

**What:** Expand the existing `resolutionAction` `v.union(...)` on the `meetingReviews` table to include `v.literal("disputed")`. No change to any other `meetingReviews` field, no index change.

**Why:** `resolveReview` in Phase 3 needs to accept and store `"disputed"` as a resolution outcome. The Convex value validator is strict — a mutation cannot call `ctx.db.patch` with a `resolutionAction: "disputed"` value unless the schema explicitly allows it. Without this literal, the Phase 3 code will reject at the validator layer before the mutation handler even runs.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Locate the `meetingReviews` table block and its `resolutionAction` field**

The existing field currently accepts five literals:

```typescript
// Path: convex/schema.ts — BEFORE
resolutionAction: v.optional(
  v.union(
    v.literal("log_payment"),
    v.literal("schedule_follow_up"),
    v.literal("mark_no_show"),
    v.literal("mark_lost"),
    v.literal("acknowledged"),
  ),
),
```

**Step 2: Add `v.literal("disputed")` as the final union member**

```typescript
// Path: convex/schema.ts — AFTER (meetingReviews table, resolutionAction field)
resolutionAction: v.optional(
  v.union(
    v.literal("log_payment"),
    v.literal("schedule_follow_up"),
    v.literal("mark_no_show"),
    v.literal("mark_lost"),
    v.literal("acknowledged"),
    v.literal("disputed"), // v2: admin disputes the closer's action → revert to meeting_overran
  ),
),
```

**Key implementation notes:**
- **Additive union change is NON-breaking.** Existing records with any of the five original values remain valid. New records can optionally store `"disputed"`.
- **Placement matters for diff readability only.** Add at the end of the union so `git blame` shows this as a pure v2 addition.
- **Do NOT remove `"acknowledged"`.** It is still a valid admin action in v2 (the "closer's outcome stands" branch).
- **Do NOT touch `closerResponse`, `closerNote`, `closerStatedOutcome`, `estimatedMeetingDurationMinutes`, or `closerRespondedAt`.** Design decision (Section 4.1 of `overhaul-v2.md`): these v1 fields are deprecated in usage but preserved in schema for backward-compatible display of legacy reviews.
- **No index change.** Existing index `by_tenantId_and_status_and_createdAt` covers all v2 queries.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add `v.literal("disputed")` to `resolutionAction` union |

---

### 1C — `statusTransitions.ts`: Add `no_show` to `meeting_overran` Transitions

**Type:** Backend (pure module)
**Parallelizable:** Yes — different file from 1A+1B, no shared imports. Can be authored first, last, or concurrently with either.

**What:** Expand `MEETING_VALID_TRANSITIONS.meeting_overran` from `["completed"]` to `["completed", "no_show"]` in `convex/lib/statusTransitions.ts`. No change to `VALID_TRANSITIONS` (opportunity transition map) — the opportunity-level `meeting_overran → no_show` transition is already valid.

**Why:** Phase 2 (`markNoShow` mutation) needs to transition the **meeting** status from `meeting_overran → no_show` when a closer marks a flagged meeting's lead as a no-show. Currently `MEETING_VALID_TRANSITIONS.meeting_overran` is `["completed"]` (admin-only false-positive correction). Without adding `"no_show"`, `validateMeetingTransition("meeting_overran", "no_show")` returns `false` and the Phase 2 mutation throws. The opportunity-level map (`VALID_TRANSITIONS`) already allows `meeting_overran → no_show`, so only the meeting-level map needs expanding.

**Where:**
- `convex/lib/statusTransitions.ts` (modify)

**How:**

**Step 1: Locate `MEETING_VALID_TRANSITIONS`**

```typescript
// Path: convex/lib/statusTransitions.ts — BEFORE (lines ~61–71)
export const MEETING_VALID_TRANSITIONS: Record<MeetingStatus, MeetingStatus[]> = {
  scheduled: ["in_progress", "completed", "meeting_overran", "canceled", "no_show"],
  in_progress: ["completed", "no_show", "canceled"],
  meeting_overran: ["completed"], // False-positive correction only (admin review)
  completed: [],
  canceled: [],
  no_show: ["scheduled"], // Webhook reversal (Calendly no-show deletion)
};
```

**Step 2: Add `"no_show"` to the `meeting_overran` entry and update the comment**

```typescript
// Path: convex/lib/statusTransitions.ts — AFTER
export const MEETING_VALID_TRANSITIONS: Record<MeetingStatus, MeetingStatus[]> = {
  scheduled: ["in_progress", "completed", "meeting_overran", "canceled", "no_show"],
  in_progress: ["completed", "no_show", "canceled"],
  // v2: Closer can mark a flagged meeting's lead as no-show directly.
  // "completed" is admin-only (false-positive correction via resolveReview).
  meeting_overran: ["completed", "no_show"],
  completed: [],
  canceled: [],
  no_show: ["scheduled"], // Webhook reversal (Calendly no-show deletion)
};
```

**Key implementation notes:**
- **Do NOT add `"lost"` or `"follow_up_scheduled"` to `meeting_overran`.** Design decision (Section 4.4 of `overhaul-v2.md`): `markAsLost` and the follow-up mutations only transition the **opportunity** status — they do not touch the meeting status. The meeting stays `meeting_overran` unless the admin corrects a false positive (→ `completed`) or the closer marks no-show (→ `no_show`). This preserves the system's observation as a permanent record on the meeting.
- **Do NOT modify `VALID_TRANSITIONS` (opportunity-level).** `VALID_TRANSITIONS.meeting_overran` already contains `["payment_received", "follow_up_scheduled", "no_show", "lost"]`. Phase 2 mutations (`markAsLost`, `markNoShow`, `logPayment`) use the opportunity-level map. `follow_up_scheduled` is present but will be **bypassed** by Phase 2's skip-transition logic — we leave the transition technically valid so `validateTransition` checks in the follow-up mutations pass, but the actual `ctx.db.patch({status: "follow_up_scheduled"})` call is short-circuited.
- **Do NOT add dispute-reversal transitions.** Reverse transitions (`no_show → meeting_overran`, `lost → meeting_overran`, `payment_received → meeting_overran`) are **admin overrides** executed directly in `resolveReview` (Phase 3), bypassing `validateTransition`. This is intentional — any code path attempting a reverse transition must be explicit.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | Add `"no_show"` to `MEETING_VALID_TRANSITIONS.meeting_overran` |

---

### 1D — Deploy Schema + Regenerate Types + Verification

**Type:** Manual (deploy + smoke-check)
**Parallelizable:** No — must run AFTER 1A, 1B, and 1C are saved. Produces the generated types every other phase imports.

**What:** Run `npx convex dev` to push the schema change to the dev deployment, regenerate `convex/_generated/*`, and smoke-verify the new types and transitions. No code authored in this subphase — pure deploy + check.

**Why:** Convex generates `dataModel.d.ts` and `api.d.ts` from `schema.ts`. Until `npx convex dev` regenerates these files, any new subphase that imports `Doc<"meetings">` will NOT see `fathomLink`, and any code referencing `"disputed"` as a resolution action will not type-check. This subphase is the single synchronization point before Phases 2, 3, 4, 5, 6 can proceed.

**Where:**
- No file edits. Terminal commands + manual verification.

**How:**

**Step 1: Run `npx convex dev` in a dedicated terminal**

```bash
# From repo root:
npx convex dev
```

Wait for:
```
✓ Schema validation succeeded
✓ Deployed to <deployment-name>
```

If you see `✗ Schema validation failed: existing documents don't match schema`, stop. That indicates either (a) you accidentally made a **non-additive** change (e.g., renamed a field, tightened a type) or (b) existing records violate the new union — in which case invoke the `convex-migration-helper` skill and apply a widen-migrate-narrow flow. For this phase, the additive changes should validate without migration.

**Step 2: Verify generated types**

After `npx convex dev` completes, inspect the regenerated files:

```bash
# Expected lines in convex/_generated/dataModel.d.ts (inside the Doc<"meetings"> type)
#   fathomLink?: string;
#   fathomLinkSavedAt?: number;
```

```bash
# Expected literal in convex/_generated/dataModel.d.ts (inside Doc<"meetingReviews">.resolutionAction)
#   | "disputed"
```

If the generated file doesn't contain the new types, re-run `npx convex dev` and watch for errors in the terminal.

**Step 3: Smoke-check transitions in a test file (optional but recommended)**

Create a throwaway file `scratch/phase1-verify.ts` at the repo root (NOT committed) that imports and logs the new transition:

```typescript
// Path: scratch/phase1-verify.ts (gitignored / temporary)
import {
  MEETING_VALID_TRANSITIONS,
  validateMeetingTransition,
  validateTransition,
} from "../convex/lib/statusTransitions";

console.log("meeting_overran transitions:", MEETING_VALID_TRANSITIONS.meeting_overran);
// Expected: ["completed", "no_show"]

console.log("meeting_overran → no_show:", validateMeetingTransition("meeting_overran", "no_show"));
// Expected: true

console.log("meeting_overran → lost (meeting-level):", validateMeetingTransition("meeting_overran", "lost" as never));
// Expected: false — lost is opportunity-only

console.log("meeting_overran → no_show (opp-level):", validateTransition("meeting_overran", "no_show"));
// Expected: true (already valid before v2 — sanity check)
```

Run with `pnpm tsx scratch/phase1-verify.ts` (or similar). Delete the file after verification.

**Step 4: Confirm no existing code regressed**

```bash
pnpm tsc --noEmit
```

Expected: zero errors. Any new error at this stage is likely a dangling reference to a renamed / removed field — but since we only **added** fields and union members, this should pass cleanly.

**Step 5: Commit schema push**

Once the three preceding subphases and verification succeed, commit the changes together:

```bash
git add convex/schema.ts convex/lib/statusTransitions.ts
git commit -m "feat(schema): add fathom link fields, disputed resolution, meeting_overran→no_show transition"
```

(Do **not** commit `convex/_generated/*` manually — it regenerates on every `npx convex dev`. It is tracked in git by Convex's convention; if your project commits generated files, include them, but never hand-edit them.)

**Key implementation notes:**
- **Convex dev server must be running for subsequent phases.** Phase 2+ depend on the regenerated `api.ts`. Keep `npx convex dev` running in a background terminal.
- **`pnpm tsc --noEmit` is the primary quality gate.** If it passes after Phase 1, no downstream file has stale type imports.
- **If the schema push fails for existing-document reasons**, immediately invoke `convex-migration-helper`. Do NOT force-delete records. The widen-migrate-narrow flow preserves data integrity.
- **The system-admin tenant has exactly 1 test tenant in production (per AGENTS.md).** Even so, treat the dev deployment as production-adjacent. Confirm the local dev instance is pointed at the non-production Convex deployment before pushing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/dataModel.d.ts` | Regenerated | Output of `npx convex dev` — do not hand-edit |
| `convex/_generated/api.d.ts` | Regenerated | Output of `npx convex dev` — do not hand-edit |
| `scratch/phase1-verify.ts` | Temporary | Optional smoke-check file, delete after use |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/schema.ts` | Modify | 1A (meetings table: fathomLink + fathomLinkSavedAt) + 1B (meetingReviews table: disputed literal) |
| `convex/lib/statusTransitions.ts` | Modify | 1C (MEETING_VALID_TRANSITIONS.meeting_overran) |
| `convex/_generated/dataModel.d.ts` | Regenerated | 1D (Convex typegen) |
| `convex/_generated/api.d.ts` | Regenerated | 1D (Convex typegen) |

**Post-phase state:** Convex deployment accepts all new fields and the `"disputed"` literal. `MEETING_VALID_TRANSITIONS.meeting_overran` permits `no_show`. `pnpm tsc --noEmit` passes. No user-visible change. Phases 2, 3, 4, 5, 6 are unblocked.

**Critical path:** This phase is on the critical path. Every v2 subphase imports from `convex/_generated/*` or reads `MEETING_VALID_TRANSITIONS`. Run immediately at project kickoff.
