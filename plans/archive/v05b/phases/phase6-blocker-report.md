# Phase 6 Blocker Report

**Date:** 2026-04-12
**Tenant ID:** `k57dqjfyf8qqy31bq375ng8gb984b24q`
**System Admin Org ID used for migration identity:** `org_01KNDZ4W6JV6YF8G1SHB3TGJFP`
**Scope:** Production preflight for Phase 6 schema narrowing

## Summary

Phase 6 is **not ready for the final production narrowing deploy**.

The production preflight and reconciliation pass cleared one blocker, but two blockers remain:

- `meetings_missing_assignedCloserId`: `18`
- `payments_with_legacy_amount`: `2`

The `tenants_with_deprecated_oauth` blocker was cleared during this run.

## What Was Run

These actions were executed against production:

```bash
# Snapshot-style preflight exports
npx convex data tenants --prod --limit 2000 --order asc --format jsonArray
npx convex data tenantCalendlyConnections --prod --limit 2000 --order asc --format jsonArray
npx convex data users --prod --limit 2000 --order asc --format jsonArray
npx convex data leads --prod --limit 2000 --order asc --format jsonArray
npx convex data meetings --prod --limit 2000 --order asc --format jsonArray
npx convex data followUps --prod --limit 2000 --order asc --format jsonArray
npx convex data paymentRecords --prod --limit 2000 --order asc --format jsonArray

# Deployed production validation / reconciliation functions
npx convex run admin/narrowingValidation:validateNarrowingReadiness '{}' --prod
npx convex run admin/migrations:backfillMeetingCloserId '{}' --prod --identity '{"subject":"migration-runner","organization_id":"org_01KNDZ4W6JV6YF8G1SHB3TGJFP"}'
npx convex run opportunities/maintenance:repairAssignmentsFromCalendlyHosts '{"tenantId":"k57dqjfyf8qqy31bq375ng8gb984b24q"}' --prod
npx convex run admin/migrations:backfillMeetingCloserId '{}' --prod --identity '{"subject":"migration-runner","organization_id":"org_01KNDZ4W6JV6YF8G1SHB3TGJFP"}'
npx convex run admin/narrowingBackfills:stripTenantOAuthFields '{}' --prod
npx convex run admin/narrowingValidation:validateNarrowingReadiness '{}' --prod
```

This action was also attempted and failed:

```bash
npx convex run admin/narrowingBackfills:stripPaymentAmount '{}' --prod
```

## Validation Results

### Initial production validation

`admin/narrowingValidation:validateNarrowingReadiness` returned:

```json
{
  "allClear": false,
  "results": {
    "followUps_missing_type": 0,
    "leads_invalid_customFields": 0,
    "leads_missing_status": 0,
    "meetings_missing_assignedCloserId": 19,
    "payments_missing_amountMinor": 0,
    "payments_missing_contextType": 0,
    "payments_with_legacy_amount": 2,
    "tenants_with_deprecated_oauth": 1,
    "users_missing_isActive": 0
  }
}
```

### Final production validation after reconciliation

`admin/narrowingValidation:validateNarrowingReadiness` returned:

```json
{
  "allClear": false,
  "results": {
    "followUps_missing_type": 0,
    "leads_invalid_customFields": 0,
    "leads_missing_status": 0,
    "meetings_missing_assignedCloserId": 18,
    "payments_missing_amountMinor": 0,
    "payments_missing_contextType": 0,
    "payments_with_legacy_amount": 2,
    "tenants_with_deprecated_oauth": 0,
    "users_missing_isActive": 0
  }
}
```

## What Was Successfully Fixed

### 1. Deprecated tenant OAuth fields were stripped

`admin/narrowingBackfills:stripTenantOAuthFields` succeeded:

```json
{
  "stripped": 1,
  "syncedToConnections": 1,
  "total": 1
}
```

This cleared:

- `tenants_with_deprecated_oauth`: `1 -> 0`

### 2. One meeting closer was backfilled

The first `admin/migrations:backfillMeetingCloserId` run returned:

```json
{
  "skippedNoCloser": 18,
  "total": 228,
  "updated": 1
}
```

After that, the tenant-level repair pass ran:

```json
{
  "mappedHosts": 231,
  "patched": 227,
  "scanned": 227
}
```

But a second `backfillMeetingCloserId` still returned:

```json
{
  "skippedNoCloser": 18,
  "total": 228,
  "updated": 0
}
```

So the opportunity host repair did not fully resolve the remaining 18 meetings.

## Remaining Blockers

### Blocker A: 18 meetings still have no `assignedCloserId`

This is the primary schema blocker for `meetings.assignedCloserId` becoming required.

#### Root cause

These 18 meetings are downstream of opportunities whose assigned closer still cannot be resolved from production data.

There is no payment-history or follow-up-history signal available for these records, so the remaining rows are not safely inferable by the currently deployed backfills.

#### Host breakdown

The unresolved meetings are tied to these Calendly hosts:

- `https://api.calendly.com/users/HBCGVET7KPDFJOXU`: `13` meetings
- `https://api.calendly.com/users/6e091822-b3cc-442f-a28d-b3c053eb9516`: `5` meetings

For comparison, this host is properly linked and was not the blocker:

- `https://api.calendly.com/users/d81722da-292b-41d6-85c2-377fd3a5c8be`

#### Production evidence

From production snapshots:

