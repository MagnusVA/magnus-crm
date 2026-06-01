# Phase 0 — Preflight, Query Budget, and Blast Radius

**Status:** Complete (2026-06-01)  
**Goal:** Lock implementation guardrails before schema or UI work starts.

**Prerequisite:** `plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md` accepted for MVP scope.

**Runs in PARALLEL with:** Nothing at the phase level. Phase 0 is a short foundation gate before implementation starts.

---

## Acceptance criteria (Gate 0)

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Storage: keep `leadGenWorkerSchedules`; add `slackQualifierSchedules` + `dmCloserSchedules`; no master schedule table in MVP | **Locked** | Design §4.3; Phase 1 added only the planned additive schedule tables |
| 2 | No manual per-day schedule bucket table in any phase plan | **Verified** | Grep across `plans/overview-efficiency-schedules/**` — only prohibitions, no bucket-table plans |
| 3 | Every backend read path has table/index/cap strategy before coding | **Documented** | Query budget tables below (0B) |
| 4 | Every frontend subscription accounted for (active vs skip) | **Documented** | Subscription budget (0D) |
| 5 | Blast-radius table for touched / indirect areas | **Documented** | Blast-radius lock (0E) |
| 6 | Rollout prevents efficiency-first ranking before schedule coverage or null-rate messaging | **Documented** | Rollout gate (0F); Phase 5 owns final decision |
| 7 | MVP does not require a data backfill | **Locked** | Additive empty tables; missing rows → 0 hours / null rate |
| 8 | Aggregate/backfill ideas deferred to separate migration plan | **Locked** | Migration triggers (0C); DM aggregate only if cap fails |
| 9 | `pnpm tsc --noEmit` listed as gate for every implementation phase | **Verified** | All phase plans include criterion; parallelization Gate 0–5 |
| 10 | `pnpm tsc --noEmit` passes | **Passed** | `pnpm tsc --noEmit` exit 0 on 2026-06-01 |

**Gate 0 decision:** Proceed to Phase 1 (schema + shared `workSchedule` library).

---

## Skills invoked

| Skill | Use in Phase 0 |
|-------|----------------|
| `convex-performance-audit` | Bounded reads, subscription cost, hot-path classification |
| `convex-migration-helper` | Additive MVP vs migration triggers |
| `next-best-practices` | RSC/client boundaries for settings + overview |
| `shadcn` | Reuse Tabs, Table, Card, Field, Input, Select from Lead Gen settings |
| `frontend-design` | Dense operational admin UI; match workspace patterns |

**Convex contract:** `convex/_generated/ai/guidelines.md` overrides general Convex knowledge for all later phases.

---

## Subphase dependency graph

```
0A (Source + docs inventory) ─────┬── 0B (Convex query budget) ──────────┐
                                 ├── 0C (Migration/no-backfill gate) ───┤
                                 ├── 0D (Frontend subscription budget) ─┤── 0E (Blast-radius lock)
                                 └── 0F (Rollout gate definition) ──────┘
```

**Execution:** 0A → parallel 0B/0C/0D/0F → 0E consolidation.

---

## 0A — Source and reference inventory (complete)

### Design and internal docs

| Document | Role |
|----------|------|
| `plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md` | Product contract (§4.3 storage, §4.6 numerators, §17 skills) |
| `plans/overview-efficiency-schedules/phases/parallelization-strategy.md` | Critical path, file ownership, quality gates |
| `.docs/internal/phases-planification-creation.md` | Phase doc conventions |
| `.docs/internal/parallelization.md` | Parallel execution patterns |
| `convex/_generated/ai/guidelines.md` | Convex implementation contract |

### Verified implementation surfaces (rg + file read)

