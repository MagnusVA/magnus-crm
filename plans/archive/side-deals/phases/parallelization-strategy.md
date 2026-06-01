# Parallelization Strategy - Opportunities Management & Side Deals

**Purpose:** This document defines the parallel execution roadmap across all seven implementation phases for Opportunities Management & Side Deals. It identifies the critical path, maximum concurrency windows, file ownership boundaries, staffing strategies, and quality gates needed to ship without gaps or merge collisions.

**Prerequisite:** `plans/side-deals/side-deals-design.md` is accepted. Phase 1 must use widen-migrate-narrow because production has one real test tenant. Before any implementation starts, `npx convex dev`, `pnpm tsc --noEmit`, and `pnpm lint` should be green on `main`.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **1** | Schema & Enum Foundations | Backend / Migration | High | None |
| **2** | Backend: Opportunity Creation & Lifecycle Mutations | Backend | High | Phase 1 |
| **3** | Frontend: Opportunities List Page | Frontend | Medium-High | Phase 2 for live integration; can scaffold after 2D contract |
| **4** | Frontend: Opportunity Create Page | Frontend | Medium-High | Phase 2 for submit/pickers |
| **5** | Frontend: Opportunity Detail & Side-Deal Payment Flow | Full-Stack | High | Phase 2 |
| **6** | Reporting, Void & Audit Trail | Full-Stack | Medium-High | Phase 5; Phase 1 origin validators |
| **7** | Staleness Detection, Nudges & Empty-Opportunity Cleanup | Full-Stack | Medium-High | Phase 5; sequence shared detail UI after Phase 6 edits |

**Important dependency nuance:** Phases 3, 4, and 5 can run as a frontend/full-stack fan-out after Phase 2. Phase 3 and 4 do not block Phase 5, but the user-visible MVP is incomplete until Phase 4 create and Phase 5 detail/payment both land.

---

## Master Dependency Graph

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                  PHASE 1                                     │
│  Schema & Enum Foundations                                                   │
│  Widen schema, origin validators, lifecycle helper, backfill                 │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼──────────────────────────────────────────┐
│                                  PHASE 2                                     │
│  Backend: Opportunity Creation & Lifecycle Mutations                         │
│  createManual, sideDeals.logPayment, markLost, list/search/picker queries    │
└───────────────┬───────────────────┬───────────────────┬─────────────────────┘
                │                   │                   │
┌───────────────▼──────────────┐ ┌──▼────────────────┐ ┌▼─────────────────────┐
│           PHASE 3            │ │      PHASE 4      │ │        PHASE 5        │
│  Opportunities List Page     │ │ Create Page       │ │ Detail + Payment Flow │
│  /workspace/opportunities    │ │ /opportunities/new│ │ /opportunities/[id]   │
└───────────────┬──────────────┘ └──┬────────────────┘ └──────────┬───────────┘
                │                   │                             │
                │                   │                             │
                └──────────────┬────┴──────────────┬──────────────┘
                               │                   │
                    ┌──────────▼──────────┐ ┌──────▼──────────────┐
                    │       PHASE 6       │ │       PHASE 7       │
                    │ Reporting + Void    │ │ Staleness + Cleanup │
                    │ Admin correction    │ │ Nudges + delete     │
                    └──────────┬──────────┘ └──────┬──────────────┘
                               │                   │
                               └──────────┬────────┘
                                          │
                              ┌───────────▼───────────┐
                              │     FINAL QA GATE      │
                              │  Typecheck, lint, UX,  │
                              │  accounting, cron      │
                              └───────────────────────┘
