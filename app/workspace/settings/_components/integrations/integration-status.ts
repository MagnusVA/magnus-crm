import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { getCalendlyTokenTiming } from "@/lib/calendly-connection-status";
import type { Tone } from "../settings-ui";

// One status word per integration, shared by its card's title row and the
// band's Integrations tab count.

export type CalendlyStatus = NonNullable<FunctionReturnType<typeof api.calendly.oauthQueries.getConnectionStatus>>;
export type SlackStatus = FunctionReturnType<typeof api.slack.channels.getInstallationStatus>;
export type SlackConnected = Extract<SlackStatus, { kind: "connected" }>;

export type IntegrationState = { word: string; tone: Tone; connected: boolean };

export function calendlyConnected(status: CalendlyStatus) {
  return status.hasAccessToken && !status.needsReconnect;
}

export function calendlyWebhookReady(status: CalendlyStatus) {
  return status.calendlyWebhookUri !== null && status.hasWebhookSigningKey;
}

export function calendlyState(status: CalendlyStatus, now: number): IntegrationState {
  if (status.needsReconnect) return { word: "Needs reconnect", tone: "warning", connected: false };
  if (!status.hasAccessToken) return { word: "Not connected", tone: "warning", connected: false };
  if (getCalendlyTokenTiming(status.tokenExpiresAt, now).isExpired) {
    return { word: "Token expired", tone: "danger", connected: true };
  }
  if (!calendlyWebhookReady(status)) return { word: "No webhook", tone: "warning", connected: true };
  if (status.lastEventTypeSyncStatus === "failed") return { word: "Sync failed", tone: "danger", connected: true };
  return { word: "Connected", tone: "ok", connected: true };
}

export function slackMissingChannel(status: SlackConnected) {
  return status.status === "active" && (!status.notifyChannelId || !status.staleReminderChannelId);
}

export function slackChannelErrors(status: SlackConnected) {
  return [
    status.notifyChannelError,
    status.staleReminderChannelError,
    status.leadGenNotifyChannelError,
    status.bookingReviewChannelError,
  ].filter((error): error is NonNullable<typeof error> => Boolean(error));
}

export function slackState(status: SlackStatus): IntegrationState {
  if (status.kind === "not_connected") return { word: "Not connected", tone: "warning", connected: false };
  switch (status.status) {
    case "uninstalled":
      return { word: "Uninstalled", tone: "warning", connected: false };
    case "token_expired":
      return { word: "Token expired", tone: "danger", connected: false };
    case "revoked":
      return { word: "Revoked", tone: "danger", connected: false };
    case "active": {
      const errors = slackChannelErrors(status);
      if (errors.some((error) => error.code !== "not_in_channel")) {
        return { word: "Channel error", tone: "danger", connected: true };
      }
      if (slackMissingChannel(status)) return { word: "Pick channels", tone: "warning", connected: true };
      if (errors.length > 0) return { word: "Invite needed", tone: "warning", connected: true };
      return { word: "Connected", tone: "ok", connected: true };
    }
  }
}
