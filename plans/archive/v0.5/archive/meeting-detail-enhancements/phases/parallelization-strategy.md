# Parallelization Strategy — Meeting Detail Enhancements (Feature I)

**Purpose:** This document defines the parallelization strategy across all 4 implementation phases of Feature I, identifying the critical path, dependency graph, file ownership boundaries, maximum concurrency opportunities, and quality gates. Designed for single-agent execution with maximum within-phase parallelism.

**Prerequisite:** v0.4 fully deployed. Feature G (UTM Tracking & Attribution) complete — `utmParams` fields on `meetings` and `opportunities`, `convex/lib/utmParams.ts` utility. Feature J (Form Handling) complete — RHF + Zod patterns established. Schema is deployable.

**External coordination:** Feature F (Event Type Field Mappings) runs in parallel during Window 1 of the v0.5 feature-area parallelization strategy. Feature I and Feature F share only `convex/schema.ts` (additive changes to different tables). Schema deploys must be serialized: **Feature I first, then Feature F**.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies | Est. Time |
|---|---|---|---|---|---|
| **1** | Schema & Backend | Backend | Low-Medium | Feature G complete | ~30 min |
| **2** | Frontend Card Components | Frontend | Medium | Phase 1 | ~30 min |
| **3** | Notes Enhancement & Outcome Tags | Frontend | Low-Medium | Phase 1 | ~30 min |
| **4** | Page Integration & Testing | Frontend + QA | Low | Phases 2 + 3 | ~30 min |

---

## Master Dependency Graph

```
┌──────────────────────────────────────────────────────────────────┐
│                         PHASE 1                                  │
│  Schema & Backend (FOUNDATION)                                   │
│  ┌─────────┐  ┌─────────────────┐  ┌──────────────────────┐     │
│  │ 1A      │  │ 1B              │  │ 1C                   │     │
│  │ Schema  │──│ Query enrichment│  │ Outcome mutation     │     │
│  │         │  │                 │  │                      │     │
│  └─────────┘  └─────────────────┘  └──────────────────────┘     │
│       │              ▲                      ▲                    │
│       └──────────────┴──────────────────────┘                    │
│              1B + 1C run in parallel after 1A                    │
└───────────────────────────┬──────────────────────────────────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
┌─────────────▼──────────────┐  ┌─────────▼──────────────────────┐
│        PHASE 2              │  │        PHASE 3                  │
│  Frontend Card Components   │  │  Notes Enhancement              │
│  ┌───────┐  ┌───────────┐  │  │  ┌──────────────┐ ┌──────────┐ │
│  │ 2A    │  │ 2B        │  │  │  │ 3A           │ │ 3B       │ │
│  │ Deal  │  │ Attrib.   │  │  │  │ Outcome Sel. │ │ Notes    │ │
│  │ Won   │  │ Card      │  │  │  │              │ │ enhance  │ │
│  └───────┘  └───────────┘  │  │  └──────────────┘ └──────────┘ │
│  (2A ∥ 2B — parallel)      │  │  (3A → 3B — sequential)        │
└─────────────┬──────────────┘  └────────────┬───────────────────┘
              │                              │
              └──────────────┬───────────────┘
                             │
              ┌──────────────▼─────────────────────────────────┐
              │              PHASE 4                            │
              │  Page Integration & Testing                    │
              │  ┌─────────┐  ┌──────────┐  ┌──────────────┐  │
              │  │ 4A      │  │ 4B       │  │ 4C           │  │
              │  │ Wire up │  │ Skeleton │  │ QA (expect)  │  │
              │  └─────────┘  └──────────┘  └──────────────┘  │
              │  (4A ∥ 4B → 4C)                                │
              └────────────────────────────────────────────────┘
```

---

## Maximum Parallelism Windows

### Window 1: Foundation (Sequential Backend — Must Complete First)

**Concurrency:** Up to 2 subphases in parallel within Phase 1.

Phase 1 is the foundation — everything blocks on it. The schema change (1A) must deploy first. After deployment, the query enrichment (1B) and mutation (1C) run in parallel because they modify different files.

```
Timeline: ████████████████████████████████
          1A (schema) ───────────────────┐
                                         ├── 1B (getMeetingDetail enrichment)
                                         │
                                         └── 1C (updateMeetingOutcome mutation)
                                                                              │
                                                        1D (deploy + verify) ─┘
```

**Internal parallelism:**

| Subphase | File | Depends On | Parallel With |
|---|---|---|---|
| 1A | `convex/schema.ts` | Nothing | Nothing (must go first) |
| 1B | `convex/closer/meetingDetail.ts` | 1A (types) | 1C |
| 1C | `convex/closer/meetingActions.ts` | 1A (types) | 1B |
| 1D | (verify only) | 1B + 1C | Nothing |

