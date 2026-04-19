# Phase 3 — Outcome Dropdown Removal & Notes Cleanup

**Goal:** Delete every code path that reads or writes `meetings.meetingOutcome` and remove the now-orphaned `MeetingNotes` / `MeetingOutcomeSelect` / `updateMeetingNotes` / `updateMeetingOutcome` symbols. The `meetingOutcome` branch in `deriveCallOutcome` is removed with a `TODO` comment for future reporting work. The schema field and its index remain (removal requires a widen-migrate-narrow migration — deferred). After this phase, no production code references `meetingOutcome` or the legacy notepad mutation, and the codebase has one less dead feature.

**Prerequisite:** Phase 2 fully deployed. Both page clients must already render `<MeetingComments>` and no longer import `<MeetingNotes>` — otherwise deleting `meeting-notes.tsx` breaks the build.

**Runs in PARALLEL with:** **Phase 4** (data migration) — different directories, no shared files. Phase 2 is a hard blocker.

**Skills to invoke:**
- `simplify` — code quality review after deletions. Flags any dead imports, unused helpers, or unreferenced type exports that the mechanical deletion misses.
- `expect` — browser verification that the admin lead meetings tab still renders cleanly after column removal, and that both meeting detail pages still look correct without the outcome dropdown.

> **Critical path:** On the critical path (Phase 1 → Phase 2 → Phase 3). This is the final phase on the main path; shipping it closes the feature.

---

## Acceptance Criteria

1. `app/workspace/closer/meetings/_components/meeting-notes.tsx` no longer exists on disk.
2. `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` no longer exists on disk.
3. `convex/closer/meetingActions.ts` no longer exports `updateMeetingNotes` or `updateMeetingOutcome`; all surrounding code compiles.
4. `convex/reporting/lib/outcomeDerivation.ts` no longer contains the `if (meeting.meetingOutcome === "not_qualified")` branch; a `TODO` comment documenting the reporting gap is in its place.
5. A grep for `MeetingNotes`, `MeetingOutcomeSelect`, `MeetingOutcome` (type), `updateMeetingNotes`, `updateMeetingOutcome`, or `meetingOutcome` across `app/**` and `convex/**` (excluding `_generated/`, `schema.ts` with its DEAD comment, and `.md` plan files) returns **zero matches**.
6. `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` no longer renders an "Outcome" column header or cell.
7. `convex/schema.ts` still declares the `meetingOutcome` field and the `by_tenantId_and_meetingOutcome_and_scheduledAt` index (both flagged with a "DEAD FIELD — scheduled for widen-migrate-narrow migration" comment); `npx convex dev` succeeds.
8. The "DQ" (disqualified) `CallOutcome` variant in `outcomeDerivation.ts` still exists in the type union but has no code path that produces it — this is intentional and documented by the `TODO` added in the same phase.
9. PostHog no longer emits `meeting_outcome_set` events (confirmed via the PostHog live events view on the test tenant after deploy).
10. Both meeting detail pages (closer + admin) render without the outcome dropdown and still display the Comments card.
11. The lead meetings tab renders one fewer column; no JSX key warnings in the console.
12. `pnpm tsc --noEmit` passes.

---

## Subphase Dependency Graph

```
Phase 2 complete ─┐
                  │
                  ├── 3A (delete frontend components) ─────────┐
                  │                                            │
                  ├── 3B (remove lead-meetings-tab column) ────┤
                  │                                            ├── 3F (final grep + tsc)
                  ├── 3C (delete backend mutations) ───────────┤
                  │                                            │
                  ├── 3D (remove deriveCallOutcome branch) ────┤
                  │                                            │
                  └── 3E (schema deprecation comments) ────────┘
```

**Optimal execution:**
- 3A, 3B, 3C, 3D, 3E all touch different files and have **zero runtime coupling**. Run them in parallel.
- 3F is a verification step — `pnpm tsc --noEmit`, grep for leftover references, `expect` browser check. Blocks phase close.
- Because these are all deletions / comment additions, merge order is flexible. Do them in a single PR if solo, or 1 PR per subphase if parallel — either works.

**Estimated time:** 0.5 day (all subphases are small; the work is in verification, not implementation).

---

## Subphases

### 3A — Delete Orphaned Frontend Components

**Type:** Frontend
**Parallelizable:** Yes — independent of 3B, 3C, 3D, 3E.

