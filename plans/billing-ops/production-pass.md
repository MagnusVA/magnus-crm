# Billing Ops Production Pass

**Date:** 2026-05-27  
**Scope:** Production deployment plan for Billing Ops MVP from commit `e9611778adf07a4ef4410b3c986885511476db48` (`fastcommit`) plus the Billing Ops plan set.  
**Source docs:** `billing-ops-design.md`, `parallelization-strategy.md`, `phase2-review-qa.md`, `phase3-correction-qa.md`, `phase4-export-release-qa.md`, and `phase0-rollout-runbook.md`.

## Decision

Billing Ops can be deployed to production only as a disabled, tenant-gated feature first. Do not enable any tenant until Convex deploy, app deploy, aggregate backfill, readiness verification, Phase 2 QA, Phase 3 QA, and Phase 4 export/release QA all pass.

The production activation is a manual per-tenant action:

1. Deploy widened schema/functions and Next.js routes.
2. Keep `tenants.billingOpsEnabled !== true`.
3. Backfill Billing aggregate components for the production test tenant.
4. Run automated readiness verification and persist a passing readiness row.
5. Run the manual QA matrices.
6. Manually set `billingOpsEnabled = true` for the test tenant only.

Rollback is setting `billingOpsEnabled = false`. Do not remove widened schema, new tables, aggregate components, readiness rows, or export audit rows for a normal release reversal.

## Current Pass Evidence

Local checks run against the current workspace on 2026-05-27:

| Check | Result | Notes |
|---|---|---|
| `pnpm tsc --noEmit` | Pass | No output. |
| `pnpm exec convex codegen --dry-run --typecheck disable` | Pass | Completed codegen dry-run; no working-tree changes. |
| Targeted ESLint | Pass with warnings | Two `@next/next/no-img-element` warnings in `app/workspace/billing/_components/billing-proof-preview.tsx`. |
| `pnpm build` | Pass | Next.js 16.2.1 production build completed; Billing routes are present as PPR routes. |

Not run in this pass:

- Production Convex deploy.
- Production app deploy.
- Production aggregate backfill.
- Production readiness verification.
- Browser/manual QA against the production test tenant.
- CSV export audit verification in production.

Current working tree warning: there are uncommitted Slack OAuth files outside Billing Ops:

```text
app/api/slack/start/route.ts
convex/lib/slackOAuthState.ts
convex/slack/installations.ts
convex/slack/oauth.ts
convex/slack/oauthStateMutations.ts
```

Before deploying from a local checkout, either commit those changes intentionally or remove/stash them. A local Convex deploy uses the working tree, not just the last commit.

## Pre-Deploy Gates

Do these before any production deploy:

| Gate | Required Result |
|---|---|
| Product semantics | Product accepts `paymentRecords.status = "verified"` as "billing reviewed" for MVP. If not, stop and implement the dedicated review-field migration branch from design section 10.8. |
| Deploy scope | The deploy source is exactly the intended Billing Ops commit plus any explicitly approved follow-up fixes. No accidental dirty files. |
| Tenant target | Identify the single production test tenant `tenantId` and WorkOS org id. Do not bulk-enable tenants. |
| E2E auth env | Production must not set `E2E_AUTH_ENABLED=1`, `TEST_USERS_PASSWORD`, or E2E user email env vars except on an explicitly approved throwaway test deployment. |
| Existing env | Existing production `NEXT_PUBLIC_CONVEX_URL`, WorkOS/AuthKit, Convex, Slack, Calendly, and PostHog env vars are unchanged and present. |
| Phase 5 | Do not add or configure `billing_admin` for this release. MVP uses `tenant_master` and `tenant_admin`. |

## Operator Variables

Use CLI path syntax for Convex functions. For system-admin-only functions, pass an identity whose org claim matches `SYSTEM_ADMIN_ORG_ID`.

```bash
export TARGET_TENANT_ID="<convex tenant id>"
export SYSTEM_ADMIN_IDENTITY='{"subject":"billing-prod-pass","tokenIdentifier":"billing-prod-pass","organization_id":"<SYSTEM_ADMIN_ORG_ID>"}'
```

The `--identity` flag is privileged because it is accepted by the Convex CLI. Run these commands only from a secured operator environment with production deploy access.

## Deploy Order

### 1. Final Local/CI Verification

```bash
pnpm exec convex codegen --dry-run --typecheck disable
pnpm tsc --noEmit
pnpm exec eslint app/workspace/billing \
  app/workspace/_components/workspace-auth.tsx \
  app/workspace/_components/workspace-shell-client.tsx \
  app/workspace/_components/workspace-shell.tsx \
  components/command-palette.tsx \
  convex/billing convex/admin/billingOps.ts convex/lib/permissions.ts \
  convex/tenants.ts lib/auth.ts lib/csv.ts
pnpm build
```

