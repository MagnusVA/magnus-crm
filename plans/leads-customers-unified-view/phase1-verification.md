# Phase 1 Verification - Entity Projection and Query Facade

| Check | Command | Result |
|---|---|---|
| Convex insights baseline | `npx convex insights --details` | Passed with unrelated OCC warnings in `pipeline/inviteeCreated.js:process` and `calendly/healthCheckMutations.js:markTenantHealthChecked`. |
| Convex schema/codegen | `npx convex dev --once` | Passed. Initial run found an over-length index name; fixed and reran successfully. |
| TypeScript | `pnpm tsc --noEmit` | Passed. |
| Backfill dry run | `npx convex run migrations:run '{"fn":"migrations:backfillLeadCustomerSearchRows","dryRun":true}'` | Passed on dev deployment; processed 9 leads, no committed changes. |
| Backfill run | `npx convex run migrations:run '{"fn":"migrations:backfillLeadCustomerSearchRows"}'` | Passed on dev deployment; processed 9 leads. |
| Assertion dry run | `npx convex run migrations:run '{"fn":"migrations:assertLeadCustomerSearchRowsBackfilled","dryRun":true}'` | Passed on dev deployment; processed 9 leads. |
| Assertion run | `npx convex run migrations:run '{"fn":"migrations:assertLeadCustomerSearchRowsBackfilled"}'` | Passed on dev deployment; processed 9 leads. |

## Performance Review

- [x] `searchEntities` resolves direct IDs first, then uses `withSearchIndex`.
- [x] `listEntities` uses tenant-first indexes before pagination.
- [x] `getEntityDetail` caps identifiers, opportunities, meetings, comments, payments, and activity.
- [x] New public lead-customer queries do not use Convex `.filter()` database filtering.
- [x] New lead-customer queries do not use unbounded `.collect()`.

## Logging Review

- [x] Projection rebuild logs include IDs, lifecycle, and counts only.
- [x] Search/list/detail functions do not log raw search terms, names, emails, phone numbers, handles, comments, notes, or payment references.
