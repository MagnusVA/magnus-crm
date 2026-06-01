# Parallelization Strategy — Meeting Overran & Review System

**Purpose:** This document defines the parallelization strategy across all 6 implementation phases, identifying the critical path, dependency graph, maximum concurrency opportunities, file ownership boundaries, and execution strategies for solo, two-developer, and three+ developer/agent configurations.

**Prerequisite:** v0.6 schema deployed. Design document finalized at `plans/late-start-review/late-start-review-design.md`.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Foundation: Schema, Status Renames & WIP Cleanup | Full-Stack | High | None (foundation) |
| **2** | Backend: Automatic Attendance Detection | Backend | Medium-High | Phase 1 |
| **3** | Backend: Closer Context Submission | Backend | Medium | Phase 1, Phase 2 (2A only) |
| **4** | Backend: Admin Review Resolution | Backend | Medium-High | Phase 1 |
| **5** | Frontend: Closer Experience | Frontend | High | Phase 1, Phase 3 |
| **6** | Frontend: Admin Review Pipeline | Frontend | High | Phase 1, Phase 4 |

---

## Master Dependency Graph

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              PHASE 1                                      │
│  Foundation: Schema, Status Renames & WIP Cleanup (FOUNDATION)            │
│  Type: Full-Stack | ~34 files | Estimated: 1-2 days                      │
└─────────┬────────────────────────────┬───────────────────────────────────┘
          │                            │
          │                            │
┌─────────▼──────────┐                │
│      PHASE 2       │                │
│  Automatic         │                │
│  Attendance        │                │
│  Detection         │                │
│  (Backend)         │                │
└─────────┬──────────┘                │
          │                            │
          │ ┌──────────────────────────┤
          │ │                          │
┌─────────▼─▼────────┐     ┌──────────▼──────────┐
│      PHASE 3       │     │      PHASE 4        │
│  Closer Context    │     │  Admin Review        │
│  Submission        │     │  Resolution          │
│  (Backend)         │     │  (Backend)           │
└─────────┬──────────┘     └──────────┬───────────┘
          │                            │
┌─────────▼──────────┐     ┌──────────▼──────────┐
│      PHASE 5       │     │      PHASE 6        │
│  Closer            │     │  Admin Review        │
│  Experience        │     │  Pipeline            │
│  (Frontend)        │     │  (Frontend)          │
└────────────────────┘     └─────────────────────┘
```

**Key observation:** After Phase 1, the work splits into two completely independent tracks:
- **Backend Track A:** Phase 2 → Phase 3 → Phase 5 (Closer flow)
- **Backend Track B:** Phase 4 → Phase 6 (Admin flow)

Phase 2 feeds Phase 3 (the detection function creates reviews that closers respond to). Phase 3 and Phase 4 are independent (different files). Phase 5 and Phase 6 are independent (different routes).

---

## Maximum Parallelism Windows

### Window 1: Sequential Foundation (Must Complete First)

**Concurrency:** Up to 3 subphases in parallel within Phase 1.

Phase 1 is the critical foundation. Everything blocks on it. However, it has internal parallelism:

```
Timeline: ████████████████████████████████████████
          1A (schema) ─────────────────┐
          1B (status transitions) ─────┤── 1C (backend renames) ──────────┐
                                       ├── 1D (frontend renames) ─────────┤── 1F (deploy & verify)
                                       └── 1E (WIP removal + rename) ─────┘
```

**Internal parallelism:**
- 1A + 1B run in parallel (different files: `schema.ts` vs `statusTransitions.ts` + `tenantStatsHelper.ts`)
- Once 1A + 1B complete → 1C + 1D + 1E run in parallel (different file sets — see ownership table)
- Once all complete → 1F (deploy + verify)

---

### Window 2: Full Backend Parallelism

**Concurrency:** 2 completely independent backend streams running simultaneously.

After Phase 1 completes, Phase 2 and Phase 4 have **zero shared files**:

- **Phase 2** works in `convex/closer/meetingOverrun.ts` (new), `convex/pipeline/inviteeCreated.ts`, `convex/pipeline/inviteeCanceled.ts`, `convex/pipeline/inviteeNoShow.ts`, `convex/closer/meetingActions.ts`, `convex/admin/meetingActions.ts`
- **Phase 4** works in `convex/reviews/queries.ts`, `convex/reviews/mutations.ts`

No merge conflicts. No shared state.

```
Timeline:                    ████████████████████████████████████████████████
                             Phase 2 (Attendance Detection) ──────────────────┐
                                                                               │
                             Phase 4 (Admin Resolution) ──────┐               │
                                                               │               │
                                                               ▼               ▼
                                                          Window 3A       Window 3B
