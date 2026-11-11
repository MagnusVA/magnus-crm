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
| `lead_generator` | `lead-generator` | Lead gen worker; can capture leads, respark their own batch, and view their own capture and respark activity (My Activity) |

- `convex/lib/roleMapping.ts` maps WorkOS slugs to CRM roles, and an unknown slug maps to `closer`.
- `convex/lib/permissions.ts` defines the permission slugs (`reports:view`, `billing:*`, `lead-gen:capture`, and others) and which roles hold them. Gate new features on a permission slug when one fits.
- AI assistants: `mcp:connect` (closers, lead generators, owners and admins) lets a role use MCP tools once the tenant switches the role on; `mcp:manage-admin-access` (owners only) switches admin roles on or off, chooses which kinds of change admins' assistants may make, and blocks or unblocks an admin; `second-opinion:review` (owners and admins) works the second-opinion queue, sees results during the shadow run, and can run Jev again on a check (`secondOpinion.rerun`); `second-opinion:manage` (owners only) turns the second opinion on, because it sends recorded calls to a model provider.
- Closers see only records where they're the assigned or attributed closer; `convex/leadCustomers/permissions.ts` enforces this per record.
- `lead-gen:respark` (lead generators and admins) covers the Respark screen, its queries and its actions. A lead generator also needs an active lead gen worker: turning their lead gen access off stops every respark read and action, held batch included. Lead generators can't open person pages; the respark person panel (`getResparkPersonPanel` in `convex/respark/queries.ts`) answers only for an item in the caller's own unexpired batch, returns null otherwise, and masks phone and email on the server.
- DM closers (`dmClosers` table) and Slack qualifiers (`slackUsers` table) aren't CRM users and have no role.

## Guards by surface

| Surface | Guard |
| --- | --- |
| Next.js pages and layouts | `requirePermission(slug)` or `requireRole(roles)` from `lib/auth.ts`; `requireWorkspaceUser()` admits any tenant member. Denied users redirect to their role's home page. |
| Convex queries and mutations | `requireTenantUser(ctx, roles)`, which returns `{ userId, tenantId, role, workosUserId }` |
| Convex actions | `requireTenantUserFromAction(ctx, roles)`. Older actions call `requireIdentity(ctx)` and authorize by hand, skipping WorkOS ID canonicalization; use the shared guard in new code. |
| Billing | `requireBillingPermission` plus `requireBillingOpsEnabled` from `convex/billing/guards.ts`; the second enforces the tenant's `billingOpsEnabled` flag |
| System admin (`/admin`) | `requireSystemAdmin()` in Next.js and `requireSystemAdminSession(identity)` in Convex. Membership means the identity's org equals `SYSTEM_ADMIN_ORG_ID`, and `/workspace` redirects system admins to `/admin`. `convex/admin/` also holds tenant-admin code (`meetingActions.ts`), so check each function's guard rather than its folder. |
| DM link portal (`/dm-links/[portalSlug]`) | Shared password, outside WorkOS. Public functions take a `sessionToken` and verify it with `verifyPortalSessionToken` (`convex/linkPortal/sessionToken.ts`, Web Crypto). The bootstrap is a query (`getPortalBootstrap`); the actions call internal functions that run `assertActivePortalSession` (`convex/linkPortal/leadSession.ts`). The tenant comes from the token. Which event types a DM closer can copy links for comes from booking coverage (`convex/lib/bookingSetup/coverage.ts`); the bootstrap and the copy mutation apply the same rule. |
| Webhooks | Signature verification; see `docs/agents/convex.md` |
| MCP tools (`/mcp`) | The mount verifies AuthKit access tokens (issuer `AUTHKIT_DOMAIN`, audience `MCP_RESOURCE_URL`); each tool runs `requireMcpUser(ctx, caller, roles)`, or `requireMcpAdmin(ctx, caller, { family, permission })` for admin tools, from `convex/mcp/guard.ts` on the injected caller. See "AI assistants over MCP" in `docs/agents/convex.md` |
| Assistant plan approvals (`/workspace/assistant/approvals/[planId]`) | `getPlan`, `approvePlan` and `declinePlan` in `convex/mcp/approvals.ts` run `canApprove`, which repeats every check the MCP guard makes (reading switch, kind of change, permission, block, Billing switch, no switch changed since the plan was made) for the web user, and admits only the proposer or the owner. A closer can't open the page; another workspace's plan, or the ID of a closer's chat token, answers `plan.not_found`. |
| UI | `useRole()` and `<RequirePermission>` (`components/auth/`) only control what renders |

Lead generators also hold `mcp:connect` and use their own toolset while their role switch is on; admins with `settings:manage` can switch them on or block them. The retained lead gen admin reads use `requireMcpAdmin` with `lead-gen:view-all`, so the owner's admin reading switch and member blocks apply.

ESLint's `@convex-dev/require-access-control` rule fails any public Convex function whose handler doesn't call a guard at its top level. The accepted guard names are listed in `CONVEX_ACCESS_GUARDS` in `eslint.config.mjs`; add a new guard there. A function that is public on purpose gets an `eslint-disable-next-line` comment that says why.

## Identity helpers

- `users.workosUserId` holds either the canonical or the raw WorkOS ID, so look users up with every value from `getWorkosUserIdCandidates` (`convex/lib/workosUserId.ts`). The candidates always include the user-management form, so a token from another issuer, such as AuthKit's MCP tokens, finds the same user.
- `getIdentityOrgId(identity)` (`convex/lib/identity.ts`) reads the org claim under each name WorkOS uses.

## Routing

- `proxy.ts` is Next.js 16's replacement for middleware: it runs AuthKit, gates `/admin`, and lists unauthenticated routes in `PUBLIC_PREFIXES`. Add new public routes there.
- The proxy's matcher skips router prefetches (the `next-router-prefetch` header) and the Convex log stream. Prefetches fetch static shells, so a page must read the session behind `connection()`, as `verifySession` does, never in its static shell.
- A sign-in callback that fails (`app/callback/route.ts`) redirects to `/sign-in/error?reason=…`, a public page with a "Sign in again" link to `/sign-in`. The callback URL can't be retried, since its code and verifier cookie work once, and the page never redirects on its own, so a broken setup can't loop. `lib/sign-in-failure.ts` holds the reasons and decides which failures are rejections.
- A Server Component can't refresh the session: `refreshSession()` spends the single-use refresh token and then fails to write the cookie. A server read whose token expired before Convex checked it (`lib/convex-server-reads.ts`) redirects to the same page with `?auth_retry=<ms>`, so the proxy refreshes where the cookie can be saved. A request that arrives with a marker under a minute old doesn't redirect again.
- When Convex fails the access query in `getWorkspaceAccess` (`lib/auth.ts`), the gate redirects to `/unavailable` in place of the error screen. Convex disabling the deployment at the spending limit is the case it was built for; a production deployment redacts the message, so any failure of that query goes there. The page makes no Convex call, loads `/workspace` again after 10, 30, 60, 120 and 300 seconds, then waits for its button (`lib/unavailable-retries.ts`).
- The browser's Convex token comes from `app/api/auth/token/route.ts`, not AuthKit's `useAccessToken`. Don't write a cookie from a server action on a timer: Next then clears the client's prefetch cache and re-renders the page on the server.
