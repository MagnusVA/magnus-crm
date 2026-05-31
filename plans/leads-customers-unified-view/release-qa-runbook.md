# Leads & Customers Unified View - Release QA Runbook

## Status

Prepared for Phase 5 rollout. Production-test execution is intentionally not recorded here yet.

## Roles

| Role | Test account | Required checks |
|---|---|---|
| Tenant owner/admin | TBD | Search, detail, sheet, payments, comments, redirects, sidebar, command palette |
| Assigned closer | TBD | Assigned entity search/detail, opportunity sheet, closer meeting links, comments |
| Unassigned closer | TBD | Entity context only; no restricted opportunity comments, payments, or actions |
| Lead generator | TBD | No access to Leads & Customers workspace |

## Core Scenarios

| Scenario | Starting URL/input | Expected result | Admin | Closer |
|---|---|---|---|---|
| Search active lead by handle | `/workspace/leads-customers?q=<redacted>` | Lead row and detail load | TBD | TBD |
| Search converted customer by email | `/workspace/leads-customers?q=<redacted>` | Customer lifecycle row and customer strip load | TBD | TBD |
| Direct opportunity ID | Search box or old opportunity URL | Entity detail opens with sheet selected | TBD | TBD |
| Meeting link from detail | Detail meeting row | New tab opens role-correct meeting route | TBD | TBD |
| Legacy lead URL | `/workspace/leads/[leadId]` | Redirects to lead-centric detail route | TBD | TBD |
| Legacy customer URL | `/workspace/customers/[customerId]` | Redirects to lead-centric detail route | TBD | TBD |
| Legacy opportunity URL | `/workspace/opportunities/[opportunityId]` | Redirects to lead-centric detail route with `opportunityId` | TBD | TBD |
| New side deal | `/workspace/leads-customers/new-opportunity` | Creates side deal and redirects to entity detail sheet | TBD | TBD |
| Merged lead URL | `/workspace/leads/[sourceLeadId]` | Redirects to target lead detail route | TBD | TBD |
| Mobile detail | 390 x 844 viewport | No horizontal scroll or content overlap | TBD | TBD |

## Browser Targets

- `/workspace/leads-customers`
- `/workspace/leads-customers/[leadId]`
- `/workspace/leads-customers/[leadId]?opportunityId=[opportunityId]`
- `/workspace/leads-customers/new-opportunity`
- `/workspace/leads`
- `/workspace/customers/[customerId]`
- `/workspace/opportunities/[opportunityId]`

## Local Release Checks

- [ ] `pnpm tsc --noEmit`
- [ ] `pnpm lint`
- [ ] `npx convex dev --once`

## Evidence Rules

- Use only redacted IDs from `artifacts/sample-data-matrix.md`.
- Do not paste names, emails, phone numbers, social handles, raw search terms, payment references, comments, notes, or screenshots containing PII.
- Capture failures with role, route, viewport, expected result, actual result, and console/log status.
