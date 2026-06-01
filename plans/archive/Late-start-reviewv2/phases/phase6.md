# Phase 6 — Cleanup

**Goal:** Remove the v1 "Provide Context" dialog file, formally deprecate the v1 `respondToOverranReview` and `scheduleFollowUpFromOverran` mutations (keep exports for backward compatibility with any in-flight client requests but annotate and stop calling them from UI), update the v1 design document with a "Superseded by v2" banner, and verify no dangling imports or references remain. After this phase, the codebase is clean — no unused components, no stale mutations callable from the UI, clear documentation of what v2 replaced.

**Prerequisite:**
- **Phase 4 complete.** The closer UI (specifically `meeting-overran-banner.tsx` in 4C) no longer imports `MeetingOverranContextDialog`, so the dialog file is orphaned.
- **Phase 5 complete.** The admin UI no longer calls `respondToOverranReview` or `scheduleFollowUpFromOverran` (v1 closer-side mutations — actually, these are closer-side, never called from admin; the goal is to confirm NO caller in the whole codebase).
- All preceding phases merged, deployed, and verified.

**Runs in PARALLEL with:** Nothing. Phase 6 runs **last**, after every other phase is live. Running in parallel with Phase 4 or 5 would risk deleting files still being used.

**Skills to invoke:**
- `convex-performance-audit` — Not strictly needed for cleanup, but optional: run `npx convex insights` to confirm `respondToOverranReview` and `scheduleFollowUpFromOverran` have zero recent invocations before/after this phase.
- `simplify` — After the cleanup sweep, run the `simplify` skill on `convex/closer/meetingOverrun.ts` to catch any now-dead helper functions that only the deprecated mutations used. If the deprecated mutations are the only consumers of private helpers in that file, those helpers can be removed too.

**Acceptance Criteria:**
1. The file `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` no longer exists on disk.
2. `grep -r "meeting-overran-context-dialog" .` returns zero matches inside `app/`, `components/`, `convex/`, and `plans/` (other than the original v2 design doc and this phase plan).
3. `grep -r "MeetingOverranContextDialog" .` returns zero matches outside of the original v2 design doc and this phase plan.
4. `convex/closer/meetingOverrun.ts::respondToOverranReview` has a top-of-function JSDoc comment starting with `@deprecated v2 — ...` explaining the removal context and stating that no frontend calls it.
5. `convex/closer/meetingOverrun.ts::scheduleFollowUpFromOverran` has the same `@deprecated v2` JSDoc comment.
6. `grep -r "api.closer.meetingOverrun.respondToOverranReview" app/` returns zero matches.
7. `grep -r "api.closer.meetingOverrun.scheduleFollowUpFromOverran" app/` returns zero matches.
8. The file `plans/late-start-review/late-start-review-design.md` starts with a quote-block banner: `> **Superseded by v2:** [...]` pointing to `plans/Late-start-reviewv2/overhaul-v2.md`.
9. `pnpm tsc --noEmit` passes without errors.
10. The full `expect` verification from Phase 4E + Phase 5F still passes end-to-end after the cleanup.

---

## Subphase Dependency Graph

```
6A (Delete meeting-overran-context-dialog.tsx) ────────┐
                                                        │
6B (Deprecate respondToOverranReview + scheduleFollowUpFromOverran JSDoc) ─┤── 6D (Final verification: grep sweep + tsc + expect)
                                                        │
6C (Update v1 design doc with supersedes banner) ──────┘
```

**Optimal execution:**
1. Start **6A, 6B, 6C in parallel** — different files, no shared logic.
2. Once all three are merged, run **6D** as the final verification gate before calling v2 "done."

**Estimated time:** 0.25 days (2 hours — 5 min each for 6A/6B/6C edits, plus ~45 min verification and cleanup commits).

---

## Subphases

### 6A — Delete `meeting-overran-context-dialog.tsx`

**Type:** Frontend (file deletion)
**Parallelizable:** Yes — independent of 6B, 6C.

**What:** Remove the file `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` from the repository. Phase 4C already removed the import from `meeting-overran-banner.tsx`, so the file is orphaned.

