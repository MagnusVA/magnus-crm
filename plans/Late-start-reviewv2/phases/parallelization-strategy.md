# Parallelization Strategy — Meeting Overran Review System v2

**Purpose:** This document defines the parallelization strategy across all 6 implementation phases of the v2 overhaul, identifying the critical path, dependency graph, and maximum concurrency opportunities. It complements the per-phase plans (`phase1.md` through `phase6.md`) by showing how they compose end-to-end.

**Prerequisite:** Meeting Overran Review System v1 fully deployed (`plans/late-start-review/late-start-review-design.md`). Specifically: `meetingReviews` table exists, the Convex scheduler-driven attendance detection is running, the admin `resolveReview` mutation exists with the v1 5-action union, and the closer meeting detail page renders the v1 banner + context dialog.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Schema & Status Transition Changes | Backend (Schema) | Low | v1 deployment (schema must be clean, detection running) |
| **2** | Backend — Replace Blanket Overran Guards | Backend | Medium-High | Phase 1 |
| **3** | Backend — Fathom Link & Disputed Resolution | Backend | High | Phase 1 |
| **4** | Frontend — Closer UX Overhaul | Full-Stack (mostly frontend, reads backend APIs from 2+3) | Medium-High | Phase 1, Phase 2, Phase 3A |
| **5** | Frontend — Admin Review Updates | Full-Stack (frontend reads new backend APIs from 3) | Medium-High | Phase 1, Phase 3C, Phase 3D, Phase 4A |
| **6** | Cleanup | Maintenance | Low | Phase 4, Phase 5 complete |

**Total estimated effort:**
- Solo developer (sequential with within-phase parallelism): 7.5 days
- Two developers (Backend / Frontend split): 5 days
- Three+ developers / agents: 3.5 days

---

## Master Dependency Graph

```
                        ┌────────────────────────────────────────────────┐
                        │                   PHASE 1                      │
                        │     Schema + MEETING_VALID_TRANSITIONS         │
                        │     (FOUNDATION — every other phase depends)   │
                        │     Subphases: 1A, 1B, 1C → 1D (deploy)         │
                        └──────────────┬─────────────────────────────────┘
                                       │
                         ┌─────────────┴─────────────┐
                         │                           │
                ┌────────▼──────────┐     ┌──────────▼──────────┐
                │     PHASE 2       │     │     PHASE 3         │
                │  Replace Overran  │     │  Fathom + Disputed  │
                │  Guards           │     │  Resolution         │
                │  (Backend)        │     │  (Backend)          │
                │  2A → 2B-2F       │     │  3A, 3B, 3C → 3D    │
                └────────┬──────────┘     └──────────┬──────────┘
                         │                           │
                         │                           │ (3A creates saveFathomLink)
                         │                           │ (3C adds activeFollowUp to queries)
                         │                           │ (3D adds disputed branch)
                         │                           │
                         └──────────────┬────────────┘
                                        │
                         ┌──────────────┴─────────────┐
                         │                            │
                ┌────────▼──────────┐       ┌─────────▼───────────┐
                │     PHASE 4       │       │     PHASE 5         │
                │  Closer UX        │       │  Admin Review       │
                │  Overhaul         │       │  Updates            │
                │  (Frontend)       │       │  (Frontend)         │
                │  4A, 4B, 4C, 4D   │       │  5A, 5B, 5C, 5D, 5E │
                │        → 4E       │       │         → 5F        │
                └────────┬──────────┘       └─────────┬───────────┘
                         │                            │
                         │  (4A's FathomLinkField     │
                         │   imported by 5A)          │
                         └──────────────┬─────────────┘
                                        │
                                ┌───────▼────────┐
                                │    PHASE 6     │
                                │   Cleanup      │
                                │   6A, 6B, 6C   │
                                │       → 6D     │
                                └────────────────┘
```

**Key observations:**
- Phase 1 gates everything (schema + transitions must exist before any 2/3 code can typecheck).
- Phase 2 and Phase 3 are **backend siblings** — they can run fully in parallel with two mildly-shared files (`meetingActions.ts` and `payments.ts`), both handled via deliberately non-overlapping edits.
- Phase 4 depends on Phase 2 + Phase 3A. Phase 5 depends on Phase 3C + Phase 3D + Phase 4A.
- Phase 6 is strictly last — it deletes the v1 dialog file and annotates v1 mutations as deprecated.

