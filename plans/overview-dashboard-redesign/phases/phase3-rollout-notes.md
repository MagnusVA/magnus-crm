# Overview Dashboard Redesign - Rollout Notes

**Decision:** Hold pending authenticated browser QA  
**Date:** 2026-06-01  
**Branch/Commit:** feature/team-member-avatars / 984ea3d

## Ship Criteria

| Criterion | Status | Notes |
|---|---|---|
| Static validation green | Partial | Convex validation, TypeScript, targeted eslint, and build pass. Repo-wide `pnpm lint` is blocked by existing unrelated lint errors. |
| Role/range QA complete | Pending | Requires authenticated tenant sessions. |
| Convex logs/insights acceptable | Pass | No overview query auth/transaction/read errors observed. Insights showed OCC retry warnings on existing write paths, not the overview read. |
| Browser desktop/mobile acceptable | Blocked | In-app Browser and Chrome automation both reported no available browser targets in this session. |
| No schema/data migration introduced | Pass | `convex/schema.ts` was not changed for this implementation. |

## Backout Path

1. Revert the `/workspace` dashboard client and overview component changes.
2. Leave Phase 1 helper extraction only if existing lead-gen and Slack report parity is verified.
3. If helper extraction is suspect, revert the Phase 1 backend changes as one unit.
4. Confirm `/workspace` returns to the previous dashboard and `pnpm tsc --noEmit` passes.

## Follow-Ups

| Follow-up | Trigger | Owner | Migration Required |
|---|---|---|---|
| Split overview into section queries | Composed query too heavy | Assign during rollout | No |
| Daily DM closer rollup | Normal Month ranges hit operations cap | Assign during rollout | Yes |
| Exact Honduras operations rollups | Product requires 1am parity | Assign during rollout | Yes |

## Migration Escalation Triggers

- Add `dmCloserDailyStats` only if normal Month or Custom ranges frequently cap operations-backed sections.
- Add or change indexes only after confirming the existing tenant/day indexes cannot support the MVP read pattern.
- Migrate operations rollups to Honduras business-day boundaries only if product accepts the changed semantics and rollout plan.