Expected: no TypeScript/build errors. The two proof-preview `<img>` warnings are not blockers for this release.

### 2. Deploy Convex First

Deploy the widened Convex schema, new Billing functions, new indexes, `billingExportEvents`, `billingOpsReadinessChecks`, and aggregate components before deploying the app.

```bash
pnpm exec convex deploy
```

Use the existing production deployment mechanism if CI owns Convex deploys. Confirm no tenant has been enabled by the deploy itself.

```bash
pnpm exec convex run --prod --identity "$SYSTEM_ADMIN_IDENTITY" \
  admin/billingOps:getBillingOpsReadiness \
  '{"tenantId":"<tenantId>"}'
```

Expected:

- `enabled` is `false`.
- `latest` may be absent before the first readiness verification.
- List/detail/export/review/correction Billing functions reject while disabled; only the availability query should return the disabled state.

### 3. Deploy Next.js App

Deploy the app from the same source revision after Convex is live. The app includes:

- `/workspace/billing`
- `/workspace/billing/[paymentRecordId]`
- `/api/testing/auth/login`
- `/api/testing/auth/logout`

Immediately verify test auth is dark in the real production deployment:

```bash
curl -i https://<production-host>/api/testing/auth/login
curl -i https://<production-host>/api/testing/auth/logout
```

Expected: `404` for both routes unless this is an explicitly approved throwaway test deployment.

### 4. Disabled-State Smoke

Before backfill or enablement:

- Sign in as tenant owner/admin for the target tenant.
- Confirm Billing is hidden in the sidebar.
- Confirm Billing is hidden in the command palette.
- Navigate directly to `/workspace/billing`.
- Expected: route renders the controlled unavailable state, not the queue.
- Sign in as closer/lead generator and confirm direct route access is rejected before Billing loads.

## Backfill and Readiness

Run this only after the Convex deploy is live and the app remains disabled.

### 1. Backfill Billing Aggregates

```bash
pnpm exec convex run --prod --typecheck disable --codegen disable \
  billing/backfill:backfillBillingPaymentAggregates \
  '{"tenantId":"<tenantId>","reset":true}'
```

Record:

- command timestamp
- `startedAt`
- `completedAt` if returned
- whether `hasMore` is `false`

If `hasMore` is `true`, wait for scheduled batches to finish before readiness verification. Use Convex logs to confirm the scheduled `billing/backfill:backfillBillingPaymentAggregates` calls stop scheduling more work.

Production gap to handle before enabling if the tenant has more than one batch: the current helper does not persist a backfill status row. If the first command returns `hasMore: true`, either capture completion from logs and record an operator completion timestamp, or add a small persisted backfill-status record before relying on `aggregateBackfilledAt`.

### 2. Verify Readiness

Use an `aggregateBackfilledAt` timestamp that is after the backfill completed and before this verification command.

```bash
pnpm exec convex run --prod --identity "$SYSTEM_ADMIN_IDENTITY" \
  --typecheck disable --codegen disable \
  admin/billingOps:verifyBillingOpsReadiness \
  '{"tenantId":"<tenantId>","aggregateBackfilledAt":<timestamp>,"verifiedSemanticsAccepted":true}'
```

Expected:

- `status` is `passed`.
- `blockers` is empty.
- no aggregate count mismatch
- no truncated table count check
- recent sample has no unresolved registrants or programs

If it fails, leave Billing disabled, fix the data/code issue, rerun backfill if counts could be stale, then rerun readiness.

### 3. Confirm Enablement Refusal Behavior

Before the final enable, prove the gate reads the latest automated readiness row:

```bash
pnpm exec convex run --prod --identity "$SYSTEM_ADMIN_IDENTITY" \
  admin/billingOps:getBillingOpsReadiness \
  '{"tenantId":"<tenantId>"}'
```

Expected:

- `enabled` is `false`.
- `latest.status` is `passed`.
- `latest.summaryJson` has `verificationSource: "automated"`.
- `latest.checkedAt >= latest.aggregateBackfilledAt`.

## Release QA

Run the referenced QA documents against the production test tenant. Capture evidence links, screenshots where useful, and Convex CLI outputs.

### Phase 2 Review QA

Source: `plans/billing-ops/phases/phase2-review-qa.md`

Required:

- Record `recorded` and `verified` counts before review.
- Mark one `recorded` payment reviewed from the focused page.
- Confirm `recorded - 1`, `verified + 1`.
- Confirm revenue/customer summaries do not change.
- Confirm exactly one `payment.verified` event with actor and payment metadata.
- Confirm disabled tenant, closer, lead generator, cross-tenant id, disputed payment, and already-verified cases behave as documented.

