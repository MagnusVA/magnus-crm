# Dead Code And Reachability Audit

Date: 2026-05-05

## Scope

Audited the application source under `app/`, `components/`, `hooks/`, `lib/`, `convex/`, `public/`, and project tooling/config. I treated Next App Router files, Convex public functions, Convex cron/http entrypoints, shadcn primitives, and one-shot migration utilities as special cases because naive import-graph checks produce false positives there.

Commands run:

```bash
npx tsc --noEmit
npm run lint
npm run lint -- --ignore-pattern '.agents/**' --ignore-pattern '.claude/**' --ignore-pattern 'convex/_generated/**'
npx --yes knip --reporter json
```

I also built a local route/function reference map with `rg`, `find`, and a small Node import/reference scan.

## Executive Summary

- `npx tsc --noEmit` passes.
- No broken static internal Next routes were found. Static paths like `/workspace/reports/team`, `/workspace/profile`, `/api/slack/start`, and auth/onboarding redirects map to real routes.
- There is a high-confidence obsolete dashboard streaming layer left behind after the dashboards moved to client-page wrappers.
- There are several Convex functions with no inbound `api.*`/`internal.*` references. Some are likely truly unreachable; migration/admin one-shots need confirmation before deletion.
- `npm run lint` currently fails partly because ESLint scans local `.agents` skill files and Convex generated files. With those ignored, lint still fails on two React Compiler `set-state-in-effect` errors and reports 25 warnings, including several real unused locals.
- Several shadcn primitives and their backing packages are unused in the app today. These are safe to remove only if the team wants a lean design-system surface rather than keeping registry scaffolding.

## High-Confidence Delete Candidates

These files have no app imports and are superseded by current implementations.

### Obsolete Workspace Shell

- `app/workspace/_components/workspace-shell.tsx`

Evidence:

- The file itself says it is deprecated and can be deleted once imports are updated at lines 1-9.
- Current layout imports `WorkspaceShellFrame`, `WorkspaceAuth`, and `WorkspaceShellSkeleton`, not `WorkspaceShell`.
- Current auth imports `WorkspaceShellClient` from `workspace-shell-client`.

Risk: low. Delete this file after one final `rg "WorkspaceShell"` check.

### Obsolete Admin Dashboard Streaming Wrappers

- `app/workspace/_components/stats-section.tsx`
- `app/workspace/_components/stats-row-client.tsx`
- `app/workspace/_components/pipeline-section.tsx`
- `app/workspace/_components/pipeline-summary-client.tsx`
- `app/workspace/_components/system-health-section.tsx`
- `app/workspace/_components/dashboard-header.tsx`

Evidence:

- `app/workspace/page.tsx` renders `DashboardPageClient`.
- `DashboardPageClient` imports `StatsRow`, `PipelineSummary`, `SystemHealth`, `SlackMetricsSection`, and `TimePeriodFilter` directly.
- The listed wrappers still use the older `preloadQuery`/`usePreloadedQuery` section model and have no inbound imports.

Risk: low to medium. Low runtime risk, but remove as one dashboard cleanup batch and run typecheck afterward.

### Obsolete Closer Dashboard Streaming Wrappers

- `app/workspace/closer/_components/closer-dashboard-header.tsx`
- `app/workspace/closer/_components/featured-meeting-section.tsx`
- `app/workspace/closer/_components/featured-meeting-card-wrapper.tsx`
- `app/workspace/closer/_components/pipeline-strip-section.tsx`

Evidence:

- `app/workspace/closer/page.tsx` renders `CloserDashboardPageClient`.
- `CloserDashboardPageClient` imports and renders `FeaturedMeetingCard`, `RemindersSection`, `PipelineStrip`, and `CalendarSection` directly.
- The listed files use the previous preloaded-section pattern and have no inbound imports.

Risk: low to medium. Delete as one closer-dashboard cleanup batch.

### Obsolete Meeting-Overran Dialog

- `app/workspace/closer/meetings/_components/meeting-overran-context-dialog.tsx`

Evidence:

- `rg "MeetingOverranContextDialog|meeting-overran-context-dialog"` only finds the file itself.
- The active overran UI is now informational via `meeting-overran-banner.tsx`, and admin review resolution uses the reviews route/components.

Risk: medium. It still calls `api.closer.meetingOverrun.respondToOverranReview`; confirm no intended v1 closer-response flow remains before deleting the paired public mutation.

### Unused Slack Settings Skeleton

