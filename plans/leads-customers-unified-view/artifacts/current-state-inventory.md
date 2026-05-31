# Leads & Customers Unified View - Current State Inventory

**Phase:** 0A - Route, Function, and Component Inventory  
**Date captured:** 2026-05-31  
**Scope:** Current `/workspace/leads`, `/workspace/customers`, `/workspace/opportunities`, and `/workspace/opportunities/new` behavior before unified-route implementation.

## Evidence Commands

- `find app/workspace/leads app/workspace/customers app/workspace/opportunities -maxdepth 5 -type f | sort`
- `rg -n "requirePermission|requireRole|useQuery|usePaginatedQuery|useMutation|useAction|fetchQuery|preloadQuery|api\\." app/workspace/leads app/workspace/customers app/workspace/opportunities`
- `rg -n "export const (list|search|get|create|update|record|mark|delete|resolve|merge|convert|manual|bulk)" convex/leads convex/customers convex/opportunities convex/closer convex/pipeline`
- `npx convex insights --details`

## Current Route Inventory

| Route | Gate | Primary client | Convex APIs | Current behavior | Phase decision |
|---|---|---|---|---|---|
| `/workspace/leads` | `requirePermission("lead:view-all")` | `LeadsPageClient` -> `LeadsPageContent` | `api.leads.queries.listLeads`, `api.leads.queries.searchLeads` | Paginated active leads by default, optional lead status tabs, lead-only search, row click opens old lead detail in a new tab with `window.open`. | Replace visible nav entry in Phase 5. Redirect route in Phase 4 after unified route exists. |
| `/workspace/leads/[leadId]` | `requirePermission("lead:view-all")` | `LeadDetailPageClient` | `api.leads.queries.getLeadDetail`, `api.customers.mutations.convertLeadToCustomer` | Lead-centric detail, redirects merged leads client-side, hides overview/meetings/opportunities/activity/fields behind tabs. | Replace with server redirect to `/workspace/leads-customers/[leadId]` in Phase 4. Use as rollback reference. |
| `/workspace/leads/[leadId]/merge` | No route-level server gate in `page.tsx`; client uses guarded queries/mutation | `MergePageClient` | `api.leads.queries.getLeadDetail`, `api.leads.queries.searchLeads`, `api.leads.queries.getMergePreview`, `api.leads.merge.mergeLead` | Merge flow remains a separate lead tool. | Keep until a unified merge route exists. Link from new detail when user has `lead:merge`. |
| `/workspace/customers` | `requirePermission("customer:view-own")` | `CustomersPageClient` | `api.customers.queries.listCustomers` | Paginated customer registry with status tabs. No customer search. | Replace with `/workspace/leads-customers?lifecycle=customer` redirect in Phase 4 or Phase 5. |
| `/workspace/customers/[customerId]` | `requirePermission("customer:view-own")` | `CustomerDetailPageClient` | `api.customers.queries.getCustomerDetail`, `api.customers.mutations.updateCustomerStatus`, `api.customers.mutations.recordCustomerPayment` | Customer-specific detail with relationships, attribution, conversion, payment history, and admin-only status/payment controls. | Resolve customer to `leadId`, then redirect to `/workspace/leads-customers/[leadId]` in Phase 4. Reuse payment/history patterns where density fits. |
| `/workspace/opportunities` | `requirePermission("pipeline:view-own")` | `OpportunitiesPageClient` | `api.opportunities.listQueries.listOpportunities`, `api.opportunities.listQueries.searchOpportunities`, `api.users.queries.listActiveClosers` | Searchable/filterable opportunity browse page, URL-synced filters, admin CSV export of loaded rows, row click opens old opportunity detail in new tab. | Replace visible browse surface. Keep query/payload patterns for opportunity sheet and rollback. |
| `/workspace/opportunities/[opportunityId]` | `requirePermission("pipeline:view-own")`; preflight `fetchQuery` + `notFound()` | `OpportunityDetailClient` | `api.opportunities.detailQuery.getOpportunityDetail`, side-deal payment/lost/delete/void mutations | Rich opportunity detail with summary, lead card, attribution, meetings, payments, activity, and permission metadata. Closer detail returns `null` for unassigned opportunities. | Reuse `getOpportunityDetail` for left sheet where possible. Redirect legacy route to entity detail with `?opportunityId=` in Phase 4. |
| `/workspace/opportunities/new` | `requirePermission("pipeline:view-own")` | `CreateOpportunityPageClient` | `api.opportunities.createManual.createManual`, `api.leads.queries.getLeadForPicker`, `api.leads.queries.searchLeadsForPicker`, `api.users.queries.listActiveClosers` | Side-deal creation with React Hook Form + Zod v4 via `standardSchemaResolver`. Supports existing or new lead. | Move/copy under `/workspace/leads-customers/new-opportunity`; old route redirects in Phase 4. |