**Schema coordination with Feature F:** Deploy 1A schema changes, run `npx convex dev`, verify success, then signal Feature F that it's safe to deploy their schema (to `eventTypeConfigs` table — different table, no conflict).

---

### Window 2: Full Frontend Parallelism (After Phase 1)

**Concurrency:** 2 completely independent streams running simultaneously.

After Phase 1 deploys and types are generated, Phase 2 and Phase 3 can run **in parallel** with **zero shared files**:

- **Phase 2** creates NEW files: `deal-won-card.tsx`, `attribution-card.tsx`
- **Phase 3** creates a NEW file (`meeting-outcome-select.tsx`) and modifies ONE existing file (`meeting-notes.tsx`)

No merge conflicts. No shared imports between Phase 2 and Phase 3. Both consume the same backend types from Phase 1 but don't depend on each other.

```
Timeline:                                 ██████████████████████████████████████
                                          Phase 2 (Deal Won + Attribution) ─────┐
                                          Phase 3 (Outcome + Notes) ────────────┤
                                                                                 ▼
                                                                           Window 3
```

**Within Phase 2 (internal parallelism):**

```
2A (DealWonCard) ─────────────────────────┐
                                           ├── (both complete → Phase 4)
2B (AttributionCard) ─────────────────────┘
   (2A ∥ 2B — separate files, zero overlap)
```

**Within Phase 3 (internal sequencing):**

```
3A (MeetingOutcomeSelect) ────────────────┐
                                           └── 3B (MeetingNotes enhance — imports 3A)
   (3A first, then 3B — 3B imports from 3A)
```

**Why Phase 2 and Phase 3 are independent:**

| Pair | Files (Phase 2) | Files (Phase 3) | Shared? |
|---|---|---|---|
| 2A ↔ 3A | `deal-won-card.tsx` (NEW) | `meeting-outcome-select.tsx` (NEW) | **No** |
| 2A ↔ 3B | `deal-won-card.tsx` (NEW) | `meeting-notes.tsx` (MODIFY) | **No** |
| 2B ↔ 3A | `attribution-card.tsx` (NEW) | `meeting-outcome-select.tsx` (NEW) | **No** |
| 2B ↔ 3B | `attribution-card.tsx` (NEW) | `meeting-notes.tsx` (MODIFY) | **No** |

Zero file overlap. Zero shared state. Full parallelism.

---

### Window 3: Integration & QA (Sequential)

**Concurrency:** 1 stream (integration) → 1 stream (QA).

After Phase 2 and Phase 3 complete, Phase 4 wires everything together and runs QA.

```
Timeline:                                                                        ███████████████████████████
                                                                                 4A+4B (wire + skeleton) ──┐
                                                                                                           │
                                                                                                    4C (QA)┘
```

Phase 4 subphases:
- 4A and 4B modify the same file (`meeting-detail-page-client.tsx`) but different sections. Run carefully (sequentially is safest, or combine into a single edit pass).
- 4C (QA) runs after 4A+4B and is delegated to a subagent using `expect`.

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum delivery time):

```
Phase 1 → Phase 2 or Phase 3 (whichever finishes last) → Phase 4
   │              │                                          │
   │              │                                          └── Integration + QA (~30 min)
   │              └── Card components OR Notes enhance (~30 min)
   └── Schema + Backend (~30 min)
```

**Length:** 3 sequential blocks = ~90 minutes minimum wall time.

**Alternative path (if only one agent):**

```
Phase 1 → Phase 2 → Phase 3 → Phase 4
  30m       30m       30m       30m    = ~2 hours
```

With parallelism (Phase 2 ∥ Phase 3):

```
Phase 1 → (Phase 2 ∥ Phase 3) → Phase 4
  30m          30m                 30m    = ~90 min
```

**Savings:** ~30 minutes by running Phase 2 and Phase 3 in parallel.

**Implication:** The critical path bottleneck is Phase 1 (schema deploy + backend). Start Phase 1 immediately. As soon as 1D (verify) passes, spawn Phase 2 and Phase 3 simultaneously.

---

## File Ownership Boundaries (Merge Conflict Prevention)

### Contested Files (Multiple Phases Touch)

