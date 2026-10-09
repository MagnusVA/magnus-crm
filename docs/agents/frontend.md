# Frontend

This guide covers how pages, components, forms, styling, and analytics are built in the Next.js app. Access checks are in `docs/agents/auth.md`.

## Pages

`next.config.ts` sets `cacheComponents: true`, and workspace pages opt out of instant navigation with `export const unstable_instant = false`. A `page.tsx` is a thin async server component that runs a gate, then renders a `"use client"` `*-page-client.tsx`. Pages take one of two shapes:

```tsx
// List and dashboard pages stream behind a skeleton
// (app/workspace/operations/qualifications/page.tsx)
export default async function OperationsQualificationsPage() {
  await requireRole(["tenant_master", "tenant_admin"]);

  return (
    <Suspense fallback={<QualificationsPageSkeleton />}>
      <QualificationsPageClient />
    </Suspense>
  );
}
```

```tsx
// Detail pages preload for usePreloadedQuery
// (app/workspace/pipeline/meetings/[meetingId]/page.tsx)
export default async function AdminMeetingDetailPage({
  params,
}: {
  params: Promise<{ meetingId: string }>;
}) {
  const { session } = await requireRole(["tenant_master", "tenant_admin"]);
  const { meetingId } = await params;

  const preloadedDetail = await preloadQuery(
    api.closer.meetingDetail.getMeetingDetail,
    { meetingId: meetingId as Id<"meetings"> },
    { token: session.accessToken },
  );

  return <AdminMeetingDetailClient preloadedDetail={preloadedDetail} />;
}
```

A `layout.tsx` can hold the gate for a whole section instead: `app/workspace/reports/layout.tsx` calls `requirePermission("reports:view")`.

- Server-side Convex calls (`preloadQuery`, `fetchQuery`, `fetchMutation`) pass `{ token: session.accessToken }`.
- Workspace routes have a `loading.tsx`. Skeletons use `components/ui/skeleton`, match the real layout's dimensions, and carry `role="status"` and an `aria-label`.
- `SectionErrorBoundary` (`app/workspace/_components/section-error-boundary.tsx`) wraps sections that load independently.
- The lead and customer UI lives under `/workspace/leads-customers`. The `leads`, `customers`, `opportunities`, `pipeline`, `operations`, `reports`, and `lead-gen` index pages only redirect, so build new screens on the canonical routes. Shared components still sit in `leads/_components` and `opportunities/_components`.

## App shell

`app/workspace/layout.tsx` renders `WorkspaceShellFrame` (sidebar), then `WorkspaceAuth` inside Suspense, which resolves `getWorkspaceAccess()` and redirects or renders `WorkspaceShellClient` (`RoleProvider`, PostHog identify, command palette). `app/ConvexClientProvider.tsx` nests AuthKit, Convex, and the Calendly and Slack connection guards. Routes outside the workspace include `/admin`, `/onboarding`, `/dm-links/[portalSlug]` (with server actions in `actions.ts`), `/support`, and the OAuth start routes under `/api`.

## Naming

Page clients are `*-page-client.tsx`, loading states `*-skeleton.tsx`, modals `*-dialog.tsx`, and drawers `*-sheet.tsx`. Route-private components go in `_components/`, with route-specific hooks beside them as `use-*.ts`. Shared hooks live in `hooks/`; page clients set the tab title with `usePageTitle`.

## Forms

- Forms use React Hook Form with Zod 4: `standardSchemaResolver` from `@hookform/resolvers/standard-schema`, the schema defined in the same file, and `useForm` types inferred from the resolver.
- Fields use `components/ui/form` (`Form`, `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage`), laid out with `FieldGroup` from `components/ui/field.tsx`. Small forms without React Hook Form use `Field`, `FieldLabel`, and `FieldError` directly.
- Submission errors go in a local `submitError` state or `toast.error`, apart from field validation errors.
- File inputs wire `onChange` by hand and take no controlled `value`.

## UI and styling

- shadcn/ui uses the `radix-nova` style on the `radix-ui` package; add and change primitives with the `shadcn` skill. `cva` variants stay inside `components/ui`.
- Keep the `app/globals.css` import order: `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`. Merge classes with `cn()` from `lib/utils`.
- `next-themes` defaults to light with system theme off and stores the choice under `theme-preference`.
- Dialogs load lazily through `next/dynamic`. Reserve `ssr: false` for browser-only code such as the command palette and calendar.

## Analytics

PostHog runs only in production with a token set (`lib/posthog-config.ts`). The client initializes in `instrumentation-client.ts` and sends through the `/ingest` proxy rewrites in `next.config.ts`. Only `usePostHogIdentify` and sign-out call `identify`. Server events use `getPostHogClient()` from `lib/posthog-server.ts`. `instrumentation.ts` reports server errors, and route error boundaries and `SectionErrorBoundary` report what they catch; `docs/agents/observability.md` covers error tracking and logs. For Convex and server-rendering patterns with Next.js, see `.docs/convex/nextjs.md`.