```

**Within Phase 2 (internal parallelism):**
```
2A (checkMeetingAttendance) ─────────────┐
                                          ├── 2C (cancel on normal flows)
2B (pipeline hooks — 3 paths) ───────────┤
                                          ├── 2D (webhook isolation)
                                          └── (2C + 2D share files — combine)
```

**Within Phase 4 (internal parallelism):**
```
4A (listPendingReviews) ─────────────────┐
4B (getReviewDetail) ────────────────────┤  (all in same file — queries.ts)
4C (getPendingReviewCount) ──────────────┘
                                          │
4D (resolveReview) ──────────────────────── (mutations.ts — independent)
```

---

### Window 3: Phase 3 + Phase 5/6 Overlap

**Concurrency:** Up to 3 streams.

Phase 3 (closer backend) starts after Phase 2. Phase 5 (closer frontend) starts after Phase 3. Phase 6 (admin frontend) starts after Phase 4.

If Phase 4 finishes before Phase 2+3, Phase 6 can start immediately while Phase 3 is still in progress.

```
Timeline:                                        ████████████████████████████████████████
                                                  Phase 3 (Closer Context) ──────────────┐
                                                                                          │
                                                  Phase 6 (Admin Frontend) ─────────────┤
                                                                                          │
                                                               Phase 3 complete ──────────┤
                                                                                          │
                                                               Phase 5 (Closer Frontend) ─┘
```

**Within Phase 3 (internal parallelism):**
```
3A (respondToOverranReview) ─────────────┐
3B (scheduleFollowUpFromOverran) ────────┤  (same file — sequential)
                                          │
3C (meetingDetail enrichment) ───────────── (different file — parallel)
```

---

### Window 4: Full Frontend Parallelism

**Concurrency:** 2 completely independent frontend streams.

Phase 5 and Phase 6 have **zero shared files**:

- **Phase 5** works in `app/workspace/closer/meetings/_components/` (new + modify)
- **Phase 6** works in `app/workspace/reviews/` (new), `app/workspace/_components/workspace-shell-client.tsx`

```
Timeline:                                                         ████████████████████████████████████████
                                                                  Phase 5 (Closer Frontend) ────────────┐
                                                                  Phase 6 (Admin Frontend) ─────────────┤
                                                                                                         ▼
                                                                                                    Integration
```

**Within Phase 5 (internal parallelism):**
```
5A (context dialog) ─────────────────────┐
5B (overran banner) ─────────────────────┤── 5C (outcome action bar) ──┐
                                          │                             ├── 5D (detail page integration)
5E (dashboard + pipeline) ───────────────┘                             │
                                                                        └── Complete
```

**Within Phase 6 (internal parallelism):**
```
6A (review list page) ───────────────────┐
6B (review detail page) ─────────────────┤
6C (resolution bar + dialogs) ───────────┤── 6D (sidebar + badge)
                                          │
6E (admin pipeline integration) ─────────┘
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum implementation time):

```
Phase 1 → Phase 2 → Phase 3 → Phase 5
  │          │         │         │
  │          │         │         └── Closer frontend experience (context dialog, banner, detail)
  │          │         └── Closer backend mutations (respond, follow-up, query enrichment)
  │          └── Scheduler-based attendance detection
  └── Schema refactoring + status renames + WIP cleanup
```

**Critical path estimated time:** 1.5 + 1 + 0.5 + 2.5 = **5.5 days** (solo, sequential)

**Alternative shorter path:**
```
Phase 1 → Phase 4 → Phase 6
  │          │         │
  │          │         └── Admin review pipeline pages
  │          └── Admin review queries + mutations
  └── Schema refactoring + status renames + WIP cleanup
```

This path is shorter (1.5 + 1 + 3 = **5.5 days**). Both paths are approximately equal, so neither is strictly shorter. The admin path could be faster if the frontend work (Phase 6) is simpler than estimated.

