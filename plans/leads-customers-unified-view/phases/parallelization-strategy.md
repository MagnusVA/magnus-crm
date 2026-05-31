# Parallelization Strategy — Leads & Customers Unified View

**Purpose:** This document defines the parallel execution strategy across all 6 implementation phases, identifying the critical path, dependency graph, maximum concurrency windows, file ownership boundaries, team allocation, quality gates, and rollback-sensitive sequencing.

**Prerequisite:** Phase 0 current-state artifacts are planned, the design document is accepted for MVP scope, and the team agrees that `leadCustomerSearchRows` is derived data backed by a migration/backfill before the route becomes canonical.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **0** | Current State Lock and UX Direction | Manual / Architecture / QA | Medium | Design accepted |
| **1** | Entity Search Projection and Query Facade | Backend / Migration | High | Phase 0 |
| **2** | Unified Route and Search Workspace | Frontend / Full-Stack | Medium-High | Phase 1A + Phase 1E contracts; full release waits for Phase 1C |
| **3** | Entity Detail Page | Frontend / Full-Stack | High | Phase 1F detail contract + Phase 2 route namespace |
| **4** | Opportunity Sheet, Meeting Links, and Legacy Redirects | Full-Stack | High | Phase 1E redirects, Phase 2 browse route, Phase 3 detail route |
| **5** | Verification and Rollout | Release / Full-Stack QA | Medium-High | Phases 1-4 verified |

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────────┐
                    │                          PHASE 0                             │
                    │  Current State Lock, UX Direction, Security Contract          │
                    │  (FOUNDATION)                                                 │
                    └───────────────────────────────┬──────────────────────────────┘
                                                    │
                    ┌───────────────────────────────▼──────────────────────────────┐
                    │                          PHASE 1                             │
                    │  Projection Schema, Backfill, Query Facade, Detail Contract   │
                    │  (BACKEND + MIGRATION FOUNDATION)                             │
                    └───────────────┬───────────────────────────────┬──────────────┘
                                    │                               │
                  ┌─────────────────▼────────────────┐ ┌───────────▼──────────────┐
                  │             PHASE 2              │ │          PHASE 3          │
                  │  Unified Search Workspace        │ │  Entity Detail Page       │
                  │  (FRONTEND BROWSE SURFACE)       │ │  (FRONTEND DETAIL SURFACE)│
                  └─────────────────┬────────────────┘ └───────────┬──────────────┘
                                    │                               │
                                    └───────────────┬───────────────┘
                                                    │
                    ┌───────────────────────────────▼──────────────────────────────┐
                    │                          PHASE 4                             │
                    │  Opportunity Sheet, Meeting Links, Legacy Redirects           │
                    │  (DRILL-IN + BACKWARD COMPATIBILITY)                          │
                    └───────────────────────────────┬──────────────────────────────┘
                                                    │
                    ┌───────────────────────────────▼──────────────────────────────┐
                    │                          PHASE 5                             │
                    │  Verification, Navigation Flip, Production Test Rollout        │
                    │  (CANONICAL RELEASE)                                          │
                    └──────────────────────────────────────────────────────────────┘
```

**Dependency nuance:** Phase 2 and Phase 3 can begin before Phase 1 production-test backfill is complete if they build against stable query names and development data. Phase 5 cannot begin visible rollout until Phase 1C assertion and Phase 4 redirects pass.

---

## Maximum Parallelism Windows

### Window 1: Foundation Evidence (Phase 0)

**Concurrency:** 4 independent streams, then one convergence stream.

Phase 0 is a planning and evidence phase. It touches planning artifacts only, so route inventory, sample-data matrix, security contract, and UX direction can run simultaneously.

```
Timeline: ████████████

0A Route/code inventory ───────────────┐
                                       ├── 0E Readiness brief ──→ 0F Handoff gate
0B Sample data matrix ─────────────────┤
                                       │
0C Permission + PII contract ──────────┤
                                       │