**Why:** The v1 "Provide Context" dialog was the closer's way to explain a flagged meeting before admin resolution. v2 replaces that workflow entirely with: (a) the Fathom link field (general evidence), and (b) direct outcome actions in the action bar. Keeping the orphaned file in the tree is dead weight and risks future confusion ("what is this dialog for?").

**Where:**
- `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` (delete)

**How:**

**Step 1: Confirm no imports remain**

```bash
# From repo root:
grep -rn "meeting-overran-context-dialog" app/ components/ convex/
grep -rn "MeetingOverranContextDialog" app/ components/ convex/
```

Both should return zero matches. If either finds a match, stop and investigate — the import remover in Phase 4C missed something.

**Step 2: Delete the file**

```bash
rm app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx
```

**Step 3: Re-run the grep sweep to confirm clean deletion**

```bash
grep -rn "meeting-overran-context-dialog" app/ components/ convex/
grep -rn "MeetingOverranContextDialog" app/ components/ convex/
```

**Step 4: Run `pnpm tsc --noEmit`**

Any TypeScript error about a missing module at this point means an import survived the Phase 4C rewrite. Fix the import before proceeding.

**Step 5: Commit the deletion on its own**

```bash
git add -A  # picks up the deletion
git commit -m "chore: delete v1 meeting-overran context dialog (superseded by v2 Fathom field + direct actions)"
```

**Key implementation notes:**
- **Keep the commit isolated.** A clean "deletion" commit is easier to review and, if needed, revert than a commit that bundles deletion with other changes.
- **Do NOT use `git rm` with `-r`** on a directory — this deletion is a single file. A stray `-r` on the wrong path could delete siblings.
- **No need to touch `components.json` or any path-alias config** — the component was imported via relative paths and `@/app/...` absolute paths; deletion doesn't affect aliasing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | Delete | Phase 4C already removed imports; file is orphaned |

---

### 6B — Deprecate `respondToOverranReview` and `scheduleFollowUpFromOverran`

**Type:** Backend (JSDoc annotation — no behavior change)
**Parallelizable:** Yes — independent of 6A, 6C.

**What:** Add `@deprecated v2 — ...` JSDoc comments at the top of `respondToOverranReview` and `scheduleFollowUpFromOverran` in `convex/closer/meetingOverrun.ts`. Keep the exports intact (no deletion) to preserve backward compatibility with any in-flight frontend bundles served to users who haven't refreshed since the deploy.

**Why:** Deprecation annotation communicates to future contributors that these mutations should not be called from new code. Leaving the exports intact (rather than deleting) is a defensive move: if a user's browser has an old JS bundle cached and it still calls `respondToOverranReview`, removing the export would cause a runtime error during the caching transition window. The JSDoc + no-new-callers policy is sufficient for v2; a true deletion can happen in a subsequent cleanup pass weeks later.

**Where:**
- `convex/closer/meetingOverrun.ts` (modify)

**How:**

**Step 1: Read the current file**

```bash
# Confirm the two mutations exist and note their structure.
# The survey in this phase-plan sequence already confirmed:
#   - export const respondToOverranReview = mutation({ ... });
#   - export const scheduleFollowUpFromOverran = mutation({ ... });
```

**Step 2: Add JSDoc comments above each mutation**

```typescript
// Path: convex/closer/meetingOverrun.ts

/**
 * @deprecated v2 — The "Provide Context" dialog has been removed. Closers now
 * save a Fathom link via `saveFathomLink` (convex/closer/meetingActions.ts)
 * and take outcome actions directly (markAsLost / markNoShow / logPayment /
 * follow-up mutations). The admin review flow validates via `resolveReview`
 * with the new `disputed` action.
 *
 * This export is retained for backward compatibility during the v2 rollout
 * cache window — no v2 frontend code calls it. Safe to remove in a future
 * cleanup pass once all deployed clients are confirmed upgraded.
 *
 * Last verified with zero frontend callers on <YYYY-MM-DD>.
 */
export const respondToOverranReview = mutation({
  // ... existing body unchanged ...
});

/**
 * @deprecated v2 — The closer's overran-specific follow-up path has been
 * replaced by the standard follow-up flow (createSchedulingLinkFollowUp /
 * createManualReminderFollowUpPublic) invoked from the OutcomeActionBar.
 * Those standard mutations skip the opportunity transition for meeting_overran
 * to preserve the "terminal overran" invariant.
 *
 * Retained for backward compatibility. Safe to remove in a future cleanup pass.
 *
 * Last verified with zero frontend callers on <YYYY-MM-DD>.
 */
export const scheduleFollowUpFromOverran = mutation({
  // ... existing body unchanged ...
});
```

