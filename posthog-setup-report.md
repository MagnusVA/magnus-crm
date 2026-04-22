<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog into MAGNUS CRM. The following changes were made:

**New files created:**
- `instrumentation-client.ts` — initializes `posthog-js` for all client-side pages using the Next.js 16 instrumentation hook (no provider needed)
- `lib/posthog-server.ts` — singleton `posthog-node` client for server-side event capture
- `.env.local` — `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` and `NEXT_PUBLIC_POSTHOG_HOST` set

**Modified files:**
- `next.config.ts` — added `/ingest` reverse-proxy rewrites and `skipTrailingSlashRedirect: true`
- 8 client component files — `posthog.capture()` calls added to key user actions; `posthog.captureException()` added to every error catch block

## Source maps

Source map upload for PostHog Error Tracking is now wired into the Next.js build via `@posthog/nextjs-config`.

- `package.json` — includes `@posthog/nextjs-config`
- `next.config.ts` — wraps the existing config in `withPostHogConfig(...)`
- Production builds upload source maps automatically when the required build credentials are present
- Uploaded source maps are deleted from the build output after upload

### Required environment variables

- `POSTHOG_API_KEY` — preferred name for the PostHog personal API key used during build
- `POSTHOG_PERSONAL_API_KEY` — supported fallback name for the same credential
- `POSTHOG_PROJECT_ID` — PostHog project ID
- `NEXT_PUBLIC_POSTHOG_HOST` — PostHog ingest host (already used by the runtime integration)

### Notes

- If `POSTHOG_API_KEY`/`POSTHOG_PERSONAL_API_KEY` and `POSTHOG_PROJECT_ID` are missing, the app still builds, but source map upload is disabled and Next.js build logs will warn about it.
- Verification is done against `.next/**/*.js.map` for Next.js, not a generic `dist/` directory.

| Event | Description | File |
|---|---|---|
| `meeting_started` | Closer clicked Start Meeting and Zoom link was opened | `app/workspace/closer/meetings/_components/outcome-action-bar.tsx` |
| `payment_logged` | Payment form submitted and opportunity closed as payment_received | `app/workspace/closer/meetings/_components/payment-form-dialog.tsx` |
| `opportunity_marked_lost` | Closer confirmed marking an opportunity as lost | `app/workspace/closer/meetings/_components/mark-lost-dialog.tsx` |
| `follow_up_link_generated` | Single-use Calendly follow-up link created for a lead | `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` |
| `follow_up_link_copied` | Closer copied the generated follow-up link to clipboard | `app/workspace/closer/meetings/_components/follow-up-dialog.tsx` |
| `team_member_invited` | Admin sent a WorkOS invitation to a new team member | `app/workspace/team/_components/invite-user-dialog.tsx` |
| `team_member_removed` | Admin removed a team member from the workspace | `app/workspace/team/_components/remove-user-dialog.tsx` |
| `event_type_config_saved` | Admin saved Calendly event type configuration | `app/workspace/settings/_components/event-type-config-dialog.tsx` |
| `calendly_reconnected` | Admin initiated a Calendly reconnect from settings | `app/workspace/settings/_components/calendly-connection.tsx` |
| `pipeline_status_filter_changed` | Closer changed the status filter on their pipeline view | `app/workspace/closer/pipeline/_components/closer-pipeline-page-client.tsx` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- **Dashboard:** [Analytics basics](https://us.posthog.com/project/371650/dashboard/1436788)
- **Insight:** [Meeting to Payment Conversion Funnel](https://us.posthog.com/project/371650/insights/YF637txX) — conversion rate from `meeting_started` → `payment_logged` within 7 days
- **Insight:** [Meeting Churn Funnel — Started to Lost](https://us.posthog.com/project/371650/insights/ytwhinJm) — how many started meetings result in `opportunity_marked_lost`
- **Insight:** [Payments vs Lost Opportunities (Daily)](https://us.posthog.com/project/371650/insights/91qf549g) — daily win/churn comparison
- **Insight:** [Follow-up Link Generated to Copied](https://us.posthog.com/project/371650/insights/jEsPec3m) — funnel showing whether closers actually share the links they generate
- **Insight:** [Team Growth — Invites vs Removals](https://us.posthog.com/project/371650/insights/f73MsQSB) — weekly team size trend over 90 days

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
