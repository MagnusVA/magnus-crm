import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "../../../_generated/server";
import { buildCalendlyConnectionStatus } from "../../../calendly/oauthQueriesCore";
import { buildSlackInstallationStatus } from "../../../slack/channelsCore";
import { buildFathomSettings } from "../../../fathom/connectionCore";
import { buildBookingHealthIssues } from "../../../operations/bookingHealthCore";
import { buildWorkHealth } from "../../../operations/workStatusCore";
import { getTenantCalendlyConnectionState } from "../../../lib/tenantCalendlyConnection";
import { readSyncRow } from "../../../analytics/results";
import { mcpCallerValidator, requireMcpAdmin } from "../../guard";
import { formatLocal } from "../../time";
import { appLink } from "../prepare";
import type { Admin } from "./common";

export const healthArea = v.union(
  v.literal("calendly"),
  v.literal("slack"),
  v.literal("fathom"),
  v.literal("booking_deliveries"),
  v.literal("projections"),
  v.literal("report_freshness"),
  v.literal("sign_in"),
);
export const healthArgs = { area: v.optional(healthArea) };
export const healthRowValidator = v.object({
  area: healthArea,
  status: v.union(
    v.literal("ok"),
    v.literal("warning"),
    v.literal("error"),
    v.literal("unknown"),
  ),
  observedAt: v.union(v.string(), v.null()),
  reasonCodes: v.array(v.string()),
  allowedActions: v.array(v.string()),
  openInMagnus: v.string(),
});
type Area =
  | "calendly"
  | "slack"
  | "fathom"
  | "booking_deliveries"
  | "projections"
  | "report_freshness"
  | "sign_in";
