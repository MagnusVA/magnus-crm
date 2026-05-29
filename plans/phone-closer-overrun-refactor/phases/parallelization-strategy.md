# Parallelization Strategy - Phone Closer Overrun Refactor

**Purpose:** Define safe execution order, concurrency windows, file ownership boundaries, deploy points, and manual gates for the six implementation phases.

**Prerequisite:** The design in `plans/phone-closer-overrun-refactor/phone-closer-overrun-refactor-design.md` is accepted. Production has one test tenant, so data cleanup and schema narrow are treated as controlled production operations.

---

## Phase Overview

| Phase | Name | Type | Deploy | Backfill / Migration | Dependencies |
|---|---|---|---|---|---|
| 1 | Outcome Contract and Status Machine | Backend | Yes | No | Design accepted |
| 2 | Stop Producing Legacy Backend Data | Backend | Yes | No | Phase 1 deployed |
| 3 | Join Link and Direct Outcomes | Frontend / Full-Stack | Yes | No | Phase 2 backend contracts |
| 4 | Reporting Simplification | Backend / Frontend | Yes | No direct migration | Phase 2; coordinate with Phase 3 nav |
| 5 | Data Cleanup | Migration / Manual | Yes, temp code | Yes | Phases 2-4 deployed |
| 6 | Schema Narrow | Schema / Cleanup | Yes | No new migration | Phase 5 hard verification |

---

## Master Dependency Graph

```
+------------------------------------------------------------+
| Phase 1                                                    |
| Status contract + outcome eligibility, schema still wide   |
+-----------------------------+------------------------------+
                              |
+-----------------------------v------------------------------+
| Phase 2                                                    |
| Backend stops producing overran/timing/in_progress data    |
+--------------+-------------------------------+-------------+
               |                               |
+--------------v--------------+   +------------v-------------+
| Phase 3                     |   | Phase 4                  |
| Join/direct outcome UI      |   | Reporting simplification |
+--------------+--------------+   +------------+-------------+
               |                               |
               +---------------+---------------+
                               |
+------------------------------v-----------------------------+
| Phase 5                                                    |
| Production cleanup: statuses, fields, projections, reviews |
+------------------------------+-----------------------------+
                               |
+------------------------------v-----------------------------+
| Phase 6                                                    |
| Schema narrow + delete temporary and legacy code           |
+------------------------------------------------------------+
```

---

## Concurrency Windows

### Window 1: Phase 1 Foundation

**Concurrency:** Low. 1A status maps and 1B eligibility helper can run together, but the phase deploy is a single backend contract gate.

**Do not parallelize with:** Phase 2 implementation that assumes scheduled outcome transitions until Phase 1 is merged/deployed.

### Window 2: Phase 2 Backend Split

**Concurrency:** Medium after 2B helper is available.

Safe split:

- 2A owns scheduler shutoff, cron removal, `inviteeCreated`, and the no-op shim.
- 2B owns `convex/lib/meetingOutcomeCompletion.ts`.
- 2C owns payment/no-show/lost mutation changes.
- 2D owns follow-up/admin meeting-id contracts.
- 2E owns pipeline cancel/no-show and side-deal/admin-resolve cleanup.

**Shared-file caution:** `convex/admin/meetingActions.ts` is touched by 2C, 2D, and 2E. Assign one implementer or sequence patches in that file.

### Window 3: Phase 3 and Phase 4 Parallel Work

**Concurrency:** High after Phase 2 deploys.

Phase 3 and Phase 4 can overlap if shared navigation/report files are assigned clearly:

- Phase 3 owns closer meeting detail, admin meeting action bar, `/workspace/reviews`, and operational review nav.
- Phase 4 owns report routes, report cards/tables, status filters/charts, and PostHog reporting notes.

**Shared-file caution:** `app/workspace/_components/workspace-shell-client.tsx` and `components/command-palette.tsx` can be touched by both phases. Coordinate ownership before editing.

### Window 4: Phase 5 Cleanup

**Concurrency:** None for production operations.

Implementation of migration helpers and audit queries can be reviewed in parallel, but production commands must run sequentially:

1. Deploy temp migration/audit code.
2. Dry-run every migration.
3. Run migrations in order.
4. Watch migration status.
5. Run hard audits.
6. Repeat targeted repair until clean.

### Window 5: Phase 6 Narrow

**Concurrency:** Low.

Schema/validator edits should happen first. Then backend and frontend cleanup can split, using TypeScript errors and grep as the work queue. Final deploy is sequential and blocked by Phase 5 verification.

---

## Critical Path

```
Phase 1 deploy
  -> Phase 2 deploy
  -> Phase 3 + Phase 4 deploys
  -> Phase 5 production cleanup and verification
  -> Phase 6 schema narrow deploy
```

The true critical path is not code volume; it is the migration safety sequence. Phase 6 must not start early, even if the branch compiles locally, because Convex schema validation checks production data at deploy time.

---

## Manual Gates

| Gate | Must pass before | Required evidence |
|---|---|---|
| Phase 1 deploy | Phase 2 starts | `scheduled` can transition to direct outcomes; schema still wide |
| Phase 2 deploy | Phase 5 cleanup | New meetings have no `attendanceCheckId`; no new legacy writers |
| Phase 3 QA | Phase 5 cleanup | Join is passive; direct outcomes work for closer/admin |
| Phase 4 QA | Phase 5 cleanup | Reports no longer read review/time buckets |
| Phase 5 verification | Phase 6 start | All audit counters zero; aggregates clean; no reviews/jobs |
| Phase 6 deploy | Completion | Narrowed schema deploys and post-deploy smoke checks pass |

---

## File Ownership Boundaries

| Area | Primary Phase | Notes |
|---|---|---|
| `convex/lib/statusTransitions.ts` | 1, 6 | Phase 1 widens behavior; Phase 6 narrows literals |
| `convex/pipeline/inviteeCreated.ts` | 2 | Remove all attendance-check scheduling sites |
| `convex/closer/* outcome mutations` | 2 | Backend direct outcomes |
| `app/workspace/closer/meetings/**` | 3 | Meeting detail and action UI |
| `app/workspace/pipeline/meetings/**` | 3 | Admin parity |
| `app/workspace/reports/**` | 4 | Report route/card/table cleanup |
| `convex/reporting/**` | 4, 5, 6 | Formulas first, then aggregate repair, then final deletes |
| `convex/migrations/**`, `convex/audits/**` | 5, 6 | Temporary code; delete in Phase 6 |
| `convex/schema.ts` | 6 | Narrow only after Phase 5 verification |

---

## Rollback Principles

- Phase 1 rollback: restore old transition maps; no data impact.
- Phase 2 rollback: can restore old backend behavior, but avoid rescheduling attendance checks unless product explicitly reverses the refactor.
- Phase 3/4 rollback: UI/report rollback only; backend remains source of truth.
- Phase 5 rollback: do not "undo" cleanup by fabricating legacy statuses. If evidence precedence was wrong, apply a corrective forward migration to the intended final status.
- Phase 6 rollback: if schema deploy fails, return to Phase 5 cleanup. If deploy succeeds and later issues appear, restore code behavior forward using the narrowed schema; do not reintroduce removed literals without a new migration design.
