# Parallelization Strategy — Lead Gen Ops

**Purpose:** This document defines the parallel execution strategy across all 6 Lead Gen Ops implementation phases, identifying the critical path, maximum concurrency windows, file ownership boundaries, team allocation, and quality gates.

**Prerequisite:** Phase 0 scope, migration, WorkOS role, route blast-radius, and QA checklists are accepted. WorkOS role slug `lead-generator` exists before any environment exposes Lead Generator invites.

## Phase 0 Gate Artifacts

Phase 0 owns the implementation guardrails that every later phase must follow:

| Artifact | Purpose |
|---|---|
| `plans/lead-gen-ops/phases/phase0-implementation-checklist.md` | Forbidden changes, allowed integration points, WorkOS/RBAC preflight, route/nav inventory, UX guardrails, and gate checks. |
| `plans/lead-gen-ops/phases/phase0-migration-notes.md` | Widen-only MVP classification, required deployment order, WorkOS role setup, migration escalation triggers, and rollback notes. |
| `plans/lead-gen-ops/phases/phase0-qa-matrix.md` | Seed data and manual QA coverage across auth, capture, reporting, Slack, Calendly, exports, and accessibility. |

Before Phase 1 starts, reviewers should confirm those artifacts are accepted and the external WorkOS `lead-generator` role exists in both dev and production.

---

## Phase Overview

| Phase | Name | Type | Estimated Complexity | Dependencies |
|---|---|---|---|---|
| **0** | Scope, Blast Radius, and Migration Guardrails | Planning / QA | Medium | Design accepted |
| **1** | RBAC and Worker Configuration | Full-Stack / Foundation | High | Phase 0 |
| **2** | Mobile Capture and Prospect Dedupe | Full-Stack | High | Phase 1; final aggregate wire depends on Phase 3A |
| **3** | Admin Reporting, Exports, and Aggregates | Full-Stack | High | Phase 1; end-to-end QA depends on Phase 2 writes |
| **4** | Audit Matching to Qualified CRM Records | Backend / Integration | Medium-High | Phase 1; realistic QA depends on Phase 2 seed data |
| **5** | Corrections, QA, and Release Gates | Full-Stack / Stabilization | High | Phases 1-4 |

---

## Master Dependency Graph

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                         PHASE 0                          │
                    │  Scope, Blast Radius, and Migration Guardrails           │
                    │  (planning foundation)                                   │
                    └─────────────────────────────┬────────────────────────────┘
                                                  │
                    ┌─────────────────────────────▼────────────────────────────┐
                    │                         PHASE 1                          │
                    │  RBAC and Worker Configuration                           │
                    │  (schema, role, WorkOS, route safety)                    │
                    └───────────────┬───────────────────┬──────────────────────┘
                                    │                   │
                   ┌────────────────▼────────────┐ ┌────▼────────────────────┐
                   │           PHASE 2           │ │          PHASE 3         │
                   │  Mobile Capture + Dedupe    │ │  Aggregates + Reporting │
                   │  (worker mobile path)       │ │  (admin reporting path) │
                   └───────────────┬─────────────┘ └────┬────────────────────┘
                                   │                    │
                                   │       ┌────────────▼────────────┐
                                   │       │        PHASE 4          │
                                   └──────►│  Audit Matching Hooks   │
                                           │  (Slack + Calendly)     │
                                           └────────────┬────────────┘
                                                        │
                    ┌───────────────────────────────────▼──────────────────────┐
                    │                         PHASE 5                          │
                    │  Corrections, Full QA, Release Gates                     │
                    │  (stabilization and rollout)                             │
                    └──────────────────────────────────────────────────────────┘
```

**Important dependency nuance:** Phase 4 backend helpers can start after Phase 1 because the audit tables exist. The arrow from Phase 2 to Phase 4 represents realistic QA data and end-to-end validation, not a hard compile dependency.

---

## Maximum Parallelism Windows

### Window 1: Foundation Lock (Phase 0, Mostly Sequential)

**Concurrency:** Up to 3 planning streams after the scope/migration guardrails are drafted.

Phase 0 establishes what is allowed to change. The migration guardrails and forbidden-change register must be written first. WorkOS/RBAC inventory, route-shell audit, and QA matrix can then run in parallel because they inspect different systems.

```
Timeline: ███████████

0A Scope lock ───────┬─────────────────────────────────────────┐
0B Migration plan ───┘                                         │
                                                               ├── 0F Execution gates
