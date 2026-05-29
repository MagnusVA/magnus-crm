# Parallelization Strategy — Overview Dashboard Redesign

**Purpose:** This document defines the parallel execution strategy across the 3 overview dashboard redesign implementation phases, identifying the critical path, maximum concurrency windows, file ownership boundaries, quality gates, and agent allocation.

**Prerequisite:** `plans/overview-dashboard-redesign/overview-dashboard-redesign-design.md` is accepted for MVP scope. Existing aggregate tables are deployed. No MVP schema migration is planned; any new table, index, or backfill requires `convex-migration-helper`.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Dashboard Query Contract | Backend | Medium-High | Design accepted; existing aggregate tables |
| **2** | Overview UI Composition | Frontend | High | Phase 1A for DTO scaffolding; Phase 1E for final query wiring |
| **3** | Verification and Rollout | Full-Stack / QA | Medium | Phases 1 and 2 complete |

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                         PHASE 1                          │
                    │  Dashboard Query Contract                                │
                    │  (backend foundation, DTOs, range, section builders)      │
                    └───────────────┬──────────────────────────────────────────┘
                                    │
                                    │ stable DTOs after 1A allow UI scaffolding
                                    │ final API wiring waits for 1E
                                    ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │                         PHASE 2                          │
                    │  Overview UI Composition                                 │
                    │  (range control, cards, tables, page integration)         │
                    └───────────────┬──────────────────────────────────────────┘
                                    │
                                    ▼
                    ┌──────────────────────────────────────────────────────────┐
                    │                         PHASE 3                          │
                    │  Verification and Rollout                                │
                    │  (static checks, role QA, Convex audit, browser QA)       │
                    └──────────────────────────────────────────────────────────┘
```

**Important dependency nuance:** Phase 2 is not fully blocked by Phase 1. The UI component streams can start after Phase 1A publishes the query name, DTO shape, and range input type. Final `useQuery(api.dashboard.overview.getOverviewDashboard, ...)` wiring waits for Phase 1E and generated Convex types.

---

## Maximum Parallelism Windows

### Window 1: Backend Contract Foundation

**Concurrency:** Up to 4 backend streams after 1A.

Phase 1A must complete first because it defines the range validator, DTOs, and public query name. After that, Lead Gen, Slack, operations, and legacy lead-gen parity work touch different files and can run in parallel.

```
Timeline: █████████████████████████████████████

1A Contract/range/types ─────┬── 1B Lead Gen helpers ───────────────┐
                             ├── 1C Slack breakdown helper ─────────┤
                             ├── 1D Operations builders ────────────┤── 1E Compose query
                             └── 1F Lead Gen report parity ─────────┘

