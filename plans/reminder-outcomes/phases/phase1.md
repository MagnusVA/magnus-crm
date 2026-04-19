# Phase 1 — Schema & Status Transition Extensions

**Goal:** Widen the opportunity state machine so `follow_up_scheduled` can terminate into `payment_received` or `lost`, and extend the `followUps` table with an optional `completionOutcome` tag so reminder outcomes can be reported distinctly from legacy "just mark it done" completions. After this phase, the Convex deployment accepts every new transition and field used in Phases 2–6, but no user-facing behaviour has changed yet.

**Prerequisite:** Nothing. Phase 1 is the foundation — every other phase imports the updated `VALID_TRANSITIONS` or the generated `Doc<"followUps">` type.

**Runs in PARALLEL with:** Nothing — all subsequent phases depend on this phase's deployed schema and transitions.

> **Critical path:** This phase is on the critical path (Phase 1 → Phase 3 → Phase 5 → Phase 6). Ship it first, ship it fast — it is a ~30-minute change that unblocks every other stream.

**Skills to invoke:**
- `convex-migration-helper` — Verify the optional `completionOutcome` field deploys cleanly against production schema validation. Because the field is optional and no backfill is required, the widen-migrate-narrow workflow collapses to a single widen step, but the skill still validates that no existing documents violate the new union.
- `convex-performance-audit` — Sanity-check that we are not adding unindexed fields that will later need an index for reporting queries (we're explicitly choosing to post-filter by `tenantId` + date range, so no index is added — document the rationale).

**Acceptance Criteria:**
1. `convex/lib/statusTransitions.ts` exports `VALID_TRANSITIONS.follow_up_scheduled` containing `["scheduled", "payment_received", "lost"]`.
2. Calling `validateTransition("follow_up_scheduled", "payment_received")` returns `true`.
3. Calling `validateTransition("follow_up_scheduled", "lost")` returns `true`.
4. Calling `validateTransition("follow_up_scheduled", "scheduled")` still returns `true` (existing Calendly re-booking path is preserved).
5. Calling `validateTransition("follow_up_scheduled", "in_progress")` still returns `false` (no accidental widening).
6. `convex/schema.ts` defines `followUps.completionOutcome` as `v.optional(v.union(...))` with the five literal values from §10.1 of the design doc.
7. `npx convex dev` starts cleanly against the current deployment — no schema validation errors against existing documents.
8. Running `ctx.db.get(<any existing completed followUp id>)` still returns a valid document (optional field, no backfill needed).
9. No existing query or mutation that writes to `followUps` now fails at runtime — the new field is optional and every current writer intentionally does not set it.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
1A (statusTransitions.ts) ──────┐
                                ├── 1C (deploy + verify)
1B (schema.ts followUps)  ──────┘
```

**Optimal execution:**
1. Start **1A** and **1B** in parallel — they touch different files with zero shared imports.
2. Once both land in the working tree, run **1C** (deploy + verify + guideline check). This is the synchronisation point that closes the phase.

**Estimated time:** 0.5 day (≈2–3 hours of wall-clock; a single focused session).

---

## Subphases

### 1A — Widen `VALID_TRANSITIONS` for `follow_up_scheduled`

**Type:** Backend
**Parallelizable:** Yes — touches only `convex/lib/statusTransitions.ts`. Independent of 1B (`convex/schema.ts`).

**What:** Add `"payment_received"` and `"lost"` to the `follow_up_scheduled` row of the `VALID_TRANSITIONS` map so the new outcome mutations in Phase 3 can transition directly from a pending manual reminder to a terminal state.

**Why:** `validateTransition` is the single choke point every status-changing mutation in this repo calls before patching an opportunity. Without this change, `logReminderPayment` and `markReminderLost` (Phase 3) would throw at the guard and the whole feature would be impossible. The transition was not previously needed because the legacy UI only supported "reminder → complete (free-text)" — the opportunity stayed in `follow_up_scheduled` forever unless a new Calendly booking arrived.

**Where:**
- `convex/lib/statusTransitions.ts` (modify)

**How:**

**Step 1: Read the current table to locate the row.**

```typescript
// Path: convex/lib/statusTransitions.ts

// BEFORE (current state — do not ship)
export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  scheduled: ["in_progress", "meeting_overran", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "no_show", "lost"],
  meeting_overran: [
    "payment_received",
    "follow_up_scheduled",
    "no_show",
    "lost",
  ],
  canceled: ["follow_up_scheduled", "scheduled"],
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"],
  // Only "scheduled" today — reminder-driven outcomes cannot terminate.
  follow_up_scheduled: ["scheduled"],
  reschedule_link_sent: ["scheduled"],
  payment_received: [],
  lost: [],
};
```

**Step 2: Widen the row. Keep the existing `"scheduled"` target — Calendly webhooks still transition `follow_up_scheduled → scheduled` when a lead re-books.**

```typescript
// Path: convex/lib/statusTransitions.ts

