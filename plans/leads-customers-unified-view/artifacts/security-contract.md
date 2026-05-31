# Leads & Customers Unified View - Security Contract

**Phase:** 0C - Permission, PII, and Logging Contract  
**Date captured:** 2026-05-31

## Governing Rules

- Tenant, user, role, and organization identity must be derived from server-side auth. Do not accept tenant/user/role from client arguments.
- All Convex functions must use validators and server guards. UI visibility is not an authorization boundary.
- Search/list/detail must be tenant-scoped by `requireTenantUser(...)` or server-side route auth plus token-backed Convex calls.
- Cross-tenant or inaccessible direct ID resolution returns `null`/`notFound()` rather than distinguishable errors.
- Logs and analytics must never include raw names, emails, phone numbers, social handles, raw search terms, payment references, or free-text comments/notes.

## Route Gates

| Surface | Next.js route gate | Convex guard | Notes |
|---|---|---|---|
| Unified browse/search | `requirePermission("lead:view-all")` | `requireTenantUser(ctx, ["tenant_master", "tenant_admin", "closer"])` | Matches current lead route access. `lead_generator` has no access. |
| Entity detail | `requirePermission("lead:view-all")` | Same tenant guard; related records carry permission metadata | Person identity is broad for MVP, but related data/actions remain permission-aware. |
| Opportunity sheet | Parent route access plus existing sheet query | Reuse `api.opportunities.detailQuery.getOpportunityDetail` where possible | Existing query returns `null` for unassigned closer access. |
| Meeting links | Existing meeting route gates | `api.closer.meetingDetail.getMeetingDetail` | Admin route uses `requireRole(["tenant_master","tenant_admin"])`; closer route also checks assigned opportunity. |
| New side deal | `requirePermission("pipeline:view-own")` | Existing `api.opportunities.createManual.createManual` guard | Admins can assign closers; closers can create only for themselves. |
| Customer payment/status actions | Existing customer route/action gates | Existing customer mutations | Do not re-authorize only in UI. |
| Legacy redirects | Existing legacy route-equivalent gate | Dedicated redirect resolver guard | Return `null` on missing, cross-tenant, or inaccessible IDs. |

## Role Contract

| CRM role | Browse/search | Entity detail | Opportunity sheet | Meeting detail links | Payments/customer actions | Side-deal creation |
|---|---|---|---|---|---|---|
| `tenant_master` | Full tenant browse | Full tenant detail | Full tenant detail | Admin meeting route | Admin-allowed actions | Can create and assign |
| `tenant_admin` | Full tenant browse | Full tenant detail | Full tenant detail | Admin meeting route | Admin-allowed actions | Can create and assign |
| `closer` | Preserve current broad lead/customer lookup for MVP | Person summary/detail as allowed by new entity query | Full only for assigned opportunities; summary-only/absent actions otherwise | Closer meeting route only where existing guard allows | Hidden or aggregate-only unless existing guard allows | Can create for self through existing mutation |
| `lead_generator` | No access | No access | No access | No access through this route | No access | No access |

## Related-Record Rules

| Related record | Authorized viewer | Unauthorized or unassigned closer |
|---|---|---|
| Opportunity row | Full summary plus Details action if `getOpportunityDetail` would allow the sheet. | Summary-only context, no Details action, no mutation actions. |
| Meeting row | Link to role-appropriate meeting detail route; bounded comments may render inline. | No comments and no detail link unless existing meeting detail guard would allow it. |
| Payment row | Visible when existing customer/payment access permits it; actions use existing mutations. | Hidden or aggregate-only. Do not expose payment proof references. |
| Comments | Active, non-deleted comments only; bounded per meeting and total. | Hidden. Do not return comment text if unauthorized. |
| Identifiers | Display on authorized entity detail; search can match them. | Never logged or emitted as analytics payload. |

## PII And Analytics Contract

Allowed analytics/log fields:

- booleans, enum filters, lifecycle/status values, counts, result counts, page sizes, capped flags;
- ID presence flags such as `hasQuery`, not the query itself;
- query length buckets: `"0"`, `"1"`, `"2-4"`, `"5-10"`, `"11+"`;
- route names and feature event names.

Forbidden analytics/log fields:

- raw search terms;
- names, emails, phone numbers, social handles, Slack labels, notes, comments, or form answers;
- payment references, proof URLs, or payment proof metadata;
- raw WorkOS tokens or session details;
- any cross-tenant ID probe details that would help enumerate records.

Recommended event shape:

```ts
posthog.capture("leads_customers_search_submitted", {
  hasQuery: true,
  queryLengthBucket: "5-10",
  lifecycle: "all",
  source: "browse",
});
```

Forbidden event shape:

```ts
posthog.capture("leads_customers_search_submitted", {
  query: searchTerm,
  email,
  phone,
});
```

## Current Security Gaps To Avoid Copying

- `convex/leads/queries.ts` currently logs `searchTerm: trimmed` in `searchLeads`. Unified search must not do this. Prefer logging only length buckets and result counts.
- Some current row click behavior uses JavaScript navigation instead of `Link`, which weakens expected browser affordances. New entity rows and meeting/opportunity actions should use `Link` or `Button asChild`.
- Current lead detail performs merged-lead redirect in a client effect. Legacy redirect resolvers should resolve server-side and avoid leaking whether a cross-tenant ID exists.

## Backend Return Contract

The entity detail query should include explicit permission metadata instead of requiring UI inference:

```ts
type RelatedRecordPermissions = {
  canOpenOpportunity: boolean;
  canOpenMeeting: boolean;
  canViewComments: boolean;
  canViewPayments: boolean;
  canRecordPayment: boolean;
};
```

For `closer`, the metadata must be derived from the authenticated `userId` and the assigned closer fields, not from client-supplied viewer state.

## Error Handling Contract

| Case | Required behavior |
|---|---|
| Missing or cross-tenant lead/customer/opportunity/meeting ID | Return `null` from Convex resolver and show `notFound()`/empty state in route. |
| Merged lead source ID | Resolve to target lead if target is in tenant; otherwise return `null`. |
| Unassigned closer opens opportunity sheet | Existing detail query returns `null`; sheet renders unavailable state without leaking details. |
| Search term under minimum length | Do not query fuzzy index unless direct ID resolution applies; show idle/empty state. |
| Direct ID probe from wrong tenant | Return no result and log only a sanitized count/outcome. |