**What:** Delete `meeting-notes.tsx` and `meeting-outcome-select.tsx` from `app/workspace/closer/meetings/_components/`.

**Why:** These files are no longer imported anywhere after Phase 2. Leaving them invites confusion ("is this still used?") and keeps dead PostHog event code alive.

**Where:**
- `app/workspace/closer/meetings/_components/meeting-notes.tsx` (delete)
- `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` (delete)

**How:**

**Step 1: Confirm zero imports remain.**

```bash
# Expect zero matches (excluding .md plan files).
grep -rn "meeting-notes\|MeetingNotes" app/ convex/ --include="*.ts" --include="*.tsx"
grep -rn "meeting-outcome-select\|MeetingOutcomeSelect\|\\bMeetingOutcome\\b" app/ convex/ --include="*.ts" --include="*.tsx"
```

If `MeetingOutcome` (the type) shows up anywhere, resolve that import first — the type was exported from `meeting-outcome-select.tsx`. The exploration confirmed the only other reference was inside `meeting-notes.tsx`, which is also being deleted, so no external consumer exists.

**Step 2: Delete both files.**

```bash
rm app/workspace/closer/meetings/_components/meeting-notes.tsx
rm app/workspace/closer/meetings/_components/meeting-outcome-select.tsx
```

**Step 3: Verify the PostHog event stops being emitted.**

