# Phase 0 — Preflight, Query Budget, and Blast Radius

**Goal:** Lock the implementation guardrails before schema or UI work starts. After this phase, the team has an explicit query-budget target, migration decision, file ownership map, and blast-radius checklist for the overview efficiency schedules MVP.

**Prerequisite:** `plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md` is accepted for MVP scope.

**Runs in PARALLEL with:** Nothing at the phase level. Phase 0 is a short foundation gate before implementation starts.

**Skills to invoke:**
- `convex-performance-audit` — classify hot paths, read sets, subscription cost, function budgets, and aggregate usage.
- `convex-migration-helper` — confirm the additive-table path does not need `@convex-dev/migrations`, and document what would trigger one.
- `next-best-practices` — confirm settings and overview changes stay inside existing App Router client/server boundaries.
- `shadcn` — inventory existing UI primitives before adding new components.
- `frontend-design` — keep settings and leaderboard UI dense, operational, and consistent with workspace conventions.

**Acceptance Criteria:**
1. The storage decision is locked: keep `leadGenWorkerSchedules`, add `slackQualifierSchedules`, add `dmCloserSchedules`, and do not create a master schedule table in MVP.
2. No new manual per-day schedule bucket table is introduced in any phase plan.
3. Every backend read path has an explicit table/index/cap strategy before implementation begins.
4. Every frontend subscription is accounted for, including when it is active and when it is skipped.
5. A blast-radius table identifies every existing feature area touched or indirectly affected.
6. Rollout sequencing explicitly prevents efficiency-first ranking from going live before schedule coverage is populated or clearly marked.
7. The implementation plan does not require a data backfill for MVP.
8. Any later aggregate/backfill idea is deferred behind a separate migration plan.
9. `pnpm tsc --noEmit` is listed as the final gate for every implementation phase.
10. `pnpm tsc --noEmit` passes without errors.

---

## Subphase Dependency Graph

```
0A (Source + docs inventory) ─────┬── 0B (Convex query budget) ──────────┐
                                 ├── 0C (Migration/no-backfill gate) ───┤
                                 ├── 0D (Frontend subscription budget) ─┤── 0E (Blast-radius lock)
                                 └── 0F (Rollout gate definition) ──────┘
```

**Optimal execution:**
1. Start 0A first so all later constraints cite actual files and docs.
2. Run 0B, 0C, 0D, and 0F in parallel; they produce independent checklists.
3. Finish with 0E, which combines backend, frontend, auth, data, and rollout risks into one blast-radius table.

**Estimated time:** 0.5-1 day

---

## Subphases

### 0A — Source and Reference Inventory

**Type:** Manual / Analysis  
**Parallelizable:** No — this creates the shared context for all other Phase 0 work.

**What:** Read the design doc, internal phase/parallelization docs, Convex guidelines, and relevant skills.

**Why:** The implementation touches Convex schema, dashboard data builders, settings UI, overview UI, and manual rollout. Missing one source of truth can produce a correct-looking implementation that breaks another surface.

**Where:**
- `plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md` (read)
- `.docs/internal/phases-planification-creation.md` (read)
- `.docs/internal/parallelization.md` (read)
- `convex/_generated/ai/guidelines.md` (read before Convex code changes)
- `.agents/skills/convex-performance-audit/**` (read)
- `.agents/skills/convex-migration-helper/SKILL.md` (read)
- `.agents/skills/next-best-practices/**` (read relevant App Router references)
- `.agents/skills/shadcn/SKILL.md` (read)
- `.agents/skills/frontend-design/SKILL.md` (read)

**How:**

**Step 1: Confirm source docs.**

```bash
rg -n "Schedule Storage Decision|Numerator Aggregation Strategy|Applicable Skills" \
  plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md
```

**Step 2: Confirm existing implementation surfaces.**

```bash
rg -n "leadGenWorkerSchedules|slackQualificationEvents|slackQualificationsByUser|meetingsByStatus|TopDmClosers" \
  convex app/workspace components hooks
```

**Key implementation notes:**
- Treat the design doc as the product contract.
- Treat `convex/_generated/ai/guidelines.md` as the Convex implementation contract.
- Do not use broad web searches for framework behavior unless local docs are missing.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Read only | Inventory phase only |

### 0B — Convex Query Budget

**Type:** Backend / Analysis  
**Parallelizable:** Yes — can run after 0A while migration and frontend budget work proceeds.

**What:** Assign efficient read strategies, caps, and subscription expectations for each Convex function.

**Why:** The overview dashboard is reactive. Every extra document read increases query cost and invalidation scope. Expanded leaderboards must not broaden the first-paint dashboard query.

