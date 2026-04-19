# Parallelization Strategy — v0.6b Reporting Completion

**Purpose:** Define the parallel execution roadmap for v0.6b's 8 phases (A–H), identify the critical path, lay out file-ownership boundaries to prevent merge conflicts, and provide three concrete execution strategies (solo, 2-developer, 3+ agents). The goal is to maximize concurrency: v0.6b is unusually parallelizable because most phases ship read-side work against disjoint files.

**Prerequisite:**
- v0.6 aggregates live (`meetingsByStatus`, `paymentSums`, `opportunityByStatus`, `leadTimeline`, `customerConversions` registered and backfilled).
- `meetingReviews` table + `followUps.completionOutcome` + meeting-time fields + Fathom link fields + `meetingOverrunSweep` cron all shipped and running in production (`main`, 2026-04-18).
- `npx convex dev` accepts the current schema without errors.
- `pnpm tsc --noEmit` is green on `main`.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **A** | Activity Feed Parity & Fixes | Full-Stack (small) | Low | None |
| **B** | Team Report Completion | Full-Stack | Medium-High | None (consumes Phase A's extended summary only at UI level — not blocking) |
| **C** | Meeting-Time Audit Report | Full-Stack | Medium | None |
| **D** | Review Operations Report | Full-Stack | Medium | None (schema index is internal to D) |
| **E** | Reminder Outcome Funnel | Full-Stack | Medium | None (schema index is internal to E); Phase E5 placeholder upgraded by Phase G |
| **F** | Pipeline Health & Leads Completeness | Full-Stack | Medium | Mostly independent. F6 should sequence after Phase A because it relies on `actorBreakdown.actorRole`, but it has no dependency on Phase B's `teamActions.ts`. |
| **G** | Origin & Attribution Schema | Full-Stack (schema + migration) | High | G5 consumers depend on G4 + backfills complete; G1 widens `schema.ts` |
| **H** | Cross-Cutting Fixes (date bug, permissions, nav) | Full-Stack (tiny) | Low | H3 nav requires C/D/E pages to exist |

---

## Master Dependency Graph

```
                    ┌────────────────────────────────────────────────────────────────┐
                    │                  PRE-EXISTING MAIN (2026-04-18)                │
                    │  v0.6 aggregates, meetingReviews, followUps, meeting-time,     │
                    │  Fathom links, meetingOverrunSweep all live.                   │
                    └────────────────────────────────────────────────────────────────┘
                                                  │
        ┌──────────────────┬─────────────────┬───┼────┬─────────────────┬─────────────────┬────────────┐
        │                  │                 │        │                 │                 │            │
  ┌─────▼─────┐      ┌─────▼─────┐     ┌─────▼──┐ ┌───▼─────┐     ┌─────▼─────┐     ┌─────▼──┐    ┌────▼─────┐
  │  PHASE A  │      │  PHASE B  │     │ PHASE C│ │ PHASE D │     │  PHASE E  │     │ PHASE F│    │ PHASE H  │
  │ Activity  │      │   Team    │     │Meeting │ │ Review  │     │ Reminder  │     │Pipeline│    │ Date fix │
  │  Feed     │      │  Report   │     │  Time  │ │   Ops   │     │  Funnel   │     │ & Leads│    │  + perm  │
  │ (parity)  │      │(complete) │     │ Report │ │ Report  │     │  Report   │     │ (ext.) │    │  + nav   │
  └─────┬─────┘      └─────┬─────┘     └─────┬──┘ └───┬─────┘     └─────┬─────┘     └─────┬──┘    └────┬─────┘
        │                  │                 │        │                 │                 │            │
        └────────────────┬─┴─────────────────┴────────┴─────────────────┴─────────────────┘            │
                         │                                                                             │
                         │                          (all 7 phases can be developed in parallel — with  │
                         │                           the few shared files explicitly sequenced below)  │
                         │                                                                             │
                         ▼                                                                             │
                   ┌─────────────────────────────────────────────────────────────┐                     │
                   │                          PHASE G                            │                     │
                   │        Origin & Attribution Schema (HIGH-RISK)              │                     │
                   │  G1 widen → G2 + G3 backfill → G4 write rollout → G5 consumers                    │
                   │  G5a revenue-by-origin, G5b reminder-driven revenue,                              │
                   │  G5c team admin-logged col, G5d pipeline reminder split                           │
                   └─────────────────────────────────────────────────────────────┘                     │
                                                                                                        │
                                                                              H3 (nav) ─────────────────┘
                                                                              (after C+D+E land)
```

**Reading this graph:**
- 7 phases (A, B, C, D, E, F, H) sit at the top level. Most can ship in parallel; the few merge-order constraints (A → F6, C/D/E → H3) are called out explicitly below.
- Phase G is the only phase with internal sequencing: widen (G1) → backfills + write-site rollout (G2+G3+G4 in parallel) → consumers (G5a-d in parallel).
- Phase H has one internal dependency on other phases: H3's sidebar nav entries point to C/D/E's new routes.

---

## Maximum Parallelism Windows

### Window 1: Foundation + High Parallelism (Weeks 1–2)

**Concurrency:** Up to **7 active workstreams** (A, B, C, D, E, F, H) plus **Phase G1 schema widen** happening in parallel. Shared files still follow the merge-order rules below.

**Why this much parallelism is possible:**
- Most phases touch a **disjoint file set** — see the File Ownership Boundaries table below for the few explicit exceptions.
- Phase A/B/F modify existing backend files (`activityFeed.ts`, `teamPerformance.ts`, `pipelineHealth.ts`, `leadConversion.ts`, `formResponseAnalytics.ts`) but each phase owns a distinct backend file. The notable frontend exception is `app/workspace/reports/activity/_components/activity-summary-cards.tsx`, which is shared by A4 and F6 and should merge in that order.
- Phase C/D/E create **new route trees** (`/workspace/reports/meeting-time`, `/reviews`, `/reminders`) — zero file overlap.
- Phase D/E/G all modify `convex/schema.ts` (D adds one index, E adds one index, G1 adds fields + 2 indexes) — all three are **additive** schema changes; they can be coordinated via a single deploy or sequenced without conflict.
- Phase H's 4-file footprint is the smallest and disjoint from everything.

```
Timeline (days):  1 ─── 2 ─── 3 ─── 4 ─── 5 ─── 6 ─── 7 ─── 8 ─── 9 ─── 10
                  ▼
  Phase A  ████████
  Phase B  ██████████████████████
  Phase C  ████████████████
  Phase D  ████████████████
  Phase E  ████████████████
  Phase F  ██████████████████
  Phase H  ████
  Phase G1 █████                                  ← schema widen ships first
  Phase G2 ──────██████                           ← backfill after G1 live
  Phase G3 ──────██████                           ← backfill after G1 live
  Phase G4 ──────████████████████                 ← write-site rollout after G1 live
  Phase G5 ──────────────────────────████████████ ← consumers after G4 + backfills audited
```

**Internal parallelism within each phase:**

**Phase A (4 subphases):**
```
A1 (event labels — backend)     ──┐
A2 (getActivitySummary — backend)─┤
                                   ├── A4 (summary cards UI — depends on A1+A2)
A3 (event row fix — frontend)   ──┘   (A3 is independent; can ship alongside A1/A2 without waiting)
```

**Phase B (6 subphases):**
```
B1 (teamPerformance — backend) ────┐
B2 (teamOutcomes.ts — backend) ────┤ (all 3 backends in parallel)
B3 (teamActions.ts — backend)  ────┤
                                    ├── B4 (closer-performance-table — depends on B1)
                                    ├── B5 (KPI cards + outcome chart — depends on B1+B2+B3)
                                    └── B6 (meeting-time section — depends on B1)
```

**Phase C (5 subphases):**
```
C1 (meetingTime.ts — backend) ──┐
                                 ├── C3 (summary cards + source-split — depends on C1+C2)
C2 (route shell — frontend)  ───┤── C4 (histograms — depends on C1+C2)
                                 └── C5 (Fathom panel — depends on C1+C2)
```

**Phase D (5 subphases):**
```
D1 (schema index — backend) ──→ D2 (reviewsReporting.ts — backend) ──┐
                                                                     ├── D4 (backlog + mix + workload — depends on D2)
D3 (route shell — frontend; can stub) ──────────────────────────────┘── D5 (dispute + revenue + closer response — depends on D2)
```

**Phase E (5 subphases, same shape as Phase D):**
```
E1 (schema index — backend) ──→ E2 (remindersReporting.ts — backend) ──┐
                                                                        ├── E4 (funnel + cards — depends on E2)
E3 (route shell — frontend; can stub) ─────────────────────────────────┘── E5 (per-closer + chain + placeholder — depends on E2)
```

**Phase F (6 subphases):**
```
F1 (pipelineHealth.ts — backend) ──┐
F2 (leadConversion.ts — backend) ──┤ (all 3 backends in parallel)
F3 (formResponseAnalytics.ts — backend) ┤
                                    ├── F4 (pipeline UI — depends on F1)
                                    ├── F5 (leads UI — depends on F2+F3)
                                    └── F6 (activity UI — depends on Phase A's actorRole extension, but zero Phase B dependency)
```

**Phase G (5 subphases, sequenced):**
```
G1 (schema widen — backend) ──→ G2 (backfill payments — backend) ─┐
                              ── G3 (backfill followUps — backend) ─┤
                              ── G4 (write-site rollout — backend) ─┼── G5a (revenue chart — both)
                                                                    ├── G5b (reminder revenue card — both)
                                                                    ├── G5c (team admin col — both)
                                                                    └── G5d (pipeline reminder split — both)
```

**Phase H (3 subphases):**
```
H1 (date-range fix — frontend) ──┐
H2 (reports:view permission — backend + layout) ──┤  (H1, H2 fully parallel)
                                  │
H3 (sidebar nav — frontend) ─────┘  (H3 ships after C/D/E)
```

---

### Window 2: Phase G Write-Site Rollout (Week 3)

**Concurrency:** Up to **10 files modified in parallel** across G2, G3, G4 — each file is a different insert site.

**Why this works:**
- Each `paymentRecords` / `followUps` insert site is a distinct file or distinct function within a file.
- Multiple agents can open PRs simultaneously, one per file.
- The shared `outcomeHelpers.ts` widens first; once that typechecks, every direct-insert PR becomes an independent typecheck → deploy cycle.

```
Timeline:
              ░░ Day 1 ░░░░░░ Day 2 ░░░░░░ Day 3 ░░░░░░ Day 4 ░░
G4: outcomeHelpers.ts       ─────────────┐
                                         │
G4: closer/payments.ts       ────────────┤
G4: closer/reminderOutcomes  ────────────┤
G4: customers/mutations     ────────────┤  All parallel once helper widens
G4: closer/followUpMutations────────────┤
G4: closer/noShowActions    ────────────┤
G4: closer/meetingOverrun   ────────────┤
G4: admin/meetingActions    ────────────┤
G4: reviews/mutations       ────────────┘
                                         │
G2 backfill                 ─────────────┤ (runs in background via scheduler)
G3 backfill                 ─────────────┘
```

**Internal parallelism within G4:** 9 files, each with 1-3 insert sites. A 3-agent swarm can own 3 files each.

---

### Window 3: Phase G Consumers (Week 4)

**Concurrency:** 4 independent full-stack consumer streams (G5a, G5b, G5c, G5d).

**Why independent:**
- G5a touches `revenue.ts` + `revenue/` route.
- G5b touches `remindersReporting.ts` + `reminders/` route.
- G5c touches `teamPerformance.ts` + team's `closer-performance-table.tsx`.
- G5d touches `pipelineHealth.ts` + pipeline's `unresolved-reminders-card.tsx`.

All four use the origin fields that G4 now writes and the backfill populated. No overlap.

```
Timeline:         ░░ Day 1 ░░░░░░ Day 2 ░░░░░░ Day 3 ░░
G5a Revenue       ████████████████
G5b Reminder $    ████████████████
G5c Team col      ████████████████
G5d Pipeline      ████████████████
```

---

## Critical Path Analysis

The **critical path** determines minimum delivery time.

```
main
  │
  ├── Phase A/B/C/D/E/F/H (shortest path to 80% of v0.6b): ~10 days in sequence, ~3–4 days parallel.
  │
  └── Phase G (longest): G1 → G2+G3+G4 → G5 = ~5 days in sequence, can be compressed to ~3 days with parallel agents.
       │
       └── G5 unlocks Revenue-by-Origin, Reminder-Driven Revenue, Admin-Logged Revenue, Pipeline reminder split.
```

**Critical path:**

```
Phase G1 (schema widen)
   ↓
Phase G4 (write-site rollout) + G2 + G3 (backfills)  (parallel internally)
   ↓
Phase G5 (consumers)
```

**Days on the critical path (estimated):**
- G1: 0.5 day (single schema edit + deploy + verify)
- G2+G3+G4 parallel: 2 days (file count is the bottleneck — 10 insert sites + 2 backfills)
- G5 (4 parallel streams): 1.5 days

**Total critical path: ~4 days**, achievable with 1 backend engineer on G1, then 2–3 agents fanning out on G4.

**Alternative shorter paths (non-critical):**
```
Phase A (parity fixes):                     ~1 day
Phase H1 (date fix):                         ~0.5 day
Phase C (meeting-time report):               ~2 days
Phase D (review ops):                        ~2 days
Phase E (reminder funnel):                   ~2 days
Phase B (team report completion):            ~3 days
Phase F (pipeline + leads extensions):       ~3 days
```

These can all ship inside Week 1 while Phase G's schema widen is being prepared.

**Implication:** Phase G is the **pacing constraint for the full v0.6b scope.** Start G1 as early as possible on Day 1 alongside the other phases — deploy G1 schema on Day 1 or 2 so G2/G3/G4 can start by Day 3. If Phase G slips, the revenue/reminder/team consumers don't land, but every other report surface still ships independently.

**Accelerate Phase G:** if a dedicated backend engineer owns Phase G end-to-end with `convex-migration-helper` already installed, the critical path can compress to **2.5 days**.

---

## File Ownership Boundaries (Merge Conflict Prevention)

These ownership boundaries are the most important section of this document. Respect them to enable parallel execution.

### Backend — `convex/`

| File / Directory | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | **D (index), E (index), G1 (fields + 2 indexes)** | All three additions are commutative. Co-deploy safe. Recommend sequencing: D + E ship indexes in one PR; G1 ships fields + 2 indexes in a second PR. |
| `convex/reporting/aggregates.ts` | **Nobody** — unchanged | Aggregates do not change in v0.6b. |
| `convex/reporting/teamPerformance.ts` | **B (modify), G5c (extend)** | Phase B splits `meeting_overran` + adds meeting-time block; Phase G5c adds `adminLoggedRevenueMinor` per closer. Different diff regions; merge sequentially B → G5c. |
| `convex/reporting/teamOutcomes.ts` | **B (new)** | |
| `convex/reporting/teamActions.ts` | **B (new)** | |
| `convex/reporting/meetingTime.ts` | **C (new)** | |
| `convex/reporting/reviewsReporting.ts` | **D (new)** | |
| `convex/reporting/remindersReporting.ts` | **E (new), G5b (extend)** | E creates; G5b adds `reminderDrivenRevenueMinor`. Sequence E → G5b. |
| `convex/reporting/pipelineHealth.ts` | **F1 (modify), G5d (extend)** | F1 adds staleCount + `getPipelineBacklogAndLoss`; G5d adds `unresolvedReminderSplit`. Sequence F1 → G5d. |
| `convex/reporting/leadConversion.ts` | **F2 (modify)** | Single modifier. |
| `convex/reporting/activityFeed.ts` | **A (extend `getActivitySummary`)** | A is the only modifier; F6 only **consumes** the extended summary via prop. |
| `convex/reporting/formResponseAnalytics.ts` | **F3 (modify — add new export)** | |
| `convex/reporting/revenue.ts` | **G5a (modify)** | |
| `convex/reporting/revenueTrend.ts` | **Nobody** — unchanged | |
| `convex/reporting/backfill.ts` | **G2 + G3 (add 2 mutations + 2 audit queries)** | |
| `convex/reporting/writeHooks.ts` | **Nobody** — unchanged | |
| `convex/reporting/verification.ts` | **Nobody** — unchanged | |
| `convex/reporting/lib/eventLabels.ts` | **A (add 9 labels)** | Only modifier. |
| `convex/reporting/lib/outcomeDerivation.ts` | **Nobody** — unchanged (consumer added in B2) | TODO at lines 48-62 is DQ disambiguation — deferred to v0.7. |
| `convex/reporting/lib/helpers.ts` | **Nobody** — unchanged (reused widely) | |
| `convex/reporting/lib/periodBucketing.ts` | **Nobody** — unchanged | |
| `convex/lib/outcomeHelpers.ts` | **G4** | Extends signatures with required `origin` / `createdBy` / `createdSource`. |
| `convex/lib/permissions.ts` | **H2** | Adds `"reports:view"`. |
| `convex/closer/payments.ts` | **G4** | 1 insert site updated. |
| `convex/closer/reminderOutcomes.ts` | **G4** | 1 payment + 1 followUp insert updated. |
| `convex/closer/followUpMutations.ts` | **G4** | 3 followUp inserts updated. |
| `convex/closer/noShowActions.ts` | **G4** | 1 followUp insert updated. |
| `convex/closer/meetingOverrun.ts` | **G4** | 1 followUp insert updated. |
| `convex/customers/mutations.ts` | **G4** | 1 payment insert updated. |
| `convex/admin/meetingActions.ts` | **G4** | 3 followUp inserts updated (reasons: `admin_initiated`, `overran_review_resolution`). |
| `convex/reviews/mutations.ts` | **G4** | payment + followUp inserts updated. |
| `convex/reviews/queries.ts` | **Nobody** — unchanged | Operational inbox is Phase D's explicit non-goal. |

### Frontend — `app/workspace/reports/`

| File / Directory | Phase Owner | Notes |
|---|---|---|
| `app/workspace/reports/_components/report-date-controls.tsx` | **H1** | |
| `app/workspace/reports/layout.tsx` | **H2** | Auth guard swap. |
| `app/workspace/reports/page.tsx` | **Nobody** — unchanged | Already redirects to /team. |
| `app/workspace/reports/team/` | **B (modify), G5c (extend closer-performance-table)** | Phase B touches every file in the team route; G5c adds one column to closer-performance-table. Sequence B → G5c. |
| `app/workspace/reports/revenue/` | **G5a** | Adds `revenue-by-origin-chart.tsx`; extends `revenue-report-page-client.tsx`. |
| `app/workspace/reports/pipeline/` | **F4 (modify + add 4), G5d (modify unresolved-reminders-card)** | F4 creates 4 new components + extends stale-pipeline-list + page-client; G5d extends one card. Sequence F4 → G5d. |
| `app/workspace/reports/leads/` | **F5 (add 4 + extend page-client)** | |
| `app/workspace/reports/activity/` | **A (modify event row + summary cards), F6 (extend summary cards)** | A and F6 both touch activity-summary-cards.tsx — A first, then F6 adds the 2 new cards in a new grid row below. |
| `app/workspace/reports/meeting-time/` | **C (new)** | Entire new route tree. |
| `app/workspace/reports/reviews/` | **D (new)** | Entire new route tree. |
| `app/workspace/reports/reminders/` | **E (new), G5b (upgrade one card)** | E creates the tree; G5b upgrades `reminder-driven-revenue-card.tsx` from placeholder to real. Sequence E → G5b. |

### Frontend — `app/workspace/_components/`

| File | Phase Owner | Notes |
|---|---|---|
| `app/workspace/_components/workspace-shell-client.tsx` | **H3** | Adds 3 nav entries. |
| All other workspace shell files | **Nobody** — unchanged | |

### Shared Phase-Overlap Merge Rules

When two phases modify the same file, follow this merge order:

| File | First → Second → Third |
|---|---|
| `convex/schema.ts` | Phase D + Phase E (indexes only) → Phase G1 (fields + indexes) |
| `convex/reporting/teamPerformance.ts` | Phase B (split + meetingTime) → Phase G5c (adminLoggedRevenue) |
| `convex/reporting/pipelineHealth.ts` | Phase F1 (staleCount + backlog query) → Phase G5d (reminder split) |
| `convex/reporting/remindersReporting.ts` | Phase E (create) → Phase G5b (revenue extension) |
| `convex/reporting/activityFeed.ts` | Phase A (summary extensions) — single modifier; Phase F6 **reads** but does not modify |
| `app/workspace/reports/team/_components/closer-performance-table.tsx` | Phase B (add review + commercial cols) → Phase G5c (add admin-logged col) |
| `app/workspace/reports/activity/_components/activity-summary-cards.tsx` | Phase A (byEventType + byOutcome cards) → Phase F6 (mostActiveCloser + actionsPerCloser cards in new grid row below) |
| `app/workspace/reports/pipeline/_components/unresolved-reminders-card.tsx` | Phase F4 (create) → Phase G5d (add split prop) |
| `app/workspace/reports/reminders/_components/reminder-driven-revenue-card.tsx` | Phase E5 (placeholder) → Phase G5b (replace with live data) |

---

## Recommended Execution Strategies

### Solo Developer

Sequence that maximizes within-phase parallelism and minimizes context switching:

1. **Day 1 (warmup):** Phase A (all subphases) + Phase H1 (date fix) + Phase H2 (permission + layout swap). These are all small, disjoint, and ship together as the "v0.6b quick wins" PR.
2. **Day 2:** Phase G1 (schema widen — deploy early so backfills can run).
3. **Days 3–4:** Phase C (backend C1 → frontend C2/C3/C4/C5). One report surface from end-to-end.
4. **Days 5–6:** Phase D (backend D1/D2 → frontend D3/D4/D5). Second report surface.
5. **Days 7–8:** Phase E (backend E1/E2 → frontend E3/E4/E5). Third report surface.
6. **Days 9–10:** Phase B (backend B1/B2/B3 → frontend B4/B5/B6). Team report completion.
7. **Day 11:** Phase F (backend F1/F2/F3 → frontend F4/F5/F6).
8. **Days 12–13:** Phase G2/G3/G4 (backfill + write-site rollout); trigger G2/G3 in background between steps.
9. **Day 14:** Verify backfill audits; Phase G5 (4 consumers).
10. **Day 15:** Phase H3 (sidebar nav); QA sweep; merge.

**Estimated total: 15 working days** (3 calendar weeks).

### Two Developers (Backend + Frontend)

Assuming a clear split between backend specialist (A) and frontend specialist (B):

| Sprint (2 days) | Developer A (Backend) | Developer B (Frontend) |
|---|---|---|
| **1** | Phase A1, A2 (event labels + summary ext) + Phase G1 (schema widen) + Phase H2 (permission) | Phase A3, A4 (event row + summary cards) + Phase H1 (date fix) |
| **2** | Phase B1, B2, B3 (teamPerformance split + outcomes + actions) + Phase C1 (meetingTime.ts) | Phase C2 (shell + skeletons) + Phase C3/C4/C5 (all UI) |
| **3** | Phase D1, D2 (schema index + reviewsReporting) + Phase E1, E2 (schema index + remindersReporting) | Phase D3/D4/D5 (reviews UI) + Phase E3/E4/E5 (reminders UI) |
| **4** | Phase F1, F2, F3 (pipelineHealth + leadConversion + formResponse) + Phase G2, G3, G4 (backfill + write-site) | Phase F4/F5/F6 (all UI) + Phase B4/B5/B6 (team UI) |
| **5** | Phase G5 backend (revenue / reminders / team / pipeline consumers) | Phase G5 frontend (revenue chart, reminder revenue card, team col, pipeline split) + Phase H3 (nav) |

**Estimated total: 10 working days** (2 calendar weeks).

### Three+ Developers / Agents

Agent A = Backend-Path-1, Agent B = Backend-Path-2, Agent C = Frontend-Full-Stack, Agent D = QA / integration.

| Sprint (2 days) | Agent A (Backend Path 1) | Agent B (Backend Path 2) | Agent C (Frontend) | Agent D (QA / Integration) |
|---|---|---|---|---|
| **1** | Phase G1 (schema widen — block gate) | Phase A1, A2 + Phase F3 | Phase A3, A4 + Phase H1 + Phase C2 shell | Review `main`, prep test fixtures |
| **2** | Phase G2, G3 (backfills, scheduler-driven) + Phase H2 | Phase B1, B2, B3 + Phase C1 + Phase D1, D2 | Phase C3/C4/C5 + Phase E3 shell | QA Phase A; verify backfill checks |
| **3** | Phase G4 — write-site rollout (9 files, ships in sub-PRs) | Phase E1, E2 + Phase F1, F2 | Phase D3/D4/D5 + Phase E4/E5 + Phase B4/B5/B6 | QA C, D; audit `unset: 0` after G2/G3 |
| **4** | Phase G5a + G5c (revenue, team column backend) | Phase G5b + G5d (reminder revenue, pipeline split backend) | Phase F4/F5/F6 + Phase G5 frontend (all 4 consumers) | QA E, F, B; full regression |
| **5** | — | — | Phase H3 (nav) + polish | Final QA sweep; release notes |

**Estimated total: 8 working days** (1.5 calendar weeks). The critical constraint is Phase G's sequential backbone (G1 → G4 → G5); Agent A stays on Phase G end-to-end to minimize context switching.

---

## Quality Gates

Each gate verifies the system is in a known-good state before proceeding. Execute the checks manually per `TESTING.MD` where browser verification is called out.

| Gate | Trigger (after which phase) | Checks |
|---|---|---|
| **Gate 1 — Phase A shipped** | After Phase A merges | `rg -n 'eventType: "' convex \| sort -u` yields no event types missing from EVENT_LABELS. Activity page renders status transitions for `opportunity.status_changed`. Summary cards include Top Event Types + Outcome Mix. `pnpm tsc --noEmit` passes. |
| **Gate 2 — Phase B shipped** | After Phase B merges | Team page renders 10-column `CloserPerformanceTable`. `meeting_overran` appears in its own column; not in no-shows. `MeetingOutcomeDistributionChart` pie chart renders. `Meeting Time` section renders 7 cards + per-closer table. 3 new summary cards (Lost Deals, Rebook Rate, Actions/Closer/Day). Manual QA: compare Jan+Feb 2026 numbers to a hand-computed sample within 5%. |
| **Gate 3 — Phase C shipped** | After Phase C merges | `/workspace/reports/meeting-time` renders 8 summary cards + 2 histograms + source-split panel + Fathom compliance panel. Empty state + truncation banner behave. Accessibility audit (axe-core) passes. |
| **Gate 4 — Phase D shipped** | After Phase D merges | `convex/schema.ts` has `meetingReviews.by_tenantId_and_resolvedAt` index. `/workspace/reports/reviews` renders backlog card + resolution mix chart + workload table + 4 KPI cards + closer response mix. Operational inbox at `/workspace/reviews` unchanged. |
| **Gate 5 — Phase E shipped** | After Phase E merges | `convex/schema.ts` has `followUps.by_tenantId_and_createdAt` index. `/workspace/reports/reminders` renders funnel + outcome card grid + per-closer table + chain-length histogram. Phase-G placeholder card renders. |
| **Gate 6 — Phase F shipped** | After Phase F merges | Pipeline page shows Stale Count (true count, not capped), Pending Overran Reviews, Unresolved Reminders, No-Show Source Split, Loss Attribution. Leads page shows 4 new KPIs + Top Answer list. Activity page shows Most Active Closer + Actions/Closer/Day. |
| **Gate 7 — Phase G1 widen live** | After Phase G1 deploys | `npx convex dev` accepts schema. `paymentRecords` / `followUps` rows still valid. 2 new indexes visible in Convex dashboard. Pre-existing queries still type-check. |
| **Gate 8 — Phase G2/G3 backfills complete** | After backfill mutations finish | `auditPaymentOriginBackfill` returns `{ unset: 0 }`. `auditFollowUpOriginBackfill` returns `{ unset: 0 }`. No logs of "defaulted" rows at unreasonable volumes (>5% of total). |
| **Gate 9 — Phase G4 write-site rollout complete** | After all 9 mutation files merge | Log a new payment as closer — row has `origin = "closer_meeting"` (verified via `npx convex data paymentRecords --limit 1` post-insert). Log as admin — `origin = "admin_meeting"` + `loggedByAdminUserId` set. Complete a reminder payment — `origin = "closer_reminder"`. Record a customer payment — `origin = "customer_flow"`. |
| **Gate 10 — Phase G5 consumers live** | After G5a/b/c/d merge | Revenue page renders Revenue-by-Origin chart. Reminders page shows Reminder-Driven Revenue card with numbers (no "Pending Phase G" placeholder). Team table has Admin-Logged column. Pipeline card shows admin/closer split. |
| **Gate 11 — Phase H shipped** | After H1/H2/H3 merge | Date picker selecting "April 1 → April 30" includes April 30 meetings. `/workspace/reports/layout.tsx` uses `requireWorkspaceUser()` + `hasPermission(access.crmUser.role, "reports:view")`. Sidebar has 8 reports entries (5 old + 3 new). |
| **Gate 12 — Final release** | All gates green | Full QA sweep per `TESTING.MD`. `pnpm tsc --noEmit` green. Next.js 16 build succeeds (`pnpm build`). Convex deploys without validation errors. No regressions reported against `main` behavior. |

---

## Risk Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Phase G1 schema widen breaks existing queries | **Critical** | All new fields are `v.optional`; no existing field changes. Deploy `npx convex dev` in dev first, verify no type errors in existing queries, then ship. |
| Phase G2/G3 backfill produces malformed rows | **High** | Idempotent design — re-run if wrong. Audit queries report `unset: 0` before consumers light up. Fall-back to "unknown" bucket surfaces issues via Revenue-by-Origin chart. |
| Phase G4 write-site rollout misses an insert site | **High** | `createPaymentRecord` / `createManualReminder` helpers make `origin` / `createdSource` required TS parameters. Direct inserts also require them. `pnpm tsc --noEmit` fails loudly if a consumer is missed. |
| Schema co-deploy conflict between Phase D, E, G | **Medium** | Deploy order: D + E indexes first (single PR), then G1 fields + indexes (second PR). Both are additive; Convex accepts. |
| Meeting-time scan exceeds transaction limits | **Medium** | All new queries bound at 2,000 rows. Phase B's extended scan runs inside the existing query (bounded). Phase C/D/E each own separate queries with their own bounds. `convex-performance-audit` skill verifies. |
| Team report response shape change breaks existing consumers | **Medium** | Phase B extends `getTeamPerformanceMetrics` additively. Only consumer is `team-report-page-client.tsx`. Confirm via `rg -n 'getTeamPerformanceMetrics' app convex` before merging B1. |
| Activity Feed regression on legacy rows | **Low** | Phase A3 preserves `metadata.fromStatus` fallback. Pre-schema-v2 events continue to render. |
| Phase H3 ships sidebar nav before routes exist | **Low** | H3 explicitly gated — ships after C, D, E. If H3 ships early, links 404 until routes land; recoverable. |
| `ChartContainer` / Recharts render regressions on new charts | **Low** | Every new chart reuses `components/ui/chart.tsx` shadcn wrapper. Configure color tokens with `--chart-*` CSS variables. QA in both light and dark mode. |
| Parallel PR merge conflicts on `convex/schema.ts` | **Medium** | File Ownership table designates D + E + G as additive modifiers. Rebase each PR against latest `main` before merge. If three PRs race, merge D → E → G in that order. |
| Phase G narrowing later breaks writes | **Critical if attempted** | Narrowing is **explicitly deferred** (design §10.4). Any future narrowing requires its own widen-migrate-narrow cycle. Do not attempt to narrow in v0.6b. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **A** | `web-design-guidelines`, `vercel-react-best-practices`, `shadcn` | UI-only extensions; accessibility + re-render stability. |
| **B** | `convex-performance-audit`, `shadcn`, `web-design-guidelines`, `frontend-design`, `vercel-react-best-practices` | Additional meeting scan + Outcome Distribution chart + 10-column table. |
| **C** | `convex-performance-audit`, `shadcn`, `frontend-design`, `web-design-guidelines`, `next-best-practices` | New route tree + 3 new chart types + full-stack audit report. |
| **D** | `convex-performance-audit`, `shadcn`, `web-design-guidelines`, `frontend-design` | Schema index + 8 UI panels; sortable workload table. |
| **E** | `convex-performance-audit`, `shadcn`, `web-design-guidelines`, `frontend-design` | Schema index + funnel visualization + chain histogram. |
| **F** | `convex-performance-audit`, `shadcn`, `web-design-guidelines` | 3 backend extensions; 8 new UI panels across pipeline/leads/activity. |
| **G** | **`convex-migration-helper`** (canonical), `convex-performance-audit`, `vercel-react-best-practices` | Widen-migrate-narrow schema migration; 10-file write rollout; 4 reporting consumers. |
| **H** | `next-best-practices`, `web-design-guidelines` | Layout-level auth; sidebar nav accessibility. |

---

## Why v0.6b Is Unusually Parallelizable

Most features ship as a sequential chain: design → schema → auth → API → page. v0.6b is different:

1. **Most phases are read-side.** Only Phase G touches write paths. Phases A, B, C, D, E, F, H all consume already-written data — so the blast radius is constrained to the reporting surface, and a bug in one phase never corrupts production data.
2. **New routes create zero file overlap.** Phases C, D, E each own their own `/workspace/reports/{name}/` tree. Concurrent work on these three trees has no conflict potential.
3. **Backend extensions are additive.** Every `getTeamPerformanceMetrics`, `getPipelineBacklogAndLoss`, `getActivitySummary` extension appends fields; nothing is removed. Old consumers continue to work.
4. **Schema changes are narrow and additive.** Only indexes (D, E) and optional fields (G1). Widen-only migration avoids narrowing risk.
5. **Operational inbox is strictly out of bounds.** `convex/reviews/queries.ts` and `app/workspace/reviews/` are not in Phase D's scope — the reports surface is a strict sibling.
6. **File ownership is explicit.** The table above names the owner of every shared file so parallel agents know when to coordinate.

*This strategy was derived from the actual file-audit of `main` on 2026-04-18 and cross-referenced against `plans/v0.6b/v0-6b-design.md`. Re-verify against `main` if implementation starts more than 7 days after 2026-04-18.*
