import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { internalAction } from "../_generated/server";

const REFRESH_BUFFER_MS = 60_000;
const PROACTIVE_BUFFER_MS = 2 * 60 * 60 * 1000;
const STALE_LOCK_MS = 30_000;
const REFRESH_BACKOFF_MIN_MS = 500;
const REFRESH_BACKOFF_JITTER_MS = 500;

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

function getRequiredEnv(name: string): string {
  const value = process.env[name];
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
      return fresh.botAccessToken;
    }
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
        console.error("[Slack:Tokens] refresh failed permanently", {
          installationId: installation._id,
          error: data.error,
        });
        throw new SlackTokenExpiredError();
      }

      console.warn("[Slack:Tokens] refresh transient failure", {
        installationId: installation._id,
        error: data.error,
      });
      throw new Error(`Slack refresh transient: ${data.error ?? "unknown"}`);
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

    console.log("[Slack:Tokens] refresh ok", {
      installationId: installation._id,
    });
    return data.access_token;
  } catch (error) {
    if (error instanceof SlackTokenExpiredError) {
      throw error;
    }

    if (slackIssuedNewTuple) {
      console.error("[Slack:Tokens] CATASTROPHIC refresh-write-fail", {
        installationId: installation._id,
        tenantId: installation.tenantId,
        teamId: installation.teamId,
        error: error instanceof Error ? error.message : "unknown",
      });
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
    console.log("[Slack:Tokens] cron tick", { dueCount: dueIds.length });

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
      console.warn("[Slack:Tokens] cron refresh skipped", {
        installationId: args.installationId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  },
});