**Where:**
- `convex/dashboard/overviewBuilders.ts` (existing)
- `convex/dashboard/overviewLeadGen.ts` (existing)
- `convex/dashboard/overviewSlack.ts` (existing)
- `convex/dashboard/overviewOperations.ts` (existing)
- `convex/reporting/aggregates.ts` (existing)
- `convex/reporting/lib/slackQualificationLedger.ts` (existing)
- `convex/workSchedules.ts` (new in Phase 2)
- `convex/dashboard/overviewLeaderboards.ts` (new in Phase 4)

**How:**

**Step 1: Record read budgets.**

| Function / Helper | Source Tables | Index Strategy | Cap / Bound | Notes |
|---|---|---|---|---|
| `listSlackQualifierSchedules` | `slackUsers`, `slackQualifierSchedules` | `by_tenantId`, or compound actor index when filtered | `slackUsers.take(300)`, schedules max `300 * 7` | Return only schedule UI fields. |
| `listDmCloserSchedules` | `dmClosers`, `attributionTeams`, `dmCloserSchedules` | `dmClosers.by_tenantId_and_teamId`, `dmCloserSchedules.by_tenantId` | `dmClosers.take(300)`, schedules max `300 * 7` | Reuse attribution list semantics. |
| `getOverviewDashboard` | existing section sources | existing indexes and helpers | top 5 per card | Do not add expanded rows to this payload. |
| `buildLeadGenEfficiencyRows` | `leadGenDailyStats`, `leadGenWorkers`, `leadGenWorkerSchedules` | `by_tenantId_and_dayKey`, `by_tenantId_and_workerId` | existing daily stat cap | Include scheduled zero-activity candidates only in builder output, then slice top 5. |
| `buildQualifierEfficiencyRows` | `slackUsers`, `slackQualifierSchedules`, Slack aggregates, bounded event detail | aggregate bounds by `[slackUserId, submittedAt]` | registry cap 300; raw event cap preserved | Use aggregates for unique-opportunity numerator. |
| `buildDmCloserEfficiencyRows` | `meetings`, `dmClosers`, `attributionTeams`, `dmCloserSchedules` | `meetings.by_tenantId_and_createdAt`, schedule actor indexes | existing booking cap | Defer new aggregate unless cap becomes a real issue. |
| `listOverviewLeaderboardRows` | shared builders | same as top builders | registry-capped rows | Active only while one card is expanded. |

**Step 2: Keep all reads bounded.**

```typescript
// Path: convex/workSchedules.ts
const slackUsers = await ctx.db
  .query("slackUsers")
  .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
  .take(300);
```

**Step 3: Prohibit these patterns.**

- No unbounded `.collect()`.
- No Convex `.filter()` for database filtering.
- No `.collect().length`.
- No public query composition through `ctx.runQuery` when a plain helper can be called.
- No new digest, daily bucket, or aggregate table without a separate migration/backfill plan.

**Key implementation notes:**
- Small registry scans are acceptable because the product already caps actors around 250-300.
- Aggregate usage should reduce numerator reads, not force a migration in MVP.
- If `npx convex insights --details` is available, capture a before/after snapshot during Phase 5.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Read only | Budget phase only |

### 0C — Migration and Rollout Gate

**Type:** Backend / Migration / Manual  
**Parallelizable:** Yes — independent after 0A.

**What:** Confirm the MVP path is additive and define what would require a migration.

**Why:** Production has a test tenant. Breaking schema/data changes need an explicit widen-migrate-narrow plan.

**Where:**
- `convex/schema.ts` (future Phase 1 modify)
- `convex/leadGen/validators.ts` (future Phase 1 modify)
- `convex/lib/workSchedule.ts` (future Phase 1 create)

**How:**

**Step 1: Lock no-migration MVP conditions.**

```text
No migration job required only if:
- `leadGenWorkerSchedules` remains unchanged except validator import aliasing.
- `slackQualifierSchedules` and `dmCloserSchedules` are new tables.
- Missing schedule rows produce zero scheduled hours and null per-hour rate.
- No existing field becomes required.
- No historical aggregate must be backfilled before reads switch.
```

**Step 2: Define migration triggers.**

| Change | Requires Migration Plan? | Reason |
|---|---:|---|
| Add new schedule tables | No | New empty tables validate immediately. |
| Add indexes to new schedule tables | No | No correctness issue with existing data. |
| Move Lead Gen schedules to a master table | Yes | Existing Lead Gen schedule data must be copied and dual-read. |
| Widen `leadGenWorkerSchedules` to polymorphic actor fields | Yes | Existing required fields and indexes change semantics. |
| Add a DM closer booking aggregate and switch reads to it | Yes, if historical rows are needed | Requires aggregate component registration and backfill verification. |

**Key implementation notes:**
- Manual schedule population is an operational rollout step, not a Convex migration.
- If the implementation deviates from additive tables, stop and create a separate migration plan before coding.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Read only | Gate definition only |

### 0D — Frontend Subscription Budget

**Type:** Frontend / Analysis  
**Parallelizable:** Yes — independent after 0A.

**What:** Define where `useQuery` subscriptions are allowed and where they must be skipped.

