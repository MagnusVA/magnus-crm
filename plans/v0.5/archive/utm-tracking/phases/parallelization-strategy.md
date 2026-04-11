# Parallelization Strategy — UTM Tracking & Attribution

**Purpose:** This document defines the parallelization strategy across all 4 implementation phases of the UTM Tracking feature, identifying the critical path, dependency graph, and maximum concurrency opportunities. This is a compact, backend-only feature — the parallelization opportunities are primarily between Phase 3 (logging) and Phase 4 (validation), and within each phase's subphases.

**Prerequisite:** None — UTM Tracking is a standalone feature with no dependency on other v0.5 features. The existing pipeline processor (`convex/pipeline/inviteeCreated.ts`) and webhook ingestion flow (`convex/webhooks/calendly.ts`) are stable.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Estimated Time | Dependencies |
|---|---|---|---|---|---|
| **1** | Schema Widen: Add `utmParams` Fields | Backend | Low | 0.5–1 day | None |
| **2** | Pipeline Extraction: `inviteeCreated` | Backend | Medium | 1–2 days | Phase 1 |
| **3** | Pipeline Logging: `inviteeCanceled` & `inviteeNoShow` | Backend | Low | 0.5 day | Phase 2 |
| **4** | Validation & Edge Case Hardening | Manual / Testing | Medium | 1–1.5 days | Phase 2 |

**Total estimated time (sequential):** 3–5 days
**Total estimated time (with parallelism):** 2.5–4 days

---

## Master Dependency Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                          PHASE 1                                │
│  Schema Widen: Add utmParams Fields (FOUNDATION)                │
│  Files: convex/lib/utmParams.ts, convex/schema.ts              │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                 ┌──────────▼──────────────────────────────────┐
                 │                  PHASE 2                     │
                 │  Pipeline Extraction: inviteeCreated         │
                 │  Files: convex/lib/utmParams.ts (extend),    │
                 │         convex/pipeline/inviteeCreated.ts,   │
                 │         convex/pipeline/debugUtm.ts          │
                 └──────────┬──────────────────┬───────────────┘
                            │                  │
              ┌─────────────▼────────┐  ┌──────▼─────────────────────┐
              │       PHASE 3        │  │         PHASE 4            │
              │  Pipeline Logging    │  │  Validation & Edge Case    │
              │  (inviteeCanceled +  │  │  Hardening (testing +      │
              │   inviteeNoShow)     │  │  cleanup)                  │
              └──────────────────────┘  └────────────────────────────┘
                    ▲                            ▲
                    │                            │
                    └──── RUN IN PARALLEL ────────┘
```

---

## Maximum Parallelism Windows

### Window 1: Foundation (Sequential — Must Complete First)

**Concurrency:** Up to 2 subphases in parallel within Phase 1.

Phase 1 creates the UTM validator and widens the schema. It is the critical foundation — Phase 2 cannot start until the schema is deployed. However, after the validator file (1A) is created, both schema updates (1B and 1C) can be applied together.

```
Timeline: ████████████████████████
          1A (validator)  ──────────┐
                                    ├── 1B (meetings schema) ──┐
                                    └── 1C (opps schema) ──────┤── 1D (deploy + verify)
                                                               │
                                                    (1B + 1C are a single edit in practice)
```

**Internal parallelism:** 1B and 1C modify the same file (`convex/schema.ts`) but different table definitions. In practice, they are applied as a single edit + single deploy. The parallelism here is conceptual — no file conflict.

---

### Window 2: Core Implementation (Sequential — Builds on Foundation)

**Concurrency:** Up to 2 subphases in parallel within Phase 2.

Phase 2 is the main implementation. The extraction helper (2A) must be written first, then the pipeline modification (2B) imports it. The debug query (2C) is independent and can be written in parallel with 2B.

```
Timeline:                         ████████████████████████████████████████
                                  2A (extraction helper) ─────────────────┐
                                                                          │
                                    2B (modify inviteeCreated) ───────────┤── 2D (deploy + verify TS)
                                    2C (debug query — parallel) ──────────┘          │
                                                                                     ▼
                                                                              2E (manual Calendly test)
```

**Internal parallelism:**
- 2B depends on 2A (imports `extractUtmParams`)
- 2C is fully independent of 2B (creates a new file, no shared imports beyond `_generated`)
- 2D and 2E are sequential verification steps

```
2A (extractUtmParams helper) ──────────┐
                                       ├── 2D (deploy) ── 2E (manual test)
2B (inviteeCreated.ts mod) ────────────┤
                                       │
2C (debugUtm.ts — independent) ────────┘
```

---

### Window 3: Observability + Validation (Full Parallelism)

**Concurrency:** 2 completely independent streams running simultaneously.

After Phase 2 completes, Phase 3 and Phase 4 have **zero code dependencies on each other**. They touch entirely different files and serve different purposes:

- **Phase 3** modifies: `convex/pipeline/inviteeCanceled.ts`, `convex/pipeline/inviteeNoShow.ts`
- **Phase 4** inspects: Convex dashboard (data + logs), deletes `convex/pipeline/debugUtm.ts`

No merge conflicts possible. No shared state. No import dependencies between them.

```
Timeline:                                                       ████████████████████████████████████████
                                                                Phase 3 (logging — 0.5 day) ────────────┐
                                                                Phase 4 (validation — 1-1.5 days) ──────┤
                                                                                                         ▼
                                                                                                      DONE
