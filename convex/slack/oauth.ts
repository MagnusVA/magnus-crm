import { v } from "convex/values";
import { action, httpAction, env } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  createSlackOAuthState,
  fingerprintSlackOAuthStateToken,
  validateAndConsumeSlackOAuthState,
} from "../lib/slackOAuthState";
import { log, logRequestContext, reportError } from "../lib/observability/log";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";
import { timeoutSignal } from "../lib/timeoutSignal";

const SLACK_BOT_SCOPES = [
  "commands",
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
  "users:read",
];

type SlackOAuthAccessResponse = {
  ok: boolean;
  error?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  bot_user_id?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
  enterprise?: { id?: string } | null;
  is_enterprise_install?: boolean;
};

function createLogId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function missingSlackOAuthFields(data: SlackOAuthAccessResponse) {
  const missing: string[] = [];
  if (!data.ok) missing.push("ok");
  if (!data.access_token) missing.push("access_token");
  if (!data.refresh_token) missing.push("refresh_token");
  if (!data.expires_in) missing.push("expires_in");
  if (!data.app_id) missing.push("app_id");
  if (!data.bot_user_id) missing.push("bot_user_id");
  if (!data.team?.id) missing.push("team.id");
  if (!data.team?.name) missing.push("team.name");
  return missing;
}

