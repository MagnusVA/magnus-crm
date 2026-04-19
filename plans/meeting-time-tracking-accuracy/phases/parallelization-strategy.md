# Parallelization Strategy — Meeting Time Tracking Accuracy

**Purpose:** This document defines the parallelization strategy across the three implementation phases of the Meeting Time Tracking Accuracy feature, identifying the critical path, dependency graph, file-ownership boundaries, and maximum concurrency opportunities. Phase 4 (dangling `in_progress` safety-net sweep) is in scope of the design document but deferred from v0.1 per Open Question §13.3; it is included in the dependency graph as a dotted-line optional phase.

**Prerequisite:** v0.6 time-tracking schema is already deployed (`meetings.startedAt`, `stoppedAt`, `completedAt`, `lateStartDurationMs`, `exceededScheduledDurationMs`, `overranDetectedAt`, `reviewId`, `fathomLink`, `fathomLinkSavedAt`). `meetingReviews` table exists with the existing resolution fields. The `stopMeeting` mutation exists on the backend (unexposed in UI). The overran detection cron + sweep (`checkMeetingAttendance` / `meetingOverrunSweep`) is deployed and operational on the test tenant.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Decouple outcome actions + `markNoShow` end-time semantics | Backend | Low | v0.6 deployed (prior feature) |
| **2** | Explicit "End Meeting" closer button | Full-Stack (mostly frontend) | Low–Medium | Phase 1 |
| **3** | Admin manual time entry during overran review | Full-Stack | Medium | Phase 1 |
| **4** | Dangling `in_progress` safety-net sweep (deferred — optional) | Backend | Low | Phase 1 |

---

## Master Dependency Graph

```
                ┌─────────────────────────────────────────────────────────┐
                │                         PHASE 1                         │
                │   Decouple + markNoShow end-time semantics              │
                │   (FOUNDATION — schema + markNoShow + contract docs)    │
                │                                                         │
                │   1A schema additions ──────────┐                       │
                │                                 │                       │
                │   1C contract comments ─────────┤                       │
                │                                 │                       │
                │                                 └─→ 1B markNoShow       │
                └──────────┬─────────────────────────────┬────────────────┘
                           │                             │
                ┌──────────▼──────────┐         ┌────────▼─────────┐
                │      PHASE 2        │         │     PHASE 3      │
                │  End Meeting button │         │  Admin manual    │
                │  (Full-Stack)       │         │  time entry      │
                │                     │         │  (Full-Stack)    │
                │  2A backend attrib. │         │  3A helper       │
                │  2B EndMeetingBtn   │         │  3B resolveReview│
                │  2C action-bar wire │         │  3C Sheet form   │
                │  2D browser verify  │         │  3D bar wire     │
                │                     │         │  3E audit card   │
                │                     │         │  3F browser ver. │
                └──────────┬──────────┘         └────────┬─────────┘
                           │                             │
                           │                             │
                           │  (no dependency between Phase 2 and Phase 3)
                           │                             │
                           └─────────────┬───────────────┘
                                         │
                                  Feature complete (v0.1)

                                  ┌─────────────────────────────┐
                                  │    PHASE 4 (DEFERRED)       │
                                  │   Dangling in_progress      │
                                  │   safety-net sweep          │
                                  │   (optional; ship if test   │
                                  │    tenant shows >5/week     │
                                  │    dangling meetings)       │
                                  └─────────────────────────────┘
                                          (dotted — not v0.1)
```

---

## Maximum Parallelism Windows

### Window 1: Phase 1 Foundation (Sequential Foundation — Must Complete First)

**Concurrency:** Up to 2 subphases in parallel within Phase 1 (1A + 1C concurrently; 1B follows 1A).

Phase 1 is the critical foundation. Every downstream phase depends on the schema fields added in 1A (`meetings.startedAtSource`, `stoppedAtSource`, `meetingReviews.manualStartedAt`, `manualStoppedAt`, `timesSetByUserId`, `timesSetAt`). The subphases inside Phase 1 parallelize as follows:

- **1A (schema additions)** — blocks 1B because 1B writes `stoppedAtSource` which 1A introduces.
- **1C (contract comments)** — pure comment additions in three unrelated files. Zero compile impact. Runs in parallel with 1A.
- **1B (`markNoShow` enhancement)** — reads `stoppedAtSource` type; waits for 1A deploy.

```
Timeline: ████████████████████████
          1A (schema) ────────────┐
                                  ├── 1B (markNoShow — needs 1A types)
          1C (contract comments) ─┘  (parallel with 1A, independent)

          Window 1 duration: ~0.5–1 day
```

---

### Window 2: Phase 2 || Phase 3 (Full Independent Parallelism)

**Concurrency:** 2 completely independent streams running simultaneously.

After Phase 1 completes, Phase 2 and Phase 3 have **zero shared files and zero shared state**. They serve different user roles (closer vs. admin) on different routes:

- **Phase 2** works in `convex/closer/meetingActions.ts` and `app/workspace/closer/meetings/[meetingId]/_components/`.
- **Phase 3** works in `convex/reviews/mutations.ts`, `convex/lib/manualMeetingTimes.ts` (new), and `app/workspace/reviews/[reviewId]/_components/`.

No merge conflicts possible. No shared mutations between them (Phase 2 extends `startMeeting`/`stopMeeting`; Phase 3 extends `resolveReview`).

```
Timeline:                          ████████████████████████████████
                                   Phase 2 (End Meeting button) ────────────┐
                                   Phase 3 (Admin manual times) ────────────┤
                                                                            ▼
                                                                     Feature done

          Window 2 duration: ~1.5–2 days (Phase 3 is the longer of the two)
```

**Within Phase 2 (internal parallelism):**

```
2A (backend source attribution)   ────┐
                                      │
2B (EndMeetingButton component)   ────┤  (2A and 2B independent; different files)
                                      │
                                      ├── 2C (OutcomeActionBar integration — needs 2A + 2B)
                                      │
                                      └── 2D (browser verification — needs 2C)
```

**Within Phase 3 (internal parallelism):**

```
3A (validateManualTimes helper)   ────┐
                                      │
3C (AcknowledgeWithTimesSheet)    ────┤  (3A, 3C, 3E all independent)
                                      │
3E (audit card on detail page)    ────┤
                                      │
3A done ─────→ 3B (resolveReview extension — needs helper import)
                                      │
3C done ─────→ 3D (resolution-bar wire — imports Sheet)
                                      │
3B + 3D done ─→ 3F (browser verification — needs full backend + frontend flow)
```

**Parallelism note within Phase 3:** 3A, 3C, and 3E can all be started immediately at the top of the phase. 3B and 3D each wait on one upstream subphase. This makes Phase 3's critical path `3A → 3B → 3F` (backend spine) and `3C → 3D → 3F` (frontend spine) — whichever finishes later determines 3F's start.

---

### Window 3 (Deferred): Phase 4 Dangling Safety Net

**Concurrency:** Single stream if shipped. Independent of everything.

Phase 4 (if shipped) adds `convex/closer/danglingMeetingSweep.ts` (new file) and a `crons.ts` entry. It touches no file owned by Phases 1/2/3. Can ship at any time after Phase 1 — even post-v0.1.

```
Timeline:                                              ████
                                                       Phase 4 (if measured demand warrants)
                                                       — convex/closer/danglingMeetingSweep.ts (new)
                                                       — convex/crons.ts (modify: add interval)
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 (1A → 1B)  →  Phase 3 (3A → 3B → 3F)
  │                     │
  │                     └── Admin manual times backend + browser verify (longest sub-stream)
  └── Schema deploy (blocks everything)
```

**Longer path in detail:**

```
1A (schema) ──→ 1B (markNoShow)  ~0.5 day
                     │
                     ▼
3A (helper) ──→ 3B (resolveReview) ──→ 3F (browser verify)  ~1.5–2 days
```

**Alternative shorter path:**

```
1A → 1B → Phase 2 complete (2A → 2B → 2C → 2D)   ~1–1.5 days
```

This path is the shorter of the two, so the **End Meeting button** ships sooner than the admin manual-time-entry flow. If Phase 2 is prioritized for an early demo (e.g., show the closer UX first), it reaches "shippable" state 0.5–1 day before Phase 3 completes.