**Why:** The dashboard is already one live overview subscription. Expanded leaderboards should not multiply live query cost until a card is opened.

**Where:**
- `app/workspace/_components/dashboard-page-client.tsx` (future modify)
- `app/workspace/_components/overview-expandable-leaderboard.tsx` (future create)
- `app/workspace/settings/_components/settings-page-client.tsx` (future modify)
- `app/workspace/settings/_components/work-schedules-tab.tsx` (future create)

**How:**

**Step 1: Keep first paint to one overview query.**

```tsx
// Path: app/workspace/_components/dashboard-page-client.tsx
const overview = useQuery(
  api.dashboard.overview.getOverviewDashboard,
  isAdmin ? { range: queryRange } : "skip",
);
```

**Step 2: Only subscribe to expanded rows while open.**

```tsx
// Path: app/workspace/_components/overview-expandable-leaderboard.tsx
const rows = useQuery(
  api.dashboard.overviewLeaderboards.listOverviewLeaderboardRows,
  open ? { kind, range: queryRange, filters } : "skip",
);
```

**Step 3: Defer or debounce search.**

```tsx
// Path: app/workspace/_components/overview-expandable-leaderboard.tsx
const deferredSearch = useDeferredValue(search);
```

**Key implementation notes:**
- The settings schedules tab can subscribe to schedule lists because it is admin-only and not on the dashboard first paint.
- Avoid per-row `useQuery` calls. Parent queries return enriched rows.
- Keep `useSearchParams()` inside existing Suspense boundaries for settings.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Read only | Subscription plan only |

### 0E — Blast Radius Lock

**Type:** Full-Stack / QA  
**Parallelizable:** No — consolidates 0B-0D and rollout constraints.

**What:** Define what can break outside the immediate feature and how to detect it.

**Why:** This work touches shared dashboard contracts, Lead Gen helpers, Slack reporting semantics, DM attribution, and settings navigation.

**Where:**
- `plans/overview-efficiency-schedules/phases/*` (new docs)

**How:**

| Feature Area | Why It Is In Radius | Guardrail |
|---|---|---|
| Lead Gen Ops reporting/export | Shared worker performance helpers and schedule validator aliasing | Keep existing report sort order and exports quantity-first unless product asks otherwise. |
| Lead Gen capture aggregates | `leadGenDailyStats.scheduledHours` snapshots use weekday helpers | Sunday-first `getUTCDay()` mapping must match current helper. |
| Slack qualification reports | Qualifier numerator may use aggregates while reports still use event details | Preserve existing ledger caps and do not change `getQualificationReport` semantics. |
| DM attribution settings | DM closer registry is used by schedules and attribution config | Do not change `dmClosers` shape or active/inactive behavior. |
| Phone closer operations | Existing operations cards and tables use `operationsMeetingDailyStats` | Do not change operations stats buckets for this feature. |
| Overview dashboard | Shared `OverviewDashboard` type and top cards | Add fields compatibly and update all consuming cards together. |
| Workspace settings | New tab inside existing admin settings route | Preserve existing tab query param behavior and Suspense boundary. |
| Auth/RBAC | New functions are admin-only | Derive tenant/user via `requireTenantUser`; no client tenant/user args. |
| Convex subscriptions | Extra expanded query can be expensive | Use `"skip"` while collapsed and return bounded rows. |
| Production test tenant | Efficiency ranking can look wrong before schedules exist | Populate schedules or clearly mark null rates before enabling ranking. |

**Key implementation notes:**
- If a guardrail fails, do not continue into the next phase until the design or phase plan is updated.
- The blast radius table must be revisited in Phase 5 during QA.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| `plans/overview-efficiency-schedules/phases/phase0.md` | Create | This gate document |

### 0F — Rollout Gate Definition

**Type:** Manual / QA  
**Parallelizable:** Yes — can run after 0A while other Phase 0 work proceeds.

**What:** Define the manual production rollout sequence.

**Why:** The feature is technically additive, but ranking quality depends on populated schedules.

**Where:**
- `plans/overview-efficiency-schedules/phases/phase5.md` (future QA plan)

**How:**

1. Deploy additive schema and schedule management UI.
2. Populate Slack qualifier schedules for expected production test tenant actors.
3. Populate DM closer schedules for expected production test tenant actors.
4. Verify schedule coverage in the settings UI.
5. Verify overview rows show raw counts and scheduled hours.
6. Enable or accept efficiency-first ranking only after the team agrees null-rate rows are expected.

**Key implementation notes:**
- No automated migration job is part of this rollout.
- Keep rollback simple: if ranking is confusing, revert the dashboard sort/display change while retaining schedule tables.

**Files touched:**

| File | Action | Notes |
|---|---|---|
| None | Read only | Rollout definition only |

---

## Phase Summary

| File | Action | Subphase |
|---|---|---|
| `plans/overview-efficiency-schedules/phases/phase0.md` | Create | 0A-0F |