function getRequiredEnv(name: keyof typeof env): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} not set`);
  }
  return value;
}

const SLACK_FETCH_TIMEOUT_MS = 30_000;

type SlackOAuthFailureReason =
  | "token_request_failed"
  | "invalid_json"
  | "failed_validation"
  | "cross_tenant_install"
  | "unexpected_error";

/**
 * Report an install that ends on the `oauth_failed` redirect. The redirect
 * hides the failure from the function's status, so it goes to Error Tracking.
 * Cross-tenant attempts are warnings; anything pointing at Slack or our code
 * is an error. Stale tabs and scanners (missing params, invalid state) are
 * logged by `logSlackOAuthRejected` instead.
 */
function reportSlackOAuthFailed(
  reason: SlackOAuthFailureReason,
  attrs: Record<string, unknown>,
  error?: unknown,
) {
  const severity = reason === "cross_tenant_install" ? "warning" : "error";
  reportError(
    "slack.oauth.failed",
    error ?? new Error(`Slack OAuth install failed: ${reason}`),
    {
      severity,
      integration: "slack",
      fingerprint: `slack.oauth.failed:${reason}`,
      reason,
      redirectStatus: "oauth_failed",
      ...attrs,
    },
  );
}

/** A callback from a stale tab, a replayed link, or a scanner. */
function logSlackOAuthRejected(
  reason: "missing_params" | "invalid_state",
  attrs: Record<string, unknown>,
) {
  log.warn("slack.oauth.rejected", {
    reason,
    redirectStatus: "oauth_failed",
    ...attrs,
  });
}

function workspaceSettingsUrl(slackStatus: string): string {
  const appUrl = getRequiredEnv("APP_URL");
  const url = new URL("/workspace/settings", appUrl);
  url.searchParams.set("tab", "integrations");
  url.searchParams.set("slack", slackStatus);
  return url.toString();
}

export const startInstall = action({
  args: {
    requestId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const requestId = args.requestId ?? createLogId("slack_oauth_start");

    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const clientId = getRequiredEnv("SLACK_CLIENT_ID");
    const redirectUri = getRequiredEnv("SLACK_REDIRECT_URI");

    const state = await createSlackOAuthState(ctx, {
      tenantId: access.tenantId,
      workosUserId: access.workosUserId,
      requestId,
      ttlSeconds: 600,
    });
    const stateFingerprint = await fingerprintSlackOAuthStateToken(
      state.token,
    );

    const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state.token);

    log.info("slack.oauth.started", {
      requestId,
      tenantId: access.tenantId,
      userId: access.userId,
      stateExpiresAt: state.expiresAt,
      stateFingerprint,
    });

    return { authorizeUrl: authorizeUrl.toString() };
  },
});

export const oauthRedirect = httpAction(async (ctx, req) => {
  const callbackId = createLogId("slack_oauth_cb");
  let requestId: string | undefined;
  let stateFingerprint: string | undefined;

  try {
    const url = new URL(req.url);
    const errorParam = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const stateRaw = url.searchParams.get("state");
    if (stateRaw) {
      stateFingerprint = await fingerprintSlackOAuthStateToken(stateRaw);
    }


    if (errorParam) {
      log.warn("slack.oauth.denied", {
        callbackId,
        stateFingerprint,
        // Anyone can set this query param; keep only Slack-style codes.
        slackError: /^[a-z_]{1,64}$/.test(errorParam) ? errorParam : "unrecognized",
        redirectStatus: "denied",
      });
      return Response.redirect(workspaceSettingsUrl("denied"), 302);
    }

    if (!code || !stateRaw) {
      logSlackOAuthRejected("missing_params", {
        callbackId,
        hasCode: Boolean(code),
        hasState: Boolean(stateRaw),
        stateFingerprint,
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }

    const state = await validateAndConsumeSlackOAuthState(ctx, {
      token: stateRaw,
    });
    requestId = state?.requestId;
    if (!state) {
      logSlackOAuthRejected("invalid_state", {
        callbackId,
        stateFingerprint,
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }
    logRequestContext({ tenantId: state.tenantId });

    const installer = await ctx.runQuery(
      internal.slack.installations.verifyInstallerStillAdmin,
      {
        tenantId: state.tenantId,
        workosUserId: state.workosUserId,
        requestId,
      },
    );
    if (!installer) {
      log.warn("slack.oauth.admin_required", {
        requestId,
        callbackId,
        tenantId: state.tenantId,
        workosUserId: state.workosUserId,
        redirectStatus: "admin_required",
      });
      return Response.redirect(workspaceSettingsUrl("admin_required"), 302);
    }

    const redirectUri = getRequiredEnv("SLACK_REDIRECT_URI");

    let tokenResponse: Response;
    try {
      tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: getRequiredEnv("SLACK_CLIENT_ID"),
          client_secret: getRequiredEnv("SLACK_CLIENT_SECRET"),
          redirect_uri: redirectUri,
        }),
        signal: timeoutSignal(SLACK_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      reportSlackOAuthFailed(
        "token_request_failed",
        { requestId, callbackId, tenantId: state.tenantId },
        error,
      );
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }


    let data: SlackOAuthAccessResponse;
    try {
      data = (await tokenResponse.json()) as SlackOAuthAccessResponse;
    } catch (error) {
      reportSlackOAuthFailed(
        "invalid_json",
        {
          requestId,
          callbackId,
          tenantId: state.tenantId,
          httpStatus: tokenResponse.status,
        },
        error,
      );
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }


    const missingFields = missingSlackOAuthFields(data);
    if (missingFields.length > 0) {
      reportSlackOAuthFailed("failed_validation", {
        requestId,
        callbackId,
        tenantId: state.tenantId,
        httpStatus: tokenResponse.status,
        slackError: data.error,
        missingFields,
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }

    const teamId = data.team!.id!;
    const appId = data.app_id!;
    const scopes = (data.scope ?? "").split(",").filter(Boolean);

    const existing = await ctx.runQuery(
      internal.slack.installations.byTeamIdAndAppId,
      {
        teamId,
        appId,
      },
    );


    const tokenTuple = {
      teamName: data.team!.name!,
      enterpriseId: data.enterprise?.id,
      isEnterpriseInstall: Boolean(data.is_enterprise_install),
      appId,
      botUserId: data.bot_user_id!,
      botAccessToken: data.access_token!,
      refreshToken: data.refresh_token!,
      tokenExpiresAt: Date.now() + data.expires_in! * 1000,
      scopes,
      installedByWorkosUserId: state.workosUserId,
      requestId,
    };
    let needsChannelPicker = true;
    let installationId = existing?._id;

    if (existing) {
      if (existing.tenantId !== state.tenantId) {
        reportSlackOAuthFailed("cross_tenant_install", {
          requestId,
          callbackId,
          installationId: existing._id,
          existingTenantId: existing.tenantId,
          tenantId: state.tenantId,
          previousStatus: existing.status,
          teamId,
          appId,
        });
        return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
      }

      await ctx.runMutation(internal.slack.installations.reactivate, {
        id: existing._id,
        ...tokenTuple,
      });
      needsChannelPicker = !existing.notifyChannelId;
    } else {
      installationId = await ctx.runMutation(
        internal.slack.installations.upsertOnInstall,
        {
          tenantId: state.tenantId,
          teamId,
          ...tokenTuple,
        },
      );
    }

    log.info("slack.oauth.installed", {
      requestId,
      callbackId,
      tenantId: state.tenantId,
      installationId,
      outcome: existing ? "reactivated" : "created",
      previousStatus: existing?.status,
      teamId,
      appId,
      needsChannelPicker,
    });

    const destination = new URL(workspaceSettingsUrl("connected"));
    if (needsChannelPicker) {
      destination.searchParams.set("pickChannel", "true");
    }
    return Response.redirect(destination.toString(), 302);
  } catch (error) {
    reportSlackOAuthFailed(
      "unexpected_error",
      { requestId, callbackId, stateFingerprint },
      error,
    );
    return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
  }
});
