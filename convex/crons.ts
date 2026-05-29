import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "refresh-calendly-tokens",
  { minutes: 90 },
  internal.calendly.tokens.refreshAllTokens,
  {},
);

crons.interval(
  "calendly-health-check",
  { hours: 24 },
  internal.calendly.healthCheck.runHealthCheck,
  {},
);

crons.interval(
  "sync-calendly-org-members",
  { hours: 24 },
  internal.calendly.orgMembers.syncAllTenants,
  {},
);

// Event type metadata sync is manual-only for the MVP; do not add a recurring job here.
crons.interval(
  "cleanup-expired-webhook-events",
  { hours: 24 },
  internal.webhooks.cleanup.cleanupExpiredEvents,
  {},
);

crons.interval(
  "cleanup-expired-invites",
  { hours: 24 },
  internal.admin.inviteCleanup.cleanupExpiredInvites,
  {},
);

crons.interval(
  "nudge-stale-side-deals",
  { hours: 6 },
  internal.opportunities.staleness.nudgeStaleSideDeals,
  {},
);

crons.interval(
  "refresh-slack-tokens",
  { hours: 1 },
  internal.slack.tokens.refreshExpiringTokens,
  {},
);

crons.interval(
  "cleanup-slack-oauth-states",
  { hours: 24 },
  internal.slack.cleanup.deleteExpiredOAuthStates,
  {},
);

crons.interval(
  "cleanup-slack-raw-events",
  { hours: 24 },
  internal.slack.cleanup.deleteExpiredRawEvents,
  {},
);

crons.cron(
  "slack-stale-qualified-leads-reminder",
  "0 * * * *",
  internal.slack.staleReminders.maybeRun,
  {},
);

export default crons;
