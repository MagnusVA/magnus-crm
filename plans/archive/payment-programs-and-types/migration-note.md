# Payment Programs & Types Migration Note

**Date:** 2026-04-21
**Status:** Production cutover completed.

## Outcome

The production rollout for payment programs and payment types is complete.

Production was moved through the intended sequence:

1. Reintroduce Convex migration wiring.
2. Widen the production-safe schema.
3. Backfill legacy `customers` and `paymentRecords`.
4. Clean up legacy fields on live documents.
5. Narrow the schema to the final target contract.

## Final production contract

Production now uses the final shape:

- `tenantPrograms`
- `customers.programId`
- `customers.programName`
- `paymentRecords.programId`
- `paymentRecords.programName`
- `paymentRecords.paymentType`
- `paymentRecords.commissionable`
- `paymentRecords.attributedCloserId`
- `paymentRecords.recordedByUserId`

Legacy production fields from the deferred cutover are no longer part of the
active schema:

- `customers.programType`
- `paymentRecords.closerId`
- `paymentRecords.provider`
- `paymentRecords.loggedByAdminUserId`
- `paymentRecords.origin = "customer_flow"`

## Verification

Post-cutover production audit returned zero remaining legacy rows:

- `customersMissingProgramId: 0`
- `customersWithLegacyProgramType: 0`
- `paymentsMissingCommissionable: 0`
- `paymentsMissingPaymentType: 0`
- `paymentsMissingProgramId: 0`
- `paymentsMissingProgramName: 0`
- `paymentsMissingRecordedByUserId: 0`
- `paymentsUsingLegacyFields: 0`
- `paymentsUsingLegacyOrigin: 0`

Sanity check after the final narrow deploy:

- `dashboard/adminStats:getAdminDashboardStats` still returns `revenueLogged: 2000`

## Working rule

Continue development against the final target contract. The temporary
production-safe bridge for this rollout has been removed.