| Symbol / area | Primary locations | Notes |
|---------------|-------------------|-------|
| `leadGenWorkerSchedules` | `convex/schema.ts` (L141–155), `convex/leadGen/schedules.ts`, `convex/leadGen/workers.ts`, `app/workspace/lead-gen/_components/lead-gen-settings-page-client.tsx` | Weekday + hours; Sunday-first `WEEKDAYS[date.getUTCDay()]` in `schedules.ts` |
| `slackQualificationEvents` | `convex/schema.ts`, `convex/reporting/lib/slackQualificationLedger.ts` | `MAX_QUALIFICATION_EVENTS = 1000` cap |
| `slackQualificationsByUser` | `convex/convex.config.ts`, `convex/reporting/slackQualifications.ts` | Aggregate for report counts; overview breakdown still uses ledger today |
| `meetingsByStatus` | `convex/convex.config.ts`, `convex/reporting/writeHooks.ts` | Phone-closer oriented aggregate; not DM booking `createdAt` |
| Top DM closers (overview) | `convex/dashboard/overviewOperations.ts` → `getTopDmClosersOverviewSection` | **Today:** `operationsMeetingDailyStats` by `dayKey`, ranked by `scheduled` count |
| Overview dashboard | `convex/dashboard/overview.ts`, `overviewBuilders.ts`, `app/workspace/_components/dashboard-page-client.tsx` | Single `useQuery(getOverviewDashboard)` for admins |
| DM closer registry | `convex/attribution/dmClosers.ts` | `listDmClosers` uses `.take(300)` closers, `.take(200)` teams |
| Settings shell | `app/workspace/settings/_components/settings-page-client.tsx` | `useSearchParams` inside Suspense; tabs: calendly, event-types, field-mappings, programs, integrations, attribution |

### Not present yet (expected)

- `slackQualifierSchedules`, `dmCloserSchedules` — Phase 1 schema
- `convex/workSchedules.ts`, `convex/workSchedules/rangeHours.ts` — Phases 2–3
- `convex/dashboard/overviewLeaderboards.ts` — Phase 4
- `overview-expandable-leaderboard.tsx` — Phase 4

---

## 0B — Convex query budget (complete)

**Principles (from `convex-performance-audit`):** Registry scans ~300 actors are acceptable; prohibit unbounded `.collect()`, Convex `.filter()` for DB filtering, `.collect().length`, and public `ctx.runQuery` composition where helpers suffice. No new digest/daily-bucket/aggregate tables without a separate migration plan.

### Planned functions (implementation phases)

| Function / helper | Source tables | Index strategy | Cap / bound | Phase |
|-----------------|---------------|----------------|-------------|-------|
| `listSlackQualifierSchedules` | `slackUsers`, `slackQualifierSchedules` | `by_tenantId`; `by_tenantId_and_slackUserId` (+ weekday unique) | Users `.take(300)`; ≤7 schedule rows per actor | 2 |
| `listDmCloserSchedules` | `dmClosers`, `attributionTeams`, `dmCloserSchedules` | `by_tenantId_and_teamId` / `by_tenantId`; actor+weekday | Closers `.take(300)` (match `listDmClosers`); teams `.take(200)`; ≤7 rows/actor | 2 |
| `getOverviewDashboard` | existing section sources | existing indexes | Top 5 per leaderboard card only | 3–5 |
| `buildLeadGenEfficiencyRows` | `leadGenDailyStats`, `leadGenWorkers`, `leadGenWorkerSchedules` | `by_tenantId_and_dayKey`, `by_tenantId_and_workerId` | `DAILY_STATS_READ_LIMIT = 500`; registry from rows | 3 |
| `buildQualifierEfficiencyRows` | `slackUsers`, `slackQualifierSchedules`, aggregates, bounded ledger | `by_tenantId_and_submittedAt`; aggregate bounds `[slackUserId, submittedAt]` | Registry ≤300; ledger `MAX_QUALIFICATION_EVENTS = 1000` | 3 |
| `buildDmCloserEfficiencyRows` | `meetings`, `dmClosers`, `dmCloserSchedules` | `meetings.by_tenantId_and_createdAt` (planned) | Bounded meeting scan per Phase 3 plan | 3 |
| `listOverviewLeaderboardRows` | shared builders | same as above | Full registry-capped set | 4 |

### Current vs planned (verified today)