```

**Parallel levels:**
- Level 1: Phase 1 only.
- Level 2: Phase 2 only, with high internal parallelism.
- Level 3: Phases 3, 4, and 5 together.
- Level 4: Phase 6 and Phase 7 backend streams together; shared detail UI sequenced.
- Level 5: Final integrated QA.

---

## Maximum Parallelism Windows

### Window 1: Schema Foundation and Backfill

**Concurrency:** Up to 3 internal backend streams after the 1A schema gate.

Phase 1 is the hard foundation. All later phases import generated fields/types and rely on the migration/backfill compatibility helpers. No other phase should merge runtime code before 1A is deployed.

```
Timeline: ███████████████████████████████████████
          1A schema widen ───┐
                             ├── 1B sideDeals/opportunityActivity helpers ──┐
                             ├── 1C existing writer compliance ─────────────┤
                             └── 1D migration definition ───────────────────┤
                                                                           ▼
                                                                    1E backfill
                                                                           ▼
                                                               1F narrow runbook
```

**Internal parallelism:**

```
1A (schema + validators) ──┬── 1B (new helper files)
                           ├── 1C (pipeline/closer/admin writer sweep)
                           └── 1D (migrations.ts)

1B + 1C + 1D complete ──→ 1E (migration execution + verification)
```

**Why this is safe:** 1B creates new helper files, 1C edits runtime writers, and 1D edits `convex/migrations.ts`. The only shared generated type dependency is unlocked by 1A.

---

### Window 2: Backend API Fan-Out

**Concurrency:** Up to 4 backend streams after 2A.

Phase 2 has a small serial gate, then broad module-level independence.

```
Timeline:          ███████████████████████████████
                   2A identity extraction ─┐
                                           ├── 2B createManual ──────────────┐
                                           ├── 2C sideDeals payment/lost ────┤
                                           ├── 2D list/search queries ───────┤
                                           └── 2E picker queries ────────────┤
                                                                               ▼
                                                                         2G QA gate
```

**Internal parallelism:**

```
2A (convex/leads/identityResolution.ts + validators.ts)
        │
        ├── 2B convex/opportunities/createManual.ts
        ├── 2C convex/sideDeals/logPayment.ts + markLost.ts
        ├── 2D convex/opportunities/listQueries.ts
        └── 2E convex/leads/queries.ts + convex/users/queries.ts
```

**Why this is safe:** Each backend stream owns different files after 2A. The only overlap risk is `convex/leads/queries.ts`, owned solely by 2E.

---

### Window 3: User-Facing Surface Fan-Out

**Concurrency:** 3 major streams: list, create, and detail/payment.

After Phase 2, three user-facing surfaces can be built simultaneously. They live under different route subtrees.

```
Timeline:                    █████████████████████████████████████████
                             Phase 3 List Page       ████████████████
                             Phase 4 Create Page     ████████████████
                             Phase 5 Detail/Payment  ███████████████████
                                                    │
                                                    ▼
                                             usable side-deal loop
```

**Within Phase 3:**

```
3A route/skeleton ─────────────┐
3B state/query client ──────┐  │
3C controls ────────────────┤──┴── 3D table
3E nav/command palette ─────┘       │
                                    ▼
                                  3F QA
```

**Within Phase 4:**

```
4A route/skeleton ─────────────┐
4B schema/form shell ──────────┼── 4D submit integration
4C combobox/select ────────────┘          │
4E deep-link polish ──────────────────────┤
                                          ▼
                                        4F QA
```

**Within Phase 5:**

```
5A detail query ───────────────┐
5B route/skeleton ─────────────┼── 5C detail client/sections
5D payment dialog ─────────────┤
5E lost dialog ────────────────┘
5F pipeline navigation ───────────────────┐
                                          ▼
                                        5G QA