// AFTER — ship this
export const VALID_TRANSITIONS: Record<
  OpportunityStatus,
  OpportunityStatus[]
> = {
  scheduled: ["in_progress", "meeting_overran", "canceled", "no_show"],
  in_progress: ["payment_received", "follow_up_scheduled", "no_show", "lost"],
  meeting_overran: [
    "payment_received",
    "follow_up_scheduled",
    "no_show",
    "lost",
  ],
  canceled: ["follow_up_scheduled", "scheduled"],
  no_show: ["follow_up_scheduled", "reschedule_link_sent", "scheduled"],
  // CHANGED — reminder-driven outcomes. `"scheduled"` is preserved for the
  // Calendly re-booking path (see `convex/pipeline/inviteeCreated.ts`). The
  // two new targets are the terminal transitions called by the new
  // `logReminderPayment` and `markReminderLost` mutations in Phase 3, plus
  // the `give_up` branch of `markReminderNoResponse`.
  follow_up_scheduled: [
    "scheduled",
    "payment_received", // NEW — reminder resulted in a sale
    "lost", // NEW — reminder resulted in the lead dropping off
  ],
  reschedule_link_sent: ["scheduled"],
  payment_received: [],
  lost: [],
};
```

**Step 3: Add an inline unit-style sanity check (no new test files — we rely on the acceptance criteria + `pnpm tsc --noEmit`). Confirm nothing else in the file (`validateTransition`, `getValidNextStatuses`) needs changes — those functions read the map reflectively and pick up the new entries automatically.**

```bash
# Quick self-check in a Convex REPL or a scratch file
validateTransition("follow_up_scheduled", "payment_received") // → true
validateTransition("follow_up_scheduled", "lost")             // → true
validateTransition("follow_up_scheduled", "scheduled")        // → true (still)
validateTransition("follow_up_scheduled", "in_progress")      // → false (no accidental widening)
```

**Key implementation notes:**
- **No new status values.** We are reusing the existing `"payment_received"` and `"lost"` literals from `OpportunityStatus`. This keeps the union tight and avoids cascading into stats, aggregates, and pipeline processors.
- **Do not remove `"scheduled"`.** The Calendly `invitee.created` pipeline (`convex/pipeline/inviteeCreated.ts`) still transitions `follow_up_scheduled → scheduled` when a lead re-books. Removing it would break that flow silently.
- **Transition order is cosmetic.** The array is a set under the hood; listing `"scheduled"` first keeps diffs readable.
- **Watch for downstream consumers.** `getValidNextStatuses(status)` returns `VALID_TRANSITIONS[status]`. Anything rendering "what can this opportunity transition to?" in the admin UI will now expose these targets. For MVP this is fine — admins have no reminder UI, but if they navigate to a `follow_up_scheduled` opportunity via pipeline detail, they will see the wider set. Acceptable — backend still guards.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | Widen `follow_up_scheduled` row to include `payment_received` and `lost`. |

---

### 1B — Extend `followUps` schema with `completionOutcome`

**Type:** Backend
**Parallelizable:** Yes — touches only `convex/schema.ts`. Independent of 1A.

**What:** Add an optional `completionOutcome` union field to the `followUps` table so Phase 3 mutations can record the structured result of a reminder outcome (payment, lost, one of three no-response variants) without breaking backwards compatibility with legacy completed follow-ups.

**Why:** Today `followUps.completionNote` is a free-text string — reporting cannot tell "this reminder closed a sale" from "this reminder fizzled out." A structured tag lets future dashboards answer "what percentage of manual reminders convert to payment?" cheaply. Keeping the field optional means every legacy completed follow-up remains schema-valid with no backfill.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Locate the `followUps` table definition (currently around lines 711–767 per the design doc).**

```typescript
// Path: convex/schema.ts