| Area | Current behavior | Planned change | Blast note |
|------|------------------|----------------|------------|
| Lead Gen top 5 | `buildWorkerPerformanceRows` → `compareWorkerPerformanceRows` sorts by **submissions** (`convex/leadGen/reportBuilders.ts` L111–119) | Dashboard-only efficiency sort in new builder; **do not** change `compareWorkerPerformanceRows` | Lead Gen Ops reports/exports stay quantity-first |
| Top Qualifiers | `buildSlackUserQualificationBreakdown` sorts by **`total` events** (L94–101); ledger cap 1000 | Rank by unique Slack opportunities / hour; prefer `slackQualificationsByUser` for numerators | `getQualificationReport` semantics unchanged |
| Top DM Closers | `operationsMeetingDailyStats` + `OPERATIONS_STATS_ROW_LIMIT = 1000` (`overviewOperations.ts`) | Phase 3: **`meetings` by `createdAt`**, exclude `follow_up`; **do not** use ops daily stats for booking-created metric | Phone closer ops section still uses same stats table |
| Overview payload | Parallel sections in `overviewBuilders.ts`; no expanded rows | Add efficiency fields to types; keep top 5 only on first paint | Minimize RSC boundary growth |

### Prohibited patterns (locked)

- Unbounded `.collect()`, Convex `.filter()` on DB queries, `.collect().length`
- Reusing `leadGenWorkerSchedules` for Slack/DM actors (would require migration + discriminated schema)
- Master `workSchedules` polymorphic table in MVP
- Persisted per-day schedule buckets or schedule-hour snapshots for Slack/DM
- Efficiency sort inside `convex/leadGen/reportBuilders.ts` shared export paths

---

## 0C — Migration and rollout gate (complete)

### No-migration MVP conditions (all must hold)

| Condition | Verified |
|-----------|----------|
| `leadGenWorkerSchedules` unchanged except validator re-export path (Phase 1) | Yes — table shape stable in `schema.ts` |
| `slackQualifierSchedules` + `dmCloserSchedules` are **new** tables | Yes — not in schema yet |
| Missing schedule → 0 scheduled hours, `null` efficiency | Design + Phase 3 helpers |
| No existing field becomes required | Yes |
| No historical aggregate backfill before reads switch | Yes for MVP |

**Operational note:** Manual schedule entry in settings is **not** a Convex migration job.

### Migration triggers (if scope changes, stop and plan)

| Change | Migration? | Reason |
|--------|:----------:|--------|
| Add new schedule tables | No | Empty tables deploy cleanly |
| Add indexes on new tables | No | No correctness issue |
| Move Lead Gen to master schedule table | **Yes** | Copy + dual-read |
| Widen `leadGenWorkerSchedules` for polymorphic actors | **Yes** | Semantics + indexes change |
| New DM booking aggregate + historical backfill | **Yes** | Component registration + verification |

---

## 0D — Frontend subscription budget (complete)

| Surface | Query | When active | When skipped | Notes |
|---------|-------|-------------|--------------|-------|
| Overview dashboard | `api.dashboard.overview.getOverviewDashboard` | `isAdmin === true` | `"skip"` for non-admins | Verified `dashboard-page-client.tsx` L36–38 |
| Expanded leaderboard (planned) | `api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows` | Card `open === true` | `"skip"` when collapsed | One expanded card at a time (Phase 4) |
| Expanded search (planned) | Same query args | Debounce via `useDeferredValue(search)` | — | Local filter only; no per-row `useQuery` |
| Settings schedules tab (planned) | `listSlackQualifierSchedules`, `listDmCloserSchedules` | Admin on `/workspace/settings?tab=schedules` | Not on overview first paint | Add `schedules` to tab union without breaking existing tabs |
| Settings (existing) | Calendly, event types, etc. | `isAdmin` | `"skip"` | Preserve Suspense + `useSearchParams` pattern |

**Next.js:** Settings page already wraps content in `<Suspense>` (`settings-page-client.tsx`). New tab follows same pattern.

**UI primitives (shadcn):** Reuse from `lead-gen-settings-page-client.tsx`: `Tabs`, `Table`, `Card`, `Input`, `Select`, `Field`, `Button`, `MemberIdentity`.

---

## 0E — Blast radius lock (complete)

