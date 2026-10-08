# Follow-ups from the October 2026 docs audit

These issues came up while rewriting `AGENTS.md` on 2026-10-08. Nothing here has been changed yet. Line numbers are from `main` at that date.

## 1. Unused code

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

## 2. Orphaned View Transition CSS

`app/globals.css:148-178` styles `.page-transition` view transitions (selectors plus the `vt-fade-out` and `vt-fade-in` keyframes), and its comment says `workspace-shell-client.tsx` renders `<ViewTransition default="page-transition">`. No `<ViewTransition>` exists anywhere in the code, and `next.config.ts` doesn't enable the feature, so the rules never apply. The reduced-motion rules at `app/globals.css:275-277` reset the same pseudo-elements.

### Fix

Either delete the page-transition CSS and its comment, or wire up View Transitions with the `vercel-react-view-transitions` skill and fix the comment to point at the real component.

## 3. Stale closer meeting README

`app/workspace/closer/meetings/_components/README.md` (291 lines) documents the meeting detail components as of "Phase 7". It lists a `MeetingNotes` component that no longer exists (comments replaced notes) and omits current components such as `meeting-comments.tsx`, `deal-won-card.tsx`, `attribution-card.tsx`, and `reschedule-chain-banner.tsx`.

### Fix

Delete it. The component files and `docs/agents/frontend.md` cover the conventions, and a hand-maintained component inventory goes stale with each feature.

## 4. Environment variables that no code reads

`.env.convex.production` and `.env.vercel.production` set `CALENDLY_WEBHOOK_SIGNING_KEY`, `WORKOS_WEBHOOK_SECRET`, and `WORKOS_ENVIRONMENT_ID`, but nothing in `app/`, `lib/`, or `convex/` reads them. Calendly webhook secrets are per tenant and stored in `tenantCalendlyConnections`, and no app code handles WorkOS webhooks. `.env.vercel.production` also lists `CALENDLY_CLIENT_SECRET`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and `WORKOS_COOKIE_PASSWORD` twice.

`NEXT_PUBLIC_CALENDLY_CLIENT_ID` in `.env.local` is read only by Convex, as a fallback for `CALENDLY_CLIENT_ID`; Next.js never reads it, and Convex can't see `.env.local`.

### Fix

Confirm the three variables are unused on the Vercel and Convex dashboards, then remove them along with the duplicate entries. Set `CALENDLY_CLIENT_ID` on each Convex deployment and drop the `NEXT_PUBLIC_CALENDLY_CLIENT_ID` fallback in `convex/admin/tenants.ts`, `convex/calendly/healthCheck.ts`, `convex/calendly/oauth.ts`, and `convex/calendly/tokens.ts`.
