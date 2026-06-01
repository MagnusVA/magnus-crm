# Overview efficiency schedules — brainstorm notes

## Status (2026-06-01)

Phases 0–3 are implemented and verified working in dev: schedule tables, admin settings tab, and overview top cards ranked by per-hour efficiency with bounded reads.

## This is not the final solution

Treat the current implementation as an **MVP / interim architecture**, not the long-term design. Ship it to unblock admins and efficiency-ranked overview cards, but plan a follow-up pass before calling the feature “done.”

### Known limitations and likely follow-ups

| Area | MVP today | Likely “final” direction |
|------|-----------|---------------------------|
| Schedule storage | Three actor-specific tables (`leadGenWorkerSchedules`, `slackQualifierSchedules`, `dmCloserSchedules`) | Possible unified work-schedule model or master table; avoid duplicating weekday/hour CRUD forever |
| Denominator | Read-time sum of weekly rows over business dates (no per-day buckets) | May need precomputed buckets or snapshots if ranges/getOverviewDashboard cost grows |
| Top DM closers | Bounded `meetings` scan by `createdAt`, exclude `follow_up` | Dedicated aggregate keyed by `dmCloserId` + `createdAt` if scan hits caps in production |
| Top qualifiers | `slackQualificationsByUser` aggregate + bounded event ledger for secondary fields | Tighter single-path counting; less dual aggregate + ledger |
| Lead Gen reports | Quantity-first sort unchanged | Product may want efficiency-first exports later (explicit decision) |
| Overview UI | Top 5 + minimal card copy on DM closers | Phase 4 expanded leaderboards, Phase 5 copy/tooltips/rollout gate |
| Rollout | Efficiency ranking live once schedules exist | Formal schedule-coverage gate and null-rate messaging (Phase 5) |

### Do not over-commit in later phases

- Phase 4–5 should **reuse** `overviewLeaderboardBuilders` and `rangeHours`—not fork ranking logic.
- Do not add per-day schedule bucket tables, crons, or backfills without a separate design + migration plan.
- Do not change Lead Gen Ops report sort order without explicit product sign-off.

### References

- Design: `plans/overview-efficiency-schedules/overview-efficiency-schedules-design.md`
- Parallelization / blast radius: `plans/overview-efficiency-schedules/phases/parallelization-strategy.md`
- Phase completion notes: `plans/overview-efficiency-schedules/phases/phase0.md` (and phases 2–3 as implemented)