```

**Why this is safe:**
- Phase 3 owns `app/workspace/opportunities/page.tsx` and `_components/*` directly under `opportunities`.
- Phase 4 owns `app/workspace/opportunities/new/*`.
- Phase 5 owns `app/workspace/opportunities/[opportunityId]/*`.
- Shared edits are limited to `components/command-palette.tsx` and `app/workspace/_components/pipeline/opportunities-table.tsx`, both explicitly assigned.

---

### Window 4: Post-Detail Accounting and Cleanup

**Concurrency:** 2 backend streams plus sequenced shared detail UI.

After Phase 5, Phase 6 and Phase 7 can overlap, but they both touch the detail query/client. Backend work should run in parallel; UI integration should be sequenced.

```
Timeline:                                      █████████████████████████
                                               Phase 6 reporting/void backend ███████
                                               Phase 7 staleness/delete backend ██████
                                               Phase 6 detail void UI       ███
                                               Phase 7 stale/delete UI         ███
                                                                          │
                                                                          ▼
                                                                    final integrated QA
```

**Within Phase 6:**

```
6A void mutation ──┬── 6B detail permission ── 6D void UI ──┐
6C reporting backend ─────────────── 6E reporting UI ───────┤
                                                            ▼
                                                          6F QA
```

**Within Phase 7:**

```
7A schema/index ──┬── 7B cron/internal mutation ─┐
                  ├── 7C delete mutation ────────┼── 7D query/action integration
                  └── 7E UI shell ───────────────┘          │
                                                            ▼
                                                          7F QA
```

**Why this is safe:** Phase 6 backend owns `voidPayment` and reporting files; Phase 7 backend owns `staleness`, cron, and delete mutation. The shared files `detailQuery.ts` and `opportunity-detail-client.tsx` must be edited in sequence: Phase 6 void permission/action first, Phase 7 stale/delete fields second.

---

### Window 5: Final Integrated Verification

**Concurrency:** Low. This is intentionally a serial quality gate.

```
Timeline:                                                        █████████
                                                                 Typecheck
                                                                 Lint
                                                                 Convex dev
                                                                 Browser flows
                                                                 Accounting checks
                                                                 Cron checks
```

**Why serial:** The final gate validates cross-phase behavior: create -> list -> detail -> payment -> reporting -> void -> staleness/delete. Running those in isolation misses accounting and stale-reminder regressions.

---

## Critical Path Analysis

The longest delivery chain for the complete MVP is:

```
Phase 1 ──→ Phase 2 ──→ Phase 5 ──→ Phase 6 ──→ Phase 7 ──→ Final QA
 schema       backend      detail      void       cleanup
```

**Why Phase 5 is on the path:** Phase 6 voiding and Phase 7 cleanup both integrate through the opportunity detail page and detail query. The list/create pages can run beside Phase 5, but the post-detail work cannot.

**Parallel side paths:**

```
Phase 1 ──→ Phase 2 ──→ Phase 3 (list)
Phase 1 ──→ Phase 2 ──→ Phase 4 (create)
```

These are required for the user-visible feature, but they can finish while Phase 5 is underway.

**Implication:** Start Phase 5 immediately after Phase 2, not after Phase 3/4. Waiting for list/create to finish before detail wastes the largest parallelism window.

**Minimum estimated timeline:**
- Solo developer: 9-13 working days.
- Two developers: 6-8 working days.
- Three+ developers/agents: 4-6 working days, limited by Phase 1 -> Phase 2 -> Phase 5 -> Phase 6/7 sequencing and QA depth.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | Phase 1, Phase 7 | Phase 1 widens opportunities/payment/lead identifiers; Phase 7 adds follow-up reason/index. Sequential ownership only. |
| `convex/lib/paymentTypes.ts` | Phase 1 | Side-deal origin validators/types. |
| `convex/lib/sideDeals.ts` | Phase 1 | New helper. Later phases import only. |
| `convex/lib/opportunityActivity.ts` | Phase 1 | New lifecycle helper. Later phases import only. |
| `convex/migrations.ts` | Phase 1 | Backfill definition only. |
| `convex/pipeline/inviteeCreated.ts` | Phase 1, Phase 2A | Phase 1 sets source/activity; Phase 2A extracts identity. Coordinate merge if same developer does not own both. |
| `convex/pipeline/inviteeCanceled.ts` | Phase 1 | Lifecycle helper conversion. |
| `convex/pipeline/inviteeNoShow.ts` | Phase 1 | Lifecycle helper conversion. |
| `convex/lib/opportunityMeetingRefs.ts` | Phase 1 | latestActivityAt maintenance. |
| `convex/closer/payments.ts` | Phase 1 | Existing Calendly payment lifecycle helper conversion. |
| `convex/closer/meetingActions.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/admin/meetingActions.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/closer/followUpMutations.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/closer/noShowActions.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/closer/meetingOverrun.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/closer/reminderOutcomes.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/customers/mutations.ts` | Phase 1 | Review/convert payment-conversion adjacent opportunity lifecycle writes. |
| `convex/lib/outcomeHelpers.ts` | Phase 1 | Review shared outcome status patches for opportunity lifecycle writes. |
| `convex/opportunities/maintenance.ts` | Phase 1 | Review maintenance patches for lifecycle/activity invariants. |
| `convex/leads/merge.ts` | Phase 1 | Review merge rewrites for opportunity aggregate/activity consistency. |
| `convex/reviews/mutations.ts` | Phase 1 | Existing lifecycle helper conversion. |
| `convex/unavailability/redistribution.ts` | Phase 1 | Review assignment-only patches. |
| `convex/opportunities/validators.ts` | Phase 2 | New shared validators. |
| `convex/leads/identityResolution.ts` | Phase 2 | New shared resolver. |
| `convex/opportunities/createManual.ts` | Phase 2 | Manual opportunity creation. |
| `convex/sideDeals/logPayment.ts` | Phase 2, Phase 7 | Phase 2 creates; Phase 7 expires stale nudges. |
| `convex/sideDeals/markLost.ts` | Phase 2, Phase 7 | Phase 2 creates; Phase 7 expires stale nudges. |
| `convex/opportunities/listQueries.ts` | Phase 2, Phase 7 | Phase 2 creates list/search; Phase 7 adds stale flag. |
| `convex/leads/queries.ts` | Phase 2 | Picker queries. |
| `convex/users/queries.ts` | Phase 2 | Active closer picker query. |
| `app/workspace/opportunities/page.tsx` | Phase 3 | List route only. |
| `app/workspace/opportunities/loading.tsx` | Phase 3 | List route loading only. |
| `app/workspace/opportunities/_components/*` | Phase 3, Phase 7 | Phase 3 owns list components; Phase 7 modifies `opportunities-table.tsx` for stale badge only. |
| `app/workspace/_components/workspace-shell-client.tsx` | Phase 3 | Add nav item. No later phase should touch for this feature. |
| `components/command-palette.tsx` | Phase 3 or Phase 4 | Assign one owner to add both list and create entries to avoid conflict. |
| `app/workspace/opportunities/new/*` | Phase 4 | Create page subtree. |
| `app/workspace/leads/[leadId]/_components/lead-detail-page-client.tsx` | Phase 4 optional | Optional deep-link CTA only. |
| `convex/opportunities/detailQuery.ts` | Phase 5, Phase 6, Phase 7 | Phase 5 creates; Phase 6 adds void permission; Phase 7 adds stale/delete flags. Sequential edits required. |
| `app/workspace/opportunities/[opportunityId]/*` | Phase 5, Phase 6, Phase 7 | Phase 5 creates; Phase 6 adds void dialog; Phase 7 adds delete/stale UI. Sequential edits to shared client. |
| `app/workspace/_components/pipeline/opportunities-table.tsx` | Phase 5 | Route primary action to opportunity detail. |
| `app/workspace/pipeline/_components/pipeline-page-client.tsx` | Phase 5 optional | Prop update only if table contract changes. |
| `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` | Phase 5 optional | Prop update only if table contract changes. |
| `convex/sideDeals/voidPayment.ts` | Phase 6 | New mutation. |
| `convex/dashboard/adminStats.ts` | Phase 6 | Side-deal metrics. |
| `convex/reporting/revenue.ts` | Phase 6 | Review/modify origin grouping if needed. |
| `convex/reporting/lib/helpers.ts` | Phase 6 | Review/modify origin classification if needed. |
| `app/workspace/reports/revenue/_components/revenue-by-origin-chart.tsx` | Phase 6 | Side-deal origin labels. |
| `app/workspace/_components/stats-row.tsx` | Phase 6 | Dashboard side-deal card if this file renders cards. |
| `app/workspace/_components/stats-row-client.tsx` | Phase 6 | Type/client update if stats split. |
| `app/workspace/reports/revenue/_components/revenue-kpi-cards.tsx` | Phase 6 | Review/modify if origin-aware. |
| `convex/opportunities/staleness.ts` | Phase 7 | New internal mutation. |
| `convex/crons.ts` | Phase 7 | Add stale side-deal cron. |
| `convex/sideDeals/deleteEmptyOpportunity.ts` | Phase 7 | New mutation. |
| `convex/lib/staleOpportunityNudges.ts` | Phase 7 optional | Shared nudge-expiry helper if extracted. |
| `app/workspace/closer/_components/reminders-section.tsx` | Phase 7 | Route stale nudge rows to opportunity detail. |
| `app/workspace/closer/reminders/[followUpId]/_components/reminder-outcome-action-bar.tsx` | Phase 7 | Guard generic reminder outcome actions for stale nudges. |

---

## Recommended Execution Strategies

### Solo Developer

**Estimated total:** 9-13 working days.

| Sprint | Work |
|---|---|
| Day 1-2 | Phase 1: schema widen, helpers, writer sweep, migration dry run/backfill. |
| Day 3-4 | Phase 2: identity extraction, createManual, sideDeal mutations, list/search/picker queries. |
| Day 5 | Phase 3 list page and nav integration. |
| Day 6 | Phase 4 create page and picker UX. |
| Day 7-8 | Phase 5 detail route, payment dialog, mark lost, pipeline navigation. |
| Day 9 | Phase 6 void mutation/UI and reporting metrics. |
| Day 10 | Phase 7 staleness cron/delete UI. |
| Day 11+ | Integrated QA, accounting checks, browser polish, narrow-deploy follow-up only after backfill proof. |

**Solo guidance:** Do not start Phase 3 before Phase 2 query signatures are stable. The fastest solo path is to complete backend first, then build the three UI surfaces with known API references.

---

### Two Developers

**Estimated total:** 6-8 working days.

| Sprint | Developer A | Developer B |
|---|---|---|
| Day 1 | Phase 1A/1B/1D schema, helpers, migration | Phase 1C writer sweep after 1A deploys |
| Day 2 | Phase 2A identity extraction + validators | Phase 2C sideDeals payment/lost after 2A |
| Day 3 | Phase 2B createManual + 2E picker queries | Phase 2D list/search queries + backend QA |
| Day 4 | Phase 5A/5B detail query/route | Phase 3 list page |
| Day 5 | Phase 5C/5D/5E detail sections/dialogs | Phase 4 create page |
| Day 6 | Phase 6 void/reporting backend | Phase 6 UI + reporting labels |
| Day 7 | Phase 7 cron/delete backend | Phase 7 stale/delete UI |
| Day 8 | Integrated QA/accounting/cron/browser fixes | Integrated QA/accounting/cron/browser fixes |

**Two-dev guidance:** Developer A should own Convex-heavy files through Phase 6/7. Developer B should own route/UI surfaces after Phase 2 to minimize context switching.

---

### Three+ Developers/Agents

**Estimated total:** 4-6 working days.

| Sprint | Backend A | Backend B | Frontend A | Frontend B / QA |
|---|---|---|---|---|
| Day 1 AM | Phase 1A schema | Phase 1C writer inventory prep | Read existing list/create/detail UI patterns | Prepare QA checklist and test data plan |
| Day 1 PM | Phase 1B helpers + 1D migration | Phase 1C writer conversions | Phase 3 static route/table skeleton only; no generated API refs | Phase 4 static form skeleton only; no generated API refs |
| Day 2 AM | Phase 2A identity extraction | Phase 2C sideDeal mutations | Phase 3 filter/table component props with placeholder data | Phase 4 picker UI shell with placeholder data |
| Day 2 PM | Phase 2B createManual | Phase 2D/2E list/search/picker queries | Phase 3 list/search integration after 2D signatures land | Phase 4 submit/deep-link integration after 2B/2E signatures land |
| Day 3 | Phase 5A detail query + backend fixes | Phase 6A/6C void/reporting backend starts after 5A | Phase 5 route, detail query consumer, and dialogs after 5A | Phase 3/4 QA and fixes |
| Day 4 | Phase 7A/7B/7C staleness/delete backend | Phase 6 accounting/reporting verification | Phase 6 void UI/reporting labels | Phase 7 stale/delete UI |
| Day 5 | Final backend fixes | Final accounting/cron checks | Browser polish | Integrated QA, screenshots, release notes |

**Three+ guidance:** Do not assign two agents to `opportunity-detail-client.tsx` at the same time. Before Phase 2 generated API signatures exist, frontend work is limited to reading patterns and local placeholder shells; do not import planned `api.*` paths or wire real `useQuery` / `useMutation` calls until the owning backend subphase lands. Sequence Phase 5 base detail, then Phase 6 void UI, then Phase 7 stale/delete UI.

---

## Quality Gates

| Gate name | Trigger | Checks |
|---|---|---|
| **Gate 1: Schema Widen** | After Phase 1A | `npx convex dev`; generated types include optional fields; existing schema rows still validate. |
| **Gate 2: Writer Sweep** | After Phase 1C | `rg` for direct opportunity lifecycle patches; all runtime status/payment/meeting-ref patches use `patchOpportunityLifecycle` or have documented exception. |
| **Gate 3: Backfill Proof** | After Phase 1E | Dry run + real backfill complete; zero rows missing `source` or `latestActivityAt`; no narrow deploy yet. |
| **Gate 4: Backend API** | After Phase 2 | Dashboard smoke tests for createManual idempotency, logPayment, markLost, list/search scoping; `pnpm tsc --noEmit`. |
| **Gate 5: List/Create UI** | After Phases 3 and 4 | Admin/closer role checks, URL filters, lead prefill, mobile layout, successful create -> detail navigation. |
| **Gate 6: Detail Payment Flow** | After Phase 5 | Create -> detail -> payment -> customer conversion; Calendly detail read-only behavior; pipeline row navigation. |
| **Gate 7: Void Accounting** | After Phase 6 | Void reverses stats/aggregates/customer conversion correctly; reporting labels side-deal origins; Calendly reporting unchanged. |
| **Gate 8: Staleness Cleanup** | After Phase 7 | Cron idempotency, stale badge/banner, delete invariants, stats reversal, nudge expiry. |
| **Gate 9: Final Release** | After all phases | `pnpm tsc --noEmit`; `pnpm lint`; `npx convex dev`; browser pass at desktop/mobile; production rollout notes include migration/backfill/narrow status. |

---

## Risk Mitigation

| Risk | Impact | Mitigation strategy |
|---|---|---|
| Narrowing `opportunities.source` before backfill | Critical | Phase 1 uses widen-migrate-narrow. Narrow deploy is explicitly deferred until zero missing fields are verified. |
| Missing an existing opportunity status patch | High | Gate 2 `rg` sweep; central `patchOpportunityLifecycle`; reviewer blocks direct lifecycle patches. |
| Pagination returns empty pages because filters apply after paginate | High | Phase 1 adds all source/status/closer/latestActivity indexes; Phase 2 list query chooses exact index branch before pagination. |
| Manual create duplicates opportunities on retry | High | `manualCreationKey` plus `by_tenantId_and_manualCreationKey`; client uses stable `clientRequestId` until success. |
| Cross-tenant or cross-closer data leakage | Critical | Every Convex query/mutation uses `requireTenantUser`; closers scoped server-side; detail returns `null` for unauthorized. |
| Side-deal payment creates inconsistent customer/payment state | High | Reuse `assertPaymentRow`, `resolveProgramForWrite`, `executeConversion`, `syncCustomerPaymentSummary`, `insertPaymentAggregate`, `applyPaymentStatsDelta`. |
| Void path loosens general state machine | High | Do not add `payment_received -> lost` to `VALID_TRANSITIONS`; keep exception local to `sideDeals.voidPayment`. |
| Revenue origin UI breaks on new union literals | Medium | Use `satisfies Record<RevenueOrigin, ...>` in origin metadata; Phase 6 typecheck catches missing labels. |
| Cron creates duplicate stale nudges | Medium | `by_opportunityId_and_status_and_reason` point lookup; cron checks pending nudge before insert; idempotency tested by running twice. |
| Stale nudge uses generic reminder outcome flow | High | Phase 7 routes stale nudge rows to opportunity detail and guards reminder outcome actions, so payments/lost outcomes use side-deal mutations and origins. |
| Delete removes meaningful work | Critical | `deleteEmptyOpportunity` requires zero payments, zero meetings, no booked/completed follow-ups, and only stale-nudge follow-ups. Mutation rechecks server-side. |
| Merge conflicts in detail files | Medium | File ownership table sequences detail client/query edits: Phase 5 base, Phase 6 void, Phase 7 stale/delete. |
| UI becomes too sparse/marketing-like | Medium | Frontend phases use existing CRM table/card patterns; no landing pages, no hero sections, no decorative card nesting. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **1** | `convex-migration-helper`, `convex-performance-audit`, `convex-dev-workos-authkit` | Safe widen/backfill/narrow, index review, auth boundary sanity. |
| **2** | `convex-performance-audit`, `convex-dev-workos-authkit`, `convex-migration-helper` | Backend API correctness, role scoping, no accidental breaking schema changes. |
| **3** | `frontend-design`, `next-best-practices`, `shadcn`, `vercel-react-best-practices` | List page UX, Suspense/search params, existing primitives, render stability. |
| **4** | `frontend-design`, `next-best-practices`, `shadcn`, `vercel-react-best-practices` | Full-page form, RHF/Zod, picker composition, idempotent submit behavior. |
| **5** | `frontend-design`, `next-best-practices`, `shadcn`, `web-design-guidelines` | Detail route, dialogs, accessibility, section isolation. |
| **6** | `convex-performance-audit`, `convex-migration-helper`, `frontend-design`, `web-design-guidelines` | Accounting/reporting correctness, no migration surprises, destructive UI clarity. |
| **7** | `convex-performance-audit`, `convex-migration-helper`, `frontend-design`, `web-design-guidelines` | Cron safety, additive schema, cleanup UI, destructive delete accessibility. |

---

## Non-Negotiable Sequencing Rules

1. Phase 1A must deploy before any code imports `source`, `latestActivityAt`, or side-deal origins.
2. Phase 1E backfill must complete before relying on `latestActivityAt` ordering in production.
3. Phase 2A must land before manual create or Calendly identity refactors diverge.
4. Phase 5 should start immediately after Phase 2; do not wait for Phase 3/4 to finish.
5. Phase 6 and Phase 7 may overlap only if `detailQuery.ts` and `opportunity-detail-client.tsx` edits are sequenced.
6. The final narrow schema deploy is a follow-up after production backfill verification, not part of the main feature merge.
