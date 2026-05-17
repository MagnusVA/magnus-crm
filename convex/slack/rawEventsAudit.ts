import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

const REDACTED_KEYS = new Set([
  "response_url",
  "trigger_id",
  "token",
  "ssl_check",
]);

const REDACTED_PII_KEYS = new Set([
  "email",
  "phone",
  "real_name",
  "real_name_normalized",
  "display_name",
  "display_name_normalized",
  "first_name",
  "last_name",
]);

const SENSITIVE_MODAL_BLOCK_IDS = new Set(["full_name"]);

const PROFILE_PII_KEYS = new Set([
  "email",
  "phone",
  "real_name",
  "real_name_normalized",
  "display_name",
  "display_name_normalized",
  "first_name",
  "last_name",
]);

export type RawSlackEventInsert = {
  tenantId?: Id<"tenants">;
  teamId: string;
  apiAppId?: string;
  eventType: string;
  rawBody: string;
  parsedPayload: unknown;
  slackEventId?: string;
};

export async function buildRawEventEnvelope(args: RawSlackEventInsert) {
  const requestHash = await sha256Hex(args.rawBody);
  const redacted = redact(args.parsedPayload);

  return {
    teamId: args.teamId,
    tenantId: args.tenantId,
    apiAppId: args.apiAppId,
    eventType: args.eventType,
    payloadRedacted: JSON.stringify(redacted ?? null),
    requestHash,
    slackEventId: args.slackEventId,
  };
}

export async function persistRawSlackEvent(
  ctx: ActionCtx,
  args: RawSlackEventInsert,
): Promise<void> {
  const envelope = await buildRawEventEnvelope(args);
  await ctx.runMutation(internal.slack.rawEvents.insert, envelope);
}

function redact(value: unknown, path: string[] = [], depth = 0): unknown {
  if (depth > 8) {
    return "<redacted:depth>";
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, path, depth + 1));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key)) {
      continue;
    }
    const nextPath = [...path, key];
    if (REDACTED_PII_KEYS.has(key)) {
      out[key] = "<redacted:pii>";
      continue;
    }
    if (
      key === "value" &&
      path.some((part) => SENSITIVE_MODAL_BLOCK_IDS.has(part))
    ) {
      out[key] = "<redacted:pii>";
      continue;
    }
    if (path.includes("profile") && PROFILE_PII_KEYS.has(key)) {
      out[key] = "<redacted:pii>";
      continue;
    }
    out[key] = redact(item, nextPath, depth + 1);
  }
  return out;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