- `app/workspace/settings/_components/integrations/slack-integration-card-skeleton.tsx`

Evidence:

- `SettingsPage` preloads `api.slack.channels.getInstallationStatus`.
- `SettingsPageClient` renders `SlackIntegrationCard` directly.
- No code imports `SlackIntegrationCardSkeleton`.

Risk: low. Either delete it or wire it into a local Suspense fallback.

### Unused Libraries

- `lib/deployment-environment.ts`
- `lib/posthog-capture.ts`

Evidence:

- No imports of `isNonProductionDeployment`.
- No imports of `captureServerEvent`; server analytics currently call `getPostHogClient` directly from `lib/posthog-server.ts`.

Risk: low. `lib/posthog-capture.ts` is a useful helper if planned, but it is currently dead.

## Convex Reachability Findings

### Likely Unreachable Internal Functions

These are internal Convex functions with no inbound `internal.*` references from app or Convex code. Internal functions are not client-callable entrypoints, so these are stronger dead-code candidates than unreferenced public queries/actions.

- `convex/pipeline/queries.ts`: `getLeadByEmail`, `getMeetingByCalendlyEventUri`, `getUserByCalendlyUri`, `getFollowUpOpportunity`, `getEventTypeConfig`
- `convex/calendly/webhookSetup.ts`: `provisionWebhooks`
- `convex/admin/tenants.ts`: `testWorkosConnection`
- `convex/meetings/maintenance.ts`: `backfillMeetingLinks`
- `convex/opportunities/maintenance.ts`: `repairAssignmentsFromCalendlyHosts`
- `convex/tenantPrograms/seed.ts`: `ensureInitialProgramForTenant`
- `convex/tenants.ts`: `getByWorkosOrgId`
- `convex/slack/users.ts`: `byTenantAndSlackUserId`, `upsertOnSubmission`
- `convex/testing/calendly.ts`: all exported internal testing actions
- `convex/testing/operationalData.ts`: `resetOperationalData` and its internal query/mutation helpers
- `convex/workos/userMutations.ts`: `createUserWithCalendlyLink`, `normalizeStoredWorkosUserIds`

Notes:

- `convex/pipeline/queries.ts` comments still claim these helpers are used by webhook handlers, but current handlers query directly.
- `convex/slack/users.ts` has a useful direct helper `upsertSlackUserOnSubmission`; only the internal mutation wrapper appears unused.
- The testing/operational reset functions are destructive. If they are intentionally retained, expose them through a deliberate public/admin-only wrapper or move them to documented maintenance tooling; as internal-only functions with no callers, they lead nowhere.

### Public Convex Functions With No App References

Public functions can be manually run from Convex tooling, so these are not automatic delete candidates. They are still worth classifying because they are not reachable through the shipped UI/RSC/API routes.

Migration/admin one-shots:

- Most exports in `convex/admin/migrations.ts`
- `convex/admin/rawWebhookReplay.ts`: `previewFreshStartFromRawWebhooks`, `rebuildFreshStartFromRawWebhooks`

Feature/public API candidates:

- `convex/admin/tenantsQueries.ts`: `getTenant`
- `convex/closer/followUp.ts`: `createFollowUp`
- `convex/closer/followUpMutations.ts`: `markReminderComplete`
- `convex/closer/meetingOverrun.ts`: `scheduleFollowUpFromOverran`
- `convex/closer/payments.ts`: `getPaymentProofUrl`
- `convex/leads/mutations.ts`: `updateLead`
- `convex/slack/metrics.ts`: `perPlatformConversion`
- `convex/workos/userMutations.ts`: public `claimInvitedAccount` mutation

Recommended handling:

- Keep migration/raw replay functions until a migration inventory confirms which production one-shots are still needed.
- Strongly consider deleting or internalizing the feature/public API candidates if no UI or route will call them.
- For WorkOS, the active flow uses `api.workos.userActions.claimInvitedAccount` from `lib/auth.ts`; the public mutation appears superseded.

## Paths And Navigation

No static internal URLs were found that map to missing App Router routes.

Stale navigation-adjacent issue:

- `components/command-palette.tsx` has stale page/shortcut definitions compared with `app/workspace/_components/workspace-shell-client.tsx`.
- Shell admin order is Overview, Pipeline, Reviews, Leads, Customers, Opportunities, Team, Settings.
- Command palette admin order is Overview, Team, Pipeline, Settings, Opportunities.
- Command palette closer includes `My Schedule` with the same href as `Dashboard`.

