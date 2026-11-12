import { cronJobs, makeFunctionReference } from "convex/server";
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
  "pipeline-stuck-events",
  { minutes: 15 },
  internal.pipeline.mutations.reportStuckEvents,
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
  "report-unresolved-webhook-events",
  { hours: 24 },
  internal.webhooks.cleanup.reportUnresolvedEvents,
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

crons.interval(
  "maintain-operations-reports",
  { minutes: 10 },
  internal.operations.reports.maintenance.run,
  {},
);

crons.cron(
  "slack-stale-qualified-leads-reminder",
  "7 * * * *",
  internal.slack.staleReminders.maybeRun,
  {},
);

// Closes Slack-qualified opportunities that never booked. See staleExpiry.ts
// for why it runs a day after the stale digest first lists them.
crons.cron(
  "expire-stale-slack-opportunities",
  "23 * * * *",
  internal.slack.staleExpiry.expireStaleSlackOpportunities,
  {},
);

crons.interval("reporting-work-health", { minutes: 15 }, internal.operations.workStatus.reportProblems, {});

// The heartbeat Fivetran copies to ClickHouse as the reporting watermark, and
// the stale-sync alert (docs/plans/clickhouse-reporting.md §8.2).
crons.interval("analytics-heartbeat", { minutes: 5 }, internal.analytics.sync.beat, {});

// MCP upkeep (docs/plans/closer-assistant.md §6.8): idle gateway sessions,
// audit rows after 90 days (decision 16), and used preview tokens.
crons.cron("mcp-prune", "20 7 * * *", internal.mcp.access.pruneDaily, {});

// Fathom (docs/plans/closer-assistant.md §6.5): reconciliation, member sync
// and health every 30 minutes; raw events, held payloads and old transcripts daily.
crons.interval("fathom-reconcile-and-health", { minutes: 30 }, internal.fathom.maintenance.sweep, {});
crons.cron("fathom-retention", "41 7 * * *", internal.fathom.maintenance.purge, {});

crons.interval("second-opinion-day-close", { hours: 1 }, internal.secondOpinion.sweep.run, {});

// Call insights: runs whose worker died get a new one, and runs waiting for
// room under the monthly limit are tried again. A no-op while nothing waits.
crons.interval("call-insights-sweep", { minutes: 15 }, internal.callInsights.maintenance.sweep, {});

crons.cron("call-insights-drift", "17 8 * * 1", makeFunctionReference<"mutation">("callInsights/eval/drift:weekly"), {});

export default crons;