---

## Maximum Parallelism Windows

### Window 1: Phase 1 — Sequential Foundation

**Concurrency:** Up to 3 subphases in parallel within Phase 1, then 1 deploy step.

Phase 1 is small but sequential. 1A (meetings table fields), 1B (meetingReviews disputed literal), and 1C (MEETING_VALID_TRANSITIONS) each touch one file and can be edited in parallel. 1D is the deploy + typegen step that MUST follow.

```
Timeline:           ██████
          1A (meetings.fathomLink)  ──────┐
          1B (meetingReviews.disputed) ───┼── 1D (npx convex dev + verify)
          1C (meeting_overran→no_show) ───┘
```

**Internal parallelism:**
- 1A + 1B both edit `convex/schema.ts` (different table blocks). Single author can batch; two authors must coordinate via review/rebase.
- 1C edits `convex/lib/statusTransitions.ts` — fully independent.
- 1D runs after all three land — produces regenerated `convex/_generated/*` that Phases 2-6 consume.

**Estimated time:** 0.5 days.

---

### Window 2: Phase 2 + Phase 3 — Backend Full Parallelism

**Concurrency:** 2 independent backend streams.

After Phase 1 deploys, Phases 2 and 3 can run simultaneously. They operate on **nearly-disjoint file sets**:

- **Phase 2** owns: `convex/lib/overranReviewGuards.ts` (new), `convex/closer/noShowActions.ts`, `convex/closer/followUpMutations.ts`, `convex/closer/followUp.ts`, `convex/closer/payments.ts`, + modifies `convex/closer/meetingActions.ts::markAsLost`.
- **Phase 3** owns: `convex/lib/paymentHelpers.ts` (new), `convex/reviews/queries.ts`, `convex/reviews/mutations.ts`, `convex/lib/outcomeHelpers.ts` (small refactor), `convex/reporting/writeHooks.ts` (add `deleteCustomerAggregate`), + modifies `convex/closer/payments.ts` (small refactor for `syncCustomerPaymentSummary` import) + adds `convex/closer/meetingActions.ts::saveFathomLink` (new export).

**Two files are touched by both phases:**
1. **`convex/closer/meetingActions.ts`** — Phase 2B modifies `markAsLost`; Phase 3A appends `saveFathomLink`. Different code regions. **Mitigation:** 3A is an append-at-bottom edit; 2B is a middle-of-file edit. No textual overlap; merge naturally.
2. **`convex/closer/payments.ts`** — Phase 2F modifies `logPayment` (guard + error message); Phase 3B refactors `syncCustomerPaymentSummary` out to the shared helper. Different code regions (guard is inside the handler; helper is at module top). **Mitigation:** Phase 3B does ALL payment-helper refactors (across payments.ts + outcomeHelpers.ts) as a dedicated commit. Phase 2F edits only the `logPayment` handler body. If a merge conflict arises, it's trivial to resolve.

```
Timeline:             ██████████████████████████████████████
                      Phase 2 (Replace Overran Guards) ────┐
                      Phase 3 (Fathom + Disputed) ─────────┤
                                                            ▼
                                                       Window 3
```

**Within Phase 2 (internal parallelism):**
```
2A (lib/overranReviewGuards.ts — shared helper) ────┐
                                                     │  (must complete first — every 2B-2F depends on it)
                                                     │
                                                     ├── 2B (meetingActions.ts::markAsLost)
                                                     ├── 2C (noShowActions.ts::markNoShow)
                                                     ├── 2D (followUpMutations.ts — 4 handlers)
                                                     ├── 2E (followUp.ts action — ActionCtx variant)
                                                     └── 2F (payments.ts::logPayment)
```

**Within Phase 3 (internal parallelism):**
```
3A (saveFathomLink — new mutation) ────────────────┐
                                                    │
3B (lib/paymentHelpers.ts — 3 helpers) ─────┐       │
                                             ├── 3D (resolveReview — disputed branch)
3C (reviews/queries.ts — activeFollowUp) ────┘       │
                                                    │
                                                    (3A independent of 3B, 3C, 3D)
```

