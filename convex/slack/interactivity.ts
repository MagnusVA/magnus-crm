import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { httpAction } from "../_generated/server";
import { parseQualifyLeadSubmission } from "../lib/slackBlockKit";
import { verifySlackSignature } from "../lib/slackSignature";
import { persistRawSlackEvent } from "./rawEventsAudit";

const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

export const interactivity = httpAction(async (ctx, req) => {
  const rawBody = await req.text();

  if (!(await verifyInboundSlackRequest(req, rawBody))) {
    console.warn("[Slack:Int] bad signature");
    return new Response("Bad signature", { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const payloadRaw = form.get("payload");
  if (!payloadRaw) {
    console.warn("[Slack:Int] missing payload field");
    return new Response("Bad request", { status: 400 });
  }

  const payload = parseJsonObject(payloadRaw);
  if (!payload) {
    console.warn("[Slack:Int] payload not JSON object");
    return new Response("Bad request", { status: 400 });
  }

  const payloadTeamId =
    getStringAtPath(payload, ["team", "id"]) ??
    getStringAtPath(payload, ["user", "team_id"]) ??
    "";
  const payloadAppId = getStringAtPath(payload, ["api_app_id"]) ?? "";
  const payloadType = getStringAtPath(payload, ["type"]) ?? "unknown";

  await persistRawSlackEvent(ctx, {
    teamId: payloadTeamId,
    apiAppId: payloadAppId,
    eventType: payloadType,
    rawBody,
    parsedPayload: payload,
  });

  if (payloadType !== "view_submission") {
    console.log("[Slack:Int] ignored type", { type: payloadType });
    return new Response("", { status: 200 });
  }

  const callbackId = getStringAtPath(payload, ["view", "callback_id"]);
  if (callbackId !== "qualify_lead_submit") {
    console.log("[Slack:Int] ignored callback_id", { callbackId });
    return new Response("", { status: 200 });
  }

  const view = getObjectAtPath(payload, ["view"]);
  const parsed = parseQualifyLeadSubmission(view);
  if (!parsed) {
    console.error("[Slack:Int] view payload malformed");
    return jsonResponse({
      response_action: "errors",
      errors: { handle: "Couldn't parse — please try again." },
    });
  }

  if (
    !payloadTeamId ||
    !payloadAppId ||
    payloadTeamId !== parsed.teamId ||
    payloadAppId !== parsed.appId
  ) {
    console.error("[Slack:Int] Slack context mismatch - possible tampering", {
      payloadTeamId,
      metadataTeamId: parsed.teamId,
      payloadAppId,
      metadataAppId: parsed.appId,
    });
    return verificationFailedResponse();
  }

  const installation = await ctx.runQuery(
    internal.slack.installations.byTeamIdAndAppId,
    {
      teamId: payloadTeamId,
      appId: payloadAppId,
    },
  );
  if (!installation || installation.tenantId !== parsed.tenantId) {
    console.error("[Slack:Int] tenantId mismatch - possible tampering", {
      metadataTenant: parsed.tenantId,
      installationTenant: installation?.tenantId,
      teamId: payloadTeamId,
      appId: payloadAppId,
    });
    return verificationFailedResponse();
  }

  const fieldErrors: Record<string, string> = {};
  if (parsed.fullName.length === 0) {
    fieldErrors.full_name = "Required";
  }
  if (parsed.handle.length === 0) {
    fieldErrors.handle = "Required";
  }
  if (parsed.email && !looksLikeEmail(parsed.email)) {
    fieldErrors.email = "Invalid email";
  }

  if (Object.keys(fieldErrors).length > 0) {
    return jsonResponse({
      response_action: "errors",
      errors: fieldErrors,
    });
  }

  let result: CreateQualifiedLeadResult;
  try {
    result = await ctx.runMutation(internal.slack.createQualifiedLead.create, {
      tenantId: parsed.tenantId,
      installationId: installation._id,
      fullName: parsed.fullName,
      platform: parsed.platform,
      handle: parsed.handle,
      email: parsed.email ?? undefined,
      phone: parsed.phone ?? undefined,
      qualifiedBy: {
        slackUserId: parsed.slackUserId,
        slackTeamId: parsed.teamId,
        submittedAt: Date.now(),
      },
    });
  } catch (error) {
    console.error("[Slack:Int] createQualifiedLead threw", {
      tenantId: parsed.tenantId,
      err: error instanceof Error ? error.message : "unknown",
    });
    return jsonResponse({
      response_action: "errors",
      errors: { handle: "Couldn't save the lead - please try again." },
    });
  }

  if (result.duplicate) {
    if ("alreadyBooked" in result && result.alreadyBooked) {
      return jsonResponse({
        response_action: "errors",
        errors: {
          handle: "This lead already has a booked or active opportunity.",
        },
      });
    }

    const priorAt = result.priorQualifiedBy?.submittedAt;
    const elapsedDays = priorAt
      ? Math.floor((Date.now() - priorAt) / (24 * 60 * 60 * 1000))
      : null;
    const duration =
      elapsedDays && elapsedDays > 0
        ? ` ${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`
        : "";
    const priorUser = result.priorQualifiedBy?.slackUserId;
    const message = priorUser
      ? `Already qualified by <@${priorUser}>${duration}.`
      : "This lead has already been qualified recently.";
    return jsonResponse({
      response_action: "errors",
      errors: { handle: message },
    });
  }

  console.log("[Slack:Int] view_submission committed", {
    tenantId: parsed.tenantId,
    opportunityId: result.opportunityId,
    leadId: result.leadId,
    isNewLead: result.isNewLead,
    resolvedVia: result.resolvedVia,
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

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function getObjectAtPath(
  value: Record<string, unknown>,
  path: string[],
): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "object" && current !== null
    ? (current as Record<string, unknown>)
    : null;
}

function getStringAtPath(
  value: Record<string, unknown>,
  path: string[],
): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function verificationFailedResponse() {
  return jsonResponse({
    response_action: "errors",
    errors: { handle: "Submission verification failed - please retry." },
  });
}

function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type CreateQualifiedLeadResult =
  | {
      duplicate: true;
      existingOpportunityId: Id<"opportunities">;
      priorQualifiedBy: {
        slackUserId: string;
        slackTeamId: string;
        submittedAt: number;
      } | null;
      alreadyBooked?: boolean;
    }
  | {
      duplicate: false;
      opportunityId: Id<"opportunities">;
      leadId: Id<"leads">;
      isNewLead: boolean;
      resolvedVia: "email" | "social_handle" | "phone" | "new";
    };
