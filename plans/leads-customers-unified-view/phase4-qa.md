# Phase 4 QA — Sheet and Legacy Redirects

## Redirect Matrix

| Legacy URL | Expected target | Admin | Closer assigned | Closer unassigned |
|---|---|---|---|---|
| `/workspace/leads` | `/workspace/leads-customers` | Not run | Not run | Not run |
| `/workspace/leads?status=converted` | `/workspace/leads-customers?lifecycle=customer` | Not run | Not run | Not run |
| `/workspace/leads/[leadId]` | `/workspace/leads-customers/[leadId]` | Not run | Not run | Not run |
| `/workspace/leads/[sourceMergedLeadId]` | target lead route | Not run | Not run | Not run |
| `/workspace/customers` | `/workspace/leads-customers?lifecycle=customer` | Not run | Not run | Not run |
| `/workspace/customers/[customerId]` | lead route | Not run | Not run | Not run |
| `/workspace/opportunities` | `/workspace/leads-customers` | Not run | Not run | Not run |
| `/workspace/opportunities/[opportunityId]` | lead route with `opportunityId` | Not run | Not run | `404` |
| `/workspace/opportunities/new` | `/workspace/leads-customers/new-opportunity` | Not run | Not run | Not run |

## Sheet Checks

- [ ] Opening `/workspace/leads-customers/[leadId]?opportunityId=[opportunityId]` shows a left-side sheet on desktop.
- [ ] Closing the sheet removes only `opportunityId` and preserves the lead detail route.
- [ ] Browser back closes/restores URL state correctly.
- [ ] Mobile sheet is full-width and scrolls internally.
- [ ] Escape key closes the sheet.
- [ ] Unauthorized or malformed opportunity IDs render the unavailable state without exposing payments, comments, or actions.
- [ ] Side-deal actions appear only when `getOpportunityDetail` permissions allow them.
- [ ] Meeting links open in a new tab with the role-correct route.
- [ ] `/workspace/leads/[leadId]/merge` still renders the merge page.

## Automated Checks

- [x] `pnpm tsc --noEmit`
- [ ] `pnpm lint` — fails on pre-existing/generated files outside Phase 4.
- [x] Phase 4 scoped ESLint for touched files.