**Implication:** Start Phase 2 AND Phase 4 as early as possible after Phase 1 completes. They are both on critical paths for their respective frontend phases and can run in full parallel.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific directories/files to prevent conflicts:

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | All schema changes happen in Phase 1. No later phase modifies it. |
| `convex/lib/statusTransitions.ts` | **Phase 1 only** | Status transition map changes in Phase 1 only. |
| `convex/lib/tenantStatsHelper.ts` | **Phase 1 only** | Active statuses set changes in Phase 1 only. |
| `convex/lib/permissions.ts` | **Phase 1 only** | Already present — no changes needed. |
| `lib/status-config.ts` | **Phase 1 only** | Status config + pipeline display order updated in Phase 1. |
| `convex/closer/meetingOverrun.ts` | **Phase 2 (create) → Phase 3 (extend)** | New file. Phase 2 creates with `checkMeetingAttendance`. Phase 3 adds `respondToOverranReview` and `scheduleFollowUpFromOverran`. Sequential — no conflict. |
| `convex/pipeline/inviteeCreated.ts` | **Phase 2 only** | Pipeline hook additions. |
| `convex/pipeline/inviteeCanceled.ts` | **Phase 1 (rename) → Phase 2 (cancel + isolation)** | Phase 1 renames status. Phase 2 adds cancellation + domain event. Sequential. |
| `convex/pipeline/inviteeNoShow.ts` | **Phase 1 (rename) → Phase 2 (cancel + isolation)** | Same as above. |
| `convex/closer/meetingActions.ts` | **Phase 1 (rename, field rename) → Phase 2 (cancellation)** | Sequential. |
| `convex/admin/meetingActions.ts` | **Phase 1 (field rename) → Phase 2 (cancellation)** | Sequential. |
| `convex/reviews/queries.ts` | **Phase 1 (fix type errors) → Phase 4 (refactor)** | Phase 1 fixes compile errors from schema change. Phase 4 rewrites functions. Sequential. |
| `convex/reviews/mutations.ts` | **Phase 1 (fix type errors) → Phase 4 (refactor)** | Same as above. |
| `convex/closer/meetingDetail.ts` | **Phase 3 only** | Review enrichment. |
| `convex/closer/lateStartReview.ts` | **Phase 1 (delete)** | Removed in Phase 1. |
| `app/workspace/closer/meetings/_components/late-start-reason-dialog.tsx` | **Phase 1 (delete)** | Removed in Phase 1. |
| `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` | **Phase 1 (remove imports) → Phase 5 (update behavior)** | Sequential. |
| `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx` | **Phase 5 only** | New file. |
| `app/workspace/closer/meetings/_components/meeting-overran-banner.tsx` | **Phase 5 only** | New file. |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | **Phase 5 only** | Banner integration. |
| `app/workspace/reviews/` | **Phase 6 only** | Entire new directory. |
| `app/workspace/_components/workspace-shell-client.tsx` | **Phase 6 only** | "Reviews" nav item + badge. |
| All remaining `convex/` files (dashboard, pipeline, followUp, etc.) | **Phase 1 only** | Status renames — mechanical, one-time. |
| All remaining `app/` reporting files | **Phase 1 only** | Status renames — mechanical, one-time. |

**Key rule:** No two phases that run in parallel ever touch the same file. All shared files are modified sequentially via phase dependencies.

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism. The solo developer benefits from reduced context switching by batching backend and frontend work.

1. **Phase 1** — Foundation (all subphases: schema → renames → WIP removal → deploy)
2. **Phase 2** — Attendance detection (create meetingOverrun.ts → pipeline hooks → cancellation + isolation)
3. **Phase 3** — Closer context (respondToReview → scheduleFollowUp → query enrichment)
4. **Phase 4** — Admin resolution (queries → mutation — batch all backend at once)
5. **Phase 5** — Closer frontend (dialog → banner → action bar → detail page → pipeline)
6. **Phase 6** — Admin frontend (list page → detail page → resolution dialog → sidebar)

**Estimated time:** 8–10 days

### Two Developers (Backend + Frontend)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| 1 | Phase 1 (all backend subphases: 1A, 1B, 1C, 1E) | Phase 1 (frontend subphases: 1D — blocked until 1A+1B) |
| 2 | Phase 2 (full) + Phase 4 (full) — in parallel, different files | Phase 1F verify + stub frontend pages (blocked on Phase 1 deploy) |
| 3 | Phase 3 (full) — closer backend | Phase 6A-6B (review list + detail pages — Phase 4 backend ready) |
| 4 | Integration testing + bug fixes | Phase 5 (full — Phase 3 backend ready) + Phase 6C-6E (resolution + nav) |
| 5 | End-to-end testing | End-to-end testing |

**Estimated time:** 5–6 days

### Three+ Developers / Agents

