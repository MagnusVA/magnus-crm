# Parallelization Strategy — Overview Efficiency Schedules

**Purpose:** This document defines the execution strategy across the Overview Efficiency Schedules implementation phases, identifying the critical path, maximum concurrency windows, file ownership boundaries, quality gates, and blast-radius controls.

**Prerequisite:** `plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md` is accepted. Phase 0 guardrails are complete. The MVP storage path is additive: keep `leadGenWorkerSchedules`, add `slackQualifierSchedules`, and add `dmCloserSchedules`.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **0** | Preflight, Query Budget, and Blast Radius | Analysis / QA | Medium | Design accepted |
| **1** | Schedule Schema and Shared Work Schedule Library | Backend | Medium | Phase 0 |
| **2** | Schedule Management APIs and Settings UI | Full-Stack | Medium-High | Phase 1 |
| **3** | Efficient Overview Efficiency Builders | Backend | High | Phase 1 |
| **4** | Expandable Leaderboard Query and Interaction | Full-Stack | High | Phase 3 |
| **5** | Dashboard Presentation, Rollout, and QA | Full-Stack / QA / Release | Medium-High | Phases 2, 3, 4 |

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                         PHASE 0                          │
                    │  Preflight, Query Budget, Blast Radius                   │
                    │  (FOUNDATION, no code changes)                           │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │
                    ┌────────────────────────────▼─────────────────────────────┐
                    │                         PHASE 1                          │
                    │  Schedule Schema + Shared Weekday Library                │
                    │  (FOUNDATION, generated Convex types)                    │
                    └───────────────┬───────────────────────────┬──────────────┘
                                    │                           │
                    ┌───────────────▼──────────────┐ ┌──────────▼──────────────┐
                    │           PHASE 2            │ │          PHASE 3         │
                    │  Schedule API + Settings UI  │ │  Overview Builders       │
                    │  (admin data entry)          │ │  (efficiency backend)    │
                    └───────────────┬──────────────┘ └──────────┬──────────────┘
                                    │                           │
                                    │                ┌──────────▼──────────────┐
                                    │                │          PHASE 4         │
                                    │                │  Expanded Leaderboards   │
                                    │                │  (on-demand query + UI)  │
                                    │                └──────────┬──────────────┘
                                    │                           │
                                    └───────────────┬───────────┘
                                                    │
                    ┌───────────────────────────────▼──────────────────────────┐
                    │                         PHASE 5                          │
                    │  Dashboard Presentation, Rollout, QA                     │
                    │  (release gate + blast-radius verification)              │
                    └──────────────────────────────────────────────────────────┘
```

**Important dependency nuance:** Phase 2 and Phase 3 can run in parallel after Phase 1. Phase 2 is the schedule-entry surface; Phase 3 is the overview read path. Phase 4 depends on Phase 3 shared builders. Phase 5 can start copy/type work after Phase 3 row types stabilize, but final QA waits for Phase 4 and schedule coverage.

---

## Maximum Parallelism Windows

### Window 1: Foundation Lock

**Concurrency:** Up to 4 analysis streams after 0A.

Phase 0 avoids expensive rework by locking the query budget, migration path, subscription behavior, and blast radius before implementation.

```
Timeline: ███████████████████

0A Source/docs inventory ─────┬── 0B Convex query budget ───────────┐
                              ├── 0C Migration/no-backfill gate ───┤── 0E Blast-radius lock
                              ├── 0D Subscription budget ──────────┤
                              └── 0F Rollout gate ─────────────────┘
```

**Internal parallelism:**
```
0A ──┬── 0B ──┐
     ├── 0C ──┤
     ├── 0D ──┤── 0E
     └── 0F ──┘
```

**Why safe:**
- All streams are analysis/doc updates.
- No production code is touched.
- Outputs are guardrails for later phases.

---

### Window 2: Schema Foundation

**Concurrency:** Up to 2 backend streams after 1A.

Phase 1 is mostly sequential because generated Convex types block all implementation phases. After the shared weekday module exists, schema and lead-gen alias updates can run together.

```
Timeline:        █████████████████

