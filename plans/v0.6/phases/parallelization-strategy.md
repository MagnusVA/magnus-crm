# Parallelization Strategy — Admin Reporting & Analytics (v0.6)

**Purpose:** This document defines the parallelization strategy across all 6 implementation phases of the Reporting & Analytics feature, identifying the critical path, dependency graph, maximum concurrency opportunities, file ownership boundaries, and recommended execution strategies.

**Prerequisite:** v0.5b database audit fully deployed — all schema changes, 25 domain event emission sites, `meetingFormResponses` backfill, and `eventTypeFieldCatalog` population complete.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Aggregate Foundation | Backend / Config | Medium | v0.5b complete |
| **2** | Meeting Time Tracking + Mutation Integration + Form Response Pipeline | Backend + Frontend | High | Phase 1 |
| **3** | Core Reporting Queries | Backend | Medium-High | Phase 1 |
| **4** | Frontend — Report Shell & Navigation | Frontend | Low | Phase 1 (workspace auth system stable) |
| **5** | Frontend — Report Pages | Full-Stack | High | Phase 3 + Phase 4 |
| **6** | QA & Polish | Manual + Full-Stack | Medium | Phase 2 + Phase 3 + Phase 5 |

---

## Master Dependency Graph

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                              PHASE 1                                          │
│  Aggregate Foundation (FOUNDATION)                                            │
│  Install @convex-dev/aggregate, schema, 5 instances, backfill                 │
└───────┬──────────────────────────┬──────────────────────────┬────────────────┘
        │                          │                          │
┌───────▼──────────────┐  ┌───────▼──────────────┐  ┌───────▼──────────────┐
│      PHASE 2         │  │      PHASE 3         │  │      PHASE 4         │
│  Meeting Time Track  │  │  Core Reporting      │  │  Report Shell &      │
│  + Mutation Hooks    │  │  Queries             │  │  Navigation          │
│  + Form Pipeline     │  │  (7 query files)     │  │  (routes, skeleton)  │
│  (Backend + FE)      │  │  (Backend only)      │  │  (Frontend only)     │
└───────┬──────────────┘  └───────┬──────────────┘  └───────┬──────────────┘
        │                          │                          │
        │                          └─────────────┬────────────┘
        │                                        │
        │                               ┌────────▼──────────────┐
        │                               │      PHASE 5          │
        │                               │  Report Pages         │
        │                               │  (5 full-stack pages) │
        │                               └────────┬──────────────┘
        │                                        │
        └──────────────────┬─────────────────────┘
                           │
                  ┌────────▼──────────────┐
                  │      PHASE 6          │
                  │  QA & Polish          │
                  │  (Verification)       │
                  └───────────────────────┘
```

**Key insight:** After Phase 1 completes, Phases 2, 3, and 4 can ALL run simultaneously — they touch entirely different files across different directories.

---

## Maximum Parallelism Windows

### Window 1: Sequential Foundation (Must Complete First)

**Concurrency:** Up to 3 subphases in parallel within Phase 1.

Phase 1 is the foundation. Everything blocks on it. However, after the package install + config (1A), subphases 1B, 1C, and 1E can all run simultaneously. The backfill mutations (1D) wait for schema (1B) and aggregate instances (1C).

```
Timeline: ████████████████████████████████████████████
          1A (install + config) ──────┐
                                      ├── 1B (schema) ──────────────────┐
                                      ├── 1C (aggregate instances) ─────┤── 1D (backfill mutations)
                                      └── 1E (period bucketing) ────────┤
                                                                        └── 1F (deploy + verify)
```

**Internal parallelism: 3 subphases concurrent after 1A.**

---

### Window 2: Triple Parallelism (Backend + Backend + Frontend)

**Concurrency:** 3 completely independent streams running simultaneously.

After Phase 1 completes, Phase 2, Phase 3, and Phase 4 have **zero shared dependencies**. They touch entirely different directories:

- **Phase 2** works in: `convex/closer/`, `convex/pipeline/`, `convex/customers/`, `convex/unavailability/`, `convex/lib/`, `app/workspace/closer/meetings/`
- **Phase 3** works in: `convex/reporting/` (new files only)
- **Phase 4** works in: `app/workspace/reports/` (new directory), `app/workspace/_components/` (one file: sidebar)

No merge conflicts possible. No shared state.

```
Timeline:                        ███████████████████████████████████████████████████████████████
                                 Phase 2 (Mutation Integration) ──────────────────────────────┐
                                 Phase 3 (Reporting Queries) ─────────────────────────────────┤
                                 Phase 4 (Report Shell) ──────────────────────────────────────┤
                                                                                              ▼
                                                                                        Window 3
