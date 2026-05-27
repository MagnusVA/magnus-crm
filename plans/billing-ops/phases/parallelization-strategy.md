# Parallelization Strategy — Billing Ops

**Purpose:** This document defines the parallel execution strategy across all 6 Billing Ops implementation phases, identifying the critical path, dependency graph, maximum concurrency windows, file ownership boundaries, team allocation, and quality gates.

**Prerequisite:** The Billing Ops design is accepted, Phase 0 product semantics are locked, and the widen-only schema plan is approved. Billing Ops must remain disabled for every tenant until all MVP phases, backfill verification, export audit, and release QA pass.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **0** | Data Audit and Product Lock | Backend / Migration / Manual | High | Design accepted |
| **1** | Read-Only Billing Queue | Full-Stack | High | Phase 0 schema, guards, aggregate components |
| **2** | Review Actions | Full-Stack | Medium | Phase 1 guards, detail query, aggregate hooks |
| **3** | Payment Corrections | Full-Stack | High | Phase 1 aggregate hooks; Phase 2 review semantics stable |
| **4** | Copy and Export Workflow | Full-Stack / Release | Medium-High | Phase 1 row/detail shape; Phase 0 export table; Phase 2-3 history labels |
| **5** | Optional Least-Privilege Billing Role | Auth / Migration / Full-Stack | Medium-High | MVP proven; product selects narrower role |

---

## Master Dependency Graph

```
                    ┌────────────────────────────────────────────────────────────┐
                    │                         PHASE 0                            │
                    │  Data Audit, Schema Widen, Aggregates, Enablement Gate     │
                    │  (FOUNDATION, Billing disabled)                            │
                    └───────────────────────────┬────────────────────────────────┘
                                                │
                    ┌───────────────────────────▼────────────────────────────────┐
                    │                         PHASE 1                            │
                    │  Read-Only Queue, Detail, Enrichment, Aggregate Hooks      │
                    │  (FOUNDATION FOR MVP UI)                                   │
                    └──────────────┬────────────────────┬────────────────────────┘
                                   │                    │
                  ┌────────────────▼────────────┐ ┌─────▼──────────────────────┐
                  │           PHASE 2           │ │           PHASE 3           │
                  │  Review Actions             │ │  Payment Corrections        │
                  │  (status transition)        │ │  (financial mutation path)  │
                  └──────────────┬──────────────┘ └─────────────┬──────────────┘
                                 │                              │
                                 └──────────────┬───────────────┘
                                                │
                    ┌───────────────────────────▼────────────────────────────────┐
                    │                         PHASE 4                            │
                    │  Copy, CSV Export, Export Audit, Navigation, Release Gate  │
                    │  (MVP ENABLEMENT)                                          │
                    └───────────────────────────┬────────────────────────────────┘
                                                │
                    ┌───────────────────────────▼────────────────────────────────┐
                    │                         PHASE 5                            │
                    │  Optional billing_admin Role                               │
                    │  (POST-MVP unless product escalates)                       │
                    └────────────────────────────────────────────────────────────┘
```

**Important dependency nuance:** Phase 4 copy/export backend can begin after Phase 1 row/detail contracts exist, but the release gate inside Phase 4 must wait for Phases 2 and 3 because exported/history data must reflect review and correction events.

---

## Maximum Parallelism Windows

### Window 1: Foundation Lock (Phase 0)

**Concurrency:** Up to 3 streams after the schema widen is started.

Phase 0 is the only truly blocking foundation. Product semantics and schema/component work can start together, then audit, backfill, and enablement checks split across separate files.

```
Timeline: ██████████████████████

0A Product lock + audit matrix ───────────┐
                                          ├── 0C Audit query ────────────────┐
0B Schema + aggregate components ─────────┼── 0D Backfill + count helpers ───┤── 0F Runbook/gate evidence
                                          └── 0E Readiness + enablement ─────┘
```

**Internal parallelism:**
```
0A ───────────────┐
                  ├── 0C
0B ───────────────┼── 0D
                  └── 0E

0C + 0D + 0E ──→ 0F
```

**Why independent:**

- 0A changes only plan/product artifacts.
- 0B owns `convex/schema.ts`, `convex/convex.config.ts`, and initial `convex/billing/aggregates.ts`.
- 0C owns `convex/billing/audit.ts` and validators.
- 0D owns aggregate backfill helpers.
- 0E owns `convex/admin/billingOps.ts`.