**Step 3: Verify no frontend calls**

```bash
grep -rn "api.closer.meetingOverrun.respondToOverranReview" app/ components/
grep -rn "api.closer.meetingOverrun.scheduleFollowUpFromOverran" app/ components/
```

Both should return zero matches. If either finds a match, go back to Phase 4C and remove the call — do NOT proceed to commit this phase.

**Step 4: (Optional) Check for internal Convex callers**

```bash
grep -rn "respondToOverranReview\|scheduleFollowUpFromOverran" convex/
```

The only matches should be the declarations themselves plus (possibly) internal helpers within `convex/closer/meetingOverrun.ts`. If any OTHER Convex file references these mutations, investigate — they should be server-only callable via HTTP (frontend mutation), not from within other server code.

**Step 5: Commit**

```bash
git add convex/closer/meetingOverrun.ts
git commit -m "chore: deprecate v1 overran-response mutations with @deprecated JSDoc"
```

**Key implementation notes:**
- **Do NOT delete the exports.** The rollout is incremental — users with stale bundles might still call the deprecated mutations during the rollout window. A `cache window` of 24-48 hours is typical; after that, another cleanup pass (not part of v2) can remove the exports.
- **`@deprecated` JSDoc tag** is understood by TypeScript Language Server — IDE users see strikethrough on these symbols, catching any accidental new call.
- **The `// Last verified with zero frontend callers on <DATE>`** line is a bookkeeping discipline — when a future cleanup-sweep contributor reads this, they know the last time someone checked. Fill in the date at commit time.
- **Do NOT add a `console.warn("[Deprecated]...")` at runtime.** The deprecated mutations may be called from stale clients; spamming logs adds no value because we already know why (cache window).

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `convex/closer/meetingOverrun.ts` | Modify | Add `@deprecated` JSDoc to `respondToOverranReview` and `scheduleFollowUpFromOverran` |

---

### 6C — Update v1 Design Doc with "Superseded" Banner

**Type:** Documentation
**Parallelizable:** Yes — independent of 6A, 6B.

**What:** Prepend a Markdown blockquote banner to `plans/late-start-review/late-start-review-design.md` indicating that v2 supersedes the closer UX, context dialog, and blocking behavior. Do NOT modify any other part of the v1 document — its text still documents the initial detection pipeline and admin resolution mechanism, which v2 extends rather than replaces.

**Why:** Future contributors finding the v1 doc via search should immediately see that portions are superseded. Without this banner, someone reading the v1 design might implement against the outdated specification (e.g., re-introducing the blanket `meeting_overran` guard).

**Where:**
- `plans/late-start-review/late-start-review-design.md` (modify)

**How:**

**Step 1: Prepend the banner at the very top of the file**

```markdown
> **Superseded by v2:** The closer UX, "Provide Context" dialog, and blocking
> behavior described in this document have been replaced by
> [`plans/Late-start-reviewv2/overhaul-v2.md`](../Late-start-reviewv2/overhaul-v2.md).
> Phases 1-2 of the automatic detection system (scheduler-driven flagging) and
> Phase 4 of the admin review pipeline remain as originally designed, with v2
> adding the `disputed` resolution action, Fathom link evidence, and the
> skip-transition follow-up behavior for terminal overran opportunities.
>
> Do not implement new behavior against this document without cross-referencing
> v2 — the closer-side guard model and "Provide Context" workflow are removed.

# Meeting Overran Review System — Design Specification v1

<!-- (original v1 content follows, unchanged) -->
```

**Step 2: Leave the rest of the v1 document unchanged**

No other edits. The superseded banner alone is sufficient.

**Step 3: Commit**

```bash
git add plans/late-start-review/late-start-review-design.md
git commit -m "docs: mark v1 late-start review design as superseded by v2 overhaul"
```