```

**Within Phase 2 (internal parallelism):**
```
2A (meetingActions.ts mutations) ────────────────────────────┐
                                                             │
2C (closer/noShow + followUp + payments hooks) ──────────────┤  (2A, 2C, 2D in parallel — different files)
                                                             │
2D (customers + unavailability + lib sync hooks) ────────────┤
                                                             │
2E (form response pipeline) ─→ 2B (pipeline aggregate hooks)│  (2E→2B sequential — both touch inviteeCreated.ts)
                                                             │
                                                             └── 2F (frontend — End Meeting + Late Start)
                                                                 (depends on 2A for mutation exports)
```

**Within Phase 3 (internal parallelism):**
```
3A (shared helpers) ─────────────────────────────────────────┐
                                                             ├── 3B (team performance) ──────┐
                                                             ├── 3C (revenue) ───────────────┤
                                                             ├── 3D (pipeline health) ───────┤  (6 queries in parallel!)
                                                             ├── 3E (lead conversion) ───────┤
                                                             ├── 3F (activity feed) ─────────┤
                                                             └── 3G (form analytics) ────────┘
```

**Within Phase 4 (internal parallelism):**
```
4A (report routes + layout) ─────────────────────────────────┐
                                                             ├── 4D (skeleton components)
4B (sidebar nav update) ─────────────────────────────────────┘

4C (shared date controls) ───────────────────────────────────┘
```

---

### Window 3: Full Frontend Build (5 Report Pages in Parallel)

**Concurrency:** Up to 5 independent frontend streams.

After Phase 3 (queries) and Phase 4 (shell) complete, all 5 report pages can be built simultaneously. Each page lives in its own route directory with zero shared files:

- **5A** → `app/workspace/reports/team/_components/`
- **5B** → `app/workspace/reports/revenue/_components/`
- **5C** → `app/workspace/reports/pipeline/_components/`
- **5D** → `app/workspace/reports/leads/_components/`
- **5E** → `app/workspace/reports/activity/_components/`

```
Timeline:                                                                    ████████████████████████████████████████
                                                                             5A (Team Performance) ─────────────────┐
                                                                             5B (Revenue) ──────────────────────────┤
                                                                             5C (Pipeline Health) ──────────────────┤
                                                                             5D (Leads & Conversions) ──────────────┤
                                                                             5E (Activity Feed) ────────────────────┤
                                                                                                                    ▼
                                                                                                              Window 4
```

---

### Window 4: QA & Polish (Sequential)

**Concurrency:** 3 parallel verification streams within Phase 6.

```
Timeline:                                                                                                        ████████████████████
                                                                                                                 6A (Excel cross-ref) ──┐
                                                                                                                 6B (aggregate test) ───┤── 6D (fixes)
                                                                                                                 6C (edge cases) ───────┘
```

---

## Critical Path Analysis

The **critical path** (longest sequential chain determining minimum implementation time):

```
Phase 1 → Phase 3 → Phase 5 → Phase 6
  │          │          │         │
  │          │          │         └── QA verification + fixes (1-2 days)
  │          │          └── 5 report pages built (5.5-6.5 days)
  │          └── 7 reporting queries + helpers (3-4 days)
  └── Aggregate foundation + backfill (2-3 days)