---

### Window 2: Read-Only Foundation (Phase 1)

**Concurrency:** Up to 4 streams after 1A guards and 1D aggregate hook contract start.

Phase 1 is full-stack but can be split cleanly into backend guard/query/enrichment/hook streams and a frontend route/UI stream that waits for stable API references.

```
Timeline:                 █████████████████████████████████

1A Permissions/guards ─────┬── 1B Queue query/counts ──────┐
                           ├── 1C Enrichment/detail ───────┤── 1E Routes/skeletons ──→ 1F Read-only UI
1D Aggregate write hooks ──┘                               │
                                                           └── Phase 2/3 backend contracts
```

**Within Phase 1:**
```
1A ──→ 1B ───────────────┐
      1C ───────────────┤── 1E ──→ 1F
1D ─────────────────────┘
```

**Why independent:**

- 1A touches permission and guard files.
- 1B touches query/filter selection files.
- 1C touches enrichment/detail files.
- 1D touches shared payment aggregate hooks and reset cleanup.
- 1E/1F touch new `app/workspace/billing/**` files.

---

### Window 3: Maximum MVP Parallelism (Phases 2, 3, and Early 4)

**Concurrency:** 3 phase streams plus internal subphase parallelism.

After Phase 1 contracts exist, review actions, corrections, and copy/export backend can proceed simultaneously. The final Phase 4 release gate still waits for all streams.

```
Timeline:                                      ███████████████████████████████████████

Phase 2 Review Actions ────────────────┐
                                       ├── Phase 4 Release Gate
Phase 3 Corrections ───────────────────┤
                                       │
Phase 4 Copy/Export backend + nav ─────┘
```

**Within Phase 2:**
```
2A markReviewed ─────┬── 2B next-review query ─────┐
                     ├── 2C event labels ──────────┤── 2D review UI ──→ 2E QA
                     └─────────────────────────────┘
```

**Within Phase 3:**
```
3A correction mutation ───┬── 3B tenant stats helper ──────┐
                          ├── 3C program cache helper ─────┤── 3E detail/history ──→ 3F QA
                          └── 3D correction dialog ────────┘
```

**Within early Phase 4:**
```
4A copy payload ───────────┐
4B export query ───────────┼── 4D export menu ──────────────┐
4C export audit ───────────┘                                ├── 4F release QA
4E nav/command gating ──────────────────────────────────────┘
```

**Why independent:**

- Phase 2 owns review transition and review UI.
- Phase 3 owns financial correction mutation, stats/program side effects, and correction dialog.
- Phase 4 owns copy/export DTOs, export audit, CSV UI, and nav gating.
- Shared files that need sequencing are `convex/billing/mutations.ts`, `convex/billing/queries.ts`, and `app/workspace/billing/_components/billing-review-page-client.tsx`.

---

### Window 4: MVP Release Gate (Phase 4F)

**Concurrency:** Low; up to 2 QA streams can gather evidence, but enablement is sequential.

Release gating validates the whole MVP and then enables one tenant manually. It should not be compressed into parallel implementation work.

```
Timeline:                                                              ████████████

Phase 0 readiness evidence ─────┐
Phase 1 read-only QA ───────────┤
Phase 2 review QA ──────────────┤── 4F export/release QA ──→ Manual enablement
Phase 3 correction QA ──────────┤
Phase 4 export/nav QA ──────────┘
```

**Internal parallelism:**
```
Security/access QA ───────┐
Export/content QA ────────┤── Final go/no-go
Aggregate/count QA ───────┘
```

---

### Window 5: Optional Role Extension (Phase 5)

**Concurrency:** Up to 2 streams after WorkOS preflight.

Phase 5 is post-MVP unless product requires least privilege earlier. It edits auth/role/team/shell files, so it should not overlap with Phase 4 nav/auth changes.

```
Timeline:                                                                            ███████████████

5A WorkOS preflight ─────┬── 5B schema/role mapping ───┐
                         └── 5C permissions/guards ────┤── 5D team UI ─────┐
                                                         └── 5E shell/nav ──┤── 5F role QA
```

---

## Critical Path Analysis

The longest sequential chain that determines minimum MVP delivery time is:

```
Phase 0B → Phase 0D → Phase 1D → Phase 3A → Phase 3B/3C → Phase 3F → Phase 4F → Manual enablement
   │          │          │          │          │             │          │             │
   │          │          │          │          │             │          │             └── Tenant flag flips only after all evidence
   │          │          │          │          │             │          └── Export/nav/release QA consumes all phases
   │          │          │          │          │             └── Financial correction QA is highest-risk
   │          │          │          │          └── Stats/program side effects prevent financial drift
   │          │          │          └── Correction contract defines return-to-review behavior
   │          │          └── New writes must keep Billing counts correct after backfill
   │          └── Aggregate backfill/count helpers are exact-count foundation
   └── Schema/components must exist before generated Convex refs compile
```

**Alternative shorter path:**
```
Phase 0A → Phase 1A → Phase 2A → Phase 2D → Phase 2E
```

This path is shorter because review actions patch existing fields and do not require the tenant stats replacement or sold-program cache repair work that corrections require.

**Another shorter path:**
```
Phase 1C → Phase 4A → Phase 4B/4C → Phase 4D
```

Copy/export can be implemented quickly after row/detail shape exists, but it cannot ship until correction/review event history and release QA pass.

**Implication:** Start Phase 3 backend as early as possible after Phase 1D. Correction side effects are the critical path and highest risk.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `convex/schema.ts` | Phase 0, then Phase 5 only | Phase 0 owns MVP schema widen; Phase 5 owns optional role widen. Avoid parallel edits. |
| `convex/convex.config.ts` | Phase 0 | Aggregate component registrations only. |
| `convex/billing/aggregates.ts` | Phase 0 / Phase 1 | Phase 0 defines components/helpers; Phase 1 integrates count usage. |
| `convex/billing/audit.ts` | Phase 0 | No later phase should edit unless readiness requirements change. |
| `convex/admin/billingOps.ts` | Phase 0 | System-admin readiness and enablement only. |
| `convex/billing/guards.ts` | Phase 1, then Phase 5 | Phase 1 MVP roles; Phase 5 optional billing_admin. |
| `convex/billing/queryBuilder.ts` | Phase 1 | Queue/export filter selection. Phase 4 reuses, should avoid changing signature. |
| `convex/billing/enrichment.ts` | Phase 1, then Phase 3 minor | Phase 1 owns row/detail enrichment; Phase 3 may add event actor detail only. |
| `convex/billing/queries.ts` | Phase 1 / Phase 2 / Phase 4 | High-conflict file. Sequence list/detail first, then next-review, then export. |
| `convex/billing/mutations.ts` | Phase 2 / Phase 3 / Phase 4 | High-conflict file. Allocate one backend owner or serialize mutation additions. |
| `convex/billing/export.ts` | Phase 4 | Export DTO/filter normalization. |
| `convex/reporting/writeHooks.ts` | Phase 1 | Billing aggregate hook integration. Phase 3 should reuse, not refactor. |
| `convex/lib/tenantStatsHelper.ts` | Phase 3 | Replacement stats helper only. |
| `convex/lib/soldProgramCache.ts` | Phase 3 | Program correction cache repair only. |
| `convex/lib/permissions.ts` | Phase 1, then Phase 5 | MVP Billing permissions, optional role expansion later. |
| `convex/lib/roleMapping.ts` | Phase 5 | Optional role only. |
| `convex/workos/**` | Phase 5 | Optional role WorkOS flows only. |
| `convex/tenants.ts` | Phase 4 | Return `billingOpsEnabled` for workspace shell. |
| `lib/auth.ts` | Phase 4, then Phase 5 | Phase 4 tenant flag; Phase 5 billing_admin fallback. |
| `app/workspace/billing/page.tsx` | Phase 1 | Route wrapper. Later phases should not change auth gate. |
| `app/workspace/billing/[paymentRecordId]/page.tsx` | Phase 1 | Route wrapper. Later phases should not change auth gate. |
| `app/workspace/billing/_components/billing-page-client.tsx` | Phase 1 / Phase 4 | Phase 1 filters/table; Phase 4 export menu. |
| `app/workspace/billing/_components/billing-review-page-client.tsx` | Phase 1 / Phase 2 / Phase 3 / Phase 4 | High-conflict file. Sequence action mounts carefully. |
| `app/workspace/billing/_components/billing-queue-table.tsx` | Phase 1 | Read-only queue. Do not add review buttons. |
| `app/workspace/billing/_components/billing-event-history.tsx` | Phase 1 / Phase 2 / Phase 3 | Phase 2 labels, Phase 3 correction metadata. |
| `app/workspace/billing/_components/correction-dialog.tsx` | Phase 3 | Correction UI only. |
| `app/workspace/billing/_components/export-menu.tsx` | Phase 4 | Export UI only. |
| `app/workspace/billing/_components/copy-billing-payload-button.tsx` | Phase 4 | Copy UI only. |
| `app/workspace/_components/workspace-auth.tsx` | Phase 4 | Pass tenant flag. |
| `app/workspace/_components/workspace-shell-client.tsx` | Phase 4, then Phase 5 | Billing nav, then optional billing_admin nav. |
| `components/command-palette.tsx` | Phase 4, then Phase 5 | Billing command, then optional role-specific page set. |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Phase 5 | Optional role only. |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Phase 5 | Optional role only. |
| `plans/billing-ops/phases/*-qa.md` | Owning phase | QA artifacts should be created by the same phase owner. |