| Feature area | Why in radius | Guardrail | Key files |
|--------------|---------------|-----------|-----------|
| Lead Gen Ops reporting/export | Shared `buildWorkerPerformanceRows` / `compareWorkerPerformanceRows` | Efficiency sort only in **dashboard** builders; exports keep submission sort | `convex/leadGen/reportBuilders.ts`, `overviewLeadGen.ts` |
| Lead Gen daily stats / aggregates | `scheduledHours` on `leadGenDailyStats` uses weekday helpers | Sunday-first `getUTCDay()` via shared `weekdayForBusinessDate` (Phase 1) | `convex/leadGen/schedules.ts`, `convex/leadGen/aggregates.ts` |
| Slack qualification reports | Numerator may move to aggregates; reports use ledger | Do not change `getQualificationReport` caps/semantics | `convex/reporting/slackQualifications.ts`, `slackQualificationLedger.ts` |
| DM attribution settings | Same `dmClosers` registry for schedules + UTM | No shape/active-flag changes | `convex/attribution/dmClosers.ts`, settings attribution tab |
| Phone closer operations | Shares `operationsMeetingDailyStats` with DM card today | Do not change ops stats buckets for this feature; DM metric moves to `meetings` in Phase 3 | `overviewOperations.ts` |
| Overview dashboard contract | Shared `OverviewDashboard` type + cards | Add fields compatibly; update all three cards together in Phase 5 | `overviewTypes.ts`, `overview-top-cards.tsx`, card components |
| Workspace settings | New tab in existing route | Only register `tab=schedules`; preserve other tab query values | `settings-page-client.tsx` |
| Auth/RBAC | New admin mutations/queries | `requireTenantUser(ctx, ["tenant_master", "tenant_admin"])`; no client tenant/user args | `convex/requireTenantUser.ts` |
| Convex subscriptions | Second query when expanded | `"skip"` when collapsed; bounded row count | Phase 4 components |
| Production test tenant | Ranking misleading with empty schedules | Populate schedules **or** show null-rate context before efficiency-first UX (Phase 5) | Manual rollout (0F) |

**If a guardrail fails during implementation:** Stop the phase and update the design or phase plan before continuing.

**Revisit:** Phase 5 QA must re-run this table.

---

## 0F — Rollout gate definition (complete)

Manual production sequence (no automated migration):

1. Deploy Phase 1–2: additive schema + schedule management UI.
2. Populate Slack qualifier schedules for production test tenant actors.
3. Populate DM closer schedules for expected actors.
4. Verify coverage in `/workspace/settings?tab=schedules`.
5. Deploy Phase 3–5: efficiency builders + UI; verify raw counts + scheduled hours visible.
6. **Only then** enable or accept efficiency-first ranking (product sign-off). If confusing, revert sort/display while keeping schedule tables.

**Rollback:** Revert dashboard sort/display (Phase 5) without dropping schedule tables.

**Deferred:** Automated backfill, master schedule consolidation, DM booking aggregate (unless measured cap failure).

---

## Locked decisions summary

1. **Storage:** Two new weekly schedule tables; Lead Gen table untouched physically.
2. **Denominator:** Read-time sum from weekly rows × business dates in range; no per-day buckets.
3. **Numerators:** Lead Gen `leadGenDailyStats`; Slack unique opportunities (aggregates preferred); DM `meetings` by `createdAt` (replacing ops-stats-based overview ranking in Phase 3).
4. **Subscriptions:** One overview query on first paint; expanded query only while open.
5. **Weekday math:** Sunday-first UTC lookup; Monday-first UI order (`leadGen/schedules.ts` pattern → `convex/lib/workSchedule.ts`).
6. **Quality gate:** `pnpm tsc --noEmit` after every implementation phase.

---

## Phase summary

| Artifact | Action | Subphase |
|----------|--------|----------|
| `plans/overview-efficiency-schedules/phases/phase0.md` | Complete | 0A–0F |
| Production code | **No changes** | Phase 0 is analysis-only |

**Next:** Phase 1 — `convex/lib/workSchedule.ts`, schema tables, lead-gen validator alias, `npx convex dev --once`, `pnpm tsc --noEmit`.
