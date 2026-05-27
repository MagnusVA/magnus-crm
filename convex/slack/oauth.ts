import { v } from "convex/values";
import { action, httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  createSlackOAuthState,
  fingerprintSlackOAuthStateToken,
  validateAndConsumeSlackOAuthState,
} from "../lib/slackOAuthState";
import { requireTenantUserFromAction } from "../requireTenantUserFromAction";

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

function describeUrl(value: string) {
  try {
    const url = new URL(value);
    return { origin: url.origin, pathname: url.pathname };
  } catch {
    return { invalid: true };
  }
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "Unknown", message: String(error) };
}

function describeSlackOAuthResponse(data: SlackOAuthAccessResponse) {
  const scopes = (data.scope ?? "").split(",").filter(Boolean);
  return {
    ok: data.ok,
    error: data.error,
    hasAccessToken: Boolean(data.access_token),
    hasRefreshToken: Boolean(data.refresh_token),
    hasExpiresIn: typeof data.expires_in === "number",
    expiresInSeconds: data.expires_in,
    hasBotUserId: Boolean(data.bot_user_id),
    hasAppId: Boolean(data.app_id),
    hasTeamId: Boolean(data.team?.id),
    hasTeamName: Boolean(data.team?.name),
    teamNameLength: data.team?.name?.length,
    enterpriseIdPresent: Boolean(data.enterprise?.id),
    isEnterpriseInstall: Boolean(data.is_enterprise_install),
    scopeCount: scopes.length,
    scopes,
  };
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

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not set`);
  }
  return value;
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
    console.log("[Slack:OAuth] startInstall begin", { requestId });

    try {
      const access = await requireTenantUserFromAction(ctx, [
        "tenant_master",
        "tenant_admin",
      ]);
      console.log("[Slack:OAuth] startInstall authorized", {
        requestId,
        tenantId: access.tenantId,
        userId: access.userId,
        workosUserId: access.workosUserId,
        role: access.role,
      });

      const clientId = getRequiredEnv("SLACK_CLIENT_ID");
      const redirectUri = getRequiredEnv("SLACK_REDIRECT_URI");
      console.log("[Slack:OAuth] startInstall env ready", {
        requestId,
        hasClientId: Boolean(clientId),
        redirectUri: describeUrl(redirectUri),
        scopeCount: SLACK_BOT_SCOPES.length,
        scopes: SLACK_BOT_SCOPES,
      });

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

      console.log("[Slack:OAuth] startInstall issued", {
        requestId,
        tenantId: access.tenantId,
        workosUserId: access.workosUserId,
        stateExpiresAt: state.expiresAt,
        stateFingerprint,
        authorizeHost: authorizeUrl.host,
        authorizePathname: authorizeUrl.pathname,
        redirectUri: describeUrl(redirectUri),
      });

      return { authorizeUrl: authorizeUrl.toString() };
    } catch (error) {
      console.error("[Slack:OAuth] startInstall failed", {
        requestId,
        error: describeError(error),
      });
      throw error;
    }
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

    console.log("[Slack:OAuth] redirect received", {
      callbackId,
      path: url.pathname,
      queryParamNames: Array.from(url.searchParams.keys()).sort(),
      hasError: Boolean(errorParam),
      hasCode: Boolean(code),
      hasState: Boolean(stateRaw),
      stateFingerprint,
    });

    if (errorParam) {
      console.warn("[Slack:OAuth] redirect denied by Slack", {
        callbackId,
        errorParam,
        stateFingerprint,
      });
      return Response.redirect(workspaceSettingsUrl("denied"), 302);
    }

    if (!code || !stateRaw) {
      console.error("[Slack:OAuth] redirect missing required params", {
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
      console.error("[Slack:OAuth] invalid or expired state", {
        callbackId,
        stateFingerprint,
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }
    console.log("[Slack:OAuth] state consumed", {
      requestId,
      callbackId,
      stateFingerprint,
      tenantId: state.tenantId,
      workosUserId: state.workosUserId,
    });

    const installer = await ctx.runQuery(
      internal.slack.installations.verifyInstallerStillAdmin,
      {
        tenantId: state.tenantId,
        workosUserId: state.workosUserId,
        requestId,
      },
    );
    if (!installer) {
      console.error("[Slack:OAuth] installer no longer authorized", {
        requestId,
        callbackId,
        tenantId: state.tenantId,
        workosUserId: state.workosUserId,
      });
      return Response.redirect(workspaceSettingsUrl("admin_required"), 302);
    }
    console.log("[Slack:OAuth] installer authorization confirmed", {
      requestId,
      callbackId,
      tenantId: state.tenantId,
      installerUserId: installer.userId,
    });

    const redirectUri = getRequiredEnv("SLACK_REDIRECT_URI");
    console.log("[Slack:OAuth] exchanging OAuth code with Slack", {
      requestId,
      callbackId,
      redirectUri: describeUrl(redirectUri),
      stateFingerprint,
    });

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
      });
    } catch (error) {
      console.error("[Slack:OAuth] oauth.v2.access request failed", {
        requestId,
        callbackId,
        error: describeError(error),
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }

    console.log("[Slack:OAuth] oauth.v2.access response received", {
      requestId,
      callbackId,
      httpStatus: tokenResponse.status,
      httpOk: tokenResponse.ok,
    });

    let data: SlackOAuthAccessResponse;
    try {
      data = (await tokenResponse.json()) as SlackOAuthAccessResponse;
    } catch (error) {
      console.error("[Slack:OAuth] oauth.v2.access invalid JSON", {
        requestId,
        callbackId,
        httpStatus: tokenResponse.status,
        error: describeError(error),
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }

    console.log("[Slack:OAuth] oauth.v2.access parsed", {
      requestId,
      callbackId,
      httpStatus: tokenResponse.status,
      response: describeSlackOAuthResponse(data),
    });

    const missingFields = missingSlackOAuthFields(data);
    if (missingFields.length > 0) {
      console.error("[Slack:OAuth] oauth.v2.access failed validation", {
        requestId,
        callbackId,
        httpStatus: tokenResponse.status,
        missingFields,
        response: describeSlackOAuthResponse(data),
      });
      return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
    }

    const teamId = data.team!.id!;
    const appId = data.app_id!;
    const scopes = (data.scope ?? "").split(",").filter(Boolean);
    console.log("[Slack:OAuth] looking up existing installation", {
      requestId,
      callbackId,
      tenantId: state.tenantId,
      teamId,
      appId,
      scopeCount: scopes.length,
      scopes,
    });

    const existing = await ctx.runQuery(
      internal.slack.installations.byTeamIdAndAppId,
      {
        teamId,
        appId,
        logContext: "oauth_redirect",
      },
    );

    console.log("[Slack:OAuth] existing installation lookup complete", {
      requestId,
      callbackId,
      found: Boolean(existing),
      installationId: existing?._id,
      existingTenantId: existing?.tenantId,
      previousStatus: existing?.status,
      attemptingTenantId: state.tenantId,
      hadNotifyChannel: Boolean(existing?.notifyChannelId),
      hadStaleReminderChannel: Boolean(existing?.staleReminderChannelId),
      previousTokenExpiresAt: existing?.tokenExpiresAt,
      previousUninstalledAt: existing?.uninstalledAt,
    });

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

    if (existing) {
      if (existing.tenantId !== state.tenantId) {
        console.error("[Slack:OAuth] cross-tenant install attempt", {
          requestId,
          callbackId,
          installationId: existing._id,
          existingTenantId: existing.tenantId,
          attemptingTenantId: state.tenantId,
          previousStatus: existing.status,
          teamId,
          appId,
        });
        return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
      }

      console.log("[Slack:OAuth] reactivating existing installation", {
        requestId,
        callbackId,
        installationId: existing._id,
        tenantId: state.tenantId,
        previousStatus: existing.status,
        tokenExpiresAt: tokenTuple.tokenExpiresAt,
      });
      await ctx.runMutation(internal.slack.installations.reactivate, {
        id: existing._id,
        ...tokenTuple,
      });
      needsChannelPicker = !existing.notifyChannelId;
      console.log("[Slack:OAuth] existing row reactivated", {
        requestId,
        callbackId,
        installationId: existing._id,
        tenantId: state.tenantId,
        previousStatus: existing.status,
        needsChannelPicker,
        hadNotifyChannel: Boolean(existing.notifyChannelId),
        hadStaleReminderChannel: Boolean(existing.staleReminderChannelId),
      });
    } else {
      console.log("[Slack:OAuth] creating new installation", {
        requestId,
        callbackId,
        tenantId: state.tenantId,
        teamId,
        appId,
        tokenExpiresAt: tokenTuple.tokenExpiresAt,
      });
      const insertedId = await ctx.runMutation(
        internal.slack.installations.upsertOnInstall,
        {
          tenantId: state.tenantId,
          teamId,
          ...tokenTuple,
        },
      );
      console.log("[Slack:OAuth] new installation created", {
        requestId,
        callbackId,
        installationId: insertedId,
        tenantId: state.tenantId,
        teamId,
        appId,
      });
    }

    console.log("[Slack:OAuth] install complete", {
      requestId,
      callbackId,
      tenantId: state.tenantId,
      teamId,
      appId,
      needsChannelPicker,
    });

    const destination = new URL(workspaceSettingsUrl("connected"));
    if (needsChannelPicker) {
      destination.searchParams.set("pickChannel", "true");
    }
    console.log("[Slack:OAuth] redirecting back to settings", {
      requestId,
      callbackId,
      destinationPathname: destination.pathname,
      destinationSearchParams: Array.from(destination.searchParams.keys()).sort(),
      needsChannelPicker,
    });
    return Response.redirect(destination.toString(), 302);
  } catch (error) {
    console.error("[Slack:OAuth] redirect unexpected failure", {
      requestId,
      callbackId,
      stateFingerprint,
      error: describeError(error),
    });
    return Response.redirect(workspaceSettingsUrl("oauth_failed"), 302);
  }
});