```

**Critical path total: 12-15.5 days (solo) or 8-11 days (parallelized)**

**Alternative shorter paths:**
```
Phase 1 → Phase 4 → Phase 5 → Phase 6     (shell ready sooner, waiting on queries)
Phase 1 → Phase 2 → Phase 6                (mutation hooks independent of report UI)
```

**Implications:**
- **Start Phase 3 as early as possible** after Phase 1 completes — it's on the critical path.
- Phase 4 is not on the critical path but must complete before Phase 5 starts, so start it concurrently with Phase 3.
- Phase 2 is NOT on the critical path for report page delivery, but it IS required for Phase 6 QA (aggregate integrity testing needs hooks active). Start it in Window 2 alongside Phase 3.

---

## File Ownership Boundaries (Merge Conflict Prevention)

When running phases in parallel, each phase owns specific directories to prevent conflicts:

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/convex.config.ts` | **Phase 1 only** | Aggregate registration — one-time modification. |
| `convex/schema.ts` | **Phase 1 only** | Schema fields added once. Not modified by later phases. |
| `convex/reporting/aggregates.ts` | **Phase 1 (create)** | Created in Phase 1. Imported (read-only) by Phase 2 and 3. |
| `convex/reporting/backfill.ts` | **Phase 1 only** | Backfill mutations — used once, never modified. |
| `convex/reporting/lib/periodBucketing.ts` | **Phase 1 (create)** | Imported by Phase 3C (revenueTrend). |
| `convex/reporting/lib/helpers.ts` | **Phase 3A (create)** | Imported by Phase 3B, 3C, 3E (read-only). |
| `convex/reporting/lib/eventLabels.ts` | **Phase 3F (create)** | Imported by Phase 5E (read-only). |
| `convex/reporting/lib/outcomeDerivation.ts` | **Phase 3G (create)** | Available for future use. |
| `convex/reporting/teamPerformance.ts` | **Phase 3B** | New file. |
| `convex/reporting/revenue.ts` | **Phase 3C** | New file. |
| `convex/reporting/revenueTrend.ts` | **Phase 3C** | New file. |
| `convex/reporting/pipelineHealth.ts` | **Phase 3D** | New file. |
| `convex/reporting/leadConversion.ts` | **Phase 3E** | New file. |
| `convex/reporting/activityFeed.ts` | **Phase 3F** | New file. |
| `convex/reporting/formResponseAnalytics.ts` | **Phase 3G** | New file. |
| `convex/closer/meetingActions.ts` | **Phase 2A** | Modified once (new mutations + aggregate hooks). |
| `convex/pipeline/inviteeCreated.ts` | **Phase 2E → Phase 2B** | Two sequential modifications — same developer. |
| `convex/pipeline/inviteeCanceled.ts` | **Phase 2B** | Modified once (aggregate hooks). |
| `convex/pipeline/inviteeNoShow.ts` | **Phase 2B** | Modified once (aggregate hooks). |
| `convex/closer/noShowActions.ts` | **Phase 2C** | Modified once. |
| `convex/closer/followUpMutations.ts` | **Phase 2C** | Modified once. |
| `convex/closer/payments.ts` | **Phase 2C** | Modified once. |
| `convex/customers/mutations.ts` | **Phase 2D** | Modified once. |
| `convex/customers/conversion.ts` | **Phase 2D** | Modified once. |
| `convex/unavailability/redistribution.ts` | **Phase 2D** | Modified once. |
| `convex/lib/syncOpportunityMeetingsAssignedCloser.ts` | **Phase 2D** | Modified once. |
| `convex/lib/meetingFormResponseWriter.ts` | **Phase 2E** | Created or verified. |
| `app/workspace/_components/workspace-shell-client.tsx` | **Phase 4B** | Modified once (sidebar nav). |
| `app/workspace/reports/layout.tsx` | **Phase 4A** | Created once. |
| `app/workspace/reports/_components/` | **Phase 4C** | Shared date controls. |
| `app/workspace/reports/team/` | **Phase 4A (create) → Phase 5A (fill)** | Route created in 4, content in 5. |
| `app/workspace/reports/revenue/` | **Phase 4A (create) → Phase 5B (fill)** | Route created in 4, content in 5. |
| `app/workspace/reports/pipeline/` | **Phase 4A (create) → Phase 5C (fill)** | Route created in 4, content in 5. |
| `app/workspace/reports/leads/` | **Phase 4A (create) → Phase 5D (fill)** | Route created in 4, content in 5. |
| `app/workspace/reports/activity/` | **Phase 4A (create) → Phase 5E (fill)** | Route created in 4, content in 5. |
| `app/workspace/closer/meetings/[id]/_components/` | **Phase 2F** | End Meeting button + late-start dialog. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in order, leveraging within-phase parallelism:

1. **Phase 1** — all subphases (install → schema + aggregates + helpers in parallel → backfill → deploy)
2. **Phase 3** — shared helpers → all 6 query files in parallel (batch backend work)
3. **Phase 4** — routes + sidebar + date controls + skeletons (fast — 1 day)
4. **Phase 2** — mutation hooks + frontend (interleave with Phase 3 review if needed)
5. **Phase 5** — all 5 report pages (largest effort — use within-phase parallelism)
6. **Phase 6** — QA + fixes

**Solo strategy note:** Do Phase 3 before Phase 2 even though both start in Window 2. Phase 3 is on the critical path (blocks Phase 5), while Phase 2 is only needed for Phase 6. This maximizes throughput.

**Estimated time:** 15-20 days

### Two Developers (Backend + Frontend)

| Sprint | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| 1 | Phase 1 (all subphases) | Blocked — can prepare Phase 4 structure after 1A deploys schema |
| 2 | Phase 3A → Phase 3B, 3C, 3D | Phase 4 (complete — routes, sidebar, skeletons, date controls) |
| 3 | Phase 3E, 3F, 3G + Phase 2A | Phase 5A (Team Performance page — uses 3B query) |
| 4 | Phase 2B, 2C, 2D, 2E (aggregate hooks) | Phase 5B, 5C (Revenue + Pipeline pages) |
| 5 | Phase 2F (End Meeting frontend) | Phase 5D, 5E (Leads + Activity pages) |
| 6 | Phase 6A, 6B (data validation) | Phase 6C, 6D (edge cases + fixes) |

**Estimated time:** 10-13 days

### Three+ Developers / Agents

| Sprint | Agent A (Backend - Aggregates) | Agent B (Backend - Mutations) | Agent C (Frontend) |
|---|---|---|---|
| 1 | Phase 1A, 1B, 1C, 1E | Phase 1D (blocked on 1B+1C) | Blocked on Phase 1 |
| 2 | Phase 3A → 3B, 3C, 3D | Phase 2A, 2C, 2D (parallel hooks) | Phase 4 (complete) |
| 3 | Phase 3E, 3F, 3G | Phase 2E → 2B (pipeline hooks) | Phase 5A, 5B (Team + Revenue pages) |
| 4 | Phase 6A (Excel cross-reference) | Phase 2F (End Meeting frontend) | Phase 5C, 5D, 5E (Pipeline + Leads + Activity) |
| 5 | Phase 6B (aggregate integrity) | Phase 6D (fixes) | Phase 6C (edge cases) |

**Estimated time:** 8-11 days

### Four+ Agents (Maximum Parallelism)

| Sprint | Agent A (Aggregates) | Agent B (Queries) | Agent C (Mutations) | Agent D (Frontend) |
|---|---|---|---|---|
| 1 | Phase 1 (all) | — | — | — |
| 2 | Phase 3A, 3B, 3C | Phase 3D, 3E | Phase 2A, 2C, 2D | Phase 4 (all) |
| 3 | Phase 3F, 3G | Phase 6A (early validation) | Phase 2E → 2B | Phase 5A, 5B |
| 4 | Phase 6B (integrity) | Phase 6C (edge cases) | Phase 2F | Phase 5C, 5D, 5E |
| 5 | Phase 6D (fixes) | — | — | — |

