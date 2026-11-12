import type { Id } from "../_generated/dataModel";
import { log, reportError } from "../lib/observability/log";

export type SlackNotificationKind =
  | "qualified_lead"
  | "existing_opportunity_bump"
  | "stale_digest"
  | "lead_gen_submission"
  | "booking_review"
  | "held_booking";

type SlackNotificationAttrs = {
  tenantId: Id<"tenants">;
  installationId?: Id<"slackInstallations">;
  kind: SlackNotificationKind;
  channelId?: string;
  opportunityId?: Id<"opportunities">;
  [key: string]: unknown;
};

/**
 * Errors graded as warnings: channel config an admin fixes by picking or
 * re-inviting the bot, an install Slack revoked (the reconnect banner covers
 * it), and rate limiting.
 */
const WARNING_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "not_in_channel",
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "ratelimited",
]);

export function logSlackNotifyPosted(attrs: SlackNotificationAttrs) {
  log.info("slack.notify.posted", attrs);
}

export function logSlackNotifySkipped(
  reason: string,
  attrs: SlackNotificationAttrs,
) {
  log.info("slack.notify.skipped", { ...attrs, reason });
}

/**
 * A notification that wasn't delivered. The failure is otherwise only kept in
 * a domain event or a channel error field, so it goes to Error Tracking too.
 *
 * `call` names the Slack method and how many times it ran, for a post that
 * retries. The message then reads `Slack <operation> failed: …`, the shape
 * the classifier reads as an integration failure.
 */
export function reportSlackNotifyFailed(
  slackError: string,
  attrs: SlackNotificationAttrs,
  call?: { operation: string; attempts: number },
) {
  const httpStatus = /^http_(\d{3})$/.exec(slackError)?.[1];
  // "request error" is what the classifier reads when there is no status.
  const detail = httpStatus
    ? `HTTP ${httpStatus}`
    : slackError === "transport_error"
      ? "request error transport_error"
      : slackError;
  const message = call
    ? `Slack ${call.operation} failed: ${detail}` +
      (call.attempts > 1 ? ` after ${call.attempts} attempts` : "")
    : httpStatus
      ? `Slack notification not delivered: HTTP ${httpStatus}`
      : `Slack notification not delivered: ${slackError}`;
  reportError("slack.notify.post_failed", new Error(message), {
    severity: WARNING_ERRORS.has(slackError) ? "warning" : "error",
    integration: "slack",
    fingerprint: `slack.notify.post_failed:${slackError}`,
    slackError,
    ...attrs,
    ...(call ? { attempts: call.attempts } : {}),
  });
}