| File | Phase Owner(s) | Coordination Rule |
|---|---|---|
| `convex/schema.ts` | **Phase 1A** only | Modified once in 1A. No other subphase or phase touches it. |
| `convex/closer/meetingDetail.ts` | **Phase 1B** only | Enriched in 1B. No other phase modifies it. |
| `convex/closer/meetingActions.ts` | **Phase 1C** only | Mutation added in 1C. No other phase modifies it. |
| `app/workspace/closer/meetings/_components/meeting-notes.tsx` | **Phase 3B** only | Modified in 3B. No other phase touches it. |
| `app/workspace/closer/meetings/[meetingId]/_components/meeting-detail-page-client.tsx` | **Phase 4A + 4B** | Both 4A and 4B modify this file. Run them as a single edit pass or sequentially (same subphase author). |

### Exclusively Owned Files (No Conflicts)

| File | Phase Owner | Notes |
|---|---|---|
| `app/workspace/closer/meetings/_components/deal-won-card.tsx` | **Phase 2A** | New file — no overlap. |
| `app/workspace/closer/meetings/_components/attribution-card.tsx` | **Phase 2B** | New file — no overlap. |
| `app/workspace/closer/meetings/_components/meeting-outcome-select.tsx` | **Phase 3A** | New file — no overlap. |

### External Coordination (Feature F — Parallel in Window 1)

| File | Feature I | Feature F | Conflict? |
|---|---|---|---|
| `convex/schema.ts` | Adds `meetingOutcome` to `meetings` (Phase 1A) | Adds `customFieldMappings` + `knownCustomFieldKeys` to `eventTypeConfigs` | **No** — different tables. Serialize deploys: I first, then F. |
| `convex/pipeline/inviteeCreated.ts` | NOT touched by Feature I | Feature F adds auto-discovery at end of function | **No conflict.** |
| `app/workspace/settings/_components/` | NOT touched by Feature I | Feature F creates new settings tab | **No conflict.** |
| `app/workspace/closer/meetings/_components/` | Feature I adds cards here | Feature F does NOT touch meetings | **No conflict.** |

---

## Recommended Execution Strategies

### Single Agent (Optimal)

| Block | Work | Wall Time | Notes |
|---|---|---|---|
| **1** | Phase 1A (schema) → deploy → 1B ∥ 1C (parallel) → 1D (verify) | ~30 min | Schema first, then backend in parallel |
| **2** | Phase 2 (2A ∥ 2B parallel) AND Phase 3 (3A → 3B) simultaneously | ~30 min | Full frontend parallelism |
| **3** | Phase 4 (4A + 4B → 4C QA) | ~30 min | Integration + QA via expect subagent |

**Total wall time:** ~90 minutes

**Optimal execution flow:**
1. **Start Phase 1A** — schema change to `convex/schema.ts`.
2. **Deploy** — `npx convex dev`.
3. **Start 1B and 1C in parallel** — query enrichment and mutation (different files).
4. **Verify** — `pnpm tsc --noEmit` + dashboard check.
5. **Start Phase 2 and Phase 3 simultaneously:**
   - Agent A context: Build `deal-won-card.tsx` (2A), then `attribution-card.tsx` (2B).
   - Agent B context (or same agent, interleaved): Build `meeting-outcome-select.tsx` (3A), then modify `meeting-notes.tsx` (3B).
6. **Phase 4A+4B** — Update `meeting-detail-page-client.tsx` (imports, types, layout, skeleton).
7. **Phase 4C** — Delegate QA to an expect subagent.

### Two Parallel Agents

| Window | Agent A | Agent B | Wall Time |
|---|---|---|---|
| **W1** | Phase 1A (schema) + deploy | (idle — blocked on types) | ~10 min |
| **W2** | Phase 1B (query enrichment) | Phase 1C (mutation) | ~15 min |
| **W3** | Phase 2A (DealWonCard) + 2B (AttributionCard) | Phase 3A (OutcomeSelect) + 3B (Notes enhance) | ~30 min |
| **W4** | Phase 4A+4B (integration) | Phase 4C (QA via expect) | ~20 min |

**Total wall time:** ~75 minutes

