import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  env,
  internalAction,
  internalMutation,
  type MutationCtx,
} from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import { log } from "../lib/observability/log";
import { buildBookingReviewNotification } from "../lib/slackBlockKit";
import {
  logSlackNotifyPosted,
  logSlackNotifySkipped,
  reportSlackNotifyFailed,
} from "./notifyObservability";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson } from "./webApi";

const CLEAR_CHANNEL_ERRORS = new Set(["channel_not_found", "is_archived"]);
const ACTION_REQUIRED_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
]);

/**
 * Posts a booking review to the tenant's booking review channel, or to the
 * qualified lead channel when none is set, with a link to the review page.
 */
export const post = internalAction({
  args: { reviewId: v.id("bookingReviews") },
  returns: v.null(),
  handler: async (ctx, { reviewId }) => {
    const alert = await ctx.runQuery(internal.pipeline.bookingReviews.getForAlert, {
      reviewId,
    });
    const kind = "booking_review" as const;
    if (!alert) {
      log.info("slack.notify.skipped", { kind, reviewId, reason: "review_missing" });
      return null;
    }
    const { tenantId, detail } = alert;
    // Someone may have decided before the alert went out.
    if (detail.status !== "open") {
      logSlackNotifySkipped("review_resolved", { tenantId, kind, reviewId });
      return null;
    }
    if (alert.alertPostedAt !== undefined) {
      logSlackNotifySkipped("already_posted", { tenantId, kind, reviewId });
      return null;
    }
    const installation = await ctx.runQuery(internal.slack.installations.byTenantId, {
      tenantId,
    });
    if (!installation || installation.status !== "active") {
      logSlackNotifySkipped("installation_not_active", {
        tenantId,
        kind,
        installationStatus: installation?.status ?? "missing",
      });
      return null;
    }
    // Opt-in: with no booking review channel the alert goes nowhere, and the
    // review is posted when an admin picks one.
    const channelId = installation.bookingReviewChannelId;
    if (!channelId) {
      logSlackNotifySkipped("no_channel_configured", {
        tenantId,
        installationId: installation._id,
        kind,
      });
      return null;
    }
    const notifyAttrs = {
      tenantId,
      installationId: installation._id,
      kind,
      channelId,
      reviewId,
    };
    const appUrl = env.APP_URL;
    if (!appUrl) {
      reportSlackNotifyFailed("app_url_not_configured", notifyAttrs);
      return null;
    }

    const message = buildBookingReviewNotification(detail, appUrl);
    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, tenantId);
    } catch (error) {
      logSlackTokenUnavailable("slack.notify.token_unavailable", error, notifyAttrs);
      return null;
    }

    const response = await slackApiPostJson<{ channel?: string; ts?: string }>(
      "chat.postMessage",
      token,
      {
        channel: channelId,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
        unfurl_media: false,
      },
    );
    if (response.ok) {
      await ctx.runMutation(internal.slack.bookingReviewNotify.markPosted, { reviewId });
      logSlackNotifyPosted(notifyAttrs);
      return null;
    }

    const slackErr = response.error ?? "unknown";
    reportSlackNotifyFailed(slackErr, notifyAttrs);
    // A cleared channel turns alerts off; this review stays unposted and goes
    // out when an admin picks a new channel.
    if (ACTION_REQUIRED_ERRORS.has(slackErr))
      await ctx.runMutation(internal.slack.bookingReviewNotify.recordChannelFailure, {
        installationId: installation._id,
        channelId,
        slackErr,
        clearChannel: CLEAR_CHANNEL_ERRORS.has(slackErr),
      });
    await emitDomainEventInAction(ctx, {
      tenantId,
      entityType: "slackInstallation",
      entityId: installation._id,
      eventType: "slack.notify.failed",
      source: "system",
      occurredAt: Date.now(),
      metadata: { slackErr, channel: channelId, notificationKind: kind },
    });
    return null;
  },
});

export const markPosted = internalMutation({
  args: { reviewId: v.id("bookingReviews") },
  returns: v.null(),
  handler: async (ctx, { reviewId }) => {
    if (await ctx.db.get("bookingReviews", reviewId))
      await ctx.db.patch("bookingReviews", reviewId, { alertPostedAt: Date.now() });
    return null;
  },
});

/** Open reviews read per page when posting the ones still waiting. */
const PENDING_ALERT_PAGE = 100;
/** Spaces the posts out under Slack's one-message-per-second channel limit. */
const PENDING_ALERT_SPACING_MS = 1_100;

/**
 * Posts every open review whose alert never went out, oldest first: those
 * opened while no booking review channel was set, or while the channel was
 * failing. Called when an admin sets or fixes the channel. `post` skips a
 * review already posted, so running it again is safe.
 */
export async function schedulePendingBookingReviewAlerts(
  ctx: MutationCtx,
  tenantId: Id<"tenants">,
) {
  await ctx.scheduler.runAfter(0, internal.slack.bookingReviewNotify.schedulePendingPage, {
    tenantId,
    cursor: null,
  });
}

export const schedulePendingPage = internalMutation({
  args: { tenantId: v.id("tenants"), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { tenantId, cursor }) => {
    const page = await ctx.db
      .query("bookingReviews")
      .withIndex("by_tenantId_and_status_and_createdAt", (q) =>
        q.eq("tenantId", tenantId).eq("status", "open"),
      )
      .order("asc")
      .paginate({ cursor, numItems: PENDING_ALERT_PAGE });
    const pending = page.page.filter((review) => review.alertPostedAt === undefined);
    for (const [index, review] of pending.entries())
      await ctx.scheduler.runAfter(index * PENDING_ALERT_SPACING_MS, internal.slack.bookingReviewNotify.post, {
        reviewId: review._id,
      });
    // The next page starts after this page's posts, keeping the spacing.
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        pending.length * PENDING_ALERT_SPACING_MS,
        internal.slack.bookingReviewNotify.schedulePendingPage,
        { tenantId, cursor: page.continueCursor },
      );
    log.info("slack.booking_review.pending_scheduled", {
      tenantId,
      count: pending.length,
      done: page.isDone,
    });
    return null;
  },
});

export const recordChannelFailure = internalMutation({
  args: {
    installationId: v.id("slackInstallations"),
    channelId: v.string(),
    slackErr: v.string(),
    clearChannel: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const installation = await ctx.db.get("slackInstallations", args.installationId);
    // An admin may have changed the channel since the post.
    if (!installation || installation.bookingReviewChannelId !== args.channelId) return null;
    await ctx.db.patch("slackInstallations", args.installationId, {
      ...(args.clearChannel && {
        bookingReviewChannelId: undefined,
        bookingReviewChannelName: undefined,
      }),
      bookingReviewChannelError: {
        code: args.slackErr,
        channelId: args.channelId,
        channelName: installation.bookingReviewChannelName,
        occurredAt: Date.now(),
      },
    });
    return null;
  },
});