0D UX/component direction lock ────────┘
```

**Internal parallelism:**
```
0A ───────────────┐
0B ───────────────┼── 0E ──→ 0F
0C ───────────────┤
0D ───────────────┘
```

**Why independent:**

- 0A reads routes/functions and writes `current-state-inventory.md`.
- 0B reads test data and writes `sample-data-matrix.md`.
- 0C reads auth/permission code and writes `security-contract.md`.
- 0D reads UI components and writes `ux-direction-lock.md`.

**Deployment needed:** No. This window creates planning and QA artifacts only; no application, Convex, or schema deployment should happen.

**Migrations to run:** None.

**Production continuation gate:** No production deployment or migration is required before starting Phase 1. Continue only after Phase 0 artifacts are complete and the team accepts the schema/backfill plan.

---

### Window 2: Backend Foundation and Migration Prep (Phase 1)

**Concurrency:** Up to 4 streams after schema/types land.

Phase 1 has one hard first step: schema and validators. After generated types exist, projection builder, search/list facade, detail payload, and migrations can progress in parallel with careful file ownership.

```
Timeline:             █████████████████████████████████████

1A Validators/schema ───┬── 1B Projection builder ───┬── 1C Migration/assertion ─┐
                        │                           │                            │
                        ├── 1E Search/list facade ──┤                            ├── 1G Backend verification
                        │                           │                            │
                        └── 1F Detail payload ──────┘                            │
                                                    1D Write hook integration ────┘
```

**Internal parallelism:**
```
1A ──→ 1B ──→ 1C ───────┐
      1D ───────────────┤
      1E ───────────────┤── 1G
      1F ───────────────┘
```

**Why independent after 1A:**

- 1B owns `convex/leadCustomers/projection.ts` and `searchText.ts`.
- 1E owns `convex/leadCustomers/queries.ts` and `identifierResolution.ts`.
- 1F owns `convex/leadCustomers/detail*.ts`, `permissions.ts`, and `activity.ts`.
- 1C owns `convex/migrations.ts` entries and migration runbook.
- 1D touches existing write paths and should start only after 1B's helper signature is stable.

**Concurrency warning:** `convex/schema.ts` and `convex/migrations.ts` are shared, sequential files. One backend owner should merge those edits before other agents rely on generated types or migration function names.

**Deployment needed:** Yes, for Convex code/schema before any projection backfill. Deploy only after 1A schema, 1B projection builder, 1C migration definitions, 1D write hooks, 1E query facade, and 1F detail contract compile together. The UI does not become canonical in this window, but the backend must be deployed so new writes maintain `leadCustomerSearchRows` while the backfill runs.

**Deployment checkpoint:**

- Run `npx convex dev --once` after 1A to validate schema and generated types locally.
- Deploy the Convex backend/schema after 1A-1F are merged and `pnpm tsc --noEmit` passes.
- Keep old navigation and old routes unchanged after this deploy.

**Migrations to run:** Required in every environment where real search/list data will be tested.

| Order | Migration command | When |
|---:|---|---|
| 1 | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows","dryRun":true}'` | Before touching data; validate migration logic. |
| 2 | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows"}'` | After dry run passes. |
| 3 | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'` | Validate projection completeness and consistency. |
| 4 | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled"}'` | Record a real assertion pass before frontend QA depends on projections. |

For production test tenant rollout, either run these here after the backend deploy or defer the final production-test execution to Window 5. Window 5 must at least rerun the assertion before the visible navigation flip.

**Production continuation gate:** Before Phase 2 or Phase 3 uses real production-test data, the Convex backend/schema from Phase 1 must be deployed to that environment and `backfillLeadCustomerSearchRows` plus `assertLeadCustomerSearchRowsBackfilled` must pass there. If Phase 2 and Phase 3 are only continuing in local or preview with seeded data, they may continue after the Phase 1 query/detail contracts compile, but production rollout remains blocked until the production-test assertion has passed.

---

### Window 3: Browse and Detail UI Parallelism (Phases 2 and 3)