## Navigation And Deep Links

| Surface | Current link target | Phase decision |
|---|---|---|
| Admin sidebar | `/workspace/leads`, `/workspace/customers`, `/workspace/opportunities` | Replace three entries with `/workspace/leads-customers` in Phase 5. |
| Closer sidebar | `/workspace/leads`, `/workspace/customers`, `/workspace/opportunities` | Replace three entries with `/workspace/leads-customers` in Phase 5. |
| Command palette pages | Admin: Leads and Opportunities; Closer: Opportunities | Replace with Leads & Customers and update quick action target to `/workspace/leads-customers/new-opportunity` in Phase 5. |
| Legacy pipeline page | `/workspace/pipeline` redirects to `/workspace/opportunities` unless phone-sales status maps to Operations | Preserve compatibility when `/workspace/opportunities` later redirects. |
| Reports/operations/reminders links | Several links point to `/workspace/opportunities/[opportunityId]` | Phase 4 redirect must preserve these browser/report links. |

## Current Convex Read Paths

| Function | Guard | Key reads | Bound/cost notes | Phase decision |
|---|---|---|---|---|
| `leads.queries.listLeads` | `requireTenantUser(["tenant_master","tenant_admin","closer"])` | `leads.by_tenantId_and_status` paginated; for each page row, `opportunities.by_tenantId_and_leadId.take(50)` and closer `db.get` | Bounded but row-enrichment can perform up to 25 opportunity queries per first page. | Replace browse reads with `leadCustomerSearchRows` projection. |
| `leads.queries.searchLeads` | Same | `leads.search_leads.take(20)` | Bounded, but currently logs raw `searchTerm`; do not copy this into unified search. | Replace with unified projection search and redacted analytics/logging. |
| `leads.queries.getLeadDetail` | Same | Lead, identifiers `take(100)`, opportunities `take(50)`, follow-ups `take(50)`, merge history `take(20 + 20)`, Slack events `take(20)`, per-opportunity meetings `take(50)` | Bounded but can return up to 2,500 meetings across 50 opportunities before sorting. | Fold useful lead detail sections into bounded `leadCustomers.detail.getEntityDetail`; cap meetings globally. |
| `customers.queries.listCustomers` | `requireTenantUser(["tenant_master","tenant_admin","closer"])` | `customers.by_tenantId` or `by_tenantId_and_status` paginated; converter `db.get` | Bounded, tenant-wide for closers. | Customer lifecycle fields move into search projection. |
| `customers.queries.getCustomerDetail` | Same | Customer, linked lead, winning opportunity/meeting, opportunities `take(50)`, payments `take(50)`, converter, per-opportunity meetings `take(20)` then `slice(0,20)` | Bounded; currently customer-specific layout and relationships card. | Fold customer strip, payments, and attribution into lead-centric detail. |
| `opportunities.listQueries.listOpportunities` | `requireTenantUser(["closer","tenant_master","tenant_admin"])` | Indexed opportunities by tenant/status/source/closer/activity; enriches lead, closer, and pending stale nudge per row | Bounded and indexed, but `hasPendingStaleNudge` performs one follow-up query per row. | Keep as opportunity rollback/reference. Do not use as primary person search. |
| `opportunities.listQueries.searchOpportunities` | Same | `opportunitySearch.search_opportunities.take(200)`, hydrates opportunities, JS filters, returns 50 | Projection-backed, but hydrate/filter step is too opportunity-centric for entity browse. | Direct opportunity ID lookup should map to entity row + selected sheet. |
| `opportunities.detailQuery.getOpportunityDetail` | Same; closer must be assigned | Opportunity, lead, closer, meetings `take(20)`, payments `take(50)`, domain events, stale follow-ups, attribution | Strong existing permission contract; returns `permissions` metadata. | Reuse for opportunity sheet and preserve assigned-closer guard. |

