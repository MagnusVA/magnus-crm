import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { InstallationStatus } from "./channels";
export async function buildSlackInstallationStatus(
  ctx: QueryCtx,
  tenantId: Id<"tenants">,
): Promise<InstallationStatus> {
  const installation = await ctx.db
    .query("slackInstallations")
    .withIndex("by_tenantId", (q) => q.eq("tenantId", tenantId))
    .first();

  if (!installation) {
    return { kind: "not_connected" };
  }

  return {
    kind: "connected",
    status: installation.status,
    teamId: installation.teamId,
    teamName: installation.teamName,
    installedAt: installation.installedAt,
    installedByWorkosUserId: installation.installedByWorkosUserId,
    notifyChannelId: installation.notifyChannelId,
    notifyChannelName: installation.notifyChannelName,
    staleReminderChannelId: installation.staleReminderChannelId,
    staleReminderChannelName: installation.staleReminderChannelName,
    notifyChannelError: installation.notifyChannelError,
    staleReminderChannelError: installation.staleReminderChannelError,
    leadGenNotifyChannelId: installation.leadGenNotifyChannelId,
    leadGenNotifyChannelName: installation.leadGenNotifyChannelName,
    leadGenNotifyChannelError: installation.leadGenNotifyChannelError,
    bookingReviewChannelId: installation.bookingReviewChannelId,
    bookingReviewChannelName: installation.bookingReviewChannelName,
    bookingReviewChannelError: installation.bookingReviewChannelError,
    eodReportChannelId: installation.eodReportChannelId,
    eodReportChannelName: installation.eodReportChannelName,
    eodReportChannelError: installation.eodReportChannelError,
    lastRefreshedAt: installation.lastRefreshedAt,
  };
}