**Concurrency:** 2 phase streams plus 6-8 internal frontend streams.

After Phase 1 query contracts exist, the browse route and detail route can proceed together. They mostly touch separate directories under `app/workspace/leads-customers/`.

```
Timeline:                              █████████████████████████████

Phase 2 Browse Workspace ───────────────┐
                                        ├── Phase 4 can begin after both route surfaces exist
Phase 3 Entity Detail Page ─────────────┘
```

**Within Phase 2:**
```
2A Route shell ─────┬── 2B URL state ───┬── 2C Toolbar ──────┐
                   │                   │                    ├── 2F Browse QA
                   │                   └── 2D Results ──────┤
2E New side deal ────────────────────────────────────────────┘
```

**Within Phase 3:**
```
3A Route/preload ──→ 3B Provider/frame ──┬── 3C Header/identity ─────┐
                                         ├── 3D Opportunities/payments├── 3G Detail QA
                                         ├── 3E Meetings/comments ───┤
                                         └── 3F Activity/fields ─────┘
```

**Why independent:**

- Phase 2 owns `app/workspace/leads-customers/page.tsx`, route root components, browse results, and `new-opportunity`.
- Phase 3 owns `app/workspace/leads-customers/[leadId]/page.tsx` and detail sections.
- Shared files are limited to the `leads-customers` route namespace; avoid modifying the same root page/client from both phases.

**Concurrency warning:** Phase 3 depends on the Phase 2 route folder existing, but it should not modify Phase 2's browse components. Create separate `_components` under `[leadId]`.

**Deployment needed:** Optional for preview/testing, not required for production rollout. A dev or preview deployment is useful once Phase 2 and Phase 3 compile so QA can exercise `/workspace/leads-customers` by direct URL while old nav remains unchanged.

**Deployment checkpoint:**

- Deploy only after Phase 1 backend deployment is live in the target environment.
- If the target environment uses real data, the Phase 1 projection backfill and assertion must have passed first.
- Do not flip sidebar, command palette, or high-traffic internal links in this window.

**Migrations to run:** None in this window. If browse/detail QA finds missing projection rows, rerun the Phase 1 sequence: `backfillLeadCustomerSearchRows` dry run, `backfillLeadCustomerSearchRows`, `assertLeadCustomerSearchRowsBackfilled` dry run, then `assertLeadCustomerSearchRowsBackfilled`.

**Production continuation gate:** Phase 4 can begin from local/preview builds after Phase 2 and Phase 3 routes compile and pass QA. A production deployment is not required just to start Phase 4, but if Phase 4 will be verified against production-test tenant URLs, deploy Phase 2/3 UI only after the Phase 1 production-test projection assertion is green. No additional migrations are required before Phase 4.

---

### Window 4: Drill-In and Backward Compatibility (Phase 4)

**Concurrency:** 3 streams, then one integration stream.

The opportunity sheet, meeting-link helper, and redirect resolver backend can be built concurrently. Route shims wait for resolver names and route targets.

```
Timeline:                                                ███████████████████████

4A Sheet URL state ───────┬── 4B Sheet body ─────────────┐
                          │                             │
4C Meeting link helper ───┘                             ├── 4F Integrated QA
                                                        │
4D Redirect resolvers ─────────→ 4E Legacy route shims ─┘
```

**Internal parallelism:**
```
4A ──→ 4B ─────────┐
4C ────────────────┤── 4F
4D ──→ 4E ─────────┘
```

**Why independent:**

- 4A/4B touch new sheet files under `app/workspace/leads-customers/[leadId]/_components/`.
- 4C touches meeting helper and meeting row files.
- 4D touches `convex/leadCustomers/redirects.ts`.
- 4E touches old route page files only after 4D is stable.

**Concurrency warning:** `app/workspace/opportunities/[opportunityId]/_components/*` is shared only if sheet reuse requires compact props. Assign one frontend owner to those existing opportunity detail components.

