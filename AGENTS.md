# AGENTS.md — magnus-crm

> This app is under heavy development with one test tenant on production.
> Any significant schema or data change requires a migration strategy. Use the `convex-migration-helper` skill.

## First Principles

- Check `plans/*/**.md` before starting new feature work.
- Prefer local docs before guessing: `.docs/calendly/index.md`, `.docs/convex/nextjs.md`, `.docs/convex/module-nextjs.md`, `.docs/posthog/nextjs-setup.md`, `.docs/posthog/posthog-convex.md`.
- This is **Next.js 16 App Router**. Before touching framework-sensitive code, read the relevant guide under `node_modules/next/dist/docs/`.
- For Convex + Next.js SSR/preloading/server component work, also read `.docs/convex/nextjs.md` and `.docs/convex/module-nextjs.md`.
- Before any Convex code change, read `convex/_generated/ai/guidelines.md`. Those rules override general Convex knowledge.
- Use repo-local skills from `.agents/skills/<skill-name>/SKILL.md` when the task matches their purpose.

## Core Stack

- Frontend: Next.js 16 App Router, React Server Components by default, Tailwind CSS 4, shadcn/ui (`radix-nova`), lucide-react icons.
- Backend: Convex.
- Auth: WorkOS AuthKit, with Convex token validation.
- Analytics: PostHog client/server events plus Web Vitals reporting.
- State: no Zustand/Redux/Jotai. Use Convex hooks, React context, and local component state.

## Next.js Patterns

- Layouts are Server Components by default; auth checks happen in layouts or server helpers.
- Workspace pages stay thin:

```tsx
export const unstable_instant = false;

export default function Page() {
	return <FeaturePageClient />;
}
```

- Interactive page content lives in `"use client"` `*-page-client.tsx` components.
- Wrap client boundaries in Suspense where the existing page architecture does.
- Server-side Convex calls use `fetchQuery`, `fetchMutation`, `fetchAction`, or `preloadQuery` from `convex/nextjs`.
- Client-side Convex calls use `useQuery`, `useMutation`, `useAction`, and `usePreloadedQuery` from `convex/react`.
- Server redirects use `redirect()` from `next/navigation` or the helpers in `lib/auth.ts`.
- `next.config.ts` enables View Transitions, component caching, and package import optimization. Preserve those assumptions.

## Auth, Tenancy, And RBAC

- One WorkOS organization maps to one Convex tenant. `tenants.workosOrgId` is the linking key.
- Tenant-scoped data must include `tenantId`.
- Never accept tenant, user, or role identity from client arguments when it can be derived from auth.
- System admin access is controlled by `SYSTEM_ADMIN_ORG_ID` and grants `/admin`, not CRM workspace access.
- Tenant lifecycle includes `pending_signup`, `pending_calendly`, `provisioning_webhooks`, `active`, `calendly_disconnected`, `suspended`, and `invite_expired`.

Server auth lives in `lib/auth.ts`:

- `verifySession()`
- `getWorkspaceAccess()`
- `requireWorkspaceUser()`
- `requireRole(roles[])`
- `requireSystemAdmin()`

Convex auth guards:

- `requireTenantUser(ctx, roles[])` for tenant-scoped functions.
- `requireSystemAdminSession(identity)` for admin-only functions.
- Use `getIdentityOrgId(identity)` from `convex/lib/identity.ts` for WorkOS org claim variants.
- Use `convex/lib/workosUserId.ts` for canonical/raw WorkOS user ID handling.

Roles:

- `tenant_master` = owner
- `tenant_admin` = admin
- `closer` = individual contributor

RBAC rules:

- CRM ↔ WorkOS role mapping lives in `convex/lib/roleMapping.ts`.
- Permission checks live in `convex/lib/permissions.ts`.
- Page RSCs use `requireRole(...)`.
- Convex functions use `requireTenantUser(...)`.
- `useRole()` is for UI visibility only. Backend/server code must revalidate every action.

