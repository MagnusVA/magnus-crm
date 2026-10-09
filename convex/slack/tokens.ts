import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction, env } from "../_generated/server";
import { log, reportError } from "../lib/observability/log";
import { timeoutSignal } from "../lib/timeoutSignal";

const REFRESH_BUFFER_MS = 60_000;
const PROACTIVE_BUFFER_MS = 2 * 60 * 60 * 1000;
const STALE_LOCK_MS = 30_000;
const REFRESH_BACKOFF_MIN_MS = 500;
const REFRESH_BACKOFF_JITTER_MS = 500;
const SLACK_FETCH_TIMEOUT_MS = 30_000;

/** Errors `refreshBotToken` already reported, so callers don't report twice. */
const reportedRefreshErrors = new WeakSet<object>();

export class SlackInstallationMissingError extends Error {
  constructor(tenantId: Id<"tenants">) {
    super(`Slack installation missing for tenant ${tenantId}`);
  }
}

export class SlackInstallationNotActiveError extends Error {
  constructor(status: string) {
    super(`Slack installation status=${status}`);
  }
}

export class SlackTokenExpiredError extends Error {
  constructor() {
    super("Slack refresh token rejected - tenant must re-OAuth");
  }
}

export class SlackTokenRefreshContentionError extends Error {
  constructor() {
    super("Slack token refresh contention - peer holds lock");
  }
}

export type SlackTokenUnavailableReason =
  | "installation_missing"
  | "installation_not_active"
  | "token_expired"
  | "refresh_contention"
  | "refresh_failed";

export function slackTokenUnavailableReason(
  error: unknown,
): SlackTokenUnavailableReason {
  if (error instanceof SlackInstallationMissingError) return "installation_missing";
  if (error instanceof SlackInstallationNotActiveError) {
    return "installation_not_active";
  }
  if (error instanceof SlackTokenExpiredError) return "token_expired";
  if (error instanceof SlackTokenRefreshContentionError) {
    return "refresh_contention";
  }
  return "refresh_failed";
}

/**
 * Log why `getValidSlackBotToken` failed for a caller that swallows the error.
 * Expected states (no install, expired token) log a warning; an unclassified
 * refresh failure that `refreshBotToken` didn't already report goes to Error
 * Tracking.
 */
export function logSlackTokenUnavailable(
  event: string,
  error: unknown,
  attrs: Record<string, unknown>,
) {
  const reason = slackTokenUnavailableReason(error);
  const alreadyReported =
    typeof error === "object" &&
    error !== null &&
    reportedRefreshErrors.has(error);
  if (reason === "refresh_failed" && !alreadyReported) {
    reportError(event, error, {
      severity: "warning",
      integration: "slack",
      fingerprint: `${event}:${reason}`,
      ...attrs,
      reason,
    });
    return;
  }
  log.warn(event, { ...attrs, reason });
}