**Deployment needed:** Yes if redirect shims are to be verified in a deployed environment. This is a behavior-changing deployment because old URLs begin redirecting, so deploy after 4A-4E are complete and validate in dev/preview before production test tenant.

**Deployment checkpoint:**

- Deploy sheet, meeting-link helper, redirect resolvers, and route shims together.
- If product wants old full pages available until final release, hold the 4E route-shim deployment and ship it together with Window 5 instead.
- Keep navigation unchanged until Window 5 even if redirects are deployed.

**Migrations to run:** None. Redirects resolve from source tables and the sheet uses existing opportunity detail guards. Phase 1 projection assertion should already be green, but no new migration is introduced by this window.

**Production continuation gate:** Before Phase 5 can flip visible navigation, Phase 4 redirect behavior must be available in the production test tenant. Either deploy Phase 4 route shims before Phase 5 and verify them, or bundle Phase 4 shims with the Phase 5 deployment and treat redirect smoke tests as a blocking pre-nav-flip step. No new migrations are required between Phase 4 and Phase 5, but the Phase 1 projection assertion must still be green.

---

### Window 5: Release Preflight and Visible Rollout (Phase 5)

**Concurrency:** 3 preflight streams, then sequential visible changes.

The release runbook, production-test projection verification, and audit can happen together. Navigation flip and rollout are sequential because they change what users see.

```
Timeline:                                                                     ███████████████

5A Release QA runbook ───────────────┐
                                     ├── 5D Nav/command/breadcrumb flip ──→ 5E Production test rollout ──→ 5F Evidence/rollback
5B Projection prod-test verify ──────┤
                                     │
5C Security/perf/a11y audit ─────────┘
```

**Internal parallelism:**
```
5A ───────────────┐
5B ───────────────┼── 5D ──→ 5E ──→ 5F
5C ───────────────┘
```

**Why independent before 5D:**

- 5A writes QA runbook.
- 5B runs migration/assertion and writes projection evidence.
- 5C audits code, logs, analytics, accessibility, and performance.
- 5D owns visible nav/link changes and must wait for all three.

**Deployment needed:** Yes. This is the canonical production test tenant rollout: sidebar, command palette, breadcrumbs, and selected internal links start pointing at `/workspace/leads-customers`.

**Deployment checkpoint:**

- Before 5D, confirm Phase 4 redirects are already deployed or included in the same release.
- Deploy the nav/link flip only after release QA, projection verification, and security/performance/accessibility audit pass.
- After deployment, smoke test admin and closer flows immediately and keep the rollback runbook ready.

**Migrations to run:** Required pre-flight verification, even if the backfill already ran in Window 2.

