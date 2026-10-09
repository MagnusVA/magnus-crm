import { internal } from "../_generated/api";
import { httpAction } from "../_generated/server";
import {
  describeError,
  log,
  logRequestContext,
  reportError,
} from "../lib/observability/log";
import { buildQualifyLeadModal } from "../lib/slackBlockKit";
import { verifyInboundSlackRequest } from "../lib/slackSignature";
import { getValidSlackBotToken, logSlackTokenUnavailable } from "./tokens";
import { persistRawSlackEvent } from "./rawEventsAudit";
import { timeoutSignal } from "../lib/timeoutSignal";

const VIEWS_OPEN_URL = "https://slack.com/api/views.open";
/** Slack's trigger_id expires 3s after the command, so give up before that. */
const VIEWS_OPEN_TIMEOUT_MS = 2_500;
const DISCONNECTED_TEXT =
  "Slack integration disconnected — ask an admin to reconnect in the CRM.";

export const slashCommand = httpAction(async (ctx, req) => {
  const startedAt = Date.now();
  const rawBody = await req.text();

  const signatureFailure = await verifyInboundSlackRequest(
    req,
    rawBody,
    "commands",
  );
  if (signatureFailure) {
    log.warn("slack.commands.rejected", {
      reason: "bad_signature",
      signatureFailure,
      httpStatus: 401,
    });
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
    log.warn("slack.commands.rejected", {
      reason: "malformed_payload",
      httpStatus: 400,
      teamId,
      apiAppId,
      knownCommand: command === "/qualify-lead",
      hasTrigger: Boolean(triggerId),
      hasUser: Boolean(slackUserId),
      hasChannel: Boolean(channelId),
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
  if (installation) {
    logRequestContext({ tenantId: installation.tenantId });
  }

  if (!installation || installation.status !== "active") {
    log.warn("slack.commands.rejected", {
      reason: installation ? "installation_not_active" : "no_installation",
      teamId,
      apiAppId,
      tenantId: installation?.tenantId,
      installationStatus: installation?.status,
    });
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
    logSlackTokenUnavailable("slack.commands.token_unavailable", error, {
      tenantId: installation.tenantId,
      installationId: installation._id,
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
    // The user gets an ephemeral error; the request itself succeeds.
    const errorName = describeError(error).name;
    reportError(
      "slack.commands.modal_open_failed",
      new Error("Slack views.open request failed"),
      {
        integration: "slack",
        fingerprint: `slack.commands.modal_open_failed:${errorName}`,
        errorName,
        tenantId: installation.tenantId,
        latencyMs: Date.now() - startedAt,
      },
    );
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

  log.info("slack.commands.handled", {
    tenantId: installation.tenantId,
    command: "qualify_lead",
    latencyMs: Date.now() - startedAt,
  });

  return new Response("", { status: 200 });
});

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
    signal: timeoutSignal(VIEWS_OPEN_TIMEOUT_MS),
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
    // We took longer than Slack's 3s trigger window; latency explains it.
    log.warn("slack.commands.modal_open_failed", {
      tenantId: args.tenantId,
      slackError: args.slackError,
      latencyMs: args.latencyMs,
    });
  } else {
    reportError(
      "slack.commands.modal_open_failed",
      new Error(`Slack views.open failed: ${args.slackError}`),
      {
        integration: "slack",
        fingerprint: `slack.commands.modal_open_failed:${args.slackError}`,
        tenantId: args.tenantId,
        slackError: args.slackError,
        latencyMs: args.latencyMs,
      },
    );
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