**Implication:**
- **Start Phase 3 as early as possible** after Phase 1 completes — it is on the critical path and determines the minimum delivery time for v0.1.
- Start Phase 2 in parallel with Phase 3 if two developers / agents are available. A single developer should start Phase 3 first, then context-switch to Phase 2 during Phase 3 waiting periods (e.g., while running 3F browser verification).

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running Phase 2 and Phase 3 in parallel, each phase owns specific directories and files. No file is modified by more than one phase.

| Directory / File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **Phase 1 only** | All schema additions in 1A; no other phase touches it. |
| `convex/closer/noShowActions.ts` | **Phase 1 only** (1B) | `markNoShow` enhancement. No other phase edits this file. |
| `convex/closer/payments.ts` | **Phase 1 only** (1C) | Header comment. No behavior change. No other phase edits. |
| `convex/closer/followUpMutations.ts` | **Phase 1 only** (1C) | Header comment. No other phase edits. |
| `convex/closer/meetingActions.ts` | **Phase 1 (1C header comment above `markAsLost`) + Phase 2 (2A source fields in `startMeeting`/`stopMeeting`)** | **Two phases touch this file**, but at **non-overlapping regions**: 1C adds a comment above `markAsLost` (lines ~242); 2A adds `startedAtSource` to `startMeeting` (lines ~132) and `stoppedAtSource` to `stopMeeting` (lines ~196). Sequence Phase 2A after Phase 1C to avoid hypothetical merge friction, but actual conflict probability is near zero. |
| `convex/lib/manualMeetingTimes.ts` | **Phase 3 only** (3A) | New file. |
| `convex/reviews/mutations.ts` | **Phase 3 only** (3B) | Extend `resolveReview`. No other phase edits. |
| `convex/crons.ts` | **Phase 4 only** (if shipped) | New cron interval entry. Untouched in v0.1. |
| `convex/closer/danglingMeetingSweep.ts` | **Phase 4 only** (if shipped) | New file. |
| `app/workspace/closer/meetings/[meetingId]/_components/end-meeting-button.tsx` | **Phase 2 only** (2B) | New component. |
| `app/workspace/closer/meetings/[meetingId]/_components/outcome-action-bar.tsx` | **Phase 2 only** (2C) | Two-row layout refactor. |
| `app/workspace/reviews/[reviewId]/_components/acknowledge-with-times-sheet.tsx` | **Phase 3 only** (3C) | New component. |
| `app/workspace/reviews/[reviewId]/_components/review-resolution-bar.tsx` | **Phase 3 only** (3D) | Wire Sheet for `forgot_to_press`. |
| `app/workspace/reviews/[reviewId]/_components/review-detail-page-client.tsx` | **Phase 3 only** (3E) | Add audit card. |

**Single shared-file exception:** `convex/closer/meetingActions.ts` is touched by both Phase 1C (comment) and Phase 2A (source fields in two different handlers). The touched regions are ~100 lines apart. **Rule:** Phase 1 completes before Phase 2 starts, as captured in the master dependency graph. In practice, no meaningful merge risk.

---

## Recommended Execution Strategies

### Solo Developer

Execute Phase 1 completely, then sequence Phase 2 and Phase 3 to minimize context switching. Leverage Phase 3's internal parallelism (3A / 3C / 3E concurrent) to keep active work going during build / deploy pauses.

1. **Day 0.5:** Phase 1 — 1A schema push, 1C comments in parallel, 1B once 1A deployed. Run acceptance checks.
2. **Day 1–2:** Phase 3 backend track — 3A helper, then 3B mutation extension, then manual smoke test via Convex dashboard. Context-switch to Phase 2 (2A + 2B) while Phase 3 Convex dev deploys.
3. **Day 2–3:** Phase 2 frontend (2C OutcomeActionBar integration) + Phase 3 frontend (3C Sheet + 3D wire + 3E audit card) interleaved.
4. **Day 3.5–4:** Phase 2 browser verification (2D) + Phase 3 browser verification (3F). Batch both under a single expect subagent session.

