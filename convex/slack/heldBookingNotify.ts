import { v } from "convex/values";
import { internal } from "../_generated/api";
import { env, internalAction } from "../_generated/server";
import { log } from "../lib/observability/log";
import { escapeSlackMrkdwn } from "../lib/slackBlockKit";
import {
  logSlackNotifyPosted,
  logSlackNotifySkipped,
  reportSlackNotifyFailed,
} from "./notifyObservability";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { slackApiPostJson } from "./webApi";

// The panel lives on the attribution page's diagnostics section; without it the page redirects.
const RECOVERY_PATH = "/workspace/operations/booked-calls/attribution?section=diagnostics";

/**
 * Posts a held booking that has no booking review to the booking review
 * channel, once, with the call time, the reason in plain words and a link to
 * the recovery panel. Opt-in like review alerts: with no channel set, it goes
 * nowhere and the panel still lists the booking.
 */
export const post = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  returns: v.null(),
  handler: async (ctx, { deliveryId }) => {
    const kind = "held_booking" as const;
    const alert = await ctx.runQuery(internal.pipeline.heldBookings.getForAlert, { deliveryId });
    if (!alert) {
      log.info("slack.notify.skipped", { kind, deliveryId, reason: "delivery_missing" });
      return null;
    }
    const { tenantId, booking } = alert;
    // Settled, given a review, or already posted since this was scheduled.
    if (booking.status !== "blocked" || booking.reviewId || alert.heldAlertedAt !== undefined) {
      logSlackNotifySkipped("not_needed", { tenantId, kind, deliveryId });
      return null;
    }
    const installation = await ctx.runQuery(internal.slack.installations.byTenantId, { tenantId });
    const channelId = installation?.status === "active" ? installation.bookingReviewChannelId : undefined;
    if (!installation || !channelId) {
      logSlackNotifySkipped("no_channel_configured", { tenantId, kind, deliveryId });
      return null;
    }
    const attrs = { tenantId, installationId: installation._id, kind, channelId, deliveryId };
    const appUrl = env.APP_URL;
    if (!appUrl) {
      reportSlackNotifyFailed("app_url_not_configured", attrs);
      return null;
    }
    const url = new URL(RECOVERY_PATH, appUrl.replace(/\/$/, "")).toString();
    const invitee = escapeSlackMrkdwn(booking.inviteeName ?? "Someone");
    const call = [
      booking.eventName && `*${escapeSlackMrkdwn(booking.eventName)}*`,
      booking.closerName
        ? `with ${escapeSlackMrkdwn(booking.closerName)}`
        : booking.hostName && `with ${escapeSlackMrkdwn(booking.hostName)}`,
      booking.startTime !== undefined && `for <!date^${Math.floor(booking.startTime / 1000)}^{date_short_pretty} at {time}|${new Date(booking.startTime).toISOString()}>`,
    ]
      .filter(Boolean)
      .join(" ");
    const text = `${invitee} booked ${call || "a call"}. The CRM is holding it. ${booking.explanation.cause} ${booking.explanation.nextStep}`;

    let token: string;
    try {
      token = await getValidSlackBotToken(ctx, tenantId);
    } catch (error) {
      logSlackTokenUnavailable("slack.notify.token_unavailable", error, attrs);
      return null;
    }
    const response = await slackApiPostJson("chat.postMessage", token, {
      channel: channelId,
      text: `${text} ${url}`,
      blocks: [
        { type: "header", text: { type: "plain_text", text: "⏸️ Booking held", emoji: true } },
        { type: "section", text: { type: "mrkdwn", text } },
        {
          type: "actions",
          elements: [
            { type: "button", style: "primary", text: { type: "plain_text", text: "Open held bookings" }, url },
          ],
        },
      ],
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!response.ok) {
      reportSlackNotifyFailed(response.error ?? "unknown", attrs);
      return null;
    }
    await ctx.runMutation(internal.pipeline.heldBookings.markAlerted, { deliveryId });
    logSlackNotifyPosted(attrs);
    return null;
  },
});