**Key implementation notes:**
- **Blockquote (`>`) is the right primitive.** Looks visually distinct at the top of the doc without restructuring the original content.
- **Relative link to the v2 design doc.** `../Late-start-reviewv2/overhaul-v2.md` works from the v1 location (both are siblings under `plans/`).
- **Be specific about what IS and ISN'T superseded.** The scheduler + admin pipeline are untouched — make that explicit so a future contributor doesn't assume the entire v1 plan is obsolete.
- **Do NOT delete any phase plans from `plans/late-start-review/phases/`.** They remain as history of the v1 implementation.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/late-start-review/late-start-review-design.md` | Modify | Prepend superseded banner |

---

### 6D — Final Verification Sweep

**Type:** Manual (grep + typecheck + browser verify)
**Parallelizable:** No — the end-of-v2 gate. Runs AFTER 6A, 6B, 6C are all merged.

**What:** A final sweep to confirm the codebase is clean, types still compile, and the full v2 flow still works end-to-end.

**Why:** Cleanup bugs are subtle — a stale import, a dangling reference in a test, a forgotten comment mentioning the deleted component. The sweep catches these before declaring v2 done.

**Where:**
- No file edits. Terminal commands only.

**How:**

**Step 1: Grep sweep**

```bash
# Deleted component references:
grep -rn "meeting-overran-context-dialog" app/ components/ convex/ plans/ --exclude-dir=.next --exclude-dir=node_modules
grep -rn "MeetingOverranContextDialog" app/ components/ convex/ plans/ --exclude-dir=.next --exclude-dir=node_modules

# Deprecated mutation call-sites:
grep -rn "respondToOverranReview" app/ components/ --exclude-dir=.next --exclude-dir=node_modules
grep -rn "scheduleFollowUpFromOverran" app/ components/ --exclude-dir=.next --exclude-dir=node_modules
```

Expected results:
- First two greps: zero matches (except in this phase doc, overhaul-v2.md, and the v1 design doc).
- Last two greps: zero matches in `app/` and `components/`. Matches are acceptable only inside `convex/closer/meetingOverrun.ts` (the declarations + any internal helpers — which, after running `simplify`, may have been cleaned up).

**Step 2: Full TypeScript check**

```bash
pnpm tsc --noEmit
```

Expected: zero errors.

**Step 3: Lint**

```bash
pnpm lint
```

Expected: zero errors; warnings about deprecated mutations (from `@deprecated` JSDoc) are acceptable.

**Step 4: `expect` verification** — full v2 browser sweep

Delegate to the `expect` skill:

```
Run the complete v2 end-to-end scenario suite:

1. CLOSER FLOW — FRESH OVERRAN:
   - Seed a meeting_overran meeting with pending review, no fathom, no follow-up.
   - Open /workspace/closer/meetings/[id] as the closer.
   - Verify: amber banner "Meeting Overran — Flagged for Review";
     FathomLinkField rendered empty above MeetingNotes;
     OutcomeActionBar shows Log Payment, Schedule Follow-Up, Mark No-Show, Mark as Lost.

2. CLOSER FLOW — SAVE FATHOM:
   - Paste "https://fathom.video/call/test-abc" into FathomLinkField. Click Save.
   - Verify: "✓ Saved {time}" appears; reload page; URL persists.

3. CLOSER FLOW — LOG PAYMENT (transitions):
   - Click Log Payment. Fill form. Submit.
   - Verify: banner flips to BLUE "Action Recorded — Awaiting Admin Review";
     Fathom URL still saved;
     OutcomeActionBar returns null.

4. ADMIN FLOW — VIEW REVIEW (closer-acted):
   - Admin opens /workspace/reviews. Verify new columns: Fathom (Provided/Missing), Current State.
   - Click the row. Review detail loads.
   - Verify: Fathom card shows the URL; only Acknowledge + Dispute buttons visible;
     context message "The closer has already taken action — opportunity is now payment_received".

5. ADMIN FLOW — DISPUTE:
   - Click Dispute. Verify destructive dialog. Submit "Dispute & Finalize".
   - Verify: page navigates back; row now shows "Disputed" red badge in Current State.
   - Reopen the same review detail. Verify Resolution card styled in red with ShieldAlert icon.