## Workspace Architecture

- `app/workspace/layout.tsx` owns the streaming shell and auth gate.
- `WorkspaceShellFrame` is a server shell with sidebar state above Suspense.
- `WorkspaceAuth` resolves `getWorkspaceAccess()` and redirects/renders accordingly.
- `WorkspaceShellClient` wraps workspace content with `RoleProvider`.
- `WebVitalsReporter` stays outside the auth Suspense boundary.

Skeletons and errors:

- Use `components/ui/skeleton`.
- Match real layout dimensions to avoid CLS.
- Include `role="status"` and `aria-label` on skeleton states.
- Wrap independent sections in `SectionErrorBoundary` where the surrounding page pattern does.

Preloading:

- Use `preloadQuery` in RSCs for high-value initial dashboard data.
- Pass preloaded data into a client component and read it with `usePreloadedQuery`.

## Convex Standards

File map:

- `convex/schema.ts`: source of truth for tables and indexes.
- `convex/requireTenantUser.ts`: tenant auth guard.
- `convex/requireSystemAdmin.ts`: system admin guard.
- `convex/lib/*`: shared validation, permissions, role mapping, status transitions, identity helpers, denormalized ref updates, invite tokens, constants.
- `convex/admin`, `calendly`, `closer`, `pipeline`, `webhooks`, `onboarding`, `users`, `workos`: domain modules.
- `convex/http.ts`: HTTP router.
- `convex/crons.ts`: scheduled jobs.

Schema rules:

- Every tenant data table has `tenantId: v.id("tenants")`.
- Use explicit `v.union(v.literal(...))` status fields, not plain strings.
- Add indexes for frequent query shapes. Name indexes after fields, e.g. `by_tenantId_and_status`.
- Avoid unbounded arrays in documents. Use separate tables.
- Denormalized opportunity meeting refs are maintained via `updateOpportunityMeetingRefs()`.

Function rules:

- Always include `args` validators, including internal functions.
- Use `internalQuery`, `internalMutation`, and `internalAction` for server-only logic.
- Use indexed queries with `.withIndex()`. Avoid `.filter()` for database filtering.
- Return bounded results with `.take(n)`, `.first()`, `.unique()`, or `.paginate()`.
- Do not use `.collect()` without a clear bound. Never use `.collect().length` for counting.
- Actions that need Node builtins must live in a separate `"use node"` file.
- For bulk operations that may exceed transaction limits, batch and continue with `ctx.scheduler.runAfter(0, ...)`.

Webhooks:

- Verify signatures before storing.
- Store raw events in `rawWebhookEvents`.
- Schedule async processing with `ctx.scheduler.runAfter(0, internal.pipeline.processor.processRawEvent, { rawEventId })`.
- Processors route by event type, validate transitions, update records and denormalized refs, then mark events processed.

Crons:

- Use `crons.interval()` or `crons.cron()`.
- Do not use deprecated `.hourly`, `.daily`, or `.weekly` helpers.

Logging:

- Use structured logs with domain tags such as `[Auth]`, `[Pipeline]`, `[Calendly:OAuth]`, `[Closer:Dashboard]`, and `[Admin]`.

## Frontend Standards

Important paths:

- `app/ConvexClientProvider.tsx`: AuthKit, Convex, Calendly guard provider chain.
- `app/workspace/_components/*`: workspace shell, auth, skeletons, page clients, error boundaries.
- `components/ui/*`: shadcn primitives.
- `components/auth/role-context.tsx`: `RoleProvider` and `useRole()`.
- `hooks/*`: shared client hooks such as page title, shortcuts, breadcrumbs, table sort, polling query, PostHog identify, mobile detection.

Naming:

- `*-page-client.tsx` for page-level client components.
- `*-skeleton.tsx` for loading states.
- `*-dialog.tsx` and `*-sheet.tsx` for modal/drawer UI.
- `_components/` for route-private components.

