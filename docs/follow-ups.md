# Follow-ups from the October 2026 docs audit

These issues came up while rewriting `AGENTS.md` on 2026-10-08. Nothing here has been changed yet. Line numbers are from `main` at that date.

## 1. Unguarded public backfill functions (security)

Four backfill functions are registered as public Convex functions with no auth check. Anyone who can reach the deployment URL can call them with the Convex client, without signing in. Each one loops over every tenant (up to 100 rows from `tenants`), so a call reads or writes data across tenants.

| Function | File | Type | What it does |
| --- | --- | --- | --- |
| `backfillMeetingAttribution` | `convex/attribution/backfills.ts:63` | `mutation` | Patches attribution and booked-program fields on meetings in every tenant (`ctx.db.patch` at line 125) |
| `backfillOpportunityAttribution` | `convex/attribution/backfills.ts:136` | `mutation` | Patches attribution, `qualifiedAt`, and the sold-program cache on opportunities in every tenant (`ctx.db.patch` at line 228) |
| `verifyAttributionBackfill` | `convex/attribution/backfills.ts:240` | `query` | Returns counts of meetings and opportunities missing backfilled fields across all tenants |
| `backfillUnassignedWorkersToTeam` | `convex/leadGen/backfills.ts:182` | `mutation` | Sets `teamId` on lead gen submissions and rewrites lead gen daily stats (patches at lines 222, 274, and 297) |

All four take `dryRun` and `limit` arguments, so a caller can pass `dryRun: false` and write data.

The comment above `backfillUnassignedWorkersToTeam` says it's public on purpose so it can run from the Convex CLI. The CLI doesn't need that: `npx convex run` can call internal functions.

No code in `app/`, `components/`, `lib/`, or `convex/` calls these functions, so changing them doesn't break any caller.

### Fix

1. In `convex/attribution/backfills.ts`, change `mutation` to `internalMutation` for the two backfills and `query` to `internalQuery` for `verifyAttributionBackfill`. Import both from `../_generated/server`.
2. In `convex/leadGen/backfills.ts`, change `backfillUnassignedWorkersToTeam` to `internalMutation` and delete the "intentionally public" comment. Leave `rebuildTeamOriginStatsRange` public; it already calls `requireTenantUser`.
3. Run `pnpm typecheck` and `pnpm convex:dev`, then confirm `npx convex run attribution/backfills:verifyAttributionBackfill '{}'` still works from the CLI.
4. If the backfills have already run on production and their results check out, delete them instead.

### Related check

A scan of every exported `mutation`, `query`, and `action` in `convex/` found no other unguarded function except `submitSupportRequest` (`convex/support.ts:34`), which is public on purpose and uses a honeypot field and length checks. The scan looked for guard calls by name, so a manual review of new public functions is still worth doing.

## 2. Unused code

None of these files are imported anywhere in `app/`, `components/`, `lib/`, `hooks/`, or `convex/`.

| File | Lines | Notes |
| --- | --- | --- |
| `app/workspace/_components/workspace-shell.tsx` | 356 | Marked `@deprecated`; replaced by `workspace-shell-frame.tsx`, `workspace-auth.tsx`, and `workspace-shell-client.tsx` |
| `app/workspace/_components/stats-section.tsx` | 21 | Leftover dashboard section |
| `app/workspace/_components/pipeline-section.tsx` | 20 | Leftover dashboard section |
| `components/ui/stream-boundary.tsx` | 36 | Unused streaming wrapper |
| `lib/posthog-capture.ts` | 69 | Server-side capture helper that reads the PostHog cookie; server events go through `lib/posthog-server.ts` instead |

### Fix

Delete the five files, then run `pnpm typecheck` and `pnpm lint`.

## 3. Orphaned View Transition CSS

`app/globals.css:148-178` styles `.page-transition` view transitions (selectors plus the `vt-fade-out` and `vt-fade-in` keyframes), and its comment says `workspace-shell-client.tsx` renders `<ViewTransition default="page-transition">`. No `<ViewTransition>` exists anywhere in the code, and `next.config.ts` doesn't enable the feature, so the rules never apply. The reduced-motion rules at `app/globals.css:275-277` reset the same pseudo-elements.

### Fix

Either delete the page-transition CSS and its comment, or wire up View Transitions with the `vercel-react-view-transitions` skill and fix the comment to point at the real component.

## 4. Stale closer meeting README

`app/workspace/closer/meetings/_components/README.md` (291 lines) documents the meeting detail components as of "Phase 7". It lists a `MeetingNotes` component that no longer exists (comments replaced notes) and omits current components such as `meeting-comments.tsx`, `deal-won-card.tsx`, `attribution-card.tsx`, and `reschedule-chain-banner.tsx`.

### Fix

Delete it. The component files and `docs/agents/frontend.md` cover the conventions, and a hand-maintained component inventory goes stale with each feature.

## 5. Environment variables that no code reads

`.env.convex.production` and `.env.vercel.production` set `CALENDLY_WEBHOOK_SIGNING_KEY`, `WORKOS_WEBHOOK_SECRET`, and `WORKOS_ENVIRONMENT_ID`, but nothing in `app/`, `lib/`, or `convex/` reads them. Calendly webhook secrets are per tenant and stored in `tenantCalendlyConnections`, and no app code handles WorkOS webhooks. `.env.vercel.production` also lists `CALENDLY_CLIENT_SECRET`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `WORKOS_COOKIE_PASSWORD` twice.

`NEXT_PUBLIC_CALENDLY_CLIENT_ID` in `.env.local` is read only by Convex, as a fallback for `CALENDLY_CLIENT_ID`; Next.js never reads it, and Convex can't see `.env.local`.

### Fix

Confirm the three variables are unused on the Vercel and Convex dashboards, then remove them along with the duplicate entries. Set `CALENDLY_CLIENT_ID` on each Convex deployment and drop the `NEXT_PUBLIC_CALENDLY_CLIENT_ID` fallback in `convex/admin/tenants.ts`, `convex/calendly/healthCheck.ts`, `convex/calendly/oauth.ts`, and `convex/calendly/tokens.ts`.
