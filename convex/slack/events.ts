import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { emitDomainEventInAction } from "../lib/domainEventsAction";
import { verifySlackSignature } from "../lib/slackSignature";
import { persistRawSlackEvent } from "./rawEventsAudit";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

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

  if (!(await verifyInboundSlackRequest(req, rawBody))) {
    console.warn("[Slack:Events] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  let body: SlackEventEnvelope;
  try {
    body = JSON.parse(rawBody) as SlackEventEnvelope;
  } catch {
    console.warn("[Slack:Events] body not JSON");
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
    console.log("[Slack:Events] url_verification handshake");
    return new Response(body.challenge ?? "", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  if (body.type !== "event_callback") {
    console.log("[Slack:Events] ignored top-level type", { type: body.type });
    return new Response("", { status: 200 });
  }

  const teamId = body.team_id ?? body.team?.id ?? "";
  const appId = body.api_app_id ?? "";
  const eventType = body.event?.type;

  if (!teamId || !appId) {
    console.warn("[Slack:Events] missing team_id/api_app_id", {
      teamId,
      appId,
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

    console.log("[Slack:Events] app_uninstalled", {
      teamId,
      affected: affected.length,
    });
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

    console.log("[Slack:Events] tokens_revoked", {
      teamId,
      affected: affected.length,
    });
    return new Response("", { status: 200 });
  }

  if (eventType === "user_change") {
    if (!body.event?.user) {
      console.warn("[Slack:Events] user_change without user payload");
      return new Response("", { status: 200 });
    }

    const installation = await ctx.runQuery(
      internal.slack.installations.byTeamIdAndAppId,
      { teamId, appId },
    );
    if (!installation || installation.status !== "active") {
      console.log("[Slack:Events] user_change ignored - installation inactive", {
        teamId,
        appId,
        status: installation?.status,
      });
      return new Response("", { status: 200 });
    }

    await ctx.runMutation(internal.slack.users.handleUserChange, {
      installationId: installation._id,
      userPayload: body.event.user,
    });
    console.log("[Slack:Events] user_change applied", { teamId, appId });
    return new Response("", { status: 200 });
  }

  console.log("[Slack:Events] ignored event.type", { eventType });
  return new Response("", { status: 200 });
});

async function verifyInboundSlackRequest(
  req: Request,
  rawBody: string,
): Promise<boolean> {
  return await verifySlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
    previousSigningSecret: process.env.SLACK_SIGNING_SECRET_PREVIOUS,
  });
}