### Phase 3 Correction QA

Source: `plans/billing-ops/phases/phase3-correction-qa.md`

Required:

- Run the recorded/verified/disputed correction matrix.
- Confirm financial corrections on verified payments return them to `recorded` and clear reviewer fields.
- Confirm reference/note-only corrections keep verified status.
- Confirm archived program, empty reason, no-op, and disputed correction cases behave as documented.
- Confirm customer summaries, tenant stats, payment sums, sold-program caches, and Billing counts remain consistent.

### Phase 4 Export and Release QA

Source: `plans/billing-ops/phases/phase4-export-release-qa.md`

Required:

- Access/nav disabled and enabled behavior.
- Copy payload content from focused page.
- CSV uses the visible filters and caps at 1,000 rows.
- CSV has `Has Proof File` only; no proof URLs or storage ids.
- Formula hardening for cells starting with `=`, `+`, `-`, `@`, tab, or carriage return.
- Exactly one `billingExportEvents` row per CSV export, with server-derived tenant and actor.

## Manual Enablement

Enable only after all previous gates pass:

```bash
pnpm exec convex run --prod --identity "$SYSTEM_ADMIN_IDENTITY" \
  --typecheck disable --codegen disable \
  admin/billingOps:setBillingOpsEnabled \
  '{"tenantId":"<tenantId>","enabled":true}'
```

Immediate post-enable smoke:

- owner/admin sees Billing in sidebar
- owner/admin sees Billing in command palette
- `/workspace/billing` queue loads
- focused payment page loads
- review action works on a selected test payment
- correction dialog behaves as expected
- CSV export downloads and writes one audit row
- closer/lead generator still cannot access Billing

## Monitoring Window

Monitor for at least one business day after enablement:

| Signal | What To Watch |
|---|---|
| Convex logs | `BillingOpsDisabledError`, permission errors, aggregate mismatch errors, export audit errors. |
| Billing counts | Queue exact counts change correctly after new payment inserts, reviews, disputes, voids, and corrections. |
| Existing revenue reports | No unexpected drift from review-only actions. |
| Export audits | Every CSV download creates one audit row. |
| Support feedback | Billing operators can complete the external billing handoff without manual database inspection. |

## Rollback

Primary rollback:

```bash
pnpm exec convex run --prod --identity "$SYSTEM_ADMIN_IDENTITY" \
  admin/billingOps:setBillingOpsEnabled \
  '{"tenantId":"<tenantId>","enabled":false}'
```

After rollback:

- Billing disappears from sidebar and command palette after refresh.
- Direct route renders unavailable state for admins.
- Public Billing Convex functions reject due to disabled tenant.
- Leave widened schema, indexes, components, readiness records, and export audit rows in place.

If counts are wrong:

1. Disable Billing.
2. Re-run aggregate backfill with `reset: true`.
3. Re-run readiness verification.
4. Re-run affected QA.
5. Re-enable only after a new passing readiness row.

If E2E auth is accidentally enabled on production:

1. Unset `E2E_AUTH_ENABLED` and any E2E user/password env vars.
2. Redeploy immediately.
3. Rotate `E2E_AUTH_TOKEN_SECRET`.
4. Rotate `TEST_USERS_PASSWORD` if it was present in the production environment.
5. Review access logs for `/api/testing/auth/login`.

## Evidence Log

Fill this in during the actual production pass:

| Item | Value |
|---|---|
| Deploy commit | |
| Convex deploy timestamp | |
| App deploy timestamp | |
| Target tenant id | |
| Product semantics signoff | |
| `pnpm tsc --noEmit` | |
| Convex codegen dry-run | |
| Targeted ESLint | |
| `pnpm build` | |
| E2E auth route 404 proof | |
| Backfill `startedAt` | |
| Backfill `completedAt` or operator completion timestamp | |
| Readiness check id | |
| Readiness status | |
| Phase 2 QA owner/result | |
| Phase 3 QA owner/result | |
| Phase 4 QA owner/result | |
| Enable command timestamp | |
| Post-enable smoke result | |
| Rollback command tested or ready | |

## Go/No-Go

Go only if every item is true:

- deploy source is clean and intentional
- production E2E auth is disabled
- Convex deploy succeeded
- app deploy succeeded
- Billing is unavailable while disabled
- backfill completed
- automated readiness passed after backfill
- Phase 2 QA passed
- Phase 3 QA passed
- Phase 4 QA passed
- rollback command is ready

No-go if any of these occur:

- product rejects `verified === billing reviewed`
- production deploy source includes unintended dirty files
- any tenant is enabled before readiness
- aggregate verification fails or table checks truncate
- review/correction changes revenue or counts unexpectedly
- export leaks proof URLs/storage ids
- E2E auth route is reachable on the real production deployment