1A Shared weekday module ─────┬── 1B Schedule tables ─────┐
                              └── 1C Lead-gen alias ──────┤── 1D Generate + verify
```

**Internal parallelism:**
```
1A ──┬── 1B ──┐
     └── 1C ──┤── 1D
```

**Why safe:**
- 1B owns `convex/schema.ts`.
- 1C owns `convex/leadGen/validators.ts`.
- Both depend on `convex/lib/workSchedule.ts`.

---

### Window 3: Full Parallelism After Schema

**Concurrency:** 2 full streams plus internal subphase parallelism.

After Phase 1, schedule management and overview backend work are independent enough to run together.

```
Timeline:                    █████████████████████████████████████

Phase 2 Schedule API/UI ─────────────────────────────────────────┐
                                                                ├── Phase 5 final QA later
Phase 3 Overview efficiency builders ───────────────────────────┘
```

**Within Phase 2:**
```
2A Schedule API ─────────────┬── 2C Settings tab wiring ───┐
2B Weekly editor ────────────┘                             ├── 2E Settings QA
2D States/accessibility ───────────────────────────────────┘
```

**Within Phase 3:**
```
3A Range-hours helper ───────┬── 3B Lead Gen rows ─────────┐
3F Sort helper ──────────────┼── 3C Slack rows ────────────┤── 3E Top-5 overview wiring
                             └── 3D DM closer rows ───────┘