| Sprint | Agent A (Backend — Closer Track) | Agent B (Backend — Admin Track) | Agent C (Frontend) |
|---|---|---|---|
| 1 | Phase 1A, 1B, 1C, 1E (schema + backend renames) | Phase 1D (frontend renames) | — (blocked on Phase 1) |
| 2 | Phase 2 (attendance detection) | Phase 4 (admin review queries + mutation) | Phase 1F (deploy + verify) |
| 3 | Phase 3 (closer context mutations) | — (done with backend) | Phase 6 (admin review pipeline — Phase 4 ready) |
| 4 | Integration testing | — | Phase 5 (closer experience — Phase 3 ready) |
| 5 | End-to-end testing | End-to-end testing | End-to-end testing |

**Estimated time:** 4–5 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 | `npx convex dev` succeeds. `pnpm tsc --noEmit` passes. Zero references to `pending_review`, `closer_no_show`, `overranDurationMs` in codebase. `convex/closer/lateStartReview.ts` deleted. App loads without errors. |
| **Gate 2** | After Phase 2 | Schedule a meeting via Calendly webhook. Wait for scheduled end time + 1 minute. Verify: meeting → `meeting_overran`, opportunity → `meeting_overran`, `meetingReviews` record created with `status: "pending"`. Verify: starting a meeting cancels the attendance check. Verify: cancelling a meeting cancels the attendance check. |
| **Gate 3** | After Phase 3 + 4 | Call `respondToOverranReview` as closer — verify review updated. Call `scheduleFollowUpFromOverran` — verify opportunity → `follow_up_scheduled`. Call `resolveReview` as admin with each action — verify correct transitions. Call `resolveReview` with `log_payment` when `closerResponse === "forgot_to_press"` — verify meeting → `completed`. |
| **Gate 4** | After Phase 5 | Navigate to flagged meeting as closer. Verify: overran banner renders. Provide context via dialog. Verify: banner updates reactively. Schedule follow-up. Verify: opportunity status changes reactively. |
| **Gate 5** | After Phase 6 | Navigate to `/workspace/reviews` as admin. Verify: pending reviews listed. Click through to detail. Verify: context cards render. Resolve with each action. Verify: review disappears from pending list. Verify: sidebar badge count decrements. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema errors block everything | **Critical** | Deploy schema immediately after writing. Run `npx convex dev` before proceeding. With 1 test tenant, no data migration needed — but verify no existing documents violate new schema. |
| Status rename misses a file | High | Use codebase-wide grep after all renames: `grep -r "pending_review\|closer_no_show\|overranDurationMs"`. TypeScript compilation catches most misses — any reference to a removed literal fails `tsc`. |
| Scheduler latency causes false positives | Medium | The 1-minute grace period after scheduled end handles typical meeting overruns. The idempotent guard prevents double-flagging. For MVP, this is acceptable. Post-MVP: configurable per-tenant grace period. |
| Pipeline mutation too large (inviteeCreated.ts is 2000+ lines) | Medium | The attendance check hook is only 10 lines per insertion point. Keep changes minimal and isolated to the 3 meeting creation sections. No refactoring of existing logic. |
| Frontend built against missing backend | Medium | Phase plans list exact backend function dependencies per frontend subphase. Frontend phases depend on their backend phases completing first. |
| Resolution dialog complexity | Medium | Each resolution action has its own Zod schema. Use action-specific conditional rendering rather than one monolithic form. Keep each dialog simple with minimal fields. |
| Merge conflicts between closer and admin tracks | Low | File ownership table ensures zero overlap. The only shared files are modified sequentially via phase dependencies. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-migration-helper` (optional) | `overranDurationMs` → `exceededScheduledDurationMs` rename affects production data. With 1 test tenant, direct rename is acceptable. |
| **2** | — | Pure Convex backend. Refer to `convex/_generated/ai/guidelines.md`. |
| **3** | — | Pure Convex backend. Same guidelines. |
| **4** | — | Pure Convex backend. Same guidelines. |
| **5** | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `expect` | Context dialog, overran banner, form handling, browser verification. |
| **6** | `frontend-design`, `shadcn`, `vercel-react-best-practices`, `next-best-practices`, `vercel-composition-patterns`, `web-design-guidelines`, `expect` | Full review pipeline UI with SSR, composition patterns, accessibility. |

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insight: after the foundation phase, the closer track (Phase 2 → 3 → 5) and admin track (Phase 4 → 6) are completely independent — they touch different directories, serve different user roles, and have zero shared files. Both tracks can run in full parallel with separate developers or agents.*