```

**Within Phase 3 (internal parallelism):**

```
3A (inviteeCanceled.ts log) ────────────┐
                                        ├── 3C (deploy + verify)
3B (inviteeNoShow.ts logs) ─────────────┘
```

3A and 3B touch different files — full parallel. 3C is the deploy gate.

**Within Phase 4 (internal parallelism):**

```
4A (input matrix — 10 test scenarios) ──────────┐
                                                 │
4B (follow-up attribution preservation) ─────────┤── 4D (document results + cleanup)
                                                 │
4C (debug query + performance check) ────────────┘
```

4A, 4B, and 4C are all independent manual tests — full parallel. 4D is the final gate.

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 ──→ Phase 2 ──→ Phase 4
 (0.5-1d)    (1-2d)     (1-1.5d)
   │            │           │
   │            │           └── Validation + cleanup (longest Window 3 stream)
   │            └── Core extraction implementation
   └── Schema foundation
```

**Total critical path:** 2.5–4.5 days

**Alternative shorter path:**
```
Phase 1 ──→ Phase 2 ──→ Phase 3
 (0.5-1d)    (1-2d)     (0.5d)
```

**Total:** 2–3.5 days — Phase 3 finishes ~0.5–1 day before Phase 4.

**Implication:** Phase 4 determines the overall delivery time. Since Phase 4's testing (4A, 4B, 4C) can run in parallel internally, start all three test streams simultaneously as soon as Phase 2 deploys. Phase 3 will finish first and be ready for its own verification before Phase 4 concludes.

> **Optimization note:** Phase 3 has no technical dependency on Phase 2 — it uses `isRecord()` which already exists in both files, and it doesn't import anything from `convex/lib/utmParams.ts`. The dependency is logical (add observability after the feature works, not before). A team comfortable with the risk could start Phase 3 after Phase 1 deploys, gaining ~1 day. However, the stated phase prerequisite is Phase 2.

---