```

**Why safe:**
- Phase 2 owns `convex/workSchedules.ts` and `app/workspace/settings/**`.
- Phase 3 owns `convex/workSchedules/rangeHours.ts` and `convex/dashboard/**`.
- Shared dependency is generated table types from Phase 1.

**Coordination rule:** `convex/workSchedules.ts` and `convex/workSchedules/rangeHours.ts` can be edited by different streams, but avoid both streams restructuring the `convex/workSchedules/` directory at the same time.

---

### Window 4: Expanded Query and Dashboard Presentation Overlap

**Concurrency:** Up to 3 streams after Phase 3 row types stabilize.

Phase 4 builds expanded leaderboards. Phase 5 copy/type updates can begin once the row fields are stable, but QA waits.

```
Timeline:                                      ███████████████████████

4A Expanded query ────────────┬── 4B Table ───────────────┐
                              ├── 4C Filters/search ──────┤── 4D Card integration ──→ 4F QA
                              └── 4E States/accessibility ┘

5A Card copy/display ─────────────────────────────────────┐
5B Frontend type/formatter sync ──────────────────────────┘
```

**Why safe:**
- 4A owns backend query and builder filtering.
- 4B/4C/4E create new frontend files.
- 5A modifies existing card copy and can coordinate with 4D.
- 5B owns type aliases and formatters.

**Conflict warning:** 4D and 5A both touch card files. They cannot run blindly in parallel. Assign one owner for:
- `lead-gen-overview-card.tsx`
- `top-qualifiers-card.tsx`
- `top-dm-closers-card.tsx`
- `overview-top-cards.tsx`

---

### Window 5: Final QA and Rollout Gate

**Concurrency:** 3 QA streams after Phases 2-4 are complete.

```
Timeline:                                                        █████████████

5C Role/range/blast-radius QA ─────────┐
5D Convex performance audit ───────────┤── 5F Schedule coverage + rollout decision
5E Browser/accessibility QA ───────────┘
```

**Why safe:**
- 5C validates behavior and adjacent feature areas.
- 5D validates Convex read/subscription cost.
- 5E validates UI and accessibility.
- 5F must wait for all evidence plus manual schedule coverage.

---

## Critical Path Analysis

The critical path is:

```
Phase 0
  │
  ▼
Phase 1
  │
  ▼
Phase 3
  │
  ▼
Phase 4
  │
  ▼
Phase 5 final QA + rollout
```

**Why this is critical:**
- Phase 1 generated types unblock all code.
- Phase 3 shared builders define the source of truth for both top-5 and expanded rows.
- Phase 4 depends on Phase 3 builders to avoid duplicate query logic.
- Phase 5 release decision depends on all UI and backend behavior.

**Shorter parallel path:**

```
Phase 1 → Phase 2 → Phase 5 schedule coverage
```

Phase 2 can finish before Phase 4, but final release still waits for the critical path and schedule coverage.

**Implication:** Start Phase 3 immediately after Phase 1. Do not let settings UI polish delay backend builder work, because Phase 4 cannot start without Phase 3.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `plans/overview-efficiency-schedules/phases/*` | Phase 0 | Planning artifacts only. |
| `convex/lib/workSchedule.ts` | Phase 1 | Shared foundation. Do not modify from later phases except bug fixes. |
| `convex/schema.ts` | Phase 1 | Add schedule tables only. Later phases should not touch schema unless scope changes. |
| `convex/leadGen/validators.ts` | Phase 1 | Weekday alias only. |
| `convex/workSchedules.ts` | Phase 2 | Public schedule list/set API. |
| `convex/workSchedules/rangeHours.ts` | Phase 3 | Read-time denominator helpers. Coordinate with Phase 2 directory ownership. |
| `app/workspace/settings/_components/settings-page-client.tsx` | Phase 2 | Add schedules tab only. |
| `app/workspace/settings/_components/work-schedules-tab.tsx` | Phase 2 | New settings surface. |
| `app/workspace/settings/_components/weekly-schedule-editor.tsx` | Phase 2 | New shared editor. |
| `convex/dashboard/efficiencySort.ts` | Phase 3 | Shared comparator. |
| `convex/dashboard/overviewLeaderboardBuilders.ts` | Phase 3 | Shared row builders; Phase 4 can add filter wrapper only. |
| `convex/dashboard/overviewLeadGen.ts` | Phase 3 | Top-5 Lead Gen builder wiring. |
| `convex/dashboard/overviewSlack.ts` | Phase 3 | Top-5 qualifier builder wiring. |
| `convex/dashboard/overviewOperations.ts` | Phase 3 | Top-5 DM closer builder wiring. |
| `convex/dashboard/overviewTypes.ts` | Phase 3 | Backend row fields; Phase 4 adds expanded return type. |
| `convex/dashboard/overviewLeaderboards.ts` | Phase 4 | Expanded query only. |
| `app/workspace/_components/overview-expandable-leaderboard.tsx` | Phase 4 | New expanded interaction. |
| `app/workspace/_components/overview-expanded-leaderboard-table.tsx` | Phase 4 | New expanded table. |
| `app/workspace/_components/overview-top-cards.tsx` | Phase 4 | Expansion state; coordinate with Phase 5 card copy. |
| `app/workspace/_components/lead-gen-overview-card.tsx` | Phase 4/5 shared | One owner at a time. Expansion and copy changes conflict. |
| `app/workspace/_components/top-qualifiers-card.tsx` | Phase 4/5 shared | One owner at a time. |
| `app/workspace/_components/top-dm-closers-card.tsx` | Phase 4/5 shared | One owner at a time. |
| `app/workspace/_components/overview-help-tooltip.tsx` | Phase 5 | Copy update. |
| `app/workspace/_components/overview-dashboard-types.ts` | Phase 5 | Frontend type sync. |
| `app/workspace/_components/overview-formatters.ts` | Phase 5 | Null/decimal formatting only if needed. |

---

## Recommended Execution Strategies

### Solo Developer

| Sprint | Work |
|---|---|
| 1 | Phase 0, Phase 1 |
| 2 | Phase 3 backend builders |
| 3 | Phase 2 schedule API/UI |
| 4 | Phase 4 expanded query/UI |
| 5 | Phase 5 QA and rollout |

**Estimated total time:** 6-10 focused days.

### Two Developers

| Sprint | Developer A | Developer B |
|---|---|---|
| 1 | Phase 0 + Phase 1 | Review Phase 0, prep settings/dashboard files |
| 2 | Phase 3 backend builders | Phase 2 schedule API/UI |
| 3 | Phase 4 backend query + card integration | Phase 4 table/filters/states + Phase 5 copy/types |
| 4 | Convex performance audit + rollout gate | Browser/accessibility + role/range QA |

**Estimated total time:** 4-6 focused days.

### Three+ Developers/Agents

| Sprint | Agent A | Agent B | Agent C | Agent D |
|---|---|---|---|---|
| 1 | Phase 0 + Phase 1 | Read-only review, file ownership | UI component prep | QA plan prep |
| 2 | Phase 3 Lead Gen/DM | Phase 3 Slack aggregate path | Phase 2 API | Phase 2 UI |
| 3 | Phase 4 expanded query | Phase 4 table/filter components | Phase 5 card copy/types | Settings QA |
| 4 | Convex audit | Browser QA | Role/range/blast-radius QA | Rollout evidence |

**Estimated total time:** 3-5 focused days, assuming strict file ownership.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| Gate 0: Design and blast-radius lock | After Phase 0 | Storage decision, query budget, subscription budget, migration triggers, rollout gate accepted. |
| Gate 1: Schema foundation | After Phase 1 | `npx convex dev --once`, generated types, no existing required field changes, Sunday weekday mapping verified. |
| Gate 2: Schedule management | After Phase 2 | Admin-only API, settings tab routing, invalid-hour rejection, existing settings tabs unaffected. |
| Gate 3: Overview backend | After Phase 3 | Top-5 payload only, no unbounded reads, aggregate/cap behavior, Lead Gen reports unaffected. |
| Gate 4: Expanded interaction | After Phase 4 | `"skip"` while collapsed, one expanded subscription, filters local to expanded query, stable UI states. |
| Gate 5: Final QA | After Phase 5 | Role QA, range QA, browser QA, Convex performance audit, schedule coverage, `pnpm tsc --noEmit`. |

---

## Risk Mitigation

| Risk | Impact | Mitigation Strategy |
|---|---|---|
| Accidentally shifting weekday mapping by one day | High | Use Sunday-first `weekdaysByUtcDay`; add Sunday-only QA. |
| Treating additive schedule setup as a migration and overbuilding | Medium | Keep MVP on new tables; defer master table consolidation. |
| Reusing `leadGenWorkerSchedules` for non-lead-gen actors | Critical | Reject in MVP; would require migration and discriminated schema. |
| Expanded query bloats initial dashboard payload | High | Keep `getOverviewDashboard` top-5 only; use separate query with `"skip"` until open. |
| Slack qualifier rows ranked by raw event count | Medium | Use unique Slack-qualified opportunity counts; prefer existing aggregates. |
| DM closer scan grows beyond cap | Medium | Preserve cap; if measured issue appears, design a new aggregate/backfill separately. |
| Lead Gen reports change sorting unintentionally | High | Keep efficiency sort in dashboard builders only. |
| Existing settings tabs break | Medium | Limit `settings-page-client.tsx` changes to tab registration and content. |
| Role bypass through client args | Critical | Derive tenant/user/role through `requireTenantUser` in every Convex function. |
| Too many subscriptions from expanded cards | High | Allow only one expanded card at a time; use `"skip"` while closed. |
| Schedule coverage missing in production | Medium | Rollout gate requires manual coverage verification or explicit null-rate messaging. |
| UI overflow on mobile | Medium | Stable max-height, internal scrolling, compact table columns, browser QA. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| Phase 0 | `convex-performance-audit`, `convex-migration-helper`, `next-best-practices`, `shadcn`, `frontend-design` | Lock query budget, migration path, UI primitives, and blast radius. |
| Phase 1 | `convex-migration-helper`, `convex-performance-audit` | Additive schema validation and index/write-cost review. |
| Phase 2 | `convex-performance-audit`, `next-best-practices`, `shadcn`, `frontend-design` | Efficient admin API, settings client boundary, and dense schedule UI. |
| Phase 3 | `convex-performance-audit`, `convex-migration-helper`, `vercel-react-best-practices` | Hot-path overview builders, aggregate/cap decisions, payload control. |
| Phase 4 | `convex-performance-audit`, `next-best-practices`, `shadcn`, `frontend-design`, `vercel-react-best-practices` | On-demand subscriptions, deferred filters, accessible expandable tables. |
| Phase 5 | `convex-performance-audit`, `web-design-guidelines`, `frontend-design`, `next-best-practices`, `shadcn` | Final performance, UI, accessibility, and blast-radius QA. |
