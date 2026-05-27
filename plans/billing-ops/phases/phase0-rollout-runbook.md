# Phase 0 Rollout Runbook — Billing Ops

**Scope:** Phase 0 only. Billing Ops remains disabled for every tenant until the full MVP release gate passes.

## 1. Pre-Deploy Product Signoff

- Confirm product accepts `paymentRecords.status = "verified"` as "billing reviewed" for MVP.
- If rejected, stop this branch and implement the dedicated billing review fields from design section 10.8 before Phase 1.
- Confirm external billing IDs are not stored in MVP.

## 2. Widen-Only Schema Deploy

- Deploy optional/new schema only:
  - `tenants.billingOpsEnabled?: boolean`
  - Billing payment filter indexes
  - Slack contributor timeline index
  - `billingExportEvents`
  - `billingOpsReadinessChecks`
  - Billing aggregate component registrations
- Do not create any workspace route, nav item, command palette item, or public queue query during Phase 0.
- Treat missing or false `billingOpsEnabled` as disabled everywhere.

## 3. Generated Convex Type Verification

Run after the widen commit is in place:

```bash
pnpm exec convex codegen
pnpm tsc --noEmit
```

Expected evidence:

- Generated component references include:
  - `billingPaymentsByStatus`
  - `billingPaymentsByStatusProgram`
  - `billingPaymentsByStatusType`
  - `billingPaymentsByStatusProgramType`
- Typecheck passes.

## 4. Billing Aggregate Backfill

Run for the production test tenant only. Use `reset: true` for a clean replay.

```bash
pnpm exec convex run internal.billing.backfill.backfillBillingPaymentAggregates \
  '{"tenantId":"<tenantId>","reset":true}'
```

If the response returns `hasMore: true`, wait for scheduled batches to finish. Record the final `completedAt` value as `aggregateBackfilledAt`.

Do not enable Billing Ops from the backfill.

## 5. Readiness Verification Matrix

Run the system-admin readiness mutation after backfill:

```bash
pnpm exec convex run admin.billingOps.verifyBillingOpsReadiness \
  '{"tenantId":"<tenantId>","aggregateBackfilledAt":<completedAt>,"verifiedSemanticsAccepted":true}'
```

The verification records pass/fail metadata in `billingOpsReadinessChecks`.

Count checks include:

| Status | Program | Type | Date Bounds |
|---|---|---|---|
| `recorded`, `verified`, `disputed` | none | none | all-time |
| `recorded`, `verified`, `disputed` | none | none | last 90 days |
| `recorded`, `verified`, `disputed` | each tenant program | none | all-time |
| `recorded`, `verified`, `disputed` | none | each payment type | last 90 days |
| `recorded`, `verified`, `disputed` | each tenant program | each payment type | last 90 days |

Readiness must fail if:

- Product has not accepted `verified === billing reviewed`.
- Aggregate backfill timestamp is missing.
- Recent sampled payments have unresolved `recordedByUserId` or `programId`.
- Any aggregate count differs from the matching indexed bounded table check.
- Any table count check is truncated.

## 6. Enablement Refusal Checks

Before any MVP route work is enabled, verify refusal behavior:

```bash
pnpm exec convex run admin.billingOps.setBillingOpsEnabled \
  '{"tenantId":"<tenantId>","enabled":true}'
```

Expected behavior:

- Fails if the latest readiness check is absent.
- Fails if the latest readiness check failed.
- Fails if the latest passing readiness row was manually recorded instead of produced by `verifyBillingOpsReadiness`.
- Fails if the latest passing readiness check has no `aggregateBackfilledAt`.
- Succeeds only after the latest readiness check passed after the backfill timestamp.

For Phase 0, leave the tenant disabled after testing:

```bash
pnpm exec convex run admin.billingOps.setBillingOpsEnabled \
  '{"tenantId":"<tenantId>","enabled":false}'
```

## 7. Rollback Plan

- Set `tenants.billingOpsEnabled` to false for any tenant that was temporarily enabled during manual testing.
- Leave widened schema, indexes, aggregate components, and readiness records in place.
- If aggregate data must be rebuilt, rerun the backfill with `reset: true`.
- Do not delete readiness or export audit tables during rollback.

## 8. MVP Enablement Sequence

Do not enable Billing Ops just because Phase 0 readiness passes. Enable only
after the complete MVP gate is done:

1. Phase 2 review QA passes.
2. Phase 3 correction QA passes.
3. Phase 4 export and release QA passes.
4. Latest automated readiness check is still `passed` and was recorded after
   the aggregate backfill.
5. System admin explicitly runs:

```bash
pnpm exec convex run admin.billingOps.setBillingOpsEnabled \
  '{"tenantId":"<tenantId>","enabled":true}'
```

To revoke access, set the flag back to false. Do not roll back schema for an
ordinary release reversal.

## 9. Phase 0 Exit Evidence

Record:

- Product signoff timestamp and owner.
- Widen deploy commit.
- `pnpm exec convex codegen` result.
- `pnpm tsc --noEmit` result.
- Backfill `completedAt`.
- Readiness check id and status.
- Enablement refusal check result.
- Confirmation that all tenants have `billingOpsEnabled !== true`.