| Situation | Migration command |
|---|---|
| Normal pre-flight when backfill already ran | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'` then `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled"}'` |
| Backfill has not run in the production test tenant | Run the full Phase 1 sequence: `backfillLeadCustomerSearchRows` dry run, `backfillLeadCustomerSearchRows`, `assertLeadCustomerSearchRowsBackfilled` dry run, then `assertLeadCustomerSearchRowsBackfilled`. |
| Assertion fails after write-hook changes | Fix the projection/write-hook bug, rerun `backfillLeadCustomerSearchRows`, then rerun both assertion commands. |

**Production continuation gate:** This is the final continuation gate for MVP release. The production test tenant nav/link flip must not deploy until the Phase 1 projection assertion has passed in production, Phase 4 redirects are deployed or included in the same release, and the rollback runbook is ready. After deployment, no further phase should begin until smoke tests confirm admin search/detail, closer search/detail, opportunity sheet, old customer URL redirect, and old opportunity URL redirect.

---

## Production Deployment and Migration Gates

| Transition | Production deployment required before continuing? | Migrations required before continuing? | Blocking condition |
|---|---|---|---|
| Phase 0 -> Phase 1 | No | No | Phase 0 planning artifacts must be accepted. |
| Phase 1 -> Phase 2 | Yes if Phase 2 will use production-test data; no for local stub/preview UI work | Yes if using production-test data: run `backfillLeadCustomerSearchRows` and `assertLeadCustomerSearchRowsBackfilled` | Frontend browse QA against production-test data is blocked until Convex schema/code is deployed and assertion passes. |
| Phase 1 -> Phase 3 | Yes if Phase 3 will preload production-test detail data; no for local UI work | Yes if using production-test data: same projection backfill/assertion sequence | Detail QA against production-test data is blocked until detail query code is deployed and projection assertion passes. |
| Phase 2 -> Phase 3 | No, these phases can overlap | No | Phase 3 only needs Phase 1F detail contract and the route namespace; no production deploy is required between them. |
| Phase 2/3 -> Phase 4 | Not required for local/preview; required if Phase 4 redirect/sheet QA targets production-test tenant URLs | No new migration | Phase 4 production-test QA is blocked until new browse/detail route targets exist in that environment. |
| Phase 4 -> Phase 5 | Yes, either deploy Phase 4 before Phase 5 or include it in the Phase 5 release | No new migration; rerun Phase 1 assertion before nav flip | Visible nav flip is blocked until legacy redirects are deployed/verified or included in the same release and smoke-tested before exposing nav. |
| Phase 5 pre-flight -> Phase 5 nav flip | Yes | At minimum run `assertLeadCustomerSearchRowsBackfilled` dry run and real assertion; run full backfill/assertion if backfill has not run in production-test tenant | Production test tenant nav/link flip is blocked until projection assertion, release QA, security/perf/a11y audit, and rollback readiness pass. |
| Phase 5 deployment -> post-release monitoring | Already deployed | No migration unless assertion fails or projection repair is needed | Further cleanup is blocked until smoke tests and monitoring are clean. |

**Rule:** If any phase is continuing only in local development, production deployment can be deferred. If a phase depends on production-test tenant data, links, or old route behavior, the required deployment and migration gate in this table must pass first.

---

## Critical Path Analysis

The longest sequential chain determining minimum safe rollout time is:

```
Phase 0F → Phase 1A → Phase 1B → Phase 1C → Phase 1F → Phase 3A/3B → Phase 3D → Phase 4A/4B → Phase 4E → Phase 5D → Phase 5E
   │          │          │          │          │             │            │            │            │           │           │
   │          │          │          │          │             │            │            │            │           │           └── production test tenant sees new nav
   │          │          │          │          │             │            │            │            │           └── visible shell/command flip
   │          │          │          │          │             │            │            │            └── old links must resolve safely
   │          │          │          │          │             │            │            └── sheet completes opportunity parity
   │          │          │          │          │             │            └── opportunity rows feed sheet URL state
   │          │          │          │          │             └── detail provider enables all page sections
   │          │          │          │          └── detail payload contract must be bounded and permission-aware
   │          │          │          └── projection backfill/assertion must pass before canonical route
   │          │          └── projection builder drives migration and write hooks
   │          └── schema/types unblock all Convex code
   └── current-state/security/UX assumptions locked
