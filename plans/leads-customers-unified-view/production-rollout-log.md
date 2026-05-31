# Leads & Customers Unified View - Production Test Tenant Rollout

## Status

Not deployed from this session. Use this log when the Phase 5 nav/link flip is deployed.

## Pre-Flight

- [ ] Phase 1 projection assertion passed in production test tenant.
- [ ] Phase 4 redirects verified in production test tenant or included in the same release and smoke-tested before exposing nav.
- [ ] Release QA runbook passed.
- [ ] Security/performance/accessibility audit passed.
- [ ] Rollback owner identified.

## Rollout

| Time | Action | Result |
|---|---|---|
| TBD | Deploy nav/link flip | TBD |
| TBD | Admin smoke test | TBD |
| TBD | Closer smoke test | TBD |
| TBD | Redirect smoke test | TBD |
| TBD | Convex logs review | TBD |

## Immediate Smoke Checks

- [ ] Admin sidebar shows Leads & Customers once.
- [ ] Closer sidebar shows Leads & Customers once.
- [ ] Command palette opens `/workspace/leads-customers`.
- [ ] Command palette create action opens `/workspace/leads-customers/new-opportunity`.
- [ ] Old customer URL redirects to lead-centric detail route.
- [ ] Old opportunity URL redirects to lead-centric detail route with sheet open.
- [ ] Search and detail load for sample active lead and converted customer.
- [ ] Opportunity sheet opens and closes without console errors.

## Monitor For

- `[LeadCustomers:Projection]` errors.
- `getEntityDetail` null spikes for valid sample records.
- Redirect loops.
- Missing opportunity, payment, or comment data for authorized viewers.
- Browser console errors on sheet open/close.
