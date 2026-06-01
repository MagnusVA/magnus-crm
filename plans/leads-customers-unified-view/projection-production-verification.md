# Projection Production Test Tenant Verification

## Status

Production-test assertion run completed after Phase 5 deployment. Phase 1 backfill was already run previously, so only the Window 5 assertion pair was needed.

## Required Migration Commands

If the Phase 1 backfill already ran in the production test tenant, run only the assertion pair before the nav flip:

| Order | Command | Result | Notes |
|---:|---|---|---|
| 1 | `npx convex run --prod migrations:run '{"fn":"migrations:assertLeadCustomerSearchRowsBackfilled","dryRun":true,"reset":true}'` | Passed | Processed first 100 rows without committing changes. |
| 2 | `npx convex run --prod migrations:run '{"fn":"migrations:assertLeadCustomerSearchRowsBackfilled","reset":true}'` | Passed | Completed with migration state `success`; processed 1,550 rows. |

If the backfill has not run in the production test tenant, run the full sequence:

| Order | Command | Result | Notes |
|---:|---|---|---|
| 1 | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows","dryRun":true}'` | Not run | Validate without touching data |
| 2 | `npx convex run migrations:run '{"fn":"backfillLeadCustomerSearchRows"}'` | Not run | Rebuild derived projection rows |
| 3 | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled","dryRun":true}'` | Not run | Validate completeness check |
| 4 | `npx convex run migrations:run '{"fn":"assertLeadCustomerSearchRowsBackfilled"}'` | Not run | Required before visible navigation flip |

## Sample Verification

| Scenario | Source state | Projection state | Result |
|---|---|---|---|
| Active lead | See redacted sample matrix | TBD | TBD |
| Converted customer | See redacted sample matrix | TBD | TBD |
| Opportunity direct lookup | See redacted sample matrix | TBD | TBD |
| Assigned closer detail | See redacted sample matrix | TBD | TBD |
| Unassigned closer opportunity | See redacted sample matrix | TBD | TBD |

## Spot-Check Commands

Run only after selecting the correct deployment context:

```bash
npx convex run leadCustomers/queries:listEntities '{"paginationOpts":{"numItems":25,"cursor":null},"lifecycle":"all"}'
npx convex run leadCustomers/queries:searchEntities '{"searchTerm":"<redacted-direct-id>"}'
```

## Log Review

- [ ] `[LeadCustomers:Projection]` logs include IDs and counts only.
- [ ] No raw search terms are logged.
- [ ] No names, emails, phone numbers, handles, comments, or payment references are logged.
- [ ] No repeated projection rebuild errors after normal writes.

## Failure Rule

If assertion fails, do not flip navigation. Fix the projection/write-hook issue, rerun `backfillLeadCustomerSearchRows`, then rerun both assertion commands.

## Production Assertion Evidence

Status checked with:

```bash
npx convex run --prod --component migrations lib:getStatus '{"names":["migrations:assertLeadCustomerSearchRowsBackfilled"]}'
```

Result:

| Name | State | Processed | latestStart | latestEnd |
|---|---|---:|---|---|
| `migrations:assertLeadCustomerSearchRowsBackfilled` | `success` | 1550 | `1780272213687` | `1780272222394` |
