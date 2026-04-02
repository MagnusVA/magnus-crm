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

export default crons;