## File Ownership Boundaries (Merge Conflict Prevention)

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/lib/utmParams.ts` | **Phase 1 (create) → Phase 2 (extend)** | Sequential. Phase 1 creates validator + type. Phase 2 adds `extractUtmParams()` helper. No conflict — phases are sequential. |
| `convex/schema.ts` | **Phase 1 only** | Both `meetings` and `opportunities` tables modified in Phase 1. No other phase touches schema. |
| `convex/pipeline/inviteeCreated.ts` | **Phase 2 only** | Import added + 3 insertion points (UTM extraction, meeting insert, opportunity insert). |
| `convex/pipeline/inviteeCanceled.ts` | **Phase 3 only** | Single 4-line log insertion. |
| `convex/pipeline/inviteeNoShow.ts` | **Phase 3 only** | Two 4-line log insertions (process + revert handlers). |
| `convex/pipeline/debugUtm.ts` | **Phase 2 (create) → Phase 4 (delete)** | Phase 2 creates it; Phase 4 deletes it after verification. No conflict — Phase 4 starts after Phase 2 finishes. |
| `plans/v0.5/utm-tracking/PHASE4_RESULTS.md` | **Phase 4 only** | New file — test results report. |

**Key insight:** All parallel work (Phase 3 || Phase 4 in Window 3) touches completely different files. No merge conflict risk whatsoever.

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism. Since Phases 3 and 4 are small and one person can context-switch between them:

1. **Phase 1** — Create validator (1A), update schema (1B+1C as single edit), deploy (1D).
2. **Phase 2** — Write extraction helper (2A), modify pipeline (2B) + create debug query (2C), deploy (2D), manual test (2E).
3. **Phase 3 + Phase 4 interleaved:**
   - Start Phase 3 (3A+3B in parallel, deploy 3C) — ~2 hours.
   - Run Phase 4 tests (4A+4B+4C) — ~4-6 hours.
   - While waiting for Calendly webhooks to arrive (for 4A/4B tests), continue Phase 4C (debug query + perf check).
   - Finish Phase 4D (document results, delete debug query, simplify review).

**Estimated total time:** 3–4.5 days

### Two Developers / Agents

| Sprint | Developer A (Implementation) | Developer B (Verification) |
|---|---|---|
| 1 | Phase 1 (all subphases) | — (blocked on Phase 1) |
| 2 | Phase 2 (2A → 2B + 2C → 2D) | — (blocked on Phase 2) |
| 3 | Phase 3 (3A + 3B → 3C) | Phase 4 (4A + 4B + 4C in parallel) |
| 4 | — | Phase 4D (document + cleanup + simplify) |

**Estimated total time:** 2.5–3.5 days

**Note:** The bottleneck is the Phase 1 → Phase 2 sequential chain. Developer B is idle until Phase 2 completes. In a larger v0.5 context, Developer B could work on a different v0.5 feature during Sprints 1–2.

### Three+ Developers / Agents (Maximum Parallelism)

For this feature specifically, three agents provide diminishing returns — the sequential Phase 1 → Phase 2 chain dominates.

| Sprint | Agent A (Schema + Pipeline) | Agent B (Logging) | Agent C (Testing) |
|---|---|---|---|
| 1 | Phase 1 (all) | — | — |
| 2 | Phase 2 (all) | — | — |
| 3 | — | Phase 3 (all) | Phase 4 (4A + 4B + 4C) |
| 4 | — | — | Phase 4D (cleanup) |

**Estimated total time:** 2.5–3.5 days (same as two developers — no gain from a third)

**Recommendation:** For UTM Tracking specifically, allocate at most 2 developers. Use the third on a parallel v0.5 feature (e.g., Lead Manager, Follow-Up Overhaul).

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1: Schema** | After Phase 1 | `npx convex dev` succeeds without schema errors. `pnpm tsc --noEmit` passes. Convex dashboard shows `meetings` and `opportunities` tables with `utmParams` field in schema (but no documents have it yet). Existing documents are unchanged. |
| **Gate 2: Pipeline** | After Phase 2 | `pnpm tsc --noEmit` passes. A test Calendly booking with `?utm_source=test&utm_medium=manual` produces a meeting document with `utmParams: { utm_source: "test", utm_medium: "manual" }`. The same UTMs appear on the opportunity. Structured log `[Pipeline:invitee.created] UTM extraction | hasUtm=true` visible in Convex logs. |
| **Gate 3: Observability** | After Phase 3 | Cancel event shows `[Pipeline:invitee.canceled] UTM check | hasTracking=true` in logs. No-show event shows `[Pipeline:no-show] UTM check | hasTracking=true`. Existing handler behavior (status transitions, cancellation metadata) is unchanged. |
| **Gate 4: Validation** | After Phase 4 | All 10 input validation matrix scenarios pass. Follow-up rebooking does NOT overwrite opportunity UTMs. Debug query (`debugUtm.ts`) is deleted. `PHASE4_RESULTS.md` is filed. `pnpm tsc --noEmit` still passes after cleanup. Pipeline function durations have not regressed. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema push fails | **Critical** — blocks all phases | The change is purely additive (`v.optional` fields). Cannot fail unless the import path for `utmParamsValidator` is wrong. Deploy immediately after editing and verify before moving to Phase 2. |
| Calendly changes `tracking` object schema | Medium | `extractUtmParams` only reads known fields and ignores extras. New Calendly fields are silently dropped. Removed fields result in `undefined`. Graceful degradation by design. |
| Pipeline crash on malformed tracking data | **High** — blocks all bookings for tenant | The extraction helper validates every access: type checks, null guards, Array.isArray. Returns `undefined` for any unexpected shape. The helper runs inside the existing transaction — if it throws, the entire mutation rolls back and the raw event is retried. |
| Follow-up opportunity patch accidentally includes `utmParams` | **High** — silent data corruption (attribution overwritten) | Phase 2B explicitly documents the intentional omission with a code comment. Phase 4B tests this scenario specifically. |
| Debug query left in production | Low | Phase 4D includes an explicit cleanup step to delete `convex/pipeline/debugUtm.ts`. The quality gate checks for its absence. |
| UTM values contain XSS payloads | Medium (future) | This phase stores UTMs as plain strings — no rendering. Phase 3 (Meeting Detail Enhancements, future v0.5 feature) must use React's default JSX escaping when displaying UTM values. Documented in design section 10.5. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | — | Pure schema widen. `convex-migration-helper` not needed (optional fields only). |
| **2** | `simplify` | Review modified `inviteeCreated.ts` for code quality and consistency with existing extraction patterns. |
| **3** | `simplify` | Review modified `inviteeCanceled.ts` and `inviteeNoShow.ts` for logging consistency. |
| **4** | `convex-performance-audit`, `simplify` | Verify pipeline performance hasn't regressed. Final code quality review of all UTM-related files. |

---

## Full Timeline Visualization

```
Day 1             Day 2             Day 3             Day 4
|─────────────────|─────────────────|─────────────────|──────────
|                 |                 |                 |
|  PHASE 1        |  PHASE 2 (cont) |                 |
|  ██████████████ |  ████████████████|                 |
|  Schema Widen   |  Pipeline Extr. |                 |
|                 |  + Manual Test  |                 |
|         PHASE 2 |                 |                 |
|         ████████|                 |                 |
|         Pipeline|                 |                 |
|                 |                 |  PHASE 3        |
|                 |                 |  ████████       |
|                 |                 |  Logging        |
|                 |                 |                 |
|                 |                 |  PHASE 4        |
|                 |                 |  ████████████████|████
|                 |                 |  Validation     | Cleanup
|                 |                 |                 |
|     Gate 1 ─────┤     Gate 2 ─────┤     Gate 3 ─────┤ Gate 4 ──── DONE
```

---

*This is a compact, backend-only feature. The key parallelism opportunity is Window 3 (Phase 3 || Phase 4). The bottleneck is the sequential Phase 1 → Phase 2 chain — start it as early as possible.*