**Estimated time:** 3.5–4 days

### Two Developers (Backend + Frontend Split)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| 1 (day 0.5) | 1A schema + 1B markNoShow + 1C comments | (blocked — wait on 1A) |
| 2 (day 1–1.5) | 2A source attribution + 3A helper + 3B resolveReview | 2B EndMeetingButton + 3C AcknowledgeWithTimesSheet (component skeletons can be built against stub mutation signatures) |
| 3 (day 1.5–3) | Convex dashboard smoke tests for 1B + 2A + 3B | 2C OutcomeActionBar integration + 3D resolution-bar wire + 3E audit card |
| 4 (day 3–3.5) | Post-implementation `convex-performance-audit` on resolveReview | 2D browser verification + 3F browser verification |

**Estimated time:** 3–3.5 days

### Three+ Developers / Agents

Maximum parallelism split — three agents each owning a vertical slice. Phase 1 is a single-agent task (atomic schema deploy); Phases 2 and 3 run fully in parallel from Sprint 2 onwards.

| Sprint | Agent A (Phase 1 + Phase 2 Backend) | Agent B (Phase 3 Backend) | Agent C (Frontend — Phase 2 + 3) |
|---|---|---|---|
| 1 (day 0.5) | 1A, 1B, 1C | (blocked on 1A) | (blocked on 1A) |
| 2 (day 1) | 2A source attribution | 3A helper + 3B resolveReview | 2B EndMeetingButton + 3C Sheet |
| 3 (day 1.5–2) | Convex dashboard smoke tests | post-implementation perf audit | 2C action-bar + 3D resolution-bar + 3E audit card |
| 4 (day 2–2.5) | -- | -- | 2D browser verify + 3F browser verify (single expect session) |

**Estimated time:** 2–2.5 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 (1A + 1B + 1C) | `npx convex dev` idle, no schema errors. `pnpm tsc --noEmit` passes. Manual smoke: `markNoShow` on an `in_progress` test meeting → confirm `stoppedAt`, `completedAt`, `stoppedAtSource === "closer_no_show"` persisted. Grep finds the OUTCOME MUTATION CONTRACT header in all three outcome-mutation files. |
| **Gate 2** | After Phase 2 (2A + 2B + 2C + 2D) | End Meeting button visible on `in_progress` meetings. `stopMeeting` writes `stoppedAtSource === "closer"`. Outcome row remains independent of lifecycle row (interaction matrix in design §5.5 verified). `expect` accessibility + performance audits green on closer meeting detail page. |
| **Gate 3** | After Phase 3 (3A + 3B + 3C + 3D + 3E + 3F) | `forgot_to_press` review → Acknowledge opens Sheet with defaults + Fathom link. Invalid times → inline field errors. Valid submission → meeting patched with `admin_manual` source, review patched with `manualStartedAt`/`manualStoppedAt`/`timesSetByUserId`/`timesSetAt`. `meeting.times_manually_set` event emitted. Audit card renders on resolved reviews. `expect` audits green. |
| **Gate 4 (v0.1 launch)** | After Gate 2 + Gate 3 | Full flow end-to-end on the test tenant: seed an overran meeting → closer responds `forgot_to_press` + saves Fathom link → admin opens review → admin clicks Acknowledge → Sheet opens → admin enters actual times from Fathom → submits → meeting shows correct times + `admin_manual` attribution + recomputed `lateStartDurationMs` / `exceededScheduledDurationMs`. |
| **Gate 5 (optional)** | After Phase 4 if shipped | Cron runs on schedule; dangling `in_progress` meetings older than 6h get flagged for review. No false positives on fresh `in_progress` meetings. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1A schema push rejects on production data | **Critical** | All new fields are `v.optional(...)` — schema-compatible with existing rows. Run `npx convex dev` against the test tenant first to catch any validator surprise. If rejection occurs, use `convex-migration-helper` with widen-migrate-narrow (unlikely to be needed). |
| `meetingActions.ts` dual-ownership (1C + 2A) causes merge friction in parallel dev | Medium | Master dependency graph sequences Phase 1 → Phase 2. In practice, 1C touches ~lines 242 (comment above markAsLost) and 2A touches ~lines 132 (startMeeting) and ~196 (stopMeeting) — non-overlapping. If a parallel-branch workflow is used, rebase Phase 2 branch onto Phase 1 before merge. |
| Admin enters wildly incorrect manual times (fat-finger by a year) | Medium | Backend validator ceilings (`manualStoppedAt <= now`, duration ≤ 8h, `manualStartedAt >= scheduledAt - 60min`) catch most fat-fingers. The Sheet shows a live duration preview to help the admin sanity-check before submit. See design §12.8 for the residual risk discussion. |
| Time-zone mismatch between `<Input type="datetime-local">` and Unix ms roundtrip | Medium | `datetime-local` is always browser-local (no TZ suffix). `new Date(value).valueOf()` interprets in browser-local TZ. `formatForInput()` mirrors that. The 3F browser-verification step explicitly tests roundtrip: input `14:00` local → submit → card displays `2:00 PM` local. If values drift, TZ handling needs fix. |
| Multiple admins race on the same pending review | Low | Convex mutations are serializable. Second-mover sees `review.status === "resolved"` and the existing `"Review already resolved"` error path. No lost writes. |
| Existing `did_not_attend` Dialog breaks when `forgot_to_press` routes to Sheet | Low | 3D introduces a branch on `closerResponse === "forgot_to_press"`. The `did_not_attend` and `null` branches fall through to the existing Dialog path unchanged. Regression-test both paths in 3F. |
| `meeting.times_manually_set` domain event consumers fail on unknown event type | Low | Existing domain-event consumers (reporting, PostHog bridge) are dispatcher-style — they log and skip unknown types. Adding a new type does not break them. If a specific downstream wants the event, add a handler branch in a future phase. |
| `OutcomeActionBar`'s existing `meeting_overran` pending-review UI path regresses with new two-row layout | Medium | Design §5.5 interaction matrix includes this state. 2D browser verification explicitly checks the `meeting_overran` status. |
| Phase 4 deferred indefinitely, dangling meetings accumulate | Low | Open Question §13.3 — measure pre-ship: add a one-liner admin query that counts `in_progress` meetings with `scheduledAt < now - 6h`. If > 5/week after Phase 2 ships, prioritize Phase 4. |