After deploy, open PostHog → Live Events → filter `meeting_outcome_set`. No new events should appear. (The historical events remain; we don't delete them.)

**Key implementation notes:**
- **PostHog side effect**: the `meeting_outcome_set` event was captured at `meeting-outcome-select.tsx:83` on every outcome change. Deleting the file stops the emission. If any PostHog funnel, insight, or cohort filter references this event, it freezes at its current count. **Communicate this to product analytics before shipping.**
- The `MeetingOutcome` TypeScript type export from `meeting-outcome-select.tsx:51` is also deleted. The exploration confirmed it has no external consumers.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | Delete | Replaced by `meeting-comments.tsx` in Phase 2. |
| `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` | Delete | Dropdown feature fully removed. |

**Side effects:**
- PostHog `meeting_outcome_set` event stops.
- `MeetingOutcome` type export gone.

---

### 3B — Remove Outcome Column from Lead Meetings Tab

**Type:** Frontend
**Parallelizable:** Yes — independent of 3A, 3C, 3D, 3E.

**What:** Delete the "Outcome" `TableHead` and its corresponding `TableCell` from `lead-meetings-tab.tsx`.

**Why:** This is the only other place in the app that displayed `meeting.meetingOutcome`. Removing it aligns the visible surface with the backend reality (dead field).

**Where:**
- `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` (modify)

**How:**

**Step 1: Remove the column header (around line 50).**

```tsx
// Path: app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx

// BEFORE (line ~50 within the <TableHeader> row):
<TableHead>Outcome</TableHead>

// AFTER: remove entirely (no placeholder — the column disappears).
```

**Step 2: Remove the corresponding cell (around lines 102–110).**

```tsx
// BEFORE:
<TableCell>
  {mtg.meetingOutcome ? (
    <span className="text-sm capitalize">
      {mtg.meetingOutcome.replace(/_/g, " ")}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">--</span>
  )}
</TableCell>

// AFTER: remove entirely.
```

**Step 3: Verify the table still renders and no stray cell misalignment remains.**

```bash
pnpm tsc --noEmit
```

Then load the lead detail page for a lead with meetings and visually confirm the columns line up.

**Key implementation notes:**
- No other columns reference `meetingOutcome`, so no column-index math to adjust.
- If the query fueling this tab (`api.closer.leadMeetings.*` or similar) still returns `meetingOutcome` in its shape, that's harmless — it just isn't rendered. Phase 3 does not need to modify the query.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` | Modify | Delete one `<TableHead>` and one `<TableCell>`. |

**Side effects:**
- **UX change**: stakeholders who reviewed a lead's meeting outcomes in this table lose that view. The new Comments card on the meeting detail page is the replacement surface.

---

### 3C — Delete Orphaned Backend Mutations

**Type:** Backend
**Parallelizable:** Yes — independent of 3A, 3B, 3D, 3E.

**What:** Delete the `updateMeetingNotes` mutation (lines 47–70) and the `updateMeetingOutcome` mutation (lines 315–352 per exploration) from `convex/closer/meetingActions.ts`.

**Why:** Both mutations are no longer called from any UI after Phase 2. Dead server code is a maintenance liability and a tempting foot-gun for future features.

**Where:**
- `convex/closer/meetingActions.ts` (modify)

**How:**

**Step 1: Delete `updateMeetingNotes` (lines 47–70).**

```typescript
// Path: convex/closer/meetingActions.ts

// BEFORE — lines 38–70:
/**
 * Update meeting notes.
 *
 * Called by the auto-saving notes textarea on the meeting detail page.
 * Debounced on the client side (typically 500ms–1s).
 *
 * Accessible by closers (own meetings) and admins (any meeting).
 */
export const updateMeetingNotes = mutation({
  args: {
    meetingId: v.id("meetings"),
    notes: v.string(),
  },
  handler: async (ctx, { meetingId, notes }) => {
    // ... (entire handler) ...
  },
});

// AFTER: remove the entire block + its JSDoc.
```

**Step 2: Delete `updateMeetingOutcome` (lines 315–352).**

Same treatment — delete the export entirely, including its JSDoc comment.

**Step 3: Confirm no stale imports remain at the top of the file.**

If `updateMeetingNotes` or `updateMeetingOutcome` were the sole consumers of an import (e.g., a validator helper), clean that up too. The exploration indicates they share imports with the surviving mutations (`startMeeting`, `stopMeeting`, etc.), so nothing else should need trimming.

**Step 4: Verify.**

```bash
pnpm tsc --noEmit
npx convex dev # should report zero errors
```

**Key implementation notes:**
- **Calendly webhook unaffected**: the Calendly `invitee.created` pipeline writes `notes` directly via `ctx.db.insert("meetings", { ..., notes: ... })` inside `convex/pipeline/inviteeCreated.ts` — **not** through `updateMeetingNotes`. Deleting this mutation does not break the webhook.
- **`api.closer.meetingActions.updateMeetingNotes` / `updateMeetingOutcome` no longer exist**: any external caller (there are none in this repo — confirmed via exploration) would break. If a reporting dashboard, integration test, or CLI script uses them, that will fail at runtime.
- The surviving mutations in `meetingActions.ts` (`startMeeting`, `stopMeeting`, `markNoShow`, etc.) are unaffected.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingActions.ts` | Modify | Delete two `export const` blocks + their JSDoc. |

**Side effects:**
- `api.closer.meetingActions.updateMeetingNotes` and `updateMeetingOutcome` removed from the public Convex API. Internal to repo: no callers.
- No schema changes.

---

### 3D — Remove `deriveCallOutcome` "DQ" Branch + Add TODO

**Type:** Backend
**Parallelizable:** Yes — independent of 3A, 3B, 3C, 3E.

**What:** Delete lines 48–50 of `convex/reporting/lib/outcomeDerivation.ts` (the `meeting.meetingOutcome === "not_qualified"` branch) and replace with a `TODO` comment for future reporting work.

**Why:** `meetingOutcome` no longer has a write path — so this branch can never evaluate to true on records created after Phase 3 deploys. For records created **before** Phase 3 that have `meetingOutcome === "not_qualified"` set, this branch would still trigger — but the function is unused in production (exploration verified), so there's no behavioral impact. Removing the branch closes out the last `meetingOutcome` reader in the codebase.

**Where:**
- `convex/reporting/lib/outcomeDerivation.ts` (modify)

**How:**

**Step 1: Delete lines 48–50 and replace with a TODO.**

```typescript
// Path: convex/reporting/lib/outcomeDerivation.ts

// BEFORE — lines 44–57:
  if (isRescheduled) {
    return "rescheduled";
  }

  if (meeting.meetingOutcome === "not_qualified") {
    return "dq";
  }

  if (
    meeting.status === "completed" &&
    opportunity.status === "follow_up_scheduled"
  ) {
    return "follow_up";
  }

// AFTER:
  if (isRescheduled) {
    return "rescheduled";
  }

  // TODO: Re-implement the "dq" (disqualified) CallOutcome.
  //
  // The previous trigger was `meeting.meetingOutcome === "not_qualified"`,
  // but `meetingOutcome` has been removed from all read/write paths as of
  // the meeting-comments feature (see plans/meeting-comments/phases/phase3.md
  // §3D and the design doc §6.3).
  //
  // When the v0.6b Team Performance reporting feature ships, choose one of:
  //   (a) explicit `disqualifyMeeting` mutation that sets a dedicated field
  //   (b) derive DQ from `opportunity.status === "lost"` + a structured
  //       lostReason enum
  //   (c) structured comment tag (e.g., a comment with metadata.tag = "dq")
  //
  // Until then, `CallOutcome` still exposes "dq" as a variant but no code
  // path produces it — this is intentional and documented.

  if (
    meeting.status === "completed" &&
    opportunity.status === "follow_up_scheduled"
  ) {
    return "follow_up";
  }
```

**Step 2: Confirm `deriveCallOutcome` has no production callers.**

```bash
grep -rn "deriveCallOutcome" convex/ app/ --include="*.ts" --include="*.tsx"
```

Should return only:
- The function definition itself (`outcomeDerivation.ts`).
- References inside `plans/v0.6b/*.md` and `plans/v0.6/*.md` (design docs — not code).

If any production file (not `plans/`, not `_generated/`) imports or calls it, **stop**: the Phase 3 assumption is wrong and a deeper review is required before proceeding.

**Step 3: Keep the `CallOutcome` type union intact.**

Do **not** remove `"dq"` from the `CallOutcome` union at the top of the file. The `TODO` explicitly keeps it as a known variant so future reporting work has a pre-declared value to wire up.

**Key implementation notes:**
- This is the **only** place in the backend that reads `meetingOutcome`. After this change, `meetingOutcome` is a truly dead field (zero readers, zero writers).
- The schema field is still present — see 3E. It's preserved because Convex cannot remove a field without a widen-migrate-narrow migration.
- Historical data: some existing meeting records have `meetingOutcome` set. That data is preserved (no migration here); if future work needs it for backfill purposes, it's still queryable via raw DB access.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/reporting/lib/outcomeDerivation.ts` | Modify | Delete branch + add TODO comment. |

**Side effects:**
- **Reporting (not yet shipped)**: any future code that calls `deriveCallOutcome` receives `"follow_up"` / `"in_progress"` / `"scheduled"` etc. instead of `"dq"` for previously-DQ'd meetings. Since the function has no production callers today, this is a documentation-only side effect.

---

### 3E — Schema Deprecation Comments

**Type:** Backend (config)
**Parallelizable:** Yes — independent of 3A, 3B, 3C, 3D.

**What:** Add clear "DEAD FIELD — scheduled for migration" comments above the `notes` field (line ~319) and `meetingOutcome` field (lines ~338–346) in `convex/schema.ts`. Do **not** remove the fields or the `by_tenantId_and_meetingOutcome_and_scheduledAt` index.

**Why:** Convex schema constraints: you cannot remove a field from a document validator without a widen-migrate-narrow migration. The fields stay in the schema for now, but a future engineer (or agent) opening the file should immediately see that the fields are dead and understand the migration path.

**Where:**
- `convex/schema.ts` (modify)

**How:**

**Step 1: Annotate the `notes` field (around line 319).**

```typescript
// Path: convex/schema.ts

// BEFORE (line ~319 in the meetings table):
notes: v.optional(v.string()),

// AFTER:
// DEPRECATED (as of meeting-comments feature — see plans/meeting-comments/):
// All frontend reads/writes removed. Calendly's meeting_notes_plain webhook
// still populates this field for newly-created meetings. Phase 4 migrates
// existing data to the meetingComments table. Schedule full removal via the
// `convex-migration-helper` skill once the Calendly webhook is rerouted to
// create a system comment instead.
notes: v.optional(v.string()),
```

**Step 2: Annotate the `meetingOutcome` field (lines ~338–346).**

```typescript
// BEFORE:
// Feature I: Meeting outcome classification tag.
// Set by the closer after a meeting via dropdown on the detail page.
// Captures the lead's intent signal — independent of opportunity status.
// Undefined = not yet classified.
meetingOutcome: v.optional(
  v.union(
    v.literal("interested"),
    v.literal("needs_more_info"),
    v.literal("price_objection"),
    v.literal("not_qualified"),
    v.literal("ready_to_buy"),
  ),
),

// AFTER:
// DEAD FIELD (as of meeting-comments feature — see plans/meeting-comments/).
// All read and write code paths are deleted — no production code references
// this field. Existing data is preserved but orphaned. Full removal requires
// a widen-migrate-narrow migration; schedule via the `convex-migration-helper`
// skill. The `by_tenantId_and_meetingOutcome_and_scheduledAt` index below
// must stay until the field is removed.
meetingOutcome: v.optional(
  v.union(
    v.literal("interested"),
    v.literal("needs_more_info"),
    v.literal("price_objection"),
    v.literal("not_qualified"),
    v.literal("ready_to_buy"),
  ),
),
```

**Step 3: Annotate the index (lines ~414–418).**

```typescript
// BEFORE:
.index("by_tenantId_and_meetingOutcome_and_scheduledAt", [
  "tenantId",
  "meetingOutcome",
  "scheduledAt",
])

// AFTER:
// DEAD INDEX — see DEAD FIELD comment on meetingOutcome above. Cannot remove
// independently of the field. Remove together in the follow-up migration.
.index("by_tenantId_and_meetingOutcome_and_scheduledAt", [
  "tenantId",
  "meetingOutcome",
  "scheduledAt",
])
```

**Step 4: Deploy.**

```bash
npx convex dev
```

Schema validation still passes; no data is touched.

**Key implementation notes:**
- Do **not** remove `v.optional(...)` or change the union shape — that would require a migration. Comments only.
- Do **not** remove the index — removing an index while the field still exists is technically allowed but would trigger OCC conflicts on existing queries (none left, but safer to batch the change).
- The comments link to `plans/meeting-comments/` so future reviewers have immediate context.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/schema.ts` | Modify | Add two deprecation comments (notes field, meetingOutcome field) + one index comment. |

**Side effects:**
- None. Documentation only.

---

### 3F — Final Verification & Grep Sweep

**Type:** Manual / Verification
**Parallelizable:** No — runs after 3A–3E.

**What:** Run a codebase-wide grep for any remaining `meetingOutcome` or legacy `MeetingNotes`/`MeetingOutcomeSelect` references. Run `pnpm tsc --noEmit` and `npx convex dev`. Run `expect` browser checks on both meeting detail pages and the lead meetings tab.

**Why:** Deletions are mechanical but regressions hide in odd places — a stale import, a dead type alias, a commented-out JSX snippet. This gate catches them.

**Where:** N/A (verification only)

**How:**

**Step 1: Comprehensive grep.**

```bash
# Exclude schema.ts (where the comment intentionally mentions meetingOutcome)
# and _generated and .md files.
grep -rn "meetingOutcome" app/ convex/ \
  --include="*.ts" --include="*.tsx" \
  | grep -v "_generated" \
  | grep -v "schema.ts"

# Should return 0 matches.
```

```bash
# MeetingNotes / MeetingOutcomeSelect / MeetingOutcome type.
grep -rn "MeetingNotes\|MeetingOutcomeSelect\|\\bMeetingOutcome\\b" app/ convex/ \
  --include="*.ts" --include="*.tsx"

# Should return 0 matches.
```

```bash
# updateMeetingNotes / updateMeetingOutcome mutations.
grep -rn "updateMeetingNotes\|updateMeetingOutcome" app/ convex/ \
  --include="*.ts" --include="*.tsx" \
  | grep -v "_generated"

# Should return 0 matches.
```

**Step 2: TypeScript + Convex deploy check.**

```bash
pnpm tsc --noEmit
npx convex dev # kill after it reports "Connected" with no errors
```

**Step 3: PostHog check.**

In the PostHog dashboard for the test tenant, filter live events to `event = "meeting_outcome_set"`. Verify no new events appear after the Phase 3 deploy.

**Step 4: `expect` browser sweep.**

Have the `expect` skill verify:
- `/workspace/closer/meetings/[id]` (closer view) — renders without the outcome dropdown, Comments card visible, no console errors.
- `/workspace/pipeline/meetings/[id]` (admin view) — same.
- `/workspace/leads/[id]` with the meetings tab open — one fewer column, table renders cleanly at 4 viewports.
- Accessibility audit passes on all three pages.

**Key implementation notes:**
- The grep excludes are intentional: `_generated/` is regenerated automatically, `schema.ts` contains the DEAD FIELD comment referencing the name, and `.md` files are plan documents that reference the feature history.
- If any grep returns a non-zero match, resolve it before closing the phase — the acceptance criteria require zero references outside the schema.

**Files touched:** None (verification only).

**Side effects:** None.

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | Delete | 3A |
| `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` | Delete | 3A |
| `app/workspace/leads/[leadId]/_components/tabs/lead-meetings-tab.tsx` | Modify | 3B |
| `convex/closer/meetingActions.ts` | Modify | 3C (delete 2 mutations) |
| `convex/reporting/lib/outcomeDerivation.ts` | Modify | 3D |
| `convex/schema.ts` | Modify | 3E (comments only — no structural change) |

---

## Cross-Phase Side Effects

| System | Effect | Action / Mitigation |
|---|---|---|
| PostHog `meeting_outcome_set` event | Stops being emitted. Historical events preserved. | **Notify product analytics** — freeze any dashboards referencing this event, or add a note that the event is retired. |
| PostHog any other `MeetingOutcomeSelect` events | No other events originated from this component — confirmed via exploration. | None. |
| `api.closer.meetingActions.updateMeetingNotes` | Removed from Convex API. | No in-repo callers. External tooling (CLI / scripts): none known. |
| `api.closer.meetingActions.updateMeetingOutcome` | Removed from Convex API. | Same — no in-repo callers. |
| Calendly `invitee.created` webhook | **Continues writing to `meeting.notes` via `ctx.db.insert`.** No change. | Not touched by Phase 3. Phase 4 covers migration path. Design Open Question #2 flags long-term redirection of this webhook to create a system comment — deferred. |
| `deriveCallOutcome` DQ detection | No production callers; `"dq"` CallOutcome variant becomes unreachable until reporting re-implements it. | TODO comment in code + this plan document the replacement paths. |
| `CallOutcome` TypeScript type | Still exports `"dq"` as a variant. | Intentional — keeps the type stable for future wiring. |
| `meetingOutcome` schema field | Field + index remain; marked DEAD. | Removal scheduled via `convex-migration-helper` (follow-up task, not in this plan). |
| `meeting.notes` schema field | Field remains; marked DEPRECATED. Continues to receive Calendly webhook writes. | Removal scheduled via `convex-migration-helper` (follow-up task, not in this plan). Phase 4 migrates historical data. |
| Admin lead meetings tab | One column removed (the "Outcome" column). | Stakeholders lose the quick-glance outcome column. The Comments card on the meeting detail page is the replacement surface — communicate in the release note. |
| `meetingReviews` / other tables referencing `meetingOutcome` | Exploration found no cross-table references. | Confirm by final grep in 3F. |
| Reviews feature (`/workspace/reviews/...`) | Uses an unrelated outcome concept (review outcomes, not meeting outcomes). | Exploration confirmed the code path is isolated. Unchanged by Phase 3. |
| Frontend route error boundaries | Unchanged. | No new failure modes introduced. |

---

## Deferred / Out-of-Scope (Follow-Up Tasks)

These are explicitly **not** in Phase 3 — tracked here so they don't get forgotten:

| Item | Skill to invoke | Trigger |
|---|---|---|
| Remove `meetings.notes` field from schema | `convex-migration-helper` | After Phase 4 migration completes on all tenants and the Calendly webhook is redirected to create a comment instead. |
| Remove `meetings.meetingOutcome` field + index from schema | `convex-migration-helper` | Any time after Phase 3 ships; zero data dependency. |
| Rewire Calendly `invitee.created` webhook to create an initial system comment | (design task — use Plan agent) | Unblocks full removal of `meetings.notes`. |
| Re-implement DQ classification for reporting | (wait for v0.6b Team Performance) | See design §6.3 and the TODO in `outcomeDerivation.ts`. |

---

## Verification Checklist (before closing Phase 3)

- [ ] `grep -rn "meetingOutcome" app/ convex/ --include="*.ts" --include="*.tsx" | grep -v "_generated" | grep -v "schema.ts"` returns 0 matches.
- [ ] `grep -rn "MeetingNotes\|MeetingOutcomeSelect\|\bMeetingOutcome\b" app/ convex/ --include="*.ts" --include="*.tsx"` returns 0 matches.
- [ ] `grep -rn "updateMeetingNotes\|updateMeetingOutcome" app/ convex/ --include="*.ts" --include="*.tsx" | grep -v "_generated"` returns 0 matches.
- [ ] `pnpm tsc --noEmit` passes.
- [ ] `npx convex dev` deploys cleanly.
- [ ] Closer + admin meeting detail pages render without the outcome dropdown; Comments card visible.
- [ ] Lead meetings tab renders with the correct column count (one less than before).
- [ ] PostHog live events view shows no new `meeting_outcome_set` events.
- [ ] `expect` accessibility audit passes on all three affected pages.
- [ ] Product analytics team notified about `meeting_outcome_set` retirement.
- [ ] Follow-up tasks (schema field removal, Calendly webhook redirect, DQ reporting) filed in the backlog.