function getRequiredEnv(name: keyof typeof env): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} not set`);
  }
  return value;
}

export async function getValidSlackBotToken(
  ctx: ActionCtx,
  tenantId: Id<"tenants">,
): Promise<string> {
  const installation = await ctx.runQuery(
    internal.slack.installations.byTenantId,
    { tenantId },
  );
  if (!installation) {
    throw new SlackInstallationMissingError(tenantId);
  }
  if (installation.status !== "active") {
    throw new SlackInstallationNotActiveError(installation.status);
  }

  if (installation.tokenExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return installation.botAccessToken;
  }

  return await refreshBotToken(ctx, installation);
}

async function refreshBotToken(
  ctx: ActionCtx,
  installation: Doc<"slackInstallations">,
): Promise<string> {
  const startedAt = Date.now();
  const refreshAttrs = {
    installationId: installation._id,
    tenantId: installation.tenantId,
  };
  const lockHolder = crypto.randomUUID();
  const acquired = await ctx.runMutation(
    internal.slack.installations.tryAcquireRefreshLock,
    {
      installationId: installation._id,
      lockHolder,
      staleAfterMs: STALE_LOCK_MS,
    },
  );

  if (!acquired) {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        REFRESH_BACKOFF_MIN_MS +
          Math.random() * REFRESH_BACKOFF_JITTER_MS,
      ),
    );

    const fresh = await ctx.runQuery(internal.slack.installations.byId, {
      id: installation._id,
    });
    if (fresh && fresh.tokenExpiresAt - Date.now() > REFRESH_BUFFER_MS) {
      log.info("slack.token.refresh", {
        ...refreshAttrs,
        outcome: "peer_refreshed",
        durationMs: Date.now() - startedAt,
      });
      return fresh.botAccessToken;
    }
    log.warn("slack.token.refresh", {
      ...refreshAttrs,
      outcome: "lock_contention",
      durationMs: Date.now() - startedAt,
    });
    throw new SlackTokenRefreshContentionError();
  }

  let slackIssuedNewTuple = false;
  try {
    const response = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: installation.refreshToken,
        client_id: getRequiredEnv("SLACK_CLIENT_ID"),
        client_secret: getRequiredEnv("SLACK_CLIENT_SECRET"),
      }),
      signal: timeoutSignal(SLACK_FETCH_TIMEOUT_MS),
    });
    const data = (await response.json()) as {
      ok: boolean;
      error?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.ok) {
      if (data.error === "invalid_grant" || data.error === "token_revoked") {
        await ctx.runMutation(internal.slack.installations.markTokenExpired, {
          id: installation._id,
        });
        const expiredError = new SlackTokenExpiredError();
        reportError("slack.token.expired", expiredError, {
          severity: "warning",
          integration: "slack",
          fingerprint: "slack.token.expired",
          ...refreshAttrs,
          slackError: data.error,
        });
        reportedRefreshErrors.add(expiredError);
        throw expiredError;
      }

      // The caller reports this (logSlackTokenUnavailable or the cron).
      throw new Error(
        `Slack token refresh failed: HTTP ${response.status} (${data.error ?? "unknown"})`,
      );
    }

    if (!data.access_token || !data.refresh_token || !data.expires_in) {
      throw new Error("Slack refresh response missing required fields");
    }

    slackIssuedNewTuple = true;
    const refreshedAt = Date.now();
    await ctx.runMutation(internal.slack.installations.completeRefresh, {
      id: installation._id,
      lockHolder,
      botAccessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenExpiresAt: refreshedAt + data.expires_in * 1000,
      lastRefreshedAt: refreshedAt,
    });

    log.info("slack.token.refresh", {
      ...refreshAttrs,
      outcome: "refreshed",
      expiresInSeconds: data.expires_in,
      durationMs: Date.now() - startedAt,
    });
    return data.access_token;
  } catch (error) {
    if (error instanceof SlackTokenExpiredError) {
      throw error;
    }

    if (slackIssuedNewTuple) {
      // Slack rotated the tokens but we failed to store them, so the stored
      // refresh token is dead. See runbooks/slack-token-refresh-write-failure.md.
      reportError("slack.token.refresh_write_failed", error, {
        severity: "error",
        integration: "slack",
        fingerprint: "slack.token.refresh_write_failed",
        ...refreshAttrs,
        teamId: installation.teamId,
      });
      if (typeof error === "object" && error !== null) {
        reportedRefreshErrors.add(error);
      }
      await ctx.runMutation(internal.slack.installations.markTokenExpired, {
        id: installation._id,
      });
      throw error;
    }

    await ctx.runMutation(internal.slack.installations.releaseRefreshLock, {
      id: installation._id,
      lockHolder,
    });
    throw error;
  }
}

export const refreshExpiringTokens = internalAction({
  args: {},
  handler: async (ctx) => {
    const dueIds = await ctx.runQuery(
      internal.slack.refreshCron.listExpiringInstallationIds,
      { withinMs: PROACTIVE_BUFFER_MS },
    );
    if (dueIds.length > 0) {
      log.info("slack.token.refresh_cron", { dueCount: dueIds.length });
    }

    for (const installationId of dueIds) {
      await ctx.scheduler.runAfter(
        0,
        internal.slack.tokens.refreshOneInstallation,
        { installationId },
      );
    }
  },
});

export const refreshOneInstallation = internalAction({
  args: { installationId: v.id("slackInstallations") },
  handler: async (ctx, args) => {
    const installation = await ctx.runQuery(
      internal.slack.installations.byId,
      { id: args.installationId },
    );
    if (!installation || installation.status !== "active") {
      return;
    }
    if (installation.tokenExpiresAt - Date.now() > PROACTIVE_BUFFER_MS) {
      return;
    }

    try {
      await refreshBotToken(ctx, installation);
    } catch (error) {
      // Swallowed; the next cron tick retries while the token is still valid.
      const alreadyReported =
        typeof error === "object" &&
        error !== null &&
        reportedRefreshErrors.has(error);
      if (alreadyReported || error instanceof SlackTokenRefreshContentionError) {
        log.warn("slack.token.cron_refresh_skipped", {
          installationId: args.installationId,
          tenantId: installation.tenantId,
          errorName: error instanceof Error ? error.constructor.name : "Error",
        });
      } else {
        reportError("slack.token.cron_refresh_failed", error, {
          severity: "warning",
          integration: "slack",
          fingerprint: "slack.token.cron_refresh_failed",
          installationId: args.installationId,
          tenantId: installation.tenantId,
        });
      }
    }
  },
});