- Within Phase 2: 2A blocks everything; 2B-2F run in parallel after.
- Within Phase 3: 3A independent; 3B + 3C parallel; 3D waits on 3B + 3C.

**Estimated time:** 2 days (Phase 2 = 1.5 days, Phase 3 = 2 days — Phase 3 is the longer one, defines window duration).

---

### Window 3: Phase 4 + Phase 5 — Full-Stack Frontend Parallelism

**Concurrency:** 2 independent full-stack streams.

After Phase 2 and Phase 3 complete, Phase 4 (Closer UX) and Phase 5 (Admin Review) are largely independent UI surfaces serving different user roles:

- **Phase 4** builds / modifies: `app/workspace/closer/meetings/_components/*` and the closer meeting detail page.
- **Phase 5** builds / modifies: `app/workspace/reviews/*` (review list + detail) and the admin meeting detail page.

**Shared file:** `app/workspace/closer/meetings/_components/fathom-link-field.tsx` — created in 4A, imported in 5A. This is a **unidirectional** shared dependency: 5A reads a stable export from 4A. Coordinate so 4A merges before 5A starts. Or, if one developer does both phases, naturally sequences 4A → 5A as the first action of Phase 5.

```
Timeline:                                               ████████████████████████████████████████
                                                        Phase 4 (Closer UX)  ────────────────────┐
                                                        Phase 5 (Admin Review Updates) ──────────┤
                                                                                                  ▼
                                                                                             Window 4
```

**Within Phase 4 (internal parallelism):**
```
4A (FathomLinkField — new component) ────┐
                                          │
                                          ├──── 4E (meeting-detail-page-client.tsx — integration)
                                          │
4B (OutcomeActionBar — review-aware) ─────┤
                                          │
4C (MeetingOverranBanner — 4-state) ──────┤
                                          │
4D (MarkLostDialog — copy fix) ───────────┘
```

**Within Phase 5 (internal parallelism):**
```
5A (admin-meeting-detail-client.tsx — reuse FathomLinkField)  (fully independent)

5B (ReviewResolutionBar — dispute + narrow) ─┐
                                              │
5C (ReviewResolutionDialog — disputed config) ├──── 5F (ReviewDetailPageClient — integration)
                                              │
5D (ReviewContextCard — Fathom + follow-up)  ┤
                                              │
5E (ReviewsTable — v2 columns) ───────────────┘
```

- Within Phase 4: 4A-4D all parallel; 4E integrates and MUST be last.
- Within Phase 5: 5A fully independent (runs alone). 5B-5E parallel; 5F integrates and MUST be last.

**Estimated time:** 2 days (Phase 4 = 2 days, Phase 5 = 2 days — both max durations define window).

---

### Window 4: Phase 6 — Sequential Cleanup

**Concurrency:** 3 subphases in parallel, then 1 verification gate.

```
Timeline:                                                                                   ██████
                                                                                            6A (delete context dialog)  ─┐
                                                                                            6B (deprecate v1 mutations) ─┤── 6D (final verification)
                                                                                            6C (v1 doc superseded banner)─┘
```

**Within Phase 6:**
- 6A, 6B, 6C run in parallel (different files, zero shared state).
- 6D runs after all three merge — grep sweep, `pnpm tsc --noEmit`, full `expect` browser verification.

**Estimated time:** 0.25 days.

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 → Phase 3 → Phase 5 → Phase 6
  │          │          │         │
  │          │          │         └── Phase 6 (Cleanup, 0.25 day)
  │          │          └── Phase 5 (Admin Review Updates, 2 days)
  │          └── Phase 3 (Fathom + Disputed Resolution, 2 days)
  └── Phase 1 (Schema + Transitions, 0.5 day)

Total critical-path time: 4.75 days
```

**Alternative shorter path** (Phase 4 instead of Phase 5):

```
Phase 1 → Phase 2 → Phase 4 → Phase 6
 0.5 + 1.5 + 2 + 0.25 = 4.25 days