// BEFORE — existing followUps definition (abridged)
followUps: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  closerId: v.id("users"),
  type: v.union(
    v.literal("scheduling_link"),
    v.literal("manual_reminder"),
  ),
  // ... other type-specific fields ...
  contactMethod: v.optional(v.union(v.literal("call"), v.literal("text"))),
  reminderScheduledAt: v.optional(v.number()),
  reminderNote: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  completionNote: v.optional(v.string()),
  reason: v.optional(v.string()),
  status: v.union(
    v.literal("pending"),
    v.literal("completed"),
    v.literal("cancelled"),
  ),
  bookedAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_status", ["tenantId", "status"])
  // ... other indexes (unchanged) ...
```

**Step 2: Insert the new `completionOutcome` field adjacent to `completionNote`. Keep the whole surrounding object identical.**

```typescript
// Path: convex/schema.ts

// AFTER — add `completionOutcome` after `completionNote`
followUps: defineTable({
  tenantId: v.id("tenants"),
  opportunityId: v.id("opportunities"),
  leadId: v.id("leads"),
  closerId: v.id("users"),
  type: v.union(
    v.literal("scheduling_link"),
    v.literal("manual_reminder"),
  ),
  // ... other type-specific fields UNCHANGED ...
  contactMethod: v.optional(v.union(v.literal("call"), v.literal("text"))),
  reminderScheduledAt: v.optional(v.number()),
  reminderNote: v.optional(v.string()),
  completedAt: v.optional(v.number()),
  completionNote: v.optional(v.string()),

  // NEW — structured outcome tag written by the new reminder outcome
  // mutations (Phase 3). Legacy completed follow-ups and still-pending
  // follow-ups have no value. Reporting treats absent as "legacy_unstructured".
  completionOutcome: v.optional(
    v.union(
      v.literal("payment_received"),
      v.literal("lost"),
      v.literal("no_response_rescheduled"),
      v.literal("no_response_given_up"),
      v.literal("no_response_close_only"),
    ),
  ),

  reason: v.optional(v.string()),
  status: v.union(
    v.literal("pending"),
    v.literal("completed"),
    v.literal("cancelled"),
  ),
  bookedAt: v.optional(v.number()),
  createdAt: v.number(),
})
  // ALL EXISTING INDEXES UNCHANGED — no new indexes needed. Reporting
  // queries will post-filter `completionOutcome` after scoping by
  // `tenantId` + date range; the cardinality is small enough that an
  // index would be premature optimisation (see convex-performance-audit
  // rationale in §4.4 of the design doc).
  .index("by_tenantId", ["tenantId"])
  .index("by_tenantId_and_status", ["tenantId", "status"])
  // ... other indexes unchanged ...
