import { action, httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { createSlackOAuthState, validateAndConsumeSlackOAuthState } from "../lib/slackOAuthState";
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
  args: {},
  handler: async (ctx) => {
    const access = await requireTenantUserFromAction(ctx, [
      "tenant_master",
      "tenant_admin",
    ]);

    const clientId = getRequiredEnv("SLACK_CLIENT_ID");
    const redirectUri = getRequiredEnv("SLACK_REDIRECT_URI");
    const state = await createSlackOAuthState(ctx, {
      tenantId: access.tenantId,
      workosUserId: access.workosUserId,
      ttlSeconds: 600,
    });

    const authorizeUrl = new URL("https://slack.com/oauth/v2/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state.token);

    console.log("[Slack:OAuth] startInstall issued", {
      tenantId: access.tenantId,
      workosUserId: access.workosUserId,
      stateExpiresAt: state.expiresAt,
    });

    return { authorizeUrl: authorizeUrl.toString() };
  },
});

export const oauthRedirect = httpAction(async (ctx, req) => {
  const url = new URL(req.url);
  const errorParam = url.searchParams.get("error");
  if (errorParam) {
    console.warn("[Slack:OAuth] redirect with error", { errorParam });
    return Response.redirect(workspaceSettingsUrl("denied"), 302);
  }

  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  if (!code || !stateRaw) {
    return new Response("Bad request - missing code or state", { status: 400 });
  }

  const state = await validateAndConsumeSlackOAuthState(ctx, {
    token: stateRaw,
  });
  if (!state) {
    console.error("[Slack:OAuth] invalid or expired state");
    return new Response("Invalid state", { status: 401 });
  }

  const installer = await ctx.runQuery(
    internal.slack.installations.verifyInstallerStillAdmin,
    {
      tenantId: state.tenantId,
      workosUserId: state.workosUserId,
    },
  );
  if (!installer) {
    console.error("[Slack:OAuth] installer no longer authorized", {
      tenantId: state.tenantId,
      workosUserId: state.workosUserId,
    });
    return new Response("Installer no longer authorized", { status: 403 });
  }

  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: getRequiredEnv("SLACK_CLIENT_ID"),
      client_secret: getRequiredEnv("SLACK_CLIENT_SECRET"),
      redirect_uri: getRequiredEnv("SLACK_REDIRECT_URI"),
    }),
  });
  const data = (await tokenResponse.json()) as SlackOAuthAccessResponse;

  if (
    !data.ok ||
    !data.access_token ||
    !data.refresh_token ||
    !data.expires_in ||
    !data.app_id ||
    !data.bot_user_id ||
    !data.team?.id ||
    !data.team.name
  ) {
    console.error("[Slack:OAuth] oauth.v2.access failed", {
      error: data.error,
    });
    return new Response(`Slack OAuth failed: ${data.error ?? "unknown"}`, {
      status: 502,
    });
  }

  const existing = await ctx.runQuery(
    internal.slack.installations.byTeamIdAndAppId,
    {
      teamId: data.team.id,
      appId: data.app_id,
    },
  );

  const tokenTuple = {
    teamName: data.team.name,
    enterpriseId: data.enterprise?.id,
    isEnterpriseInstall: Boolean(data.is_enterprise_install),
    appId: data.app_id,
    botUserId: data.bot_user_id,
    botAccessToken: data.access_token,
    refreshToken: data.refresh_token,
    tokenExpiresAt: Date.now() + data.expires_in * 1000,
    scopes: (data.scope ?? "").split(",").filter(Boolean),
    installedByWorkosUserId: state.workosUserId,
  };
  let needsChannelPicker = true;

  if (existing) {
    if (existing.tenantId !== state.tenantId) {
      console.error("[Slack:OAuth] cross-tenant install attempt", {
        existingTenantId: existing.tenantId,
        attemptingTenantId: state.tenantId,
        teamId: data.team.id,
        appId: data.app_id,
      });
      return new Response("Slack workspace already linked to another tenant", {
        status: 409,
      });
    }

    await ctx.runMutation(internal.slack.installations.reactivate, {
      id: existing._id,
      ...tokenTuple,
    });
    needsChannelPicker = !existing.notifyChannelId;
    console.log("[Slack:OAuth] existing row reactivated", {
      id: existing._id,
      previousStatus: existing.status,
    });
  } else {
    await ctx.runMutation(internal.slack.installations.upsertOnInstall, {
      tenantId: state.tenantId,
      teamId: data.team.id,
      ...tokenTuple,
    });
  }

  console.log("[Slack:OAuth] install complete", {
    tenantId: state.tenantId,
    teamId: data.team.id,
    appId: data.app_id,
  });

  const destination = new URL(workspaceSettingsUrl("connected"));
  if (needsChannelPicker) {
    destination.searchParams.set("pickChannel", "true");
  }
  return Response.redirect(destination.toString(), 302);
});