0C WorkOS/RBAC inventory ──────────────────────────────────────┤
0D Route/shell audit ──────────────────────────────────────────┤
0E QA matrix ─────────────────────────────────────────────────┘
```

**Internal parallelism:**
```
0A + 0B ──→ 0C
         ├→ 0D
         └→ 0E

0C + 0D + 0E ──→ 0F
```

---

### Window 2: Foundation Implementation (Phase 1)

**Concurrency:** Up to 4 streams after schema/codegen.

Phase 1 is the implementation bottleneck because all later phases depend on the widened role union, new tables, permission literals, WorkOS lifecycle sync, and route fallback behavior. After `convex/schema.ts` is widened and generated types exist, backend auth, WorkOS sync, worker settings functions, and route-shell safety can run simultaneously.

```
Timeline:        █████████████████████████████████

1A Schema/types ─────┬── 1B Permissions/auth fallback ──────┐
                     ├── 1C WorkOS lifecycle sync ─────────┤
                     ├── 1D Worker/settings functions ─────┤── 1F Admin config UI ──→ 1G Gate
                     └── 1E Route/nav/command safety ──────┘
```

**Why independent:**

- 1B owns `convex/lib/*` and `lib/auth.ts`.
- 1C owns WorkOS lifecycle files and the worker sync helper.
- 1D owns Lead Gen worker/settings functions.
- 1E owns workspace shell, landing redirect, command palette, and breadcrumbs.
- 1F waits for the contracts from 1B/1D to avoid building against stubs.

---

### Window 3: Maximum Feature Parallelism (Phases 2, 3, and 4)

**Concurrency:** 3 phase streams plus internal subphase parallelism.

After Phase 1, the feature splits cleanly by ownership:

- Phase 2 owns worker capture and own-activity routes/functions.
- Phase 3 owns aggregate/reporting/export functions and admin reporting UI.
- Phase 4 owns Slack/Calendly audit integration files and optional audit display surfaces.

```
Timeline:                         ███████████████████████████████████████████

Phase 2 Mobile Capture ────────────────┬──────────────────────────────┐
Phase 3 Reporting/Aggregates ─────┬────┘                              ├── Phase 5
Phase 4 Audit Matching ───────────┴───────────────────────────────────┘
```

**Within Phase 2:**
```
2A Normalization ─────┬── 2B Capture mutation ─────┐
                      │                            ├── 2D Capture UI ─────┐
3A Aggregates ────────┘                            │                      ├── 2F QA
2C Activity queries ───────────────────────────────┴── 2E Activity UI ────┘
```

**Within Phase 3:**
```
3A Aggregate helpers ─────┬── 3B Reporting queries ──────┐
                          ├── 3C Export DTOs/CSV ────────┤
                          └── 3D Reconciliation audit ───┤── 3E Dashboard UI ──→ 3F Gate
Phase 2 capture writes ──────────────────────────────────┘
```

**Within Phase 4:**
```
4A Audit helper ─────┬── 4B Slack hook ─────────────┐
                     ├── 4C Calendly preservation ─┤
                     └── 4D Audit queries ─────────┤── 4E Optional UI ──→ 4F Gate
Phase 2 seed data ─────────────────────────────────┘
```

**Why independent:**

- Phase 2 does not edit Slack/Calendly files.
- Phase 3 does not edit capture UI except through helper imports.
- Phase 4 does not edit reporting or capture files.
- The only cross-phase function dependency is Phase 2B importing Phase 3A aggregate helpers.

---

### Window 4: Stabilization and Release (Phase 5)

**Concurrency:** Up to 3 internal streams after correction mutation semantics are stable.

Phase 5 is mostly sequential because it validates the combined feature, but correction UI, reconciliation repair, and security/export hardening can run together once 5A defines the correction contract.

```
Timeline:                                                     ███████████████████████

5A Corrections/deltas ─────┬── 5B Correction UI ─────────────┐
                           ├── 5C Reconciliation repair ─────┤
                           └── 5D Security/export hardening ─┤── 5E Full QA ──→ 5F Release
```

---

## Critical Path Analysis

The longest sequential chain determining minimum delivery time is:

```
Phase 0 → Phase 1 → Phase 3A → Phase 2B → Phase 2D → Phase 5A → Phase 5E → Phase 5F
  │          │          │          │          │          │          │          │
  │          │          │          │          │          │          │          └── Release checklist/backout
  │          │          │          │          │          │          └── Full cross-system QA
  │          │          │          │          │          └── Correction/delta contract
  │          │          │          │          └── Worker mobile capture UX
  │          │          │          └── Transactional capture write path
  │          │          └── Aggregate helpers needed by capture
  │          └── Schema, role, WorkOS, and route safety foundation
  └── Scope and migration guardrails
```

**Alternative shorter path:**
```
Phase 0 → Phase 1 → Phase 4A → Phase 4B/4C → Phase 4F
```

This path is shorter because audit matching hooks can be implemented after the schema exists, but their meaningful QA waits for Phase 2 seed capture data.

**Implication:** Start Phase 3A immediately after Phase 1. It unblocks the final capture mutation contract and therefore sits on the critical path even though most Phase 3 dashboard work can continue in parallel.

---

## File Ownership Boundaries

| Directory/File | Phase Owner | Notes |
|---|---|---|
| `plans/lead-gen-ops/phases/*` | Phase 0 | Planning artifacts and release checklist updates. |
| `convex/schema.ts` | Phase 1 only | All Lead Gen table additions and `users.role` widening happen in one schema phase. |
| `convex/leadGen/validators.ts` | Phase 1 creates, Phase 2 extends | Phase 2 may add submit-specific validator exports only. |
| `convex/lib/roleMapping.ts` | Phase 1 only | Role mapping must stabilize before WorkOS and routes. |
| `convex/lib/permissions.ts` | Phase 1 only | Lead Gen permission literals added once. |
| `lib/auth.ts` | Phase 1 only | Adds `requirePermission()` and role fallback. Later phases consume it. |
| `convex/workos/userManagement.ts` | Phase 1 only | WorkOS invite/role/remove lifecycle. |
| `convex/workos/userMutations.ts` | Phase 1 only | CRM user lifecycle and worker profile sync. |
| `convex/leadGen/workers.ts` | Phase 1 owns | Worker/team/schedule config. Later phases read IDs only. |
| `convex/leadGen/settings.ts` | Phase 1 owns | Tenant settings. Phase 5 may read settings if edit windows are added. |
| `app/workspace/page.tsx` | Phase 1 only | Role-specific workspace landing redirect. |
| `app/workspace/_components/workspace-shell-client.tsx` | Phase 1 only | Sidebar/home/shortcut role branches. |
| `components/command-palette.tsx` | Phase 1 only | Lead Gen command set and action filtering. |
| `components/workspace-breadcrumbs.tsx` | Phase 1 only | Lead Gen labels. |
| `app/workspace/team/_components/invite-user-dialog.tsx` | Phase 1 only | Expose Lead Generator role. |
| `app/workspace/team/_components/role-edit-dialog.tsx` | Phase 1 only | Expose Lead Generator role. |
| `convex/leadGen/normalization.ts` | Phase 2 only | Capture normalization and origin parsing. |
| `convex/leadGen/capture.ts` | Phase 2 only | Capture mutation. Imports Phase 3 aggregate helpers. |
| `convex/leadGen/activity.ts` | Phase 2 only | Worker own-activity queries. |
| `app/workspace/lead-gen/capture/**` | Phase 2 only | Worker mobile capture route. |
| `app/workspace/lead-gen/my-activity/**` | Phase 2 only | Worker own-activity route. |
| `convex/leadGen/aggregates.ts` | Phase 3 creates, Phase 5 extends | Phase 5 adds delta helpers; avoid changing capture contract. |
| `convex/leadGen/reporting.ts` | Phase 3 only | Admin report queries. |
| `convex/leadGen/exports.ts` | Phase 3 only | Export DTO queries. |
| `lib/csv.ts` | Phase 3 creates, Phase 5 verifies | Shared CSV serialization and hardening. |
| `convex/leadGen/reconciliation.ts` | Phase 3 creates, Phase 5 extends | Phase 3 audit, Phase 5 repair/marker. |
| `app/workspace/lead-gen/page.tsx` | Phase 3 only | Admin dashboard route. |
| `app/workspace/lead-gen/_components/lead-gen-admin-*` | Phase 3 only | Dashboard client/skeleton. |
| `app/workspace/lead-gen/_components/*table.tsx` | Phase 3/4/5 by filename | Worker/top-origin tables Phase 3; prospects Phase 4; raw/correction Phase 5. |
| `convex/leadGen/auditMatching.ts` | Phase 4 only | Internal audit match and Calendly preservation helper. |
| `convex/slack/createQualifiedLead.ts` | Phase 4 only | Only post-success audit scheduler hook. |
| `convex/pipeline/inviteeCreated.ts` | Phase 4 only | Only existing-match preservation in Slack-qualified scheduling branch. |
| `convex/leadGen/auditQueries.ts` | Phase 4 only | Optional read-only audit display queries. |
| `app/workspace/lead-gen/prospects/**` | Phase 4 creates, Phase 5 may add correction action | Admin audit display. |
| `convex/leadGen/corrections.ts` | Phase 5 only | Admin correction mutations. |
| `app/workspace/lead-gen/_components/void-submission-dialog.tsx` | Phase 5 only | Admin correction UI. |
| `plans/lead-gen-ops/phases/release-checklist.md` | Phase 5 | Final release and backout checklist. |

---

## Recommended Execution Strategies

### Solo Developer

Execute in order while batching related contexts:

1. Phase 0 planning artifacts.
2. Phase 1A schema/codegen.
3. Phase 1B/1C/1D backend auth and WorkOS work.
4. Phase 1E/1F frontend route/nav/team UI.
5. Phase 3A aggregate helpers.
6. Phase 2 backend capture/activity.
7. Phase 2 frontend capture/activity.
8. Phase 3 reporting/export backend.
9. Phase 3 dashboard frontend.
10. Phase 4 audit matching hooks and optional display.
11. Phase 5 corrections, QA, and release checklist.

**Estimated total time:** 9-12 focused days.

### Two Developers

| Sprint | Developer A | Developer B |
|---|---|---|
| 1 | Phase 0 + Phase 1A schema | Phase 0 QA/route inventory + prepare UI references |
| 2 | Phase 1B/1C WorkOS/auth | Phase 1E/1F route/nav/team UI after types land |
| 3 | Phase 3A aggregates + Phase 2B capture | Phase 2D/2E mobile UI with function contracts |
| 4 | Phase 3B/3C/3D reporting/export backend | Phase 3E dashboard UI |
| 5 | Phase 4A/4B/4C Slack/Calendly hooks | Phase 4D/4E optional audit display |
| 6 | Phase 5A/5C corrections/reconciliation | Phase 5B/5D/5E UI and QA |
| 7 | Release gate, production smoke, backout notes | Release gate, browser screenshots, regression signoff |

**Estimated total time:** 6-8 focused days.

### Three+ Developers / Agents

| Sprint | Agent A — Foundation/Backend | Agent B — Capture/Reporting Backend | Agent C — Frontend/QA |
|---|---|---|---|
| 1 | Phase 0 + Phase 1A schema | Phase 0 migration/QA checks | Phase 0 route/UX inventory |
| 2 | Phase 1B/1C WorkOS/auth | Phase 1D worker/settings functions | Phase 1E/1F nav/team UI |
| 3 | Phase 3A aggregates | Phase 2A/2B capture mutation | Phase 2D/2E capture/activity UI |
| 4 | Phase 4A/4B/4C audit hooks | Phase 3B/3C/3D reporting/export | Phase 3E admin dashboard |
| 5 | Phase 5A/5C corrections/repair | Phase 4D audit queries + integration support | Phase 4E/5B audit/correction UI |
| 6 | Slack/Calendly regression QA | Aggregate/export reconciliation QA | Browser/mobile/desktop QA |
| 7 | Release checklist and backout | Production smoke support | Final UX/accessibility pass |

**Estimated total time:** 5-6 focused days, assuming strict file ownership and daily integration.

---

## Quality Gates

| Gate | Trigger | Checks |
|---|---|---|
| **Gate 0 — Scope Lock** | After Phase 0 | WorkOS role checklist exists; migration notes classify rollout; forbidden-change checklist accepted; QA matrix created. |
| **Gate 1 — Schema/Auth Foundation** | After Phase 1 | `npx convex dev --once`; `pnpm tsc --noEmit`; invite `lead_generator` in dev; `/workspace` role redirects; command palette does not expose CRM actions to workers. |
| **Gate 2 — Capture Contract** | After Phase 2B + Phase 3A | New capture writes Lead Gen rows only; duplicate retry idempotency works; same handle reuses prospect; daily/origin aggregates update. |
| **Gate 3 — Worker UX** | After Phase 2 | Mobile capture viewport QA; my-activity pagination; closer/admin direct-call authorization failures verified. |
| **Gate 4 — Reporting/Export** | After Phase 3 | Aggregate totals reconcile to raw rows; exports are date-bounded; CSV hardening passes hostile values; dashboard desktop/tablet QA passes. |
| **Gate 5 — Audit Hooks** | After Phase 4 | Slack created/duplicate/already-booked regressions; Calendly Slack-join/cold-booking regressions; no `leadGenProspects` lookup in Calendly pipeline. |
| **Gate 6 — Corrections** | After Phase 5A/5B | Void writes correction event; aggregate delta or reconciliation marker works; destructive dialog requires reason and is admin-only. |
| **Gate 7 — Release** | End of Phase 5 | `pnpm tsc --noEmit`; `pnpm lint`; full QA matrix; mobile/desktop browser screenshots; release checklist and backout notes complete. |

---

## Risk Mitigation

| Risk | Impact | Mitigation Strategy |
|---|---|---|
| `lead_generator` falls through to closer UI/routes | Critical | Phase 1 owns `/workspace`, shell nav, command palette, shortcuts, breadcrumbs, and `requireRole()` fallback before invites are enabled. |
| Convex schema change becomes a real migration | Critical | Keep MVP widen-only. Invoke `convex-migration-helper` if existing documents need required fields, conversions, or backfills. |
| WorkOS role slug missing in production | High | Gate 0/1 require external role setup before invite UI rollout. Invite action errors remain visible to admins. |
| Lead Gen capture creates CRM funnel records | Critical | Static `rg` gate for writes to `leads`/`opportunities` inside `convex/leadGen`; design forbids this path. |
| Capture write contention on popular duplicate handles | Medium | Use tenant/dedupe index and Convex OCC; run performance audit after seed data; consider future split counters if measured conflicts appear. |
| Reporting scans raw submissions | High | Dashboard uses aggregate tables; raw submissions are paginated/detail/export only with row limits. |
| Scheduled hours double-count across sources | High | Report queries dedupe scheduled hours by `(workerId, dayKey)` when aggregating across source rows. |
| CSV formula injection | High | Shared CSV helper formula-hardens before quote escaping; QA uses hostile values. |
| Slack ACK/modal behavior regresses | Critical | Phase 4 hook is only in post-success qualification logic; re-run existing Slack QA before release. |
| Calendly cold bookings get Lead Gen matches | Critical | Phase 4 forbids `leadGenProspects` lookup in `inviteeCreated`; static `rg` gate checks this. |
| Correction deltas drift aggregates | High | Insert correction events, apply safe deltas only when provable, otherwise mark range for reconciliation. |
| Parallel agents edit shared files | Medium | File ownership table is authoritative; contested files (`schema.ts`, shell, WorkOS actions, Slack/Calendly files) have one phase owner. |

---

## Applicable Skills Per Phase

| Phase | Skills to Invoke | Reason |
|---|---|---|
| **0** | `convex-migration-helper`, `workos`, `next-best-practices`, `frontend-design`, `web-design-guidelines` | Migration classification, WorkOS role preflight, route/UX guardrails, QA matrix. |
| **1** | `convex`, `convex-migration-helper`, `workos`, `convex-dev-workos-authkit`, `next-best-practices`, `shadcn`, `frontend-design` | Schema/role widening, WorkOS lifecycle, route gates, admin config UI. |
| **2** | `convex`, `convex-performance-audit`, `next-best-practices`, `shadcn`, `frontend-design`, `web-design-guidelines`, `playwright`/`browser:browser` | Capture mutation, mobile UX, own-activity, idempotency, mobile QA. |
| **3** | `convex`, `convex-performance-audit`, `next-best-practices`, `vercel-react-best-practices`, `shadcn`, `frontend-design`, `web-design-guidelines` | Aggregate reporting, exports, dashboard performance, desktop UI. |
| **4** | `convex`, `convex-performance-audit`, `next-best-practices`, `shadcn`, `frontend-design`, `web-design-guidelines` | Audit matching, Slack/Calendly integration, optional traceability UI. |
| **5** | `convex`, `convex-migration-helper`, `convex-performance-audit`, `next-best-practices`, `shadcn`, `frontend-design`, `web-design-guidelines`, `playwright`/`browser:browser` | Corrections, reconciliation, final QA, release/backout. |

---

## Parallel Execution Rules

1. Do not expose `lead_generator` invites until Phase 1 route/nav gate passes.
2. Do not let later phases modify `convex/schema.ts`; all table/index changes are Phase 1-owned unless a new migration plan is approved.
3. Phase 2 may import Phase 3 aggregate helpers, but Phase 3 must not rewrite `convex/leadGen/capture.ts`.
4. Phase 4 may edit only `convex/slack/createQualifiedLead.ts` and `convex/pipeline/inviteeCreated.ts` among existing integration files.
5. Phase 5 may extend aggregate/reconciliation helpers but must not change the capture write contract without re-running Phase 2 and Phase 3 QA.
6. Every phase ends with `pnpm tsc --noEmit`; phases touching Convex schema/functions also run `npx convex dev --once`.
7. Browser QA is mandatory after frontend phases, with mobile capture and desktop admin screenshots.