```

**Alternative shorter path:**
```
Phase 0F → Phase 1A → Phase 1E → Phase 2A/2B → Phase 2C/2D → Phase 2F
```

This path makes the browse/search workspace testable sooner, but it is not sufficient for rollout because entity detail, opportunity sheet, redirects, and production-test projection assertion still gate canonical navigation.

**Implication:** Start Phase 1A immediately after Phase 0. Start Phase 3 as soon as Phase 1F is stable; detail and sheet are on the critical path, while Phase 2 browse work is a parallel path that can finish earlier.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `plans/leads-customers-unified-view/current-state-inventory.md` | Phase 0 | Planning artifact only. |
| `plans/leads-customers-unified-view/sample-data-matrix.md` | Phase 0 | Redacted IDs only. |
| `plans/leads-customers-unified-view/security-contract.md` | Phase 0 | Drives Phase 1 and Phase 5 audits. |
| `plans/leads-customers-unified-view/ux-direction-lock.md` | Phase 0 | Drives Phase 2-4 UI. |
| `convex/schema.ts` | Phase 1 only | New projection table. No other phase modifies schema. |
| `convex/migrations.ts` | Phase 1 only | Backfill/assertion definitions. Phase 5 runs them, does not edit them. |
| `convex/leadCustomers/validators.ts` | Phase 1 | Shared by schema/functions. |
| `convex/leadCustomers/types.ts` | Phase 1 | Shared DTO types. Later phases consume, not modify unless contract bug. |
| `convex/leadCustomers/projection.ts` | Phase 1 | Rebuild/upsert source of truth for projection. |
| `convex/leadCustomers/searchText.ts` | Phase 1 | Projection search text only. |
| `convex/leadCustomers/queries.ts` | Phase 1 | Search/list public facade. |
| `convex/leadCustomers/detail.ts` | Phase 1 | Entity detail public facade. |
| `convex/leadCustomers/detailPayload.ts` | Phase 1 | Detail builder. Phase 3 consumes. |
| `convex/leadCustomers/redirects.ts` | Phase 4 | Redirect resolver file; do not add in Phase 1 to keep responsibility clear. |
| `convex/leads/**`, `convex/customers/**`, `convex/opportunities/**`, `convex/lib/**` write hooks | Phase 1 | Projection maintenance only. Avoid unrelated refactors. |
| `app/workspace/leads-customers/page.tsx` | Phase 2 | Browse route only. |
| `app/workspace/leads-customers/loading.tsx` | Phase 2 | Browse loading state. |
| `app/workspace/leads-customers/_components/**` | Phase 2 | Browse components only, excluding `[leadId]`. |
| `app/workspace/leads-customers/new-opportunity/**` | Phase 2 | New side-deal route. Phase 4 redirects old route to it. |
| `app/workspace/leads-customers/[leadId]/page.tsx` | Phase 3 | Detail route. |
| `app/workspace/leads-customers/[leadId]/loading.tsx` | Phase 3 | Detail loading state. |
| `app/workspace/leads-customers/[leadId]/_components/entity-*` | Phase 3 | Detail sections. |
| `app/workspace/leads-customers/[leadId]/_components/opportunity-*` | Phase 4 | Sheet components. |
| `app/workspace/leads-customers/[leadId]/_components/meeting-link-utils.ts` | Phase 4 | Shared detail/sheet helper. |
| `app/workspace/opportunities/[opportunityId]/_components/*` | Phase 4 only if needed | Reuse/extract compact props for sheet; avoid broad redesign. |
| `app/workspace/leads/page.tsx` | Phase 4 | Legacy redirect shim. |
| `app/workspace/leads/[leadId]/page.tsx` | Phase 4 | Legacy redirect shim. |
| `app/workspace/leads/[leadId]/merge/**` | No owner in MVP | Keep intact. |
| `app/workspace/customers/page.tsx` | Phase 4 | Legacy redirect shim. |
| `app/workspace/customers/[customerId]/page.tsx` | Phase 4 | Legacy redirect shim. |
| `app/workspace/opportunities/page.tsx` | Phase 4 | Legacy redirect shim. |
| `app/workspace/opportunities/[opportunityId]/page.tsx` | Phase 4 | Legacy redirect shim with sheet URL. |
| `app/workspace/opportunities/new/page.tsx` | Phase 4 | Redirect to new side-deal route. |
| `app/workspace/_components/workspace-shell-client.tsx` | Phase 5 | Visible sidebar flip only after QA gates. |
| `components/command-palette.tsx` | Phase 5 | Visible command flip only after QA gates. |
| `hooks/use-breadcrumbs.ts` | Phase 5 | Breadcrumb labels. |
| `app/workspace/operations/**`, `app/workspace/reports/**`, `app/workspace/closer/**` links | Phase 5 | Update selectively where `leadId` is available. |

---

## Recommended Execution Strategies

### Solo Developer

Execute phases mostly sequentially but batch similar work to reduce context switching:

| Sprint | Work |
|---|---|
| 1 | Phase 0 all artifacts; Phase 1A schema/validators |
| 2 | Phase 1B projection + 1E search/list + 1F detail contract |
| 3 | Phase 1C migration/assertion + 1D write hooks + 1G backend verification |
| 4 | Phase 2 browse route and Phase 3 route/provider |
| 5 | Phase 3 detail sections; start Phase 4 sheet URL/body |
| 6 | Phase 4 redirect resolvers/shims and integrated QA |
| 7 | Phase 5 release QA, production-test verification, nav flip, rollout evidence |

**Estimated total time:** 17-25 days

### Two Developers

Split backend/migration and frontend/release work after Phase 0:

| Sprint | Developer A — Backend / Migration | Developer B — Frontend / QA |
|---|---|---|
| 1 | Phase 0A/0C + Phase 1A | Phase 0B/0D + UX readiness |
| 2 | Phase 1B, 1C, 1D | Phase 2A, 2B, 2C scaffolding against contracts |
| 3 | Phase 1E, 1F, 1G | Phase 2D, 2E, 2F + Phase 3A/3B |
| 4 | Phase 4D redirect resolvers | Phase 3C-3G detail sections |
| 5 | Phase 4E route shims + backend QA | Phase 4A-4C sheet/link work + UI QA |
| 6 | Phase 5B projection production-test verify + release support | Phase 5A, 5C, 5D, 5E, 5F |

**Estimated total time:** 10-15 days

### Three+ Developers / Agents

Use one backend/migration owner, one browse/detail UI owner, one sheet/release owner after Phase 1 contracts stabilize:

| Sprint | Agent A — Backend / Migration | Agent B — Browse + Detail UI | Agent C — Sheet / Redirects / Release |
|---|---|---|---|
| 1 | Phase 1A after Phase 0 gate | Phase 0D + Phase 2 visual prep | Phase 0A/0B/0C artifacts |
| 2 | Phase 1B, 1C, 1D | Phase 2A-2D | Phase 2E + release QA skeletons |
| 3 | Phase 1E, 1F, 1G | Phase 3A-3F | Phase 4D resolver draft once 1E stable |
| 4 | Backend support/perf audit | Phase 3G + visual fixes | Phase 4A-4F |
| 5 | Phase 5B projection verification | Phase 5C UI/accessibility audit | Phase 5A, 5D, 5E, 5F |

**Estimated total time:** 8-12 days

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 0 — Foundation Lock** | After Phase 0 | Current-state inventory, sample data matrix, security contract, UX direction, and handoff exist; `pnpm tsc --noEmit` passes. |
| **Gate 1 — Schema and Projection** | After Phase 1A-1C | `npx convex dev --once` succeeds; backfill dry run passes; assertion dry run passes; no unbounded migration loops. |
| **Gate 2 — Backend Facade** | After Phase 1D-1G | Search/list/detail functions use tenant auth, indexes/search indexes, caps, and no PII logs; `pnpm tsc --noEmit` passes. |
| **Gate 3 — Browse Route** | After Phase 2 | Search, filters, load more, direct opportunity hits, new side-deal route, mobile/dark QA pass. |
| **Gate 4 — Detail Route** | After Phase 3 | Active lead, customer, multi-opportunity, comments, payments, fields, and role-specific states render without tabs or overlap. |
| **Gate 5 — Backward Compatibility** | After Phase 4 | Sheet opens/closes via URL, meeting links use correct role paths, every legacy route redirects or 404s correctly. |
| **Gate 6 — Release Preflight** | Before Phase 5D | Release runbook complete, production test projection assertion passes, security/perf/accessibility audit passes. |
| **Gate 7 — Production Test Rollout** | After Phase 5E | Admin/closer smoke tests pass, old redirects pass, Convex logs clean, rollback steps documented. |

---

## Risk Mitigation

| Risk | Impact | Mitigation strategy |
|---|---|---|
| Projection table is incomplete or stale | Critical | Use `@convex-dev/migrations` backfill and assertion; keep old nav until assertion passes; rebuild from source on demand if needed. |
| Projection write hooks create write contention | High | Rebuild only after meaningful source writes; monitor Convex logs/insights; move noisy rebuilds to scheduled internal follow-up if needed. |
| Closer sees unassigned opportunity details | Critical | Keep existing opportunity detail guard; return permission metadata; hide sheet/comments/payments/actions when denied; QA assigned/unassigned scenarios. |
| Raw search terms or PII appear in logs/analytics | High | Security contract forbids it; audit logs/PostHog before rollout; use length buckets and counts only. |
| Detail payload becomes too large | High | Enforce Phase 1 caps: 50 opportunities, 50 meetings, 5 comments per meeting, 250 comments total, 50 payments, 75 activity events. |
| Legacy redirects break old reports or browser history | High | Phase 4 resolver/shim QA covers direct old URLs; Phase 5 updates high-traffic links only where IDs are available. |
| Redirect loop between old and new routes | High | New route never redirects back to old route; test every old list/detail route before nav flip. |
| UI becomes too card-heavy or tab-hidden | Medium | Phase 0 UX lock and Phase 3 QA enforce full-width sections, visible detail, compact rows, and no tab-only detail access. |
| Mobile sheet or detail overflows | Medium | Browser QA at 390 x 844; sheet full-width on mobile; long identifiers wrap/truncate. |
| New side-deal route drifts from old create flow | Medium | Reuse existing create opportunity components/mutations; old route redirects only after new route passes smoke tests. |
| Phase agents edit the same shared files | Medium | Enforce file ownership table; sequence `convex/schema.ts`, `convex/migrations.ts`, shell nav, command palette, and old route shims. |
| Rollback deletes derived data or source data by mistake | Critical | Rollback runbook says restore nav/links first; keep `leadCustomerSearchRows`; do not run destructive migrations. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **0** | `frontend-design`, `web-design-guidelines`, `next-best-practices`, `convex-performance-audit` | Lock UX, accessibility, route assumptions, and current read-cost concerns before implementation. |
| **1** | `convex-migration-helper`, `convex-performance-audit`, `next-best-practices` | Projection schema/backfill, query caps, tenant-scoped Convex facade consumed by Next routes. |
| **2** | `frontend-design`, `shadcn`, `next-best-practices`, `vercel-react-best-practices`, `web-design-guidelines` | Build compact browse workspace with correct RSC/client boundary, URL state, and responsive controls. |
| **3** | `frontend-design`, `shadcn`, `next-best-practices`, `vercel-react-best-practices`, `vercel-composition-patterns`, `web-design-guidelines` | Build provider-backed detail page with no tab-hidden data and bounded preloaded payload. |
| **4** | `frontend-design`, `shadcn`, `next-best-practices`, `vercel-react-best-practices`, `web-design-guidelines` | URL-addressed sheet, role-aware meeting links, and safe App Router redirects. |
| **5** | `convex-migration-helper`, `convex-performance-audit`, `web-design-guidelines`, `frontend-design`, `next-best-practices` | Production-test backfill verification, release audit, navigation flip, and rollback-safe rollout. |

---

## Parallel Execution Rules

1. `convex/schema.ts` is Phase 1 only. Do not let UI or redirect work add schema changes.
2. `convex/migrations.ts` is edited only for Phase 1 migration definitions. Phase 5 runs migrations and records evidence.
3. Phase 2 owns browse route root files; Phase 3 owns dynamic detail route files; Phase 4 owns sheet files under the dynamic route.
4. Old route page files are Phase 4 only. Phase 5 updates links to reduce redirect dependence after shims are verified.
5. Shell navigation, command palette, and breadcrumbs are Phase 5 only because they are visible rollout controls.
6. Any unexpected source-of-truth table change stops the current phase and triggers a migration-helper review before continuing.