**Coordination point:** After W1, Agent B is unblocked by the schema deploy. After W2, both agents proceed independently. After W3, one agent handles integration while the other runs QA.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1A** | After Phase 1A (schema) | `npx convex dev` succeeds. `Doc<"meetings">` includes `meetingOutcome` field with correct union type. Existing meetings have `meetingOutcome: undefined`. |
| **Gate 1** | After Phase 1 complete | `pnpm tsc --noEmit` passes. `getMeetingDetail` returns enriched payments with `proofFileUrl`, `proofFileContentType`, `proofFileSize`, `closerName`. `updateMeetingOutcome` mutation works from dashboard. |
| **Gate 2** | After Phase 2 + 3 | All new component files compile. `DealWonCard`, `AttributionCard`, `MeetingOutcomeSelect` are importable. `MeetingNotes` accepts `meetingOutcome` prop. |
| **Gate 3 (Feature I Final)** | After Phase 4 | Meeting detail page renders all new cards. Deal Won card shows for won deals with proof file display. Attribution card shows UTM data + booking type. Outcome select persists selections. Notes show "Last saved at" timestamp. Responsive layout verified at 4 viewports. Accessibility audit passes WCAG AA. No console errors. Performance metrics acceptable. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Schema deploy fails** | **Critical** — blocks all phases | Deploy 1A immediately. `meetingOutcome` is a simple additive optional field — lowest-risk schema change possible. Run `npx convex dev` and fix any issues before proceeding. |
| **`ctx.db.system.get()` returns unexpected shape** | **Medium** — proof file metadata missing | The `_storage` system table may have entries without `contentType` (e.g., very old files). Handle `null` gracefully: `contentType ?? null`, `size ?? null`. The `isImageContentType()` helper returns `false` for `null` — safe fallback to download link. |
| **Convex signed URL expires before lightbox opens** | **Low** — image fails to load | Convex signed URLs are short-lived but typically last minutes. The URL is fetched fresh on each `getMeetingDetail` call (reactive query). If the user stays on the page for a very long time, the URL refreshes via Convex reactivity. |
| **Frontend built against stale types** | **Medium** — TypeScript errors | Run `npx convex dev` after Phase 1 changes and verify `pnpm tsc --noEmit` before starting Phases 2-3. If types are stale, the compiler catches it immediately. |
| **Feature F deploys schema while Feature I is mid-deploy** | **High** — schema conflict | Serialize deploys: Feature I's 1A deploys and succeeds first. Then Feature F deploys. Both are additive optional fields on different tables — functional conflict is impossible, but serialization avoids deployment race conditions. |
| **Meeting detail page becomes too tall** | **Low** — UX concern | The new cards add ~300px of height. The existing page already scrolls. Cards are conditional (DealWon only for won deals). Monitor in QA — if too tall, consider collapsing Attribution card by default. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | (Read `convex/_generated/ai/guidelines.md`) | Convex file storage API (`ctx.storage.getUrl()`, `ctx.db.system.get()`), mutation patterns, schema validators. |
| **2** | `shadcn`, `frontend-design` | Card components with shadcn primitives (Card, Badge, Button, Dialog). Image lightbox. Responsive grid layout. Typography hierarchy. |
| **3** | `shadcn` | Select component, Badge color coding, Spinner for loading state. |
| **4** | `expect`, `frontend-design`, `shadcn` | Browser QA: responsive testing (4 viewports), accessibility audit (WCAG AA), console errors, performance metrics. Final layout review. |

---

## Summary: Maximum Parallelism by Window

```
Window 1 (Foundation):   1A (schema) ═══╗
                                         ║
                         1 stream       1B ═══╗ 1C ═══╗
                                              ║       ║
                         2 parallel           ╚═══════╝
                                                  ║
                                                 1D ═══╗
                                                       ▼
Window 2 (Frontend):    2A ═══════╗ 2B ═══════╗  3A ═══╗ 3B ═══╗
                                  ║           ║        ║       ║
                         4 total  ╚═══════════╝        ╚═══════╝
                         2 tracks (Phase 2 ∥ Phase 3)
                                              ║
                                              ▼
Window 3 (Integration): 4A+4B ══════════╗
                                         ║
                         1 stream       4C (QA) ═══╗
                                                    ║
                                                   DONE
```

| Metric | Value |
|---|---|
| **Total phases** | 4 |
| **Total subphases** | 12 (1A-1D + 2A-2B + 3A-3C + 4A-4C) |
| **Maximum concurrency** | 4 subphases (Window 2: 2A ∥ 2B ∥ 3A in parallel) |
| **Critical path** | Phase 1 → (Phase 2 ∥ Phase 3) → Phase 4 |
| **Critical path bottleneck** | Phase 1 (schema deploy — must precede all frontend work) |
| **Files created** | 3 (deal-won-card, attribution-card, meeting-outcome-select) |
| **Files modified** | 4 (schema, meetingDetail, meetingActions, meeting-notes, meeting-detail-page-client) |
| **Safest parallel pair** | Phase 2 ∥ Phase 3 (zero file overlap, zero shared state) |
| **Est. wall time (sequential)** | ~2 hours |
| **Est. wall time (parallel)** | ~90 minutes |
| **True bottleneck** | Schema deploy serialization with Feature F + type generation wait |

---

*This strategy maximizes parallelization for a medium-complexity feature. The key insight: Phase 2 (card components) and Phase 3 (notes enhancement) create entirely different files — run them simultaneously for a 25% wall-time reduction. The true bottleneck is not implementation speed but the schema deploy gate at the start.*
