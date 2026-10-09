import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { httpAction } from "../_generated/server";
import { isExpectedError } from "../lib/observability/errors";
import {
  describeError,
  log,
  logRequestContext,
  reportError,
} from "../lib/observability/log";
import { parseQualifyLeadSubmission } from "../lib/slackBlockKit";
import { verifyInboundSlackRequest } from "../lib/slackSignature";
import { persistRawSlackEvent } from "./rawEventsAudit";

/** Messages for input the submitter can fix, as opposed to a bug. */
const VALIDATION_MESSAGE = /is required|must be|is invalid|^Invalid |cannot be empty/i;

function logRejected(reason: string, attrs: Record<string, unknown> = {}) {
  log.warn("slack.interactivity.rejected", { reason, ...attrs });
}

export const interactivity = httpAction(async (ctx, req) => {
  const rawBody = await req.text();

  const signatureFailure = await verifyInboundSlackRequest(
    req,
    rawBody,
    "interactivity",
  );
  if (signatureFailure) {
    logRejected("bad_signature", { signatureFailure, httpStatus: 401 });
    return new Response("Bad signature", { status: 401 });
  }

  const form = new URLSearchParams(rawBody);
  const payloadRaw = form.get("payload");
  if (!payloadRaw) {
    logRejected("missing_payload", { httpStatus: 400 });
    return new Response("Bad request", { status: 400 });
  }

  const payload = parseJsonObject(payloadRaw);
  if (!payload) {
    logRejected("payload_not_json_object", { httpStatus: 400 });
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
    log.info("slack.interactivity.ignored", {
      reason: "unsupported_type",
      payloadType,
      teamId: payloadTeamId,
    });
    return new Response("", { status: 200 });
  }

  const callbackId = getStringAtPath(payload, ["view", "callback_id"]);
  if (callbackId !== "qualify_lead_submit") {
    log.info("slack.interactivity.ignored", {
      reason: "unknown_callback_id",
      callbackId,
      teamId: payloadTeamId,
    });
    return new Response("", { status: 200 });
  }

  const view = getObjectAtPath(payload, ["view"]);
  const parsed = parseQualifyLeadSubmission(view);
  if (!parsed) {
    // We built this modal, so a view we can't parse is our bug, and the
    // submitter's lead is not saved.
    reportError(
      "slack.interactivity.malformed_view",
      new Error("Slack qualify-lead view submission could not be parsed"),
      {
        integration: "slack",
        fingerprint: "slack.interactivity.malformed_view",
        teamId: payloadTeamId,
        apiAppId: payloadAppId,
      },
    );
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
    // Possible tampering with the modal's private metadata.
    logRejected("context_mismatch", {
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
    // Possible tampering with the modal's private metadata.
    logRejected(installation ? "tenant_mismatch" : "no_installation", {
      metadataTenantId: parsed.tenantId,
      installationTenantId: installation?.tenantId,
      teamId: payloadTeamId,
      apiAppId: payloadAppId,
    });
    return verificationFailedResponse();
  }
  logRequestContext({ tenantId: installation.tenantId });

  const fieldErrors: Record<string, string> = {};
  if (parsed.fullName.length === 0) {
    fieldErrors.full_name = "Required";
  }
  if (parsed.country.length === 0) {
    fieldErrors.country = "Required";
  }
  if (parsed.handle.length === 0) {
    fieldErrors.handle = "Required";
  }

  if (Object.keys(fieldErrors).length > 0) {
    log.info("slack.interactivity.validation_failed", {
      tenantId: parsed.tenantId,
      fields: Object.keys(fieldErrors),
    });
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
      handle: parsed.handle,
      country: parsed.country,
      leadType: parsed.leadType,
      qualifiedBy: {
        slackUserId: parsed.slackUserId,
        slackTeamId: parsed.teamId,
        submittedAt: Date.now(),
      },
    });
  } catch (error) {
    // Shown to the submitter as a modal error, so the request succeeds.
    if (isExpectedError(error)) {
      log.info("slack.interactivity.validation_failed", {
        tenantId: parsed.tenantId,
        reason: error.data.code,
      });
    } else if (
      error instanceof Error &&
      VALIDATION_MESSAGE.test(error.message)
    ) {
      log.info("slack.interactivity.validation_failed", {
        tenantId: parsed.tenantId,
        reason: "invalid_input",
      });
    } else {
      // The nested mutation's failure is already reported by the log stream.
      log.error("slack.interactivity.create_lead_failed", {
        tenantId: parsed.tenantId,
        installationId: installation._id,
        errorName: describeError(error).name,
      });
    }
    return jsonResponse({
      response_action: "errors",
      errors: { handle: "Couldn't save the lead - please try again." },
    });
  }

  if (result.kind === "duplicate_pending") {
    log.info("slack.interactivity.submitted", {
      tenantId: parsed.tenantId,
      outcome: "duplicate_pending",
      opportunityId: result.existingOpportunityId,
    });
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

  if (result.kind === "existing_opportunity_bump") {
    log.info("slack.interactivity.submitted", {
      tenantId: parsed.tenantId,
      outcome: "existing_opportunity_bump",
      opportunityId: result.existingOpportunityId,
      leadId: result.leadId,
      qualificationEventId: result.qualificationEventId,
    });
    return new Response("", { status: 200 });
  }

  log.info("slack.interactivity.submitted", {
    tenantId: parsed.tenantId,
    outcome: "created",
    opportunityId: result.opportunityId,
    leadId: result.leadId,
    isNewLead: result.isNewLead,
  });

  return new Response("", { status: 200 });
});

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type CreateQualifiedLeadResult =
  | {
      kind: "duplicate_pending";
      existingOpportunityId: Id<"opportunities">;
      priorQualifiedBy: {
        slackUserId: string;
        slackTeamId: string;
        submittedAt: number;
      } | null;
    }
  | {
      kind: "existing_opportunity_bump";
      existingOpportunityId: Id<"opportunities">;
      leadId: Id<"leads">;
      qualificationEventId: Id<"slackQualificationEvents">;
    }
  | {
      kind: "created";
      opportunityId: Id<"opportunities">;
      leadId: Id<"leads">;
      isNewLead: boolean;
    };