6. CLOSER FLOW — POST-DISPUTE:
   - Closer reopens the same meeting page.
   - Verify: banner is now RED "Review Disputed — Meeting overran is the final outcome";
     OutcomeActionBar returns null (opportunity is meeting_overran with a RESOLVED review);
     Fathom URL still visible and saveable.

7. ADMIN FLOW — FOLLOW-UP ON STILL-OVERRAN:
   - Seed a different meeting_overran review. As closer, create a manual reminder
     follow-up (opportunity stays meeting_overran, a followUps row with pending
     status is created).
   - Admin opens the review. Verify: opportunity badge shows "Meeting Overran";
     Current Follow-Up card shows Manual reminder, pending, reminder time;
     resolution bar shows only Acknowledge + Dispute with message about the follow-up.

8. ADMIN FLOW — FRESH NO-ACTION REVIEW:
   - Seed another meeting_overran review, closer has not acted.
   - Admin opens. Verify all 6 buttons (including override actions) render.

9. ADMIN FLOW — ADMIN SAVES FATHOM:
   - Admin opens /workspace/pipeline/meetings/[id] for a test meeting.
   - Verify FathomLinkField renders above MeetingNotes.
   - Save URL. Reload. Verify persistence.

10. ACCESSIBILITY:
    - Run axe + equal-access on every screen touched above.
    - Verify zero WCAG AA violations.
    - Test all flows at 4 viewports (360, 768, 1024, 1440).
    - Verify no console errors.
    - Verify LCP < 2.5s on /workspace/reviews and /workspace/closer/meetings/[id].

Report per-scenario pass/fail with screenshots for each step.
```

**Step 5: (Optional) Run `simplify` skill**

```
Use simplify on convex/closer/meetingOverrun.ts. The two deprecated exports
(respondToOverranReview, scheduleFollowUpFromOverran) may have private helper
functions that are now dead code (only the deprecated mutations called them).
Identify any helpers with zero other callers and remove them — this reduces
file size and tightens the deprecation surface.
```

If `simplify` identifies helpers, remove them in a follow-up commit within Phase 6D. Do NOT remove any helper that IS called from v2 code paths.

**Step 6: Commit verification evidence**

Create a short summary of the verification results (which scenarios passed, which tool versions / test dates). Append to `plans/Late-start-reviewv2/phases/phase6.md` under a new "Verification Log" heading before declaring v2 complete.

**Step 7: Deploy + announce**

Confirm Convex is deployed (`npx convex deploy` if targeting production), confirm Next.js build succeeds (`pnpm build`), and announce v2 live in the team channel.

**Key implementation notes:**
- **The `expect` suite is comprehensive.** It exercises 9 distinct behaviors across closer and admin. Each must pass independently.
- **Accessibility is a hard requirement.** Zero WCAG AA violations — the banner states, resolution dialog, and FathomLinkField all went through `web-design-guidelines` review in their respective phases; 6D is the final confirmation.
- **The simplify step is optional but recommended.** It trims dead code that the deprecation exposed. Don't let it block the phase if time is short — deprecated helpers are low-risk.
- **If ANY verification scenario fails, 6D is incomplete.** Fix the issue before closing v2. The plan explicitly disallows "ship with known broken flows."

**Files touched:**

| File | Action | Notes |
|---|---|---|
| (various, per `simplify` findings) | Modify / Delete | Only if `simplify` identifies dead code |
| `plans/Late-start-reviewv2/phases/phase6.md` | Modify | Append verification log |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | Delete | 6A |
| `convex/closer/meetingOverrun.ts` | Modify | 6B (@deprecated JSDoc on 2 exports) |
| `plans/late-start-review/late-start-review-design.md` | Modify | 6C (prepend superseded banner) |
| `plans/Late-start-reviewv2/phases/phase6.md` | Modify | 6D (append verification log) |
| (various from `simplify`) | Delete / Modify | 6D (optional dead-code trim) |

**Post-phase state:** v2 is complete and deployed. No orphaned v1 files. Deprecated mutations flagged for future removal. v1 design doc clearly marked as superseded. Full TypeScript + lint + browser verification pass. `pnpm tsc --noEmit` passes.

**Critical path:** 6D is the final gate. Runs strictly after 6A+6B+6C merge.