```

The Phase 5 path is slightly longer because Phase 5 depends on Phase 3's full completion (3D for the disputed branch), and 3D depends on 3B + 3C. Phase 3 itself is longer than Phase 2.

**Implication:** Start Phase 3 as early as possible after Phase 1 completes. Phase 3D (resolveReview disputed branch) is the single longest piece of work in the entire v2 rollout and sets the minimum achievable delivery time. Any schedule compression should focus on Phase 3 first, then Phase 5.

**Parallelism leverage:** With 2 backend developers, Phase 2 and Phase 3 run concurrently — the critical path collapses. The slowest path becomes whichever backend stream is longer (Phase 3 at 2 days), then the slowest frontend stream (Phase 5 at 2 days), then cleanup (0.25 day). Total: ~4.75 days with parallelism overhead, vs 5.75 days serial.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific directories / files to prevent conflicts.

| Directory / File | Phase Owner(s) | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | All schema changes happen in Phase 1A + 1B. No other phase touches this file. |
| `convex/lib/statusTransitions.ts` | **Phase 1 only** | Transition map update happens in 1C. |
| `convex/_generated/*` | **Phase 1 (regenerated in 1D)** | Every other phase consumes; never hand-edit. |
| `convex/lib/overranReviewGuards.ts` | **Phase 2 (create in 2A)** | Created once, consumed by 2B-2F and Phase 3D. |
| `convex/closer/noShowActions.ts` | **Phase 2 only** | 2C — single edit to `markNoShow` body. |
| `convex/closer/followUpMutations.ts` | **Phase 2 only** | 2D — 4 handler edits. |
| `convex/closer/followUp.ts` | **Phase 2 only** | 2E — single guard replacement. |
| `convex/closer/payments.ts` | **Phase 2F (modify logPayment body) + Phase 3B (refactor syncCustomerPaymentSummary)** | Different code regions. See "Two files are touched by both phases" in Window 2 above. |
| `convex/closer/meetingActions.ts` | **Phase 2B (modify markAsLost) + Phase 3A (append saveFathomLink)** | Different code regions. Append-at-bottom from 3A, middle-of-file edit from 2B. |
| `convex/lib/paymentHelpers.ts` | **Phase 3B (create)** | New file; 3D consumes. |
| `convex/lib/outcomeHelpers.ts` | **Phase 3B only** | Small refactor: delete inline `syncCustomerPaymentSummary`, import from paymentHelpers. |
| `convex/reporting/writeHooks.ts` | **Phase 3B only** | Add `deleteCustomerAggregate` to make disputed customer rollback concrete and reversible. |
| `convex/reviews/queries.ts` | **Phase 3 only** | 3C — add `activeFollowUp` enrichment. |
| `convex/reviews/mutations.ts` | **Phase 3 only** | 3D — expand union, add gate, add disputed branch. |
| `app/workspace/closer/meetings/_components/fathom-link-field.tsx` | **Phase 4 (create in 4A)** | Shared — Phase 5A imports from this path. |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | **Phase 4 only** | 4B — review-aware. |
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | **Phase 4 only** | 4C — 4-state rewrite. |
| `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` | **Phase 4 only** | 4D — copy fix. |
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | **Phase 6 (delete)** | Phase 4C already removed the import; Phase 6A deletes the file. |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | **Phase 4 only** | 4E — integration. |
| `app/workspace/pipeline/meetings/[meetingId]/_components/admin-meeting-detail-client.tsx` | **Phase 5 only** | 5A — import FathomLinkField + render above MeetingNotes. |
| `app/workspace/reviews/_components/reviews-table.tsx` | **Phase 5 only** | 5E — v2 columns. |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | **Phase 5 only** | 5B — add dispute, narrow on already-acted. |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-dialog.tsx` | **Phase 5 only** | 5C — disputed action config. |
| `app/workspace/reviews/[reviewId]/_components/review-context-card.tsx` | **Phase 5 only** | 5D — Fathom + follow-up cards, disputed styling. |
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | **Phase 5 only** | 5F — integration. |
| `convex/closer/meetingOverrun.ts` | **Phase 6 only** | 6B — @deprecated JSDoc annotations. |
| `plans/late-start-review/late-start-review-design.md` | **Phase 6 only** | 6C — superseded banner. |
| `convex/pipeline/inviteeNoShow.ts`, `convex/pipeline/inviteeCanceled.ts`, `convex/pipeline/inviteeCreated.ts` | **None (unchanged)** | Intentionally NOT modified in v2. Webhook guards remain correct. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism to batch edits efficiently and minimize context-switching:

1. **Phase 1** — Edit 1A + 1B + 1C in one session, run 1D to deploy. (~4 hours)
2. **Phase 2** — Start 2A (shared helper), then batch 2B + 2C + 2F (simpler guards), then 2D (four-handler followUpMutations), then 2E. (~1.5 days)
3. **Phase 3** — Start 3A (saveFathomLink) first as a palate-cleanser, then 3B (paymentHelpers) + 3C (queries enrichment) — both can be done back-to-back, then 3D (resolveReview disputed branch, longest single subphase in the whole rollout). (~2 days)
4. **Phase 4** — Start 4A (FathomLinkField), then batch 4B + 4C + 4D (independent frontend work), then 4E (integration + expect verification). (~2 days)
5. **Phase 5** — Start 5A (admin meeting detail — trivial reuse), then batch 5B + 5C + 5D + 5E (independent admin work), then 5F (integration + expect verification). (~2 days)
6. **Phase 6** — Batch 6A + 6B + 6C, then 6D (final verification). (~0.25 day)

**Estimated time:** 7.5 days.

---

### Two Developers (Backend + Frontend Split)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| Sprint 1 (Day 1) | Phase 1A + 1B + 1C + 1D | Study Phase 4, 5 plans; prep design mocks; wait on Phase 1 completion before touching types |
| Sprint 2 (Days 2-3) | Phase 2A (shared helper) → Phase 2B, 2C, 2D, 2E, 2F in sequence | — (blocked: backend changes in flight) |
| Sprint 3 (Days 3-4) | Phase 3A → Phase 3B + 3C in parallel → Phase 3D | Start Phase 4A (FathomLinkField — depends only on 3A `saveFathomLink` export). Begin Phase 4B, 4C, 4D once 2B, 2D are live. |
| Sprint 4 (Day 5) | Start Phase 5A (admin meeting detail — small) while frontend primary work continues | Phase 4E integration → Phase 5B + 5C + 5D + 5E in parallel |
| Sprint 5 (Day 6) | Join for Phase 5F integration + expect verification | Phase 5F integration + expect verification |
| Sprint 6 (Day 7) | Phase 6 (split subphases: A+B+C) | Phase 6 split — both pair on 6D verification |

**Estimated time:** 5 days.

---

### Three+ Developers / Agents

| Sprint | Agent A (Backend - Path 1) | Agent B (Backend - Path 2) | Agent C (Frontend) |
|---|---|---|---|
| Sprint 1 | Phase 1 (all subphases) | — (blocked on Phase 1) | — (blocked on Phase 1) |
| Sprint 2 | Phase 2A, 2B, 2C, 2D (largest), 2E, 2F | Phase 3A (saveFathomLink) + 3B (paymentHelpers) | Phase 4A (FathomLinkField — depends on 3A export) + 4D (copy fix — independent) |
| Sprint 3 | Idle / review Phase 3 PRs | Phase 3C + 3D (resolveReview disputed — the critical path) | Phase 4B + 4C (banner + action bar — independent of Phase 3) |
| Sprint 4 | Pair on Phase 5 (backend-side edits to `reviews-table.tsx` data flow — mostly consuming Phase 3C output) | Pair on Phase 4E integration + expect verification | Phase 5A + 5B + 5C + 5D + 5E in parallel |
| Sprint 5 | — | Phase 6A + 6B + 6C | Phase 5F integration + expect + Phase 6D |

**Estimated time:** 3.5 days.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 (1D) | `npx convex dev` succeeds. `pnpm tsc --noEmit` passes. `MEETING_VALID_TRANSITIONS.meeting_overran` includes `no_show`. `Doc<"meetings">` type shows `fathomLink?: string` and `fathomLinkSavedAt?: number`. `Doc<"meetingReviews">.resolutionAction` includes `"disputed"` literal. |
| **Gate 2** | After Phase 2 | All 6 closer mutations (`markAsLost`, `markNoShow`, `createSchedulingLinkFollowUp`, `confirmFollowUpScheduled`, `createManualReminderFollowUpPublic`, `logPayment`) plus the `createFollowUp` action accept `meeting_overran` opportunity with pending review. All reject with `"This meeting-overran review has already been resolved."` when the review is resolved. Follow-up mutations create records without transitioning the opportunity. `pnpm tsc --noEmit` passes. |
| **Gate 3** | After Phase 3 | `api.closer.meetingActions.saveFathomLink` exists and persists the link. `api.reviews.queries.listPendingReviews` returns `activeFollowUp` per row. `api.reviews.mutations.resolveReview({ resolutionAction: "disputed" })` reverts the opportunity to `meeting_overran`, marks payment disputed (if applicable), rolls back customer conversion (if applicable), expires pending follow-ups. Tenant stats are correctly reversed. `pnpm tsc --noEmit` passes. |
| **Gate 4** | After Phase 4 | Closer opens a flagged meeting → banner visible with 4-state treatment (amber/blue/emerald/red) across the review lifecycle → FathomLinkField saves + persists → OutcomeActionBar renders 4 actions while pending, null while resolved. `expect` suite 5 closer-scenarios pass. WCAG AA audit passes. `pnpm tsc --noEmit` passes. |
| **Gate 5** | After Phase 5 | Admin opens `/workspace/reviews` → table shows Fathom + Current State columns with disputed red badge for resolved-disputed rows. Admin opens review detail → Fathom card + Active Follow-Up card (if any) + resolution bar with 2 or 6 buttons based on closer-already-acted state. Dispute flow end-to-end works: closer logs payment → admin disputes → payment disputed, customer rollback, banner flips to red for closer. Admin meeting detail has FathomLinkField. `expect` suite 9 scenarios pass across 4 viewports. `pnpm tsc --noEmit` passes. |
| **Gate 6** | After Phase 6 | `meeting-overran-context-dialog.tsx` does not exist. Zero references to `MeetingOverranContextDialog` in `app/` / `components/`. v1 mutations annotated `@deprecated`. v1 design doc has superseded banner. Full expect browser verification of all v2 flows passes. `pnpm tsc --noEmit` passes. `pnpm lint` passes. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema push fails on existing documents | **Critical** | All changes are additive (`v.optional`, expanded union). Invoke `convex-migration-helper` skill immediately on any failure. Deploy against dev first; do not push to prod until dev deployment is clean. |
| `assertOverranReviewStillPending` helper (2A) incorrectly blocks valid closer actions because review lookup fails silently | **High** | The helper returns silently when no review exists — this intentionally permits action. Verify with a unit-equivalent: call the helper on an opportunity with status `meeting_overran` but no review record; it should not throw. Covered in Phase 2's acceptance criteria + Gate 2. |
| Phase 3D disputed flow leaves tenant stats inconsistent after customer rollback | **Critical** | `rollbackCustomerConversionIfEmpty` (Phase 3B) is designed to be transactional-safe with Convex's mutation model. The implementation delta computation mirrors the forward `executeConversion` exactly. Gate 3 explicitly checks stats consistency. Run `npx convex insights` before/after a test dispute to confirm. |
| Phase 2 + Phase 3 parallel work creates merge conflicts on `convex/closer/meetingActions.ts` or `convex/closer/payments.ts` | Medium | Discipline: 3A appends at file bottom; 2B modifies middle; 3B's payments.ts refactor is at module-top (above `logPayment`); 2F modifies handler body. Each author commits once they complete their subphase; resolve via `git` if both hit simultaneously. Plan explicitly calls out these two shared files in the File Ownership table. |
| Phase 5 frontend built against Phase 3 backend that isn't deployed yet → runtime errors | Medium | Phase 5 explicitly lists Phase 3C + 3D as prerequisites. Run `npx convex dev` / `convex deploy` between phases so API types are fresh. If a 3D prerequisite slips, Phase 5 authors can stub `activeFollowUp: null` locally — safe because the backend is permissive when closer hasn't acted. |
| FathomLinkField (4A) released before admin meeting detail import (5A) is ready, causing admin page to look inconsistent (no Fathom field) | Low | Phase 5A is explicitly marked as depending on Phase 4A. Easiest mitigation: the same developer does 4A and 5A back-to-back. Worst case: admins don't see the Fathom field for a day — acceptable during a short rollout window. |
| Phase 6A deletes the context dialog while a cached browser bundle still imports it → runtime import error | Low | The v2 `MeetingOverranBanner` (Phase 4C) removes the import before Phase 6 runs. A user's cached v1 bundle would still reference the old banner (not the dialog directly) — the worst case is a render of the old banner with a no-op Provide Context button. Negligible UX impact. Mitigation: deploy Phase 4 at least 24 hours before Phase 6. |
| Admin disputes a review while closer is actively editing the Fathom link → concurrent writes | Low | `saveFathomLink` patches only `meeting.fathomLink`. `resolveReview::disputed` patches opportunity + meeting status + payments + follow-ups — never `fathomLink`. No write conflict. The Fathom link persists through dispute, which is the intended semantic (Section 14.2 of `overhaul-v2.md`). |
| Reporting drift: `convex/reporting/lib/outcomeDerivation.ts` still maps `meeting_overran` to `no_show` / `in_progress` incorrectly | Medium | Explicitly deferred in Open Question #8 of `overhaul-v2.md` and Section 14.11. Not addressed in v2. Flag it as a known issue — any future reporting work must fix this BEFORE claiming v2 analytics accuracy. Documented in Phase 1 notes and re-noted in the final `expect` verification (log the known-gap). |
| Disputed payment rollback forgets to remove the customer reporting aggregate row | Medium | Phase 3B explicitly adds `deleteCustomerAggregate(ctx, customerId)` to `convex/reporting/writeHooks.ts` and requires `rollbackCustomerConversionIfEmpty(...)` to call it before deleting the customer row. Gate 3 verifies the full rollback path. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-migration-helper`, `convex-performance-audit` | Confirm additive changes don't require migration; sanity-check that no new index is needed. |
| **2** | `convex-setup-auth`, `convex-performance-audit` | Shared guard helper reads `meetingReviews` via indexed lookup — confirm pattern + performance. |
| **3** | `convex-setup-auth`, `convex-migration-helper`, `convex-performance-audit` | `saveFathomLink` follows `updateMeetingNotes` auth pattern; disputed flow must not leave intermediate inconsistent state; query enrichment adds N+1 parallel reads (bounded). |
| **4** | `frontend-design`, `shadcn`, `web-design-guidelines`, `vercel-react-best-practices`, `expect`, `vercel-react-view-transitions` (optional) | New component + 4-state banner + review-aware action bar — full frontend stack. Accessibility audit on all 4 banner states. |
| **5** | `frontend-design`, `shadcn`, `web-design-guidelines`, `vercel-react-best-practices`, `expect` | Admin review detail is the admin's primary decision surface — invest in polish. 9-scenario expect suite. |
| **6** | `simplify`, `convex-performance-audit` (optional) | Run `simplify` on `convex/closer/meetingOverrun.ts` after deprecating the two exports — may catch dead helper functions. Optional `npx convex insights` to confirm zero production calls to deprecated mutations. |

---

## Rollout Sequence (Production Deploy)

v2 ships as a single coordinated deploy after all 6 phases merge to `main`:

1. **Deploy Phase 1 schema** — `npx convex deploy` (or via CI). Validates against existing docs before accepting.
2. **Deploy Phases 2 + 3 backend** — same `npx convex deploy`. Mutations accept new behavior; queries return new fields; existing clients (still on v1 UI) ignore unknown return fields without error (Convex forward-compat).
3. **Deploy Phases 4 + 5 frontend** — `pnpm build` → Next.js deploy. New UI renders; new behavior live.
4. **Phase 6 cleanup** — separate commit/PR/deploy. Deletes orphaned file, adds JSDoc, updates v1 doc. No user-visible change.

Because the 1 production tenant and staff are small (per AGENTS.md header: "1 test tenant on production"), a single coordinated deploy is feasible. For larger tenant populations a later version of this system could stagger via feature flags, but v2 does not need this complexity.

---

*This strategy maximizes parallelization while respecting the strict dependency chain: Schema → Backend Guards + Fathom Backend → Frontend (Closer + Admin) → Cleanup. The key insight: Phase 2 and Phase 3 touch nearly disjoint code paths (guards vs. review resolution + Fathom), and Phase 4 / Phase 5 serve different user roles (closer vs. admin) — these are the parallelism opportunities that collapse total delivery time from ~7.5 days to ~3.5 days with sufficient staffing.*
