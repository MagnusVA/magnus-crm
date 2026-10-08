# Auth, roles, and permissions

This guide covers who can do what in Magnus CRM and which guard enforces it on each surface.

## Tenancy

One WorkOS organization is one tenant, linked by `tenants.workosOrgId`. A tenant's `status` is one of `pending_signup`, `pending_calendly`, `provisioning_webhooks`, `active`, `calendly_disconnected`, `suspended`, or `invite_expired`. `requireTenantUser` ignores tenant status, so an operation that must stop for suspended or disconnected tenants checks `tenant.status` itself.

## Roles

| CRM role | WorkOS slug | Who |
| --- | --- | --- |
| `tenant_master` | `owner` | Tenant owner |
| `tenant_admin` | `tenant-admin` | Admin |
| `closer` | `closer` | Sales closer |
| `lead_generator` | `lead-generator` | Lead gen worker; can capture leads and view their own |

- `convex/lib/roleMapping.ts` maps WorkOS slugs to CRM roles, and an unknown slug maps to `closer`.
- `convex/lib/permissions.ts` defines the permission slugs (`reports:view`, `billing:*`, `lead-gen:capture`, and others) and which roles hold them. Gate new features on a permission slug when one fits.
- Closers see only records where they're the assigned or attributed closer; `convex/leadCustomers/permissions.ts` enforces this per record.
- DM closers (`dmClosers` table) and Slack qualifiers (`slackUsers` table) aren't CRM users and have no role.

## Guards by surface

| Surface | Guard |
| --- | --- |
| Next.js pages and layouts | `requirePermission(slug)` or `requireRole(roles)` from `lib/auth.ts`; `requireWorkspaceUser()` admits any tenant member. Denied users redirect to their role's home page. |
| Convex queries and mutations | `requireTenantUser(ctx, roles)`, which returns `{ userId, tenantId, role, workosUserId }` |
| Convex actions | `requireTenantUserFromAction(ctx, roles)`. Older actions check identity by hand and skip WorkOS ID canonicalization; use the shared guard in new code. |
| Billing | `requireBillingPermission` plus `requireBillingOpsEnabled` from `convex/billing/guards.ts`; the second enforces the tenant's `billingOpsEnabled` flag |
| System admin (`/admin`) | `requireSystemAdmin()` in Next.js and `requireSystemAdminSession(identity)` in Convex. Membership means the identity's org equals `SYSTEM_ADMIN_ORG_ID`, and `/workspace` redirects system admins to `/admin`. `convex/admin/` also holds tenant-admin code (`meetingActions.ts`), so check each function's guard rather than its folder. |
| DM link portal (`/dm-links/[portalSlug]`) | Shared password, outside WorkOS. Public actions take a `sessionToken`, verify it in `"use node"` code, then call internal functions that run `assertActivePortalSession` (`convex/linkPortal/leadSession.ts`). The tenant comes from the token. |
| Webhooks | Signature verification; see `docs/agents/convex.md` |
| UI | `useRole()` and `<RequirePermission>` (`components/auth/`) only control what renders |

## Identity helpers

- `users.workosUserId` holds either the canonical or the raw WorkOS ID, so look users up with every value from `getWorkosUserIdCandidates` (`convex/lib/workosUserId.ts`).
- `getIdentityOrgId(identity)` (`convex/lib/identity.ts`) reads the org claim under each name WorkOS uses.

## Routing

- `proxy.ts` is Next.js 16's replacement for middleware: it runs AuthKit, gates `/admin`, and lists unauthenticated routes in `PUBLIC_PREFIXES`. Add new public routes there.