**Estimated time:** 7-9 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 1** | After Phase 1 | `npx convex dev` succeeds. All 5 aggregate instances registered. `backfillMeetingClassification` sets classification on all meetings. All 5 aggregate backfills complete. Aggregate counts match direct table scans. `pnpm tsc --noEmit` passes. |
| **Gate 2** | After Phase 3 | All 7 reporting query files compile. Each query returns data when called with valid date range in Convex dashboard. `requireTenantUser` enforces admin-only access. |
| **Gate 3** | After Phase 2 + 4 | All 34 aggregate hook points are coded. Sidebar nav shows "Reports" for admin roles only. Report layout auth gate redirects closers. 5 skeletons render. `pnpm tsc --noEmit` passes. |
| **Gate 4** | After Phase 5 | All 5 report pages render with real data. Date range changes trigger reactive re-fetches. Charts render with correct data. Empty states display correctly. No console errors. |
| **Gate 5** | After Phase 6 | Excel cross-reference passes (within tolerance). Aggregate counts stay in sync after live mutations. All edge cases verified. No P0 or P1 bugs outstanding. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase 1 schema errors block everything | **Critical** | Deploy schema immediately after writing. Run `npx convex dev` before proceeding to any other subphase. Use `convex-migration-helper` skill if deployment fails. |
| `@convex-dev/aggregate` API doesn't match design assumptions | **High** | Phase 1A, Step 2: verify installed API exports before coding aggregate instances. Read the package's TypeScript declarations. Adjust if needed. |
| Missed aggregate hook (1 of 34) causes count drift | **High** | Phase 2 has an exhaustive touch point inventory from the design (§5.2.2). Cross-check every hook against the inventory. Phase 6B reconciliation catches misses. |
| `inviteeCreated.ts` merge conflicts (2E + 2B both modify it) | **Medium** | Assign both to the same developer. Run 2E first (smaller change), then 2B. Or combine into a single subphase. |
| Pipeline webhook during Phase 2 deployment | **Medium** | Phase 2 hooks are additive (they don't change existing behavior). Worst case: a few events don't get aggregate updates during deployment. Re-run backfill to reconcile. |
| Chart rendering issues (recharts + OKLCH colors) | **Medium** | Use shadcn's `ChartContainer` + `ChartConfig` pattern which handles color variable resolution. Test in both light and dark mode. |
| Revenue numbers don't match Excel (rounding, timezone) | **Medium** | Phase 6A specifically targets this. Tolerance is ±1% for rates, exact match for counts. Investigate any discrepancy — it reveals classification or boundary logic bugs. |
| Component complexity in Phase 5 exceeds estimate | **Medium** | Use shadcn/ui primitives for all components. Charts use the established shadcn chart pattern (ChartContainer). No third-party component libraries beyond what's already installed. |
| Activity Feed scan at 10x volume hits Convex limits | **Low** | The 10,000-event cap with `isTruncated` flag handles this. Document the scaling path (add `domainEventCounts` aggregate) but don't implement until needed. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-migration-helper` | If schema deployment fails or backfill needs widen-migrate-narrow strategy |
| **2** | `convex-performance-audit` | Verify aggregate hooks don't exceed function write limits |
| **2** | `shadcn` | Late-start dialog uses Dialog, Form, Textarea components |
| **3** | `convex-performance-audit` | Verify aggregate query costs (document reads per query) |
| **4** | `shadcn` | Calendar, Popover, Select components for date controls |
| **4** | `next-best-practices` | RSC page pattern, unstable_instant, layout auth gates |
| **4** | `vercel-composition-patterns` | Composing reusable report shell with shared date controls |
| **5** | `frontend-design` | Production-grade report page layouts and data visualization |
| **5** | `shadcn` | Chart components, Table, Card compositions |
| **5** | `vercel-react-best-practices` | React.memo for chart components, avoiding unnecessary re-renders |
| **5** | `vercel-composition-patterns` | Shared KPI card pattern, chart wrapper composition |
| **5** | `web-design-guidelines` | WCAG compliance on charts (color contrast, screen reader labels) |
| **6** | `convex-performance-audit` | Verify query costs and subscription overhead at scale |
| **6** | `web-design-guidelines` | Final accessibility audit on all report pages |

---

## Maximum Parallelism Summary

| Window | Phases | Max Concurrent Streams | Duration |
|---|---|---|---|
| **Window 1** | Phase 1 | 3 (within-phase) | 2-3 days |
| **Window 2** | Phase 2 + Phase 3 + Phase 4 | 3 (cross-phase) + internal parallelism within each | 3-4 days (longest is Phase 2 or 3) |
| **Window 3** | Phase 5 | 5 (one per report page) | 5.5-6.5 days |
| **Window 4** | Phase 6 | 3 (verification streams) | 1-2 days |

**Solo minimum: ~15 days** (leveraging within-phase parallelism only)
**Two devs: ~10-13 days** (backend + frontend split)
**Three agents: ~8-11 days** (aggregates + mutations + frontend)
**Four+ agents: ~7-9 days** (maximum parallelism across all windows)

---

*This strategy maximizes parallelization while respecting critical dependencies. The key insight: Phase 1 is the only sequential bottleneck. After it completes, Phase 2 (mutations), Phase 3 (queries), and Phase 4 (frontend shell) touch entirely different directories — enabling true triple parallelism. Phase 5 then allows 5-way parallelism across report pages. The critical path runs through Phase 1 → Phase 3 → Phase 5 → Phase 6.*