```

**Step 3: Save the file. Do NOT touch any other table.** Every other table in `convex/schema.ts` stays byte-for-byte identical.

**Key implementation notes:**
- **Optional on purpose.** Existing completed follow-ups legitimately have no structured outcome. Marking the field required would fail schema validation on deploy and force a backfill migration — unnecessary work.
- **Five literal values, not four.** The three "no_response_*" variants keep the "I didn't reach them" outcomes distinct for reporting: `rescheduled` (closer set a new reminder), `given_up` (closer marked opp lost), `close_only` (closer deferred decision). The design doc §14.1 keeps these internal — reporting UI can map to friendly labels.
- **Matching shape in mutations.** Phase 3's `logReminderPayment` writes `"payment_received"`, `markReminderLost` writes `"lost"`, `markReminderNoResponse` writes one of the three `no_response_*` literals. The TypeScript compiler will catch typos via the generated `Doc<"followUps">` type.
- **No new indexes.** We explicitly skip an index on `completionOutcome`. Volume is low and all reporting queries will already scope by `tenantId` + a date range. Revisit if a future report filters by outcome globally across tenants — unlikely.
- **Legacy `markReminderComplete` still works.** It does not set `completionOutcome`, which is allowed because the field is optional. No edits to that mutation are needed in this phase.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add optional `completionOutcome` union to `followUps` table. No index changes. |

---

### 1C — Deploy and verify

**Type:** Backend / Manual
**Parallelizable:** No — gates the phase. Must run after **both** 1A and 1B land on disk.

**What:** Start the Convex dev deployment, confirm the schema widens cleanly, confirm the generated `_generated/dataModel.d.ts` picks up the new field, and run `pnpm tsc --noEmit` to catch any consumer that now has a type mismatch.

**Why:** The widen-migrate-narrow workflow has a single widen step for this phase. The verification step is what actually proves the widening succeeded — a schema edit that compiles locally but fails against the live deployment would silently break the entire pipeline. We want a green deploy before Phase 2/3 start writing against the new shape.

**Where:**
- No file changes. This is a command-line + dashboard verification step.

**How:**

**Step 1: Start the Convex dev watcher (leave it running).**

```bash
npx convex dev
```

Expected output fragment:

```
✔ Schema validated
✔ Pushed to https://<deployment-name>.convex.cloud
```

If validation fails, read the error — it will name the offending document. Do not force-push; instead, re-open `convex/schema.ts` and reconcile.

**Step 2: Inspect the generated types. Convex rewrites `convex/_generated/dataModel.d.ts` after every successful push.**

```bash
# Confirm the new literal union is present in the generated type
# (do this via your editor's go-to-definition on Doc<"followUps">).
# The field should appear as:
#   completionOutcome?: "payment_received" | "lost" | "no_response_rescheduled"
#                      | "no_response_given_up" | "no_response_close_only";
```

**Step 3: Typecheck the whole repo. This catches any call site that destructured `followUps` fields and relied on a different shape.**

```bash
pnpm tsc --noEmit
```

Must exit 0.

**Step 4: Invoke the `convex-migration-helper` skill.** It will:
- Enumerate tables with recent field additions.
- Confirm existing documents still validate against the new schema (they do — the field is optional).
- Flag any subtle mismatch (e.g., a literal rename that could have shaved off a legacy row).

**Step 5: (Optional but recommended) open the Convex dashboard → Data → `followUps` and pick any historical completed row. Confirm reading it succeeds and `completionOutcome` is simply absent.** The UI will render the field as "—" because it is optional.

**Step 6: Spot-check `validateTransition` in a Convex function shell, or write a tiny scratch query and call it once.**

```typescript
// Path: scratch/verify-transitions.ts (do not commit)
import { validateTransition } from "../convex/lib/statusTransitions";

console.log(validateTransition("follow_up_scheduled", "payment_received")); // true
console.log(validateTransition("follow_up_scheduled", "lost")); // true
console.log(validateTransition("follow_up_scheduled", "scheduled")); // true
console.log(validateTransition("follow_up_scheduled", "in_progress")); // false
```

Once confirmed, discard the scratch file.

**Key implementation notes:**
- **Do not ship 1A + 1B separately.** Either they land together or neither lands. Convex schema and status-transition code often cross-reference during later phases; staging the deploy is safer than two half-deployed revisions.
- **`pnpm tsc --noEmit` is the hard gate.** If it fails, the error message will point at a call site that destructures `followUp.completionOutcome` as non-optional — none should exist yet because Phase 1 is the first writer. A failure here means someone pre-landed Phase 3 code. Back it out.
- **No rollback plan needed.** Adding an optional field and widening a transition map are both forward-compatible operations. If Phase 3 later decides a different outcome taxonomy is needed, we add more literals (additive) or rename some (breaking — but we would do that before any production write uses them).
- **Zero downtime.** Convex deploys atomically; no "in-between" state where half the functions see the old schema.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/_generated/dataModel.d.ts` | Auto-generate | Regenerated by `npx convex dev`. Do not hand-edit. |
| — | Verify | `pnpm tsc --noEmit`, dashboard inspection, `validateTransition` spot-check. |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `convex/lib/statusTransitions.ts` | Modify | 1A |
| `convex/schema.ts` | Modify | 1B |
| `convex/_generated/dataModel.d.ts` | Auto-regenerate | 1C |
