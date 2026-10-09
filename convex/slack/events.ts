import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import { log, logRequestContext } from "../lib/observability/log";
import { verifyInboundSlackRequest } from "../lib/slackSignature";
import { persistRawSlackEvent } from "./rawEventsAudit";

type SlackEventEnvelope = {
  type?: string;
  challenge?: string;
  team_id?: string;
  team?: { id?: string };
  api_app_id?: string;
  event_id?: string;
  event?: {
    type?: string;
    user?: unknown;
  };
};

export const handleEvent = httpAction(async (ctx, req) => {
  const rawBody = await req.text();

  const signatureFailure = await verifyInboundSlackRequest(
    req,
    rawBody,
    "events",
  );
  if (signatureFailure) {
    log.warn("slack.events.rejected", {
      reason: "bad_signature",
      signatureFailure,
      httpStatus: 401,
    });
    return new Response("Bad signature", { status: 401 });
  }

  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    log.warn("slack.events.rejected", {
      reason: "body_not_json",
      httpStatus: 400,
    });
    return new Response("Bad request", { status: 400 });
  }

  if (body.type === "url_verification") {
    await persistRawSlackEvent(ctx, {
      teamId: body.team_id ?? "",
      apiAppId: body.api_app_id,
      eventType: "url_verification",
      rawBody,
      parsedPayload: body,
    });
    log.info("slack.events.handled", { eventType: "url_verification" });
    return new Response(body.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (body.type !== "event_callback") {
    log.info("slack.events.ignored", {
      reason: "unsupported_envelope_type",
      envelopeType: body.type,
    });
    return new Response("", { status: 200 });
  }

  const teamId = body.team_id ?? body.team?.id ?? "";
  const appId = body.api_app_id ?? "";
  const eventType = body.event?.type;

  if (!teamId || !appId) {
    log.warn("slack.events.rejected", {
      reason: "missing_team_or_app_id",
      httpStatus: 200,
      hasTeamId: Boolean(teamId),
      hasAppId: Boolean(appId),
      eventType,
    });
    return new Response("", { status: 200 });
  }

  await persistRawSlackEvent(ctx, {
    teamId,
    apiAppId: appId,
    eventType: `event_callback:${eventType ?? "unknown"}`,
    rawBody,
    parsedPayload: body,
    slackEventId: body.event_id,
  });

  if (eventType === "app_uninstalled") {
    const affected = await ctx.runMutation(
      internal.slack.installations.markUninstalled,
      { teamId, appId },
    );

    for (const row of affected) {
      await emitDomainEventInAction(ctx, {
        tenantId: row.tenantId,
        entityType: "slackInstallation",
        entityId: row.installationId,
        eventType: "slack.installation.uninstalled",
        source: "system",
        occurredAt: Date.now(),
        metadata: { teamId, appId, previousStatus: row.previousStatus },
      });
    }

    logLifecycleEvent(eventType, { teamId, appId, affected });
    return new Response("", { status: 200 });
  }

  if (eventType === "tokens_revoked") {
    const affected = await ctx.runMutation(
      internal.slack.installations.markRevoked,
      { teamId, appId },
    );

    for (const row of affected) {
      await emitDomainEventInAction(ctx, {
        tenantId: row.tenantId,
        entityType: "slackInstallation",
        entityId: row.installationId,
        eventType: "slack.installation.tokens_revoked",
        source: "system",
        occurredAt: Date.now(),
        metadata: { teamId, appId, previousStatus: row.previousStatus },
      });
    }

    logLifecycleEvent(eventType, { teamId, appId, affected });
    return new Response("", { status: 200 });
  }

  if (eventType === "user_change") {
    if (!body.event?.user) {
      log.warn("slack.events.rejected", {
        reason: "user_change_without_user",
        httpStatus: 200,
        teamId,
        apiAppId: appId,
      });
      return new Response("", { status: 200 });
    }

    const installation = await ctx.runQuery(
      internal.slack.installations.byTeamIdAndAppId,
      { teamId, appId },
    );
    if (installation) {
      logRequestContext({ tenantId: installation.tenantId });
    }
    if (!installation || installation.status !== "active") {
      log.info("slack.events.ignored", {
        reason: installation ? "installation_not_active" : "no_installation",
        eventType,
        teamId,
        apiAppId: appId,
        installationStatus: installation?.status,
      });
      return new Response("", { status: 200 });
    }

    await ctx.runMutation(internal.slack.users.handleUserChange, {
      installationId: installation._id,
      userPayload: body.event.user,
    });
    log.info("slack.events.handled", {
      eventType,
      tenantId: installation.tenantId,
      installationId: installation._id,
    });
    return new Response("", { status: 200 });
  }

  log.info("slack.events.ignored", {
    reason: "unsupported_event_type",
    eventType,
    teamId,
  });
  return new Response("", { status: 200 });
});

/**
 * Uninstall and token revocation are routine lifecycle events (our own
 * disconnect flow triggers them), so the outcome line is info. Losing an
 * installation that was still active means someone removed the app from the
 * Slack side and notifications stop, which gets a separate warning.
 */
function logLifecycleEvent(
  eventType: "app_uninstalled" | "tokens_revoked",
  args: {
    teamId: string;
    appId: string;
    affected: Array<{
      tenantId: string;
      installationId: string;
      previousStatus: string;
    }>;
  },
) {
  const { teamId, appId, affected } = args;
  if (affected.length === 1) {
    logRequestContext({ tenantId: affected[0].tenantId });
  }
  log.info("slack.events.handled", {
    eventType,
    teamId,
    apiAppId: appId,
    affectedInstallations: affected.length,
    tenantIds: affected.map((row) => row.tenantId),
  });
  for (const row of affected) {
    if (row.previousStatus !== "active") continue;
    log.warn("slack.installation.lost", {
      reason: eventType,
      tenantId: row.tenantId,
      installationId: row.installationId,
      teamId,
      apiAppId: appId,
    });
  }
}
