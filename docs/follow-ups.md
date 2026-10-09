# Follow-ups from the October 2026 audits

Sections 1 to 5 came up while rewriting `AGENTS.md` on 2026-10-08; line numbers there are from `main` at that date. Sections 6 to 10 came out of the observability audit the same day and need a product or design decision before anyone changes them. Nothing here has been changed yet.

## 1. Unused code

None of these files are imported anywhere in `app/`, `components/`, `lib/`, `hooks/`, or `convex/`.

| File | Lines | Notes |
| --- | --- | --- |
| `app/workspace/_components/stats-section.tsx` | 21 | Leftover dashboard section |
| `app/workspace/_components/pipeline-section.tsx` | 20 | Leftover dashboard section |
| `components/ui/stream-boundary.tsx` | 36 | Unused streaming wrapper |

### Fix

Delete the three files, then run `pnpm typecheck` and `pnpm lint`.

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

`NEXT_PUBLIC_CALENDLY_CLIENT_ID` in `.env.local` is no longer read anywhere; Convex now reads only `CALENDLY_CLIENT_ID`.

### Fix

Confirm the three variables are unused on the Vercel and Convex dashboards, then remove them along with the duplicate entries and `NEXT_PUBLIC_CALENDLY_CLIENT_ID`.

## 5. Optional Convex environment variables

`convex/convex.config.ts` declares the Slack, DM portal, and app URL variables with `v.optional` because nobody had confirmed they're set on production. A deploy checks required variables, so declaring an unset one as required would fail the production deploy.

### Fix

Run `npx convex env list --prod` and compare the names with `convex/convex.config.ts`. For each optional variable that is set on dev and production, drop its `v.optional` wrapper, then remove any `?? ""` fallbacks and "not set" checks that the required type makes unnecessary.

## 6. DM portal lockout can be bypassed

`verifyPassword` in `convex/linkPortal/passwordActions.ts` is a public action that takes `ipHash` as an argument, and the lockout in `convex/linkPortal/rateLimitMutations.ts` counts failed attempts per `ipHash`. The Next.js server action computes the hash from the requester's IP, but anyone calling Convex directly can send a new `ipHash` on every attempt and guess the shared portal password without ever being locked out. Failed attempts and lockouts are now logged (`link_portal.auth.password_rejected`, `link_portal.auth.locked_out`), so an attack would be visible, not blocked.

### Fix

Make the Convex function trust only a hash it can verify. Either make `verifyPassword` an `internalAction` called through a route that computes the hash server-side, or have the Next.js action sign the `ipHash` with a shared secret that Convex checks. Add a per-portal attempt limit as well, so one portal can't be brute-forced from many IPs.

## 7. Out-of-order Calendly cancels and no-shows are dropped

When an `invitee.canceled` or `invitee_no_show.*` webhook is processed before its `invitee.created`, the handlers in `convex/pipeline/inviteeCanceled.ts` and `convex/pipeline/inviteeNoShow.ts` find no meeting and mark the event processed. The meeting then stays `scheduled` forever. Both events are scheduled with `runAfter(0)`, so the race is real. `classifyMissingMeeting` in `convex/pipeline/missingMeeting.ts` now tells this case apart and reports it as `pipeline.event_dropped:<event type>:out_of_order`, but the event is still lost.

### Fix

When the matching `invitee.created` exists but is unprocessed, leave the cancel or no-show unprocessed and reschedule `processRawEvent` for it after a delay, with an attempt cap. Decide what happens when the cap is hit: report it and stop, or apply the cancel once the booking lands.

## 8. Failed booking events are never retried

If `processRawEvent` (`convex/pipeline/processor.ts`) throws, for example `no_assigned_closer` in `inviteeCreated.ts` or an unparseable payload, the raw event stays `processed: false` and nothing processes it again. The only recovery is the system-admin replay in `convex/admin/rawWebhookReplay.ts`. The new `pipeline-stuck-events` cron reports these as `pipeline.events_stuck_unprocessed` every 15 minutes until someone replays or deletes them, so the alert keeps firing while the booking is missing from the CRM.

### Fix

Decide which failures are worth retrying. Transient ones (write conflicts, timeouts) could retry automatically with backoff and an attempt counter on `rawWebhookEvents` (a schema change, so plan the migration). Permanent ones such as `no_assigned_closer` need a person, so the alert should link to the replay tool, and replayed or deleted events should stop counting as stuck.

## 9. Payment corrections keep old and new note values in domain events

`buildCorrectionMetadata` in `convex/billing/mutations.ts` writes the `{ from, to }` of every changed field into the `payment.corrected` domain event, including the free-text `note` and `referenceCode`. That event is the only history of the previous values. These nested values don't reach PostHog, because `captureDomainEvent` only forwards flat values, but the free text stays in `domainEvents` for good.

### Fix

Decide whether correction history should keep free text. If it should, leave it and document it as intentional. If not, record `noteChanged: true` instead of the values, accepting that the old note is gone after a correction.

## 10. Ownership checks throw plain errors

Ownership checks such as "Not your opportunity", "Not your meeting", and "Not your reminder" throw a plain `Error` in `convex/closer/` (`followUp.ts`, `followUpMutations.ts`, `meetingActions.ts`, `meetingComments.ts`, `meetingDetail.ts`, `noShowActions.ts`, `payments.ts`, `reminderOutcomes.ts`) and in `convex/lib/outcomeEligibility.ts`. The observability classifier treats them as expected rejections, but production redacts a plain `Error` message, so the closer sees "Server Error" instead of the reason.

### Fix

Convert them to `throw rejectRequest("auth.not_owner", "<user-facing message>", { ...ids })` from `convex/lib/observability/errors.ts`. The UI already shows `error.data.message` through `getErrorMessage` in `lib/errors.ts`, so no frontend change is needed. Do the same for other caller-caused throws in these files as you touch them.
