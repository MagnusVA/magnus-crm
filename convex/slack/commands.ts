import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import { buildQualifyLeadModal } from "../lib/slackBlockKit";
import { verifySlackSignature } from "../lib/slackSignature";
import { getValidSlackBotToken } from "./tokens";
import { persistRawSlackEvent } from "./rawEventsAudit";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";
const VIEWS_OPEN_URL = "https://slack.com/api/views.open";
const DISCONNECTED_TEXT =
  "Slack integration disconnected — ask an admin to reconnect in the CRM.";

export const slashCommand = httpAction(async (ctx, req) => {
  const startedAt = Date.now();
  const rawBody = await req.text();

  if (!(await verifyInboundSlackRequest(req, rawBody))) {
    console.warn("[Slack:Cmd] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  const params = new URLSearchParams(rawBody);
  if (params.get("ssl_check") === "1") {
    return new Response("", { status: 200 });
  }

  const teamId = params.get("team_id") ?? "";
  const apiAppId = params.get("api_app_id") ?? "";
  const triggerId = params.get("trigger_id") ?? "";
  const slackUserId = params.get("user_id") ?? "";
  const channelId = params.get("channel_id") ?? "";
  const command = params.get("command") ?? "";

  if (
    !teamId ||
    !apiAppId ||
    !triggerId ||
    !slackUserId ||
    !channelId ||
    command !== "/qualify-lead"
  ) {
    console.warn("[Slack:Cmd] malformed payload", {
      teamId,
      apiAppId,
      command,
      hasTrigger: Boolean(triggerId),
    });
    return new Response("Bad request", { status: 400 });
  }

  const installation = await ctx.runQuery(
    internal.slack.installations.byTeamIdAndAppId,
    {
      teamId,
      appId: apiAppId,
    },
  );

  if (!installation || installation.status !== "active") {
    await persistRawSlackEvent(ctx, {
      tenantId: installation?.tenantId,
      teamId,
      apiAppId,
      eventType: "slash_command_rejected",
      rawBody,
      parsedPayload: {
        reason: installation
          ? `status_${installation.status}`
          : "no_installation",
      },
    });
    return jsonResponse({
      response_type: "ephemeral",
      text: DISCONNECTED_TEXT,
    });
  }

  let token: string;
  try {
    token = await getValidSlackBotToken(ctx, installation.tenantId);
  } catch (error) {
    console.error("[Slack:Cmd] token unavailable", {
      tenantId: installation.tenantId,
      err: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse({
      response_type: "ephemeral",
      text:
        "Couldn't open the form - Slack token is being refreshed. " +
        "Try `/qualify-lead` again in a moment.",
    });
  }

  try {
    const slackError = await openQualifyLeadModal({
      token,
      triggerId,
      view: buildQualifyLeadModal({
        tenantId: installation.tenantId,
        slackUserId,
        teamId,
        appId: apiAppId,
        channelId,
      }),
    });
    if (slackError) {
      return handleViewsOpenFailure({
        slackError,
        tenantId: installation.tenantId,
        latencyMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    console.error("[Slack:Cmd] views.open request failed", {
      tenantId: installation.tenantId,
      err: error instanceof Error ? error.message : "unknown",
    });
    return openFailureResponse();
  }

  await persistRawSlackEvent(ctx, {
    tenantId: installation.tenantId,
    teamId,
    apiAppId,
    eventType: "slash_command",
    rawBody,
    parsedPayload: Object.fromEntries(params.entries()),
  });

  console.log("[Slack:Cmd] ok", {
    tenantId: installation.tenantId,
    latencyMs: Date.now() - startedAt,
  });

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

async function openQualifyLeadModal(args: {
  token: string;
  triggerId: string;
  view: ReturnType<typeof buildQualifyLeadModal>;
}): Promise<string | null> {
  const response = await fetch(VIEWS_OPEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      trigger_id: args.triggerId,
      view: args.view,
    }),
  });

  const data = (await response.json()) as { ok?: boolean; error?: string };
  if (!response.ok) {
    return data.error ?? `http_${response.status}`;
  }
  if (data.ok !== true) {
    return data.error ?? "unknown";
  }
  return null;
}

function handleViewsOpenFailure(args: {
  slackError: string;
  tenantId: string;
  latencyMs: number;
}) {
  if (args.slackError === "expired_trigger_id") {
    console.warn("[Slack:Cmd] expired_trigger_id", {
      tenantId: args.tenantId,
      latencyMs: args.latencyMs,
    });
  } else {
    console.error("[Slack:Cmd] views.open failed", {
      tenantId: args.tenantId,
      slackError: args.slackError,
    });
  }

  return openFailureResponse(args.slackError);
}

function openFailureResponse(slackError?: string) {
  return jsonResponse({
    response_type: "ephemeral",
    text:
      slackError === "expired_trigger_id"
        ? "Slack timed out opening the form. Try `/qualify-lead` again."
        : "Couldn't open the form. Please try again - if it persists, ask an admin.",
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