1E complete ─────────────────────────────────────────────────────────── 1G Backend gate
```

**Why independent:**

- 1B owns `convex/leadGen/*` helper extraction and `convex/dashboard/overviewLeadGen.ts`.
- 1C owns `convex/reporting/lib/slackQualificationBreakdown.ts`, `convex/slack/metrics.ts`, and `convex/dashboard/overviewSlack.ts`.
- 1D owns `convex/dashboard/overviewOperations.ts`.
- 1F only touches legacy lead-gen public query compatibility after 1B exports exist.

**Internal parallelism:**

```
              ┌── 1B ──┐
1A complete ──┼── 1C ──┼── 1E ──→ 1G
              ├── 1D ──┤
              └── 1F ──┘
```

---

### Window 2: Frontend Component Parallelism

**Concurrency:** Up to 4 frontend streams after 2A.

Phase 2A defines frontend type aliases, formatters, and section-state primitives. After that, the date range control, top cards, Phone Operations table, and Top Origins table are isolated component streams.

```
Timeline:              ███████████████████████████████████████

2A Types/formatters/state ───┬── 2B Range control ─────────────┐
                             ├── 2C Top cards ─────────────────┤
                             ├── 2D Phone operations table ────┤── 2F Page wiring
                             └── 2E Top origins table ─────────┘

2F complete ───────────────────────────────────────────────────── 2G Browser polish
```

**Why independent:**

- 2B owns `dashboard-date-utils.ts` and `dashboard-date-range-filter.tsx`.
- 2C owns card components and top-card grid.
- 2D owns phone operations section/table.
- 2E owns top origins section/table.
- 2F is the only subphase that modifies the existing `dashboard-page-client.tsx`.

**Internal parallelism:**

```
              ┌── 2B ──┐
2A complete ──┼── 2C ──┼── 2F ──→ 2G
              ├── 2D ──┤
              └── 2E ──┘
```

---

### Window 3: Cross-Phase Overlap

**Concurrency:** Up to 5 streams when Phase 1A is done and Phase 1E is still in progress.

This is the main schedule compression opportunity. Frontend component work can begin against stable DTOs while backend section builders continue.

```
Timeline:                    █████████████████████████████████████

Backend stream A: 1B Lead Gen helpers ────────────────────────────┐
Backend stream B: 1C Slack helper ────────────────────────────────┤
Backend stream C: 1D Operations builders ─────────────────────────┤── 1E composed query
Frontend stream A: 2B Range control ──────────────────────────────┤
Frontend stream B: 2C/2D/2E Cards and tables ─────────────────────┘

1E + 2B/2C/2D/2E complete ─────────────────────────────────────────── 2F page wiring
```

**Why safe:**

- Backend work is under `convex/`.
- Frontend component streams create new files under `app/workspace/_components/`.
- The only existing frontend file, `dashboard-page-client.tsx`, is reserved for 2F after backend query generation.
- The only shared dependency is the DTO shape from 1A.

**Coordination rule:** If Phase 1 changes the `OverviewDashboard` shape after Phase 2 starts, update `overview-dashboard-types.ts` and component props first, then continue component work. Do not let each card define local ad hoc section types.

---

### Window 4: Verification Parallelism

**Concurrency:** 3 QA streams after 3A static validation passes.

Phase 3 starts with static validation. Once that is green, role/range QA, Convex performance audit, and browser responsive QA can run independently.

```
Timeline:                                      ███████████████████

3A Static validation ─────┬── 3B Role + range QA ───────────────┐
                          ├── 3C Convex performance audit ──────┤── 3E rollout decision
                          └── 3D Browser responsive QA ─────────┘
```

**Why independent:**

- 3B is primarily auth/session and visible behavior.
- 3C is Convex logs, insights, read-path inspection, and cap policy.
- 3D is Browser viewport and interaction QA.
- 3E must wait for all three because rollout depends on their combined result.

---

## Critical Path Analysis

The longest sequential chain determining minimum delivery time is:

```
1A Contract/range/types
  │
  ▼
1B/1C/1D Section data builders
  │
  ▼
1E Composed overview query
  │
  ▼
2F Page client wiring
  │
  ▼
2G Browser polish
  │
  ▼
3A Static validation
  │
  ▼
3B/3C/3D Verification streams
  │
  ▼
3E Rollout decision
```

**Alternative shorter paths:**

```
1A → 2A → 2B Range control
1A → 2A → 2C Top cards
1A → 2A → 2D Phone table
1A → 2A → 2E Top origins table
```

These are shorter because component construction can finish before final backend composition. They only join the critical path at 2F.

**Implication:** Start Phase 2A immediately after Phase 1A. The UI does not need to wait for every backend helper, but final page wiring must wait for the generated query reference.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `plans/overview-dashboard-redesign/phases/phase1.md` | Planning | Backend implementation guide. |
| `plans/overview-dashboard-redesign/phases/phase2.md` | Planning | Frontend implementation guide. |
| `plans/overview-dashboard-redesign/phases/phase3.md` | Planning | Verification and rollout guide. |
| `convex/schema.ts` | No MVP owner | Must remain unchanged. Any required change triggers migration planning. |
| `convex/dashboard/overviewTypes.ts` | Phase 1A | DTO source for backend and frontend generated types. |
| `convex/dashboard/overviewRange.ts` | Phase 1A | Server-side Day/Week/Month/Custom range resolver. |
| `convex/dashboard/overview.ts` | Phase 1A/1E | Public query wrapper; keep thin. |
| `convex/dashboard/overviewBuilders.ts` | Phase 1E | Composes section builders and envelopes. |
| `convex/dashboard/overviewLeadGen.ts` | Phase 1B | Lead Gen overview section only. |
| `convex/dashboard/overviewOrigins.ts` | Phase 1B | Top Posts & Reels overview section only. |
| `convex/dashboard/overviewSlack.ts` | Phase 1C | Slack qualifier overview section only. |
| `convex/dashboard/overviewOperations.ts` | Phase 1D | Phone closer and DM closer operations sections. |
| `convex/leadGen/reportLimits.ts` | Phase 1B | Shared caps. Phase 3 verifies values; does not change without product/performance reason. |
| `convex/leadGen/reportReaders.ts` | Phase 1B | Bounded lead-gen aggregate readers. |
| `convex/leadGen/reportBuilders.ts` | Phase 1B/1F | Exports shared builders; avoid behavior changes outside dashboard needs. |
| `convex/leadGen/reporting.ts` | Phase 1F | Existing public lead-gen reports. Preserve API compatibility. |
| `convex/reporting/lib/slackQualificationBreakdown.ts` | Phase 1C | Shared Slack per-user builder. |
| `convex/slack/metrics.ts` | Phase 1C | Delegate existing public query to helper. |
| `app/workspace/page.tsx` | Phase 2F verify only | Should already match route-gated design. Modify only if drift is found. |
| `app/workspace/_components/overview-dashboard-types.ts` | Phase 2A | Frontend generated API type aliases. |
| `app/workspace/_components/overview-formatters.ts` | Phase 2A | Shared frontend formatters. |
| `app/workspace/_components/overview-section-state.tsx` | Phase 2A | Shared section state UI. |
| `app/workspace/_components/dashboard-date-utils.ts` | Phase 2B | Client date utilities. |
| `app/workspace/_components/dashboard-date-range-filter.tsx` | Phase 2B | Range control. |
| `app/workspace/_components/overview-top-cards.tsx` | Phase 2C | Top card grid. |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Phase 2C | Lead Gen card. |
| `app/workspace/_components/top-qualifiers-card.tsx` | Phase 2C | Slack qualifiers card. |
| `app/workspace/_components/top-dm-closers-card.tsx` | Phase 2C | DM closers card. |
| `app/workspace/_components/phone-closer-operations-section.tsx` | Phase 2D | Phone operations wrapper. |
| `app/workspace/_components/phone-closer-operations-table.tsx` | Phase 2D | Phone operations table. |
| `app/workspace/_components/top-origins-overview-section.tsx` | Phase 2E | Top origins wrapper. |
| `app/workspace/_components/top-origins-overview-table.tsx` | Phase 2E | Top origins table. |
| `app/workspace/_components/dashboard-page-client.tsx` | Phase 2F only | Do not modify from 2B/2C/2D/2E except via planned integration. |
| `app/workspace/_components/skeletons/overview-dashboard-skeleton.tsx` | Phase 2F/2G | Skeleton and responsive polish. |
| `plans/overview-dashboard-redesign/phases/phase3-verification-log.md` | Phase 3 | Created during verification. |
| `plans/overview-dashboard-redesign/phases/phase3-rollout-notes.md` | Phase 3E | Ship/hold decision and backout notes. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in dependency order, but batch similar work to reduce context switching:

| Sprint | Work |
|---|---|
| 1 | Phase 1A, then 1B/1C/1D section helpers. |
| 2 | Phase 1E/1F/1G, then Phase 2A shared frontend primitives. |
| 3 | Phase 2B range control and Phase 2C top cards. |
| 4 | Phase 2D phone table, Phase 2E top origins, Phase 2F page wiring. |
| 5 | Phase 2G polish and all Phase 3 verification/rollout notes. |

**Estimated time:** 6-10 days

### Two Developers

| Sprint | Developer A (Backend) | Developer B (Frontend / QA) |
|---|---|---|
| 1 | Phase 1A, 1B, 1C | Read design, prepare Phase 2A against DTOs after 1A |
| 2 | Phase 1D, 1E, 1F, 1G | Phase 2A, 2B, 2C with mocked/typed props |
| 3 | Backend fixes from generated API/typecheck | Phase 2D, 2E, 2F |
| 4 | Phase 3C Convex audit | Phase 2G, Phase 3B role/range QA, Phase 3D Browser QA |
| 5 | Phase 3E rollout notes with Developer B | Phase 3E rollout notes with Developer A |

**Estimated time:** 4-6 days

### Three+ Developers / Agents

| Sprint | Agent A (Backend Lead Gen) | Agent B (Backend Slack/Ops) | Agent C (Frontend) | Agent D (QA, optional) |
|---|---|---|---|---|
| 1 | Phase 1A, then 1B | Phase 1C and 1D after 1A | Phase 2A after 1A | Prepare Phase 3 log template |
| 2 | Phase 1F and helper parity | Phase 1E composed query and 1G | Phase 2B/2C/2D/2E in parallel | Static search checklist |
| 3 | Fix backend findings | Support 2F generated API wiring | Phase 2F and 2G | Phase 3B/3D setup |
| 4 | Phase 3C Convex audit | Phase 3C support | Browser fixes | Phase 3B/3D execution |
| 5 | Phase 3E decision | Phase 3E decision | Phase 3E UI notes | Phase 3E verification summary |

**Estimated time:** 3-5 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1: Contract Ready** | After Phase 1A | `overviewTypes`, `overviewRange`, and `overview` query stub exist; no client-supplied tenant/user args; `npx convex dev --once` can generate API names. |
| **Gate 2: Backend Ready** | After Phase 1G | `pnpm tsc --noEmit` passes; no new schema changes; no dashboard `ctx.runQuery`; bounded reads use indexes and caps; existing lead-gen and Slack public query shapes are preserved. |
| **Gate 3: UI Integrated** | After Phase 2F | `/workspace` uses one overview query; old dashboard subscriptions are removed; skeleton renders; page RSC remains thin and role-gated. |
| **Gate 4: Browser Polish** | After Phase 2G | Desktop and mobile viewports have no overlap; Custom range is usable; table overflow is contained; primary controls are keyboard reachable. |
| **Gate 5: Rollout Decision** | After Phase 3E | Static checks, functional QA, Convex performance audit, Browser QA, and backout notes are recorded; ship/hold decision is explicit. |

---

## Risk Mitigation

| Risk | Impact | Mitigation strategy |
|---|---|---|
| Composed query exceeds Convex transaction/read budget | High | Keep every source read capped; run Phase 3C insights/log audit; split into per-section queries while preserving `SectionResult` shape if needed. |
| Helper extraction regresses existing lead-gen reports | High | Keep public query output compatibility in 1F; compare shape before/after; back out helper extraction separately if dashboard UI is fine but reports drift. |
| Slack helper changes ratio semantics | Medium-High | Move the existing row logic into `slackQualificationBreakdown.ts` before trimming to top 5; preserve `booked / uniqueSlackOpportunityCount`. |
| Normal Month ranges hit operations cap | Medium-High | Ship capped state only if rare; if common, plan a `dmCloserDailyStats` or operations rollup migration with `convex-migration-helper`. |
| UI work starts against stale DTOs | Medium | Phase 1A owns DTOs; Phase 2 imports generated `FunctionReturnType`; coordinate any DTO change through `overview-dashboard-types.ts`. |
| Merge conflicts in `dashboard-page-client.tsx` | Medium | Reserve that file for 2F only. Earlier frontend subphases create new components and do not edit the existing page client. |
| Mobile Custom range popover is unusable | Medium | Browser QA at 390x844 is required; reduce calendar months, adjust alignment, or use responsive popover width before rollout. |
| Product changes ranking choice late | Medium | Keep Top DM Closers comparator localized in `overviewOperations.ts`; document current scheduled-first ranking in rollout notes. |
| Schema/index change slips into MVP | Critical | Treat any schema/index/backfill need as a blocker that invokes `convex-migration-helper`; do not bundle migration work into this redesign. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex`, `convex-performance-audit`, `convex-migration-helper` if needed | Tenant-scoped public query, indexed bounded reads, helper extraction, performance/cap review, migration escalation if MVP assumptions fail. |
| **2** | `frontend-design`, `shadcn`, `next-best-practices`, `vercel-react-best-practices`, `browser:browser` | Dense operational UI, existing component primitives, RSC/client boundaries, one-subscription client pattern, responsive verification. |
| **3** | `convex-performance-audit`, `browser:browser`, `next-best-practices`, `frontend-design`, `convex-migration-helper` if needed | Logs/insights/read audit, viewport QA, route/auth verification, visual polish, and migration-trigger triage. |

---

## Reference Checklist

Use these references while implementing and verifying:

| Area | Reference |
|---|---|
| Design source of truth | `plans/overview-dashboard-redesign/overview-dashboard-redesign-design.md` |
| Phase plan template | `.docs/internal/phases-planification-creation.md` |
| Parallelization rules | `.docs/internal/parallelization.md` |
| Convex generated guidelines | `convex/_generated/ai/guidelines.md` |
| Convex + Next.js | `.docs/convex/nextjs.md`, `.docs/convex/module-nextjs.md` |
| Convex indexes/performance | `.docs/convex/database/indexes-and-query-performance.md`, `.docs/convex/best-practices.md` |
| Next.js 16 RSC/streaming | `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`, `node_modules/next/dist/docs/01-app/02-guides/streaming.md`, `node_modules/next/dist/docs/01-app/02-guides/instant-navigation.md` |
| shadcn components | `pnpm exec shadcn docs button card table calendar popover toggle-group badge alert empty skeleton tooltip` |