type HealthRow = {
  area: Area;
  status: "ok" | "warning" | "error" | "unknown";
  observedAt: string | null;
  reasonCodes: string[];
  allowedActions: string[];
  openInMagnus: string;
};
export async function buildHealth(ctx: QueryCtx, me: Admin, area?: Area) {
  const rows: HealthRow[] = [];
  const wants = (key: Area) => !area || area === key;
  const push = (
    key: Area,
    status: HealthRow["status"],
    codes: string[],
    observedAt: number | null,
    path: string,
  ) =>
    rows.push({
      area: key,
      status,
      reasonCodes: codes,
      observedAt:
        observedAt === null ? null : formatLocal(observedAt, me.timeZone),
      allowedActions: ["magnus_health"],
      openInMagnus: appLink(path),
    });
  if (wants("calendly")) {
    const c = await buildCalendlyConnectionStatus(ctx, me.tenantId);
    const connection = await getTenantCalendlyConnectionState(ctx, me.tenantId);
    const observations = [c?.lastEventTypeSyncCompletedAt, c?.lastTokenRefresh, connection?.lastHealthCheckAt].filter((at): at is number => typeof at === "number");
    push(
      "calendly",
      !c?.hasAccessToken
        ? "unknown"
        : c.needsReconnect
          ? "error"
          : c.lastEventTypeSyncStatus === "failed"
            ? "warning"
            : !c.calendlyWebhookUri || !c.hasWebhookSigningKey
              ? "warning"
              : "ok",
      !c?.hasAccessToken
        ? ["not_connected"]
        : c.needsReconnect
          ? ["reconnect_required"]
          : c.lastEventTypeSyncStatus === "failed"
            ? ["sync_failed"]
            : !c.calendlyWebhookUri || !c.hasWebhookSigningKey
              ? ["webhook_incomplete"]
              : [],
      observations.length ? Math.max(...observations) : null,
      "/workspace/settings",
    );
  }
  if (wants("slack")) {
    const s = await buildSlackInstallationStatus(ctx, me.tenantId);
    const errors =
      s.kind === "connected" &&
      [
        s.notifyChannelError,
        s.staleReminderChannelError,
        s.bookingReviewChannelError,
        s.leadGenNotifyChannelError,
        s.eodReportChannelError,
      ].some(Boolean);
    push(
      "slack",
      s.kind === "not_connected"
        ? "unknown"
        : s.status !== "active"
          ? "error"
          : errors
            ? "warning"
            : "ok",
      s.kind === "not_connected"
        ? ["not_connected"]
        : s.status !== "active"
          ? ["reconnect_required"]
          : errors
            ? ["channel_delivery_failed"]
            : [],
      s.kind === "connected" ? (s.lastRefreshedAt ?? s.installedAt) : null,
      "/workspace/settings",
    );
  }
  if (wants("fathom")) {
    const f = await buildFathomSettings(ctx, me.tenantId),
      c = f.connection;
    const unlinked = f.members.some((m) => !m.ignored && !m.userId);
    push(
      "fathom",
      !c
        ? "unknown"
        : c.status !== "connected"
          ? "error"
          : c.lastError || unlinked || f.capped || c.droppedCount > 0
            ? "warning"
            : "ok",
      !c
        ? ["not_connected"]
        : c.status !== "connected"
          ? ["reconnect_required"]
          : [
              ...(c.lastError ? ["sync_error"] : []),
              ...(unlinked ? ["unlinked_recorders"] : []),
              ...(f.capped ? ["partial_settings"] : []),
              ...(c.droppedCount ? ["dropped_recordings"] : []),
            ],
      c?.lastWebhookAt ?? c?.lastReconciledAt ?? null,
      "/workspace/settings/fathom",
    );
  }
  if (wants("booking_deliveries") || wants("projections")) {
    const work = await buildWorkHealth(ctx, me.tenantId);
    if (wants("booking_deliveries")) {
      const issues = await buildBookingHealthIssues(ctx, me.tenantId);
      const broken = work.queues.some(
        (q) =>
          q.kind.startsWith("webhooks:") &&
          (q.kind.endsWith(":failed") || q.kind.endsWith(":blocked")) &&
          q.count > 0,
      );
      push(
        "booking_deliveries",
        broken
          ? "error"
          : issues.length ||
              work.queues.some((q) => q.kind === "webhooks:queued" && q.count)
            ? "warning"
            : "ok",
        [
          ...(broken ? ["delivery_failed_or_blocked"] : []),
          ...(issues.length ? ["unprocessed_bookings"] : []),
        ],
        Date.now(),
        "/workspace/operations",
      );
    }
    if (wants("projections")) {
      const failed = work.queues.some(
        (q) =>
          !q.kind.startsWith("webhooks:") &&
          q.kind.endsWith(":failed") &&
          q.count > 0,
      );
      const queued = work.queues.some(
        (q) => !q.kind.startsWith("webhooks:") && q.count > 0,
      );
      push(
        "projections",
        failed
          ? "error"
          : !work.verified
            ? "unknown"
            : queued
              ? "warning"
              : "ok",
        failed
          ? ["projection_failed"]
          : !work.verified
            ? ["projection_not_verified"]
            : queued
              ? ["projection_pending"]
              : [],
        Date.now(),
        "/workspace/operations",
      );
    }
  }
  let freshness = null;
  if (wants("report_freshness")) {
    const sync = await readSyncRow(ctx);
    const lastSyncEndedAt = sync?.lastSyncEndedAt ?? null;
    freshness = {
      asOf: sync?.watermark ?? null,
      lastSyncEndedAt,
      nextExpectedRefresh:
        lastSyncEndedAt === null ? null : lastSyncEndedAt + 6 * 3600_000,
    };
    push(
      "report_freshness",
      lastSyncEndedAt === null
        ? "unknown"
        : Date.now() > lastSyncEndedAt + 6 * 3600_000
          ? "warning"
          : "ok",
      lastSyncEndedAt === null
        ? ["no_sync_observed"]
        : Date.now() > lastSyncEndedAt + 6 * 3600_000
          ? ["refresh_overdue"]
          : [],
      lastSyncEndedAt,
      "/workspace/reports/scorecard",
    );
  }
  if (wants("sign_in"))
    push(
      "sign_in",
      "unknown",
      ["workos_not_observed"],
      null,
      "/workspace/settings",
    );
  return {
    rows,
    freshness: freshness
      ? {
          asOf:
            freshness.asOf === null
              ? null
              : formatLocal(freshness.asOf, me.timeZone),
          lastSyncEndedAt:
            freshness.lastSyncEndedAt === null
              ? null
              : formatLocal(freshness.lastSyncEndedAt, me.timeZone),
          nextExpectedRefresh:
            freshness.nextExpectedRefresh === null
              ? null
              : formatLocal(freshness.nextExpectedRefresh, me.timeZone),
        }
      : null,
    timeZone: me.timeZone,
  };
}
export const freshnessValidator = v.union(
  v.null(),
  v.object({
    asOf: v.union(v.string(), v.null()),
    lastSyncEndedAt: v.union(v.string(), v.null()),
    nextExpectedRefresh: v.union(v.string(), v.null()),
  }),
);
export const run = internalQuery({
  args: { caller: mcpCallerValidator, ...healthArgs },
  returns: v.object({
    rows: v.array(healthRowValidator),
    freshness: freshnessValidator,
    timeZone: v.string(),
  }),
  handler: async (ctx, { caller, area }) => {
    const me = await requireMcpAdmin(ctx, caller);
    return await buildHealth(ctx, me, area);
  },
});
