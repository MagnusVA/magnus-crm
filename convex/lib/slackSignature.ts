import { env } from "../_generated/server";
import { reportError } from "./observability/log";

const REPLAY_WINDOW_SECONDS = 60 * 5;
const SIG_HEADER = "x-slack-signature";
const TS_HEADER = "x-slack-request-timestamp";

export type VerifySlackSignatureArgs = {
  rawBody: string;
  timestamp: string;
  signature: string;
  signingSecret: string;
  previousSigningSecret?: string;
};

function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payload),
  );

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Why a Slack request signature check failed. `stale_timestamp` and
 * `invalid_timestamp` are usually scanners or replays; `signature_mismatch`
 * means a fresh request was signed with a secret we don't hold.
 */
export type SlackSignatureFailure =
  | "missing_secret"
  | "invalid_timestamp"
  | "stale_timestamp"
  | "signature_mismatch";

export async function checkSlackSignature(
  args: VerifySlackSignatureArgs,
): Promise<SlackSignatureFailure | null> {
  if (!args.signingSecret) {
    return "missing_secret";
  }

  const ts = Number(args.timestamp);
  if (!args.timestamp || !Number.isFinite(ts)) {
    return "invalid_timestamp";
  }

  if (Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS) {
    return "stale_timestamp";
  }

  const base = `v0:${args.timestamp}:${args.rawBody}`;
  const candidateSecrets = [
    args.signingSecret,
    args.previousSigningSecret,
  ].filter((secret): secret is string => Boolean(secret));

  for (const secret of candidateSecrets) {
    const expected = `v0=${await hmacSha256Hex(secret, base)}`;
    if (timingSafeEqualString(expected, args.signature)) {
      return null;
    }
  }

  return "signature_mismatch";
}

export async function verifySlackSignature(
  args: VerifySlackSignatureArgs,
): Promise<boolean> {
  return (await checkSlackSignature(args)) === null;
}

export type SlackInboundEndpoint =
  | "events"
  | "commands"
  | "interactivity"
  | "commands_stub"
  | "interactivity_stub"
  | "events_stub";

/**
 * Verify an inbound Slack HTTP request against the deployment's signing
 * secrets. A missing secret (every request fails) and a bad signature on a
 * fresh request go to Error Tracking; stale or malformed timestamps are
 * scanners and replays, so the caller only logs them.
 *
 * Returns the failure reason, or `null` when the request is authentic.
 */
export async function verifyInboundSlackRequest(
  req: Request,
  rawBody: string,
  endpoint: SlackInboundEndpoint,
): Promise<SlackSignatureFailure | null> {
  const failure = await checkSlackSignature({
    rawBody,
    timestamp: req.headers.get(TS_HEADER) ?? "",
    signature: req.headers.get(SIG_HEADER) ?? "",
    signingSecret: env.SLACK_SIGNING_SECRET ?? "",
    previousSigningSecret: env.SLACK_SIGNING_SECRET_PREVIOUS,
  });

  if (failure === "missing_secret") {
    reportError(
      "slack.inbound.signing_secret_missing",
      new Error("SLACK_SIGNING_SECRET is not set; rejecting all Slack requests"),
      {
        severity: "error",
        integration: "slack",
        fingerprint: "slack.inbound.signing_secret_missing",
        endpoint,
      },
    );
  } else if (failure === "signature_mismatch") {
    reportError(
      "slack.inbound.invalid_signature",
      new Error("Slack request signature did not match"),
      {
        severity: "warning",
        integration: "slack",
        fingerprint: "slack.inbound.invalid_signature",
        endpoint,
      },
    );
  }

  return failure;
}
