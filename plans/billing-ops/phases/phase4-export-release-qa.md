# Phase 4 Export and Release QA — Billing Ops

Run this after Phases 1-4 are implemented and before manually enabling Billing
Ops for the production test tenant.

## Access and Navigation

- Billing sidebar item is hidden while `billingOpsEnabled !== true`.
- Command palette Billing entry is hidden while `billingOpsEnabled !== true`.
- Direct Billing route while disabled renders the unavailable state.
- After manual enablement, tenant owners/admins see Billing in sidebar and
  command palette.
- Closers and lead generators cannot access Billing routes or Convex functions.

## Copy and CSV Export

- Focused copy payload includes payment, customer, attribution, source id,
  review, and contributor summary fields.
- Single-payment copy writes no audit row in MVP.
- CSV export uses the same queue filters visible in the UI.
- CSV export caps at 1,000 rows and reports truncation when exact count exceeds
  the cap.
- CSV contains `Has Proof File` only; no proof URL or storage id columns.
- CSV cells beginning with `=`, `+`, `-`, `@`, tab, or carriage return are
  hardened by `serializeCsv`.
- Every CSV download writes exactly one `billingExportEvents` row with
  server-derived tenant and actor ids, normalized filters, exact count,
  exported count, truncation state, and timestamp.

## Static Verification

- `pnpm exec convex codegen` passes after the Billing aggregate components and
  functions are registered.
- `pnpm tsc --noEmit` passes.
- Targeted ESLint passes for Billing Ops, auth/nav gating, command palette,
  tenant flag propagation, and CSV helpers:

```bash
pnpm exec eslint app/workspace/billing \
  app/workspace/_components/workspace-auth.tsx \
  app/workspace/_components/workspace-shell-client.tsx \
  app/workspace/_components/workspace-shell.tsx \
  components/command-palette.tsx \
  convex/billing convex/admin/billingOps.ts convex/lib/permissions.ts \
  convex/tenants.ts lib/auth.ts lib/csv.ts
```

Full-repo `pnpm lint` is currently blocked by pre-existing non-Billing errors
in generated/skill files and older unrelated React hook lint violations.
Browser/Playwright verification is operator-owned for this release gate.

## Final Enablement Order

| Gate | Required Evidence |
|---|---|
| Widen deployed | Convex schema/components deploy cleanly. |
| Hooks active | New payment inserts update Billing counts without re-backfill. |
| Backfill complete | Backfill reports no more scheduled batches. |
| Readiness passed | Latest `billingOpsReadinessChecks.status` is `passed`. |
| Review QA passed | Phase 2 checklist is complete. |
| Correction QA passed | Phase 3 checklist is complete. |
| Export QA passed | This checklist is complete. |
| Manual enable | System admin explicitly sets `billingOpsEnabled = true`. |

Rollback remains setting `billingOpsEnabled = false`; do not remove widened
schema or audit rows for ordinary release reversal.