This does not lead to a 404, but it does create an unreachable/discoverability gap for Reviews, Leads, Customers, and Reports from the command palette, and shortcut labels do not match the real Cmd+1-4 handlers.

## Unused UI Primitives And Scaffold

Knip reports these whole files as unused:

- `components/ui/accordion.tsx`
- `components/ui/aspect-ratio.tsx`
- `components/ui/button-group.tsx`
- `components/ui/carousel.tsx`
- `components/ui/context-menu.tsx`
- `components/ui/direction.tsx`
- `components/ui/drawer.tsx`
- `components/ui/hover-card.tsx`
- `components/ui/input-otp.tsx`
- `components/ui/item.tsx`
- `components/ui/menubar.tsx`
- `components/ui/native-select.tsx`
- `components/ui/navigation-menu.tsx`
- `components/ui/pagination.tsx`
- `components/ui/resizable.tsx`
- `components/ui/slider.tsx`
- `components/ui/stream-boundary.tsx`

Treat these as design-system inventory, not guaranteed dead product code. If removed, also remove now-unused dependencies:

- `embla-carousel-react` with `components/ui/carousel.tsx`
- `input-otp` with `components/ui/input-otp.tsx`
- `react-resizable-panels` with `components/ui/resizable.tsx`
- `vaul` with `components/ui/drawer.tsx`

`@base-ui/react` is currently only used by `components/ui/combobox.tsx`; keep it unless combobox is removed too.

## Unused Assets

No app references were found for:

- `public/file.svg`
- `public/globe.svg`
- `public/next.svg`
- `public/vercel.svg`
- `public/window.svg`
- `public/icon-192.png`
- `public/icon-512.png`
- `public/magnus-favicon-assets.zip`
- `public/.DS_Store`

Keep the favicon files referenced by `app/layout.tsx` and the Magnus SVGs referenced by `components/magnus-brand.tsx`.

## Dependency Findings

Likely removable direct dependencies:

- `@convex-dev/workos`: no direct import; it is also pulled transitively by `@convex-dev/workos-authkit`.
- `embla-carousel-react`, `input-otp`, `react-resizable-panels`, `vaul`: only used by unused shadcn primitive files.
- `react-scan`: only referenced in a commented-out `<Script>` block in `app/layout.tsx`.

Keep:

- `@convex-dev/workos-authkit`, `@convex-dev/migrations`, `@convex-dev/aggregate`, `@slack/types`.

## Lint-Level Dead Locals

App-only lint still reports unused values that can be cleaned independently:

- `app/workspace/closer/_components/week-view.tsx`: `todayColumnIndex`
- `app/workspace/closer/meetings/_components/reschedule-link-display.tsx`: `opportunityId`
- `app/workspace/pipeline/meetings/_components/admin-action-bar.tsx`: `payments`
- `hooks/use-polling-query.ts`: `fetchData`; docs mention exposing `refetch`, but the hook returns only data
- `convex/customers/mutations.ts`: `updateTenantStats` import
- `convex/lib/outcomeHelpers.ts`: `updateTenantStats` import
- `convex/admin/migrations.ts`: `PaymentType` import
- `convex/reporting/revenueTrend.ts`: destructured `start`, `end`

There are also lint warnings where variables intentionally start with `_` but the current lint config still reports them (`_meetings`, `_meeting`, `_doc`, `_candidates`). Either remove the unused values or adjust lint args to ignore underscore-prefixed unused bindings.

## Tooling Noise

`npm run lint` currently scans paths that should not be part of app lint:

- `.agents/skills/...`
- `.claude/...`
- `convex/_generated/...`

That causes false failures from local skill reference scripts and generated files. Add global ignores for those paths in `eslint.config.mjs` before using lint as a reliable cleanup gate.

## Recommended Cleanup Sequence

1. Update ESLint ignores so the lint signal is about this app only.
2. Delete high-confidence obsolete React files: old workspace shell, admin dashboard wrappers, closer dashboard wrappers, unused Slack skeleton, and unused `lib/*` helpers.
3. Clean lint-level unused locals and fix the two React Compiler errors.
4. Update command palette definitions to match `workspace-shell-client` navigation and reports.
5. Audit Convex public/manual migration functions separately. Do not delete migration functions until they are marked completed/not-needed for production.
6. Delete or document unreachable internal Convex functions. Be especially careful with destructive testing/maintenance functions.
7. Decide whether unused shadcn primitives are kept as design-system scaffold. If not, remove the paired dependencies and unused public assets in the same PR.