---

## Recommended Execution Strategies

### Solo Developer

**Estimated total time:** 14-20 working days for MVP, plus 3-4 days if Phase 5 is selected.

| Sequence | Work |
|---|---|
| 1 | Phase 0B schema/components, then generated types. |
| 2 | Phase 0C/0D/0E and runbook. |
| 3 | Phase 1A/1D, then Phase 1B/1C, then Phase 1E/1F. |
| 4 | Phase 2A/2B/2C/2D. |
| 5 | Phase 3A/3B/3C, then 3D/3E/3F. |
| 6 | Phase 4A/4B/4C, then 4D/4E/4F. |
| 7 | Optional Phase 5 only after MVP validation. |

**Solo optimization:** Keep `convex/billing/mutations.ts` changes sequential: review mutation first, correction mutation second, export audit third. This avoids self-inflicted merge churn.

### Two Developers

**Estimated total time:** 9-13 working days for MVP, plus optional role extension.

| Sprint | Developer A | Developer B |
|---|---|---|
| 1 | Phase 0B schema/components, aggregate helpers | Phase 0A product/audit matrix, runbook skeleton |
| 2 | Phase 0D backfill/count verification | Phase 0C audit query, Phase 0E admin enablement |
| 3 | Phase 1A guards and 1B queue query | Phase 1C enrichment/detail and 1D hook audit |
| 4 | Phase 2 review mutation/UI | Phase 1E/1F route and read-only UI |
| 5 | Phase 3 correction backend/stats/cache | Phase 4 copy/export backend and nav gating |
| 6 | Phase 3 correction UI/QA | Phase 4 export UI/release QA |
| 7 | Optional Phase 5 backend/auth | Optional Phase 5 team/shell UI |

**Two-developer rule:** Developer A owns `convex/billing/mutations.ts`; Developer B should not edit that file until A finishes mutation contracts.

### Three+ Developers/Agents

**Estimated total time:** 7-10 working days for MVP if handoffs are disciplined.

| Sprint | Backend Agent | Frontend Agent | Migration/QA Agent |
|---|---|---|---|
| 1 | Phase 0B schema/components | Read UI patterns and prepare Billing skeleton components | Phase 0A product lock and audit matrix |
| 2 | Phase 1A/1B/1C backend | Phase 1E route wrappers and skeletons | Phase 0D/0E backfill/readiness tooling |
| 3 | Phase 2A/2B review backend | Phase 1F queue/detail UI | Phase 1D aggregate hook audit |
| 4 | Phase 3A/3B/3C corrections backend | Phase 2D review UI and Phase 3D correction dialog | Phase 2 QA and count verification |
| 5 | Phase 4B/4C export backend | Phase 4A/4D/4E copy/export/nav UI | Phase 3/4 release QA and enablement runbook |
| 6 | Optional Phase 5 backend/auth | Optional Phase 5 team/shell UI | Optional role WorkOS/QA |

**Three-agent rule:** Assign a single integrator for `billing-review-page-client.tsx` because Phase 1, 2, 3, and 4 all mount controls there.

---

## Quality Gates