Styling:

- Tailwind CSS 4 with `@tailwindcss/postcss`.
- `app/globals.css` import order: `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`.
- Use `cn()` for class merging.
- Use `cva` for component variants where the existing code does.
- Use lucide-react icons.
- Preserve `next-themes` dark mode behavior and `theme-preference` storage key.

Forms:

- Use React Hook Form + Zod v4 for workspace forms.
- Import `z` from `zod`.
- Use `standardSchemaResolver` from `@hookform/resolvers/standard-schema`; do not use `zodResolver` or `zod/v3`.
- Co-locate Zod schemas with the dialog/component.
- Let resolver infer `useForm` types; avoid explicit generics unless existing code requires them.
- Use shadcn form primitives (`Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`).
- Keep submission/network errors separate from field validation errors.
- For file inputs, do not pass a controlled `value`; wire `onChange` manually.

Dynamic imports:

- Use `next/dynamic` with `ssr: false` for browser-only components such as keyboard shortcuts, local storage, or browser APIs.

## Integrations

Calendly:

- Start with `.docs/calendly/index.md`.
- Preserve OAuth, webhook signature, scope, and rate-limit assumptions.

WorkOS:

- Use the `workos` skill for AuthKit, SSO, SAML, SCIM, Directory Sync, RBAC, organizations, roles, or permissions work.
- Use `convex-dev-workos-authkit` for WorkOS AuthKit sync/events/actions in Convex.
- Use `workos-widgets` for WorkOS Widgets.

PostHog:

- Client events use `posthog-js`.
- Server events use `posthog-node`.
- Proxy rewrites under `/ingest/*` are used to reduce ad blocker loss.
- `usePostHogIdentify()` links user and org context.

## Testing And QA

- This project relies heavily on manual QA. See `TESTING.MD`.
- Use Convex CLI helpers such as `testing/calendly:bookTestInvitee` for test data when relevant.
- Validate backend state with `npx convex data` and `npx convex logs`.
- Verify role-specific UI by signing in as the appropriate test user.
- Add or run automated tests when the repo already has coverage for the area you changed or when risk justifies it.

## Skills Quick Reference

Use the matching skill file before doing specialized work:

- `convex-migration-helper`: schema changes, backfills, widen-migrate-narrow, deployment failures.
- `convex-performance-audit`: slow queries, high read/write cost, Convex insights findings.
- `convex-setup-auth`: Convex auth and identity mapping.
- `convex-dev-workos-authkit`: WorkOS AuthKit with Convex sync/events/actions.
- `convex-create-component`: reusable Convex components or backend boundaries.
- `frontend-design`: new or substantially redesigned UI.
- `shadcn`: shadcn/ui components, registries, styling, composition.
- `next-best-practices`: Next.js file conventions, RSC boundaries, async APIs, metadata, route handlers.
- `vercel-react-best-practices`: React/Next.js performance-sensitive work.
- `vercel-react-view-transitions`: View Transition animations.
- `vercel-composition-patterns`: component API refactors and composition patterns.
- `web-design-guidelines`: UI/UX/accessibility reviews.
- `workos`: WorkOS implementation or debugging.
- `workos-widgets`: WorkOS widget integrations.

## Key Files

- `lib/auth.ts`
- `convex/schema.ts`
- `convex/_generated/ai/guidelines.md`
- `convex/requireTenantUser.ts`
- `convex/requireSystemAdmin.ts`
- `convex/lib/permissions.ts`
- `convex/lib/roleMapping.ts`
- `convex/lib/statusTransitions.ts`
- `app/ConvexClientProvider.tsx`
- `app/workspace/layout.tsx`
- `app/workspace/_components/workspace-auth.tsx`
- `components/auth/role-context.tsx`
- `components/ui/field.tsx`
- `next.config.ts`
- `TESTING.MD`
