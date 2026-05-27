# Phase 3 Correction QA — Billing Ops

Use one `recorded`, one `verified`, and one `disputed` payment for this matrix.
Capture Billing counts, tenant stats, customer summary, and focused history
before and after each correction.

## Correction Matrix

| Scenario | Expected Result |
|---|---|
| Recorded amount change | Status stays `recorded`; revenue and customer summary update. |
| Verified amount change | Status returns to `recorded`; `verifiedAt` and `verifiedByUserId` clear. |
| Verified payment type change | Status returns to `recorded`; tenant stats bucket moves without changing total payment count. |
| Verified program change | Status returns to `recorded`; Billing program counts and sold-program caches refresh. |
| Verified reference-only change | Status remains `verified`; no Billing count or revenue total changes. |
| Verified note-only change | Status remains `verified`; no Billing count or revenue total changes. |
| Archived program selected by direct mutation | Mutation rejects. |
| Empty reason | Mutation rejects. |
| No-op submission | Returns `changed: false` and writes no `payment.corrected` event. |
| Disputed payment correction | Mutation rejects; dispute repair remains out of scope. |

## Downstream Surface Checks

- `paymentSums` changes only for amount/type/status-relevant corrections.
- Billing count aggregates move for status, program, and payment-type key
  changes.
- `tenantStats.totalPaymentRecords`, `wonDeals`, and active opportunity counters
  do not change during corrections.
- Customer payment totals update after amount/type corrections.
- Opportunity and meeting sold-program displays update after program
  corrections.
- Customer `programId/programName` update only when the corrected payment is the
  customer's winning opportunity payment.
- Focused payment history renders readable old/new field labels without raw
  JSON blobs.
