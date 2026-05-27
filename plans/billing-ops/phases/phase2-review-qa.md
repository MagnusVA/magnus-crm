# Phase 2 Review QA — Billing Ops

Use this checklist after `markReviewed` is deployed against the production test
tenant with Billing Ops enabled.

## Count and Event Checks

- Before review, record Billing counts for `recorded` and `verified` with the
  same queue filters.
- Mark one `recorded` payment reviewed from
  `/workspace/billing/[paymentRecordId]`.
- Confirm `recorded` count decreases by 1 and `verified` count increases by 1.
- Confirm customer payment summary and revenue reports do not change, because
  both `recorded` and `verified` are active revenue states.
- Confirm the focused history shows exactly one `payment.verified` event with
  actor, old/new status, amount, currency, type, and program metadata.

## Rejection Matrix

| Scenario | Expected Result |
|---|---|
| Tenant disabled | Mutation rejects with Billing disabled error. |
| Closer role | Route and mutation reject before payment review. |
| Lead generator role | Route and mutation reject before payment review. |
| Cross-tenant payment id | Mutation returns `Payment not found.` |
| `disputed` payment | Mutation rejects. |
| Already `verified` payment | Mutation succeeds idempotently and writes no second event. |

## Existing Flow Regression Checks

- Disputing a review still moves the relevant payment to `disputed`.
- Voiding a side-deal payment still moves the payment to `disputed`.
- Both dispute/void paths update Billing counts through the shared payment
  replacement hook.
- Queue rows do not expose row-level Mark reviewed shortcuts; review remains a
  focused-page action only.
