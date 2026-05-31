# Lead Customer Search Projection Migration Runbook

## Deploy 1 - Widen

1. Deploy the schema, projection builder, query facade, detail contract, and write hooks together.
2. Confirm `npx convex dev --once` succeeds locally before deployment.
3. Confirm old routes and navigation still do not depend on `leadCustomerSearchRows`.

## Dry Run

Run before touching real data:

```bash
npx convex run migrations:run '{"fn":"migrations:backfillLeadCustomerSearchRows","dryRun":true}'
```

## Run

```bash
npx convex run migrations:run '{"fn":"migrations:backfillLeadCustomerSearchRows"}'
npx convex run migrations:run '{"fn":"migrations:assertLeadCustomerSearchRowsBackfilled","dryRun":true}'
npx convex run migrations:run '{"fn":"migrations:assertLeadCustomerSearchRowsBackfilled"}'
```

## Verify

- Projection count matches lead count for the production test tenant.
- Redacted sample IDs from `artifacts/sample-data-matrix.md` resolve through `leadCustomers/queries:searchEntities`.
- `leadCustomers/queries:listEntities` returns visible rows with lifecycle filters.
- Convex logs contain `[LeadCustomers:Projection]` IDs, lifecycle, and counts only; no names, emails, phone numbers, handles, raw search terms, comments, or payment references.

## Rollback Notes

- This table is derived data. If assertion fails, leave old routes/navigation in place, fix `convex/leadCustomers/projection.ts`, rerun the backfill, then rerun the assertion.
- Do not delete source records or manually patch source-of-truth rows to repair projection bugs.