---

## Applicable Skills Per Phase

| Phase | Subphase(s) | Skills to Invoke | Reason |
|---|---|---|---|
| **1** | 1A | `convex-migration-helper` | Fallback only if schema push fails. Not expected for optional fields. |
| **1** | 1A post-deploy | `convex-performance-audit` | Spot-check `meetings` index/query performance after adding optional columns. |
| **2** | 2A | — | Pure Convex mutation patch. No skill needed. |
| **2** | 2B | `shadcn`, `frontend-design` | Button component with `Square` icon; visual polish. |
| **2** | 2C | `frontend-design`, `vercel-react-best-practices` | Two-row layout; verify no hydration waste. |
| **2** | 2D | `expect`, `web-design-guidelines` | Browser verification of interaction matrix; WCAG audit. |
| **3** | 3A | — | Pure helper, no dependencies. |
| **3** | 3B | `convex-performance-audit` | Post-implementation check on `resolveReview` write cost (adds 2 docs + 2 events). |
| **3** | 3C | `shadcn`, `frontend-design`, `next-best-practices` | shadcn Sheet + RHF + Zod form; confirm client boundary correctness. |
| **3** | 3D | `vercel-react-best-practices` | Verify `useState` + conditional rendering doesn't cause storms. |
| **3** | 3E | `shadcn`, `frontend-design` | Card primitive composition; info hierarchy. |
| **3** | 3F | `expect`, `web-design-guidelines` | Full admin-flow browser verification; Sheet focus-trap audit; TZ roundtrip check. |
| **4 (deferred)** | — | — | Pure cron + internal mutation; no skill needed. |

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insight: Phase 2 and Phase 3 serve different user roles (closer vs. admin) on different routes (`/workspace/closer/meetings/*` vs. `/workspace/reviews/*`), and after Phase 1's schema foundation, they have zero shared files — a textbook case for full parallel execution.*
