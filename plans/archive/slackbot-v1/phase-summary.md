# Slack Bot v1 - Phase Summary

**Source:** [`slackbot-design.md`](./slackbot-design.md) and the detailed files in [`phases/`](./phases/)

This document summarizes what each Slack Bot v1 phase accomplishes at a high level. The detailed phase documents remain the source of truth for implementation order, file-level changes, manual Slack setup, and QA gates.

## Phase Sequence

| Phase | Name | High-level outcome |
|---|---|---|
| 1 | OAuth Install & Token Rotation | Tenants can securely connect Slack, and the system can keep Slack bot tokens valid. |
| 2 | Slash Command & Modal | Slack users can run `/qualify-lead` and open/submit the lead qualification modal. |
| 3 | Lead, Opportunity & Slack-User Directory | Modal submissions create CRM leads and `qualified_pending` Slack-sourced opportunities. |
| 4 | Calendly to Slack Join | Later Calendly bookings attach to the pre-existing Slack-qualified opportunity. |
| 5 | Channel Notifications & Stale-Lead Digest | Teams receive Slack confirmations and daily reminders for old unbooked qualified leads. |
| 6 | Lifecycle & Metrics | The integration handles uninstall/reconnect events and exposes Slack lead conversion metrics. |

## Phase 1 - OAuth Install & Token Rotation

Phase 1 builds the foundation for connecting Slack workspaces to CRM tenants.

It creates the authenticated Slack install flow, signs and validates OAuth state, stores each tenant's Slack installation, and enables Slack token rotation from the beginning. It also adds proactive token refresh, refresh-lock handling, Slack manifest files, required Convex environment variables, and operational safeguards around token rotation.

By the end of this phase, a tenant admin can start a Slack OAuth install from CRM settings, Slack can redirect back into Convex, and the backend has a durable `slackInstallations` row with valid bot credentials.

Key concerns:

- Slack app setup is partly manual and order-dependent.
- `token_rotation_enabled: true` is irreversible at the Slack app level.
- Token refresh must be reliable because all later Slack API calls depend on it.

## Phase 2 - Slash Command & Modal

Phase 2 creates the first Slack-side user experience.

It registers the `/slack/commands` and `/slack/interactivity` HTTP handlers, verifies Slack request signatures, looks up the installation by `(team_id, api_app_id)`, opens the `/qualify-lead` Block Kit modal, and handles modal submission responses and inline validation errors.

By the end of this phase, a Slack user can run `/qualify-lead` and interact with the qualification form. Phase 2 does not yet create real CRM records; it prepares the verified, timed Slack request flow that Phase 3 wires into lead creation.

Key concerns:

- Slack requires the command request to be acknowledged within 3 seconds.
- The modal `trigger_id` also expires after 3 seconds.
- The command path must verify signatures and open the modal before returning.

## Phase 3 - Lead, Opportunity & Slack-User Directory

Phase 3 turns Slack modal submissions into CRM data.

It widens the lead and opportunity schema so a lead can be created from a social handle even when email is missing. It adds the `slack_qualified` source, the `qualified_pending` opportunity status, the `qualifiedBy` attribution object, redacted raw Slack event persistence, and a tenant-scoped `slackUsers` directory for displaying submitter names.

By the end of this phase, a valid modal submission creates or reuses a lead, inserts a Slack-sourced `qualified_pending` opportunity, records which Slack user submitted it, and schedules Slack-user profile enrichment without blocking the submission.

Key concerns:

- This is the first significant schema/data phase, so it requires the `convex-migration-helper` workflow.
- Existing Calendly-created leads and opportunities must keep working.
- UI and query readers must tolerate `lead.email` being absent.
- Duplicate qualification attempts for the same lead should not create duplicate open opportunities.

## Phase 4 - Calendly to Slack Join

Phase 4 closes the funnel loop between Slack qualification and Calendly booking.

It updates the Calendly `invitee.created` processing path so that, after identity resolution, the system first looks for a recent open Slack-sourced `qualified_pending` opportunity for the same lead. If one exists, the booking attaches to that opportunity and transitions it to `scheduled`. If not, the existing Calendly-only opportunity creation path continues unchanged.

By the end of this phase, Slack-qualified leads can convert into booked meetings without creating duplicate opportunities. This is the phase that makes the "Slack-qualified lead to booked meeting" conversion metric meaningful.

Key concerns:

- The join branch must reuse existing lifecycle helpers so search, stats, domain events, meeting refs, and reporting stay consistent.
- The old Calendly booking flow must remain unchanged for leads that were never Slack-qualified.
- End-to-end QA is critical: Slack qualify, Calendly book, confirm exactly one opportunity with the meeting attached.

## Phase 5 - Channel Notifications & Stale-Lead Digest

Phase 5 makes the integration visible and useful to tenant teams after install.

It adds Slack channel selection in CRM settings, lets admins choose a notification channel and stale-reminder channel, posts a confirmation message when a lead is Slack-qualified, and runs a daily 08:00 ET stale-lead digest for `qualified_pending` opportunities older than the configured window.

By the end of this phase, teams see new Slack-qualified leads in their chosen Slack channel and get regular reminders for qualified leads that have not booked a meeting.

Key concerns:

- Private channels require a human to invite the bot.
- `chat.postMessage` failures should not roll back CRM writes.
- The stale digest uses an hourly UTC cron with an America/New_York time gate to stay correct across DST.
- Slack rate limits matter most for `chat.postMessage`, especially during bursts.

## Phase 6 - Lifecycle & Metrics

Phase 6 hardens the integration for production use and adds reporting.

It handles Slack lifecycle events such as `app_uninstalled`, `tokens_revoked`, and `user_change`; supports reinstall/reactivation flows; adds Slack-qualified lead metrics; creates dashboard cards; configures operational alerting; completes dogfood validation; and activates public distribution for the production Slack app.

By the end of this phase, the Slack integration can survive uninstall/reconnect scenarios, keep historical attribution accurate, and report on Slack-sourced lead volume and conversion.

Key concerns:

- Installation rows should be marked inactive/revoked/uninstalled, not deleted.
- Reinstall must issue and persist a fresh rotated token pair.
- Metrics are MVP-bounded and should move to aggregates before broad tenant rollout.
- Public Distribution activation is the final production go-live gate.

## Overall Delivery Arc

Phases 1 and 2 establish the Slack platform connection and user entry point. Phase 3 creates CRM records from Slack. Phase 4 connects those records to Calendly bookings. Phase 5 adds team-facing notifications and reminders. Phase 6 adds lifecycle resilience, metrics, alerting, and the final go-live controls.

The core MVP is complete once a tenant can connect Slack, a Slack user can qualify a lead, the CRM records the lead before a booking exists, a later Calendly booking joins back to that same opportunity, and admins can see the resulting conversion metrics.