| Gate Name | Trigger | Checks |
|---|---|---|
| Product Semantics Gate | After 0A | `verified` reuse accepted, or 10.8 migration branch selected before coding. |
| Schema Widen Gate | After 0B | `npx convex dev` generates types; no required fields added to existing rows; tenant flag defaults disabled. |
| Aggregate Backfill Gate | After 0D | Billing aggregate backfill completes for test tenant; counts match indexed verification matrix. |
| Enablement Refusal Gate | After 0E | System-admin enable mutation fails without passing readiness record. |
| Read-Only Data Gate | After 1C | Queue/detail return correct customer/payment/attribution context with no cross-tenant leakage. |
| Write Hook Gate | After 1D | New payment insert and existing dispute/void paths update Billing counts without re-backfill. |
| Review Gate | After Phase 2 | `recorded -> verified` moves counts, writes one event, and leaves revenue summaries unchanged. |
| Correction Gate | After Phase 3 | Amount/type/program corrections repair stats, aggregates, customer summary, and program caches. |
| Export Audit Gate | After 4D | CSV has no proof URLs, formula-safe cells, cap/truncation metadata, and one audit row per download. |
| Navigation Gate | After 4E | Billing hidden while disabled, visible after enablement for authorized roles only. |
| Release Gate | After 4F | All MVP acceptance criteria pass; latest readiness check passed; manual enablement documented. |
| Optional Role Gate | After Phase 5 | WorkOS and CRM roles match; `billing_admin` passes access matrix and cannot access admin pages. |

---

## Risk Mitigation

| Risk | Impact | Mitigation Strategy |
|---|---|---|
| Product later rejects `verified` reuse | Critical | Stop before Phase 1 and implement design section 10.8 with widen-migrate-narrow. |
| Billing counts drift after backfill | Critical | Wire aggregate helpers into shared `insertPaymentAggregate` / `replacePaymentAggregate` hooks before enablement. |
| Correction stats mutate payment counts | Critical | Use `replaceTenantPaymentStatsForCorrection`; never use `applyPaymentStatsDelta` for corrections. |
| Cross-tenant id lookup leaks details | Critical | Every query/mutation derives `tenantId` from auth and validates every loaded doc's tenant before return. |
| Export leaks proof URLs | High | Export DTO includes `hasProofFile` only; proof URL remains focused-detail only after auth. |
| `usePaginatedQuery` loses exact count metadata | High | Use separate `getPaymentCount` query for exact counts instead of relying on extra pagination result fields in UI. |
| Merge conflicts in `convex/billing/mutations.ts` | Medium-High | Single backend owner or strict sequence: Phase 2 review, Phase 3 correction, Phase 4 export audit. |
| Navigation exposes Billing before enablement | High | Carry `billingOpsEnabled` through `convex/tenants.ts`, `lib/auth.ts`, and shell props; direct route still gates. |
| WorkOS `billing-admin` role missing | High | Phase 5 preflight verifies role slug in dev/prod before code exposes role. |
| WorkOS IdP mapping overrides assignments | Medium | Document tenant-specific IdP mapping and test re-login after assignment. |
| Export query too heavy | Medium | Cap at 1,000, enrich only capped rows, and use Convex insights/performance audit if fan-out grows. |
| Historical `verified` rows misrepresented | Medium | Phase 0 audit counts existing `verified` rows and requires product signoff before enablement. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| Phase 0 | `convex-migration-helper`, `convex-performance-audit`, `design-doc-review` | Schema widen, aggregate backfill, readiness verification, and product semantics lock. |
| Phase 1 | `convex-performance-audit`, `next-best-practices`, `frontend-design`, `shadcn` | Indexed queue, bounded enrichment, App Router route/client boundaries, operational table UI. |
| Phase 2 | `convex-migration-helper`, `frontend-design`, `shadcn` | Confirm no schema migration under default branch; detail-page review action UX. |
| Phase 3 | `convex-migration-helper`, `frontend-design`, `shadcn` | Financial correction safety, form pattern, status reset warnings. |
| Phase 4 | `frontend-design`, `shadcn`, `next-best-practices`, `convex-performance-audit` | Copy/export interaction, route/nav gating, bounded export performance. |
| Phase 5 | `convex-migration-helper`, `workos`, `next-best-practices` | Optional role schema widen, WorkOS RBAC behavior, route fallback and role-specific shell. |