## Current Component Surface

| Existing asset | Decision | Reason |
|---|---|---|
| `app/workspace/leads/_components/leads-table.tsx` | Reference only. | Useful column density, but row `onClick` uses JS navigation instead of `Link`, and search is lead-only. |
| `app/workspace/leads/_components/lead-search-input.tsx` | Reference only. | Phase 2 needs broader identifier search and URL state. |
| `app/workspace/leads/[leadId]/_components/tabs/*` | Reference only / extract content ideas. | Detail data must be visible on-page, not tab-gated. |
| `app/workspace/leads/[leadId]/_components/convert-to-customer-dialog.tsx` | Reuse candidate. | Conversion action remains lead-only and admin-only. |
| `app/workspace/leads/[leadId]/merge/_components/*` | Keep as legacy workflow. | Merge route remains until a new merge experience is planned. |
| `app/workspace/customers/_components/customers-table.tsx` | Reference only. | Shows payment/customer columns but lacks search and lead-centric route identity. |
| `app/workspace/customers/[customerId]/_components/payment-history-table.tsx` | Reuse/extract candidate. | Payment row semantics remain required on entity detail. |
| `app/workspace/customers/[customerId]/_components/record-payment-dialog.tsx` | Reuse candidate with existing guards. | Admin/customer payment action should not be reimplemented casually. |
| `app/workspace/_components/entity-attribution-card.tsx` | Reuse data type; redesign display density. | Attribution payload is established, but current card is too large for ledger/detail/sheet surfaces. |
| `app/workspace/opportunities/_components/opportunity-filters.tsx` | Reference only. | Filters are opportunity-specific; lifecycle filters differ. |
| `app/workspace/opportunities/_components/opportunities-table.tsx` | Reference/extract candidate. | Dense table pattern and loaded-row export are useful; primary unified browse should be person rows. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-meetings-list.tsx` | Reuse/extract candidate. | Meeting link semantics and base-path selection already fit Phase 4. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-payments-list.tsx` | Reuse/extract candidate. | Payment table semantics fit sheet/detail after density pass. |
| `app/workspace/opportunities/[opportunityId]/_components/opportunity-activity-timeline.tsx` | Reuse/extract candidate. | Event formatting can support sheet/activity sections. |
| `app/workspace/opportunities/[opportunityId]/_components/*side-deal*` | Reuse. | Mutations and permission behavior must remain on existing guarded paths. |
| `app/workspace/opportunities/new/_components/*` | Move/copy candidate. | Form stack matches repo standards; route and post-create navigation need new targets. |

## Performance Evidence

`npx convex insights --details` returned only two warnings in the last 72 hours:

| Warning | Source | Relevance |
|---|---|---|
| 3 OCC retries on `operationsMeetingDailyStats` | `pipeline/inviteeCreated.js:process` | Not part of the legacy browse/detail surfaces. |
| 1 OCC retry on `tenantCalendlyConnections` | `calendly/healthCheckMutations.js:markTenantHealthChecked` | Not part of this feature. |

Code audit still shows Phase 1 should avoid copying current read amplification:

- Lead browse enriches every page row by querying up to 50 opportunities.
- Lead detail can load meetings per opportunity and only sort globally afterward.
- Opportunity browse checks stale nudge state with a per-row follow-up query.
- Opportunity search hydrates up to 200 projection rows, then filters and trims in code.

No Phase 0 code changes are required from this evidence. It supports the Phase 1 projection caps and bounded detail payload in the design.

## Current Gaps To Carry Forward

- `convex/leads/queries.ts` logs raw search terms in `searchLeads`; unified search must not log raw identifiers, and this legacy log should be cleaned up before canonical rollout.
- Lead detail redirects merged leads client-side; Phase 4 legacy redirects should resolve server-side and return `null`/`notFound()` for inaccessible IDs.
- Customer detail uses customer ID as route identity; unified route should use lead ID and resolve customer IDs only in redirect resolvers.
- No current route combines comments, payments, opportunities, identifiers, and attribution on one visible page.
- Production read-only sample has a multi-meeting lead fixture, but no side-deal opportunity or merged-lead fixture was identified; see `sample-data-matrix.md`.