- `HBCGVET7KPDFJOXU`
  - `email`: `oystraining@gmail.com`
  - `name`: `Janelle Wheale`
  - present in `calendlyOrgMembers`
  - **no `matchedUserId`**
  - no direct `users.calendlyUserUri` match

- `6e091822-b3cc-442f-a28d-b3c053eb9516`
  - `email`: `operations@pt-domination.com`
  - `name`: `PT Domination`
  - present in `calendlyOrgMembers`
  - **no `matchedUserId`**
  - no direct closer user match

- `d81722da-292b-41d6-85c2-377fd3a5c8be`
  - `email`: `michael@pt-domination.com`
  - present in `calendlyOrgMembers`
  - `matchedUserId` points to closer user `k97fs2f79efmaxck4rbysd1v6x84cw5p`

#### Why this is blocked

The deployed production repair flow only knows how to assign a closer when a Calendly host can be mapped to:

- a `users` row with matching `calendlyUserUri` and `role === "closer"`, or
- a `calendlyOrgMembers.matchedUserId` that resolves to a closer

Those conditions are false for the two unresolved hosts above.

### Blocker B: 2 payment records still contain legacy `amount`

This blocks removal of `paymentRecords.amount` from the schema.

Affected production records:

- `jx767sstjjdvjqkwp58wwr1c9184mtas`
- `jx70hqgdtz5chpezf6k2qmkhb184pybn`

#### Root cause

The currently deployed production function `admin/narrowingBackfills:stripPaymentAmount` cannot run successfully because the **currently deployed schema still requires `paymentRecords.amount`**.

The failure was:

```text
Failed to insert or update a document in table "paymentRecords" because it does not match the schema:
Object is missing the required field `amount`.
```

This means production is in a bad in-between state:

- validation correctly says the legacy field must be removed before Phase 6 narrowing
- but the deployed stripping function removes the field against a schema that still requires it

So the field cannot be removed safely with the currently deployed production code.

## Additional Environment Observation

The production deployment does **not** currently expose the newer helper functions added locally in this chat, including:

- `admin/migrations:auditPhase6Readiness`
- `admin/migrations:backfillTenantCalendlyConnections`

Production still exposes the earlier Phase 6 helpers:

- `admin/narrowingValidation:validateNarrowingReadiness`
- `admin/narrowingBackfills:stripPaymentAmount`
- `admin/narrowingBackfills:stripTenantOAuthFields`

This matters because any next-step fix must respect the currently deployed production function surface unless an intermediate deploy is performed first.

## Recommended Next Steps For The Next Chat

The next chat should focus on the blocker-resolution path, not on rerunning the same preflight.

### Workstream 1: resolve the 18 meeting closer assignments

Determine the intended closer mapping for these two Calendly hosts:

- `https://api.calendly.com/users/HBCGVET7KPDFJOXU`
- `https://api.calendly.com/users/6e091822-b3cc-442f-a28d-b3c053eb9516`

Then choose one of these approaches:

1. Link those Calendly org members to existing closer users in production, then rerun:
   - `opportunities/maintenance:repairAssignmentsFromCalendlyHosts`
   - `admin/migrations:backfillMeetingCloserId`
2. Ship an intermediate helper deploy that can explicitly map those host URIs to the correct closer IDs and backfill the affected opportunities/meetings.
3. If the correct closer is not derivable from current data, make a manual assignment decision for the 18 affected opportunities/meetings before retrying Phase 6.

### Workstream 2: resolve the legacy payment `amount` stripping mismatch

Use a widen-migrate-narrow correction, not another blind retry.

Safe options:

1. Ship an intermediate production deploy where `paymentRecords.amount` is optional again, run `stripPaymentAmount`, verify zero legacy rows, then proceed to the final narrowing deploy.
2. Replace the deployed `stripPaymentAmount` flow with a schema-compatible helper and deploy that first.

The key constraint is:

- **do not attempt the final narrowed production deploy until `payments_with_legacy_amount === 0` and `meetings_missing_assignedCloserId === 0`.**

## Handoff Checklist

The next chat should start by reviewing:

- [phase6.md](/Users/nimbus/dev/ptdom-crm/plans/v05b/phases/phase6.md)
- [migrations.md](/Users/nimbus/dev/ptdom-crm/plans/v05b/migrations.md)
- [phase6-blocker-report.md](/Users/nimbus/dev/ptdom-crm/plans/v05b/phases/phase6-blocker-report.md)
- [migrations.ts](/Users/nimbus/dev/ptdom-crm/convex/admin/migrations.ts)
- [tenantCalendlyConnection.ts](/Users/nimbus/dev/ptdom-crm/convex/lib/tenantCalendlyConnection.ts)
- [maintenance.ts](/Users/nimbus/dev/ptdom-crm/convex/opportunities/maintenance.ts)

Production evidence saved during this run:

- `/Users/nimbus/dev/ptdom-crm/.tmp/v05b-phase6/preflight`
- `/Users/nimbus/dev/ptdom-crm/.tmp/v05b-phase6/after`

## Bottom Line

This chat successfully completed the production preflight and reduced the blocker set, but **Phase 6 is still blocked**.

The remaining blockers are real data/schema-state issues, not missing retries:

- `18` meetings still lack `assignedCloserId` because two Calendly hosts are unmapped to closers
- `2` payments still carry legacy `amount`, and the deployed stripping helper is incompatible with the currently deployed schema
