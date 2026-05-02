import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

const STATE_TTL_DEFAULT_SECONDS = 600;
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type StatePayload = {
  tenantId: Id<"tenants">;
  workosUserId: string;
  nonce: string;
  iat: number;
  exp: number;
};

export type CreatedSlackOAuthState = {
  token: string;
  expiresAt: number;
};

export type ValidatedSlackOAuthState = {
  tenantId: Id<"tenants">;
  workosUserId: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;

    encoded += BASE64URL_ALPHABET[(triple >> 18) & 63];
    encoded += BASE64URL_ALPHABET[(triple >> 12) & 63];
    if (i + 1 < bytes.length) {
      encoded += BASE64URL_ALPHABET[(triple >> 6) & 63];
    }
    if (i + 2 < bytes.length) {
      encoded += BASE64URL_ALPHABET[triple & 63];
    }
  }
  return encoded;
}

function stringToBase64Url(input: string): string {
  return bytesToBase64Url(new TextEncoder().encode(input));
}

function base64urlDecodeToString(input: string): string {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const char of input) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error("Invalid base64url character");
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return new TextDecoder().decode(new Uint8Array(bytes));
}

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

async function verifySignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const expected = await hmacSha256Hex(secret, payload);
  return timingSafeEqualString(expected, signature);
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

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getSigningSecret(explicitSecret?: string): string {
  const signingSecret = explicitSecret ?? process.env.SLACK_STATE_SIGNING_SECRET;
  if (!signingSecret) {
    throw new Error("SLACK_STATE_SIGNING_SECRET not set");
  }
  return signingSecret;
}

export async function createSlackOAuthState(
  ctx: ActionCtx,
  args: {
    tenantId: Id<"tenants">;
    workosUserId: string;
    ttlSeconds?: number;
    signingSecret?: string;
  },
): Promise<CreatedSlackOAuthState> {
  const signingSecret = getSigningSecret(args.signingSecret);
  const now = Date.now();
  const expiresAt =
    now + (args.ttlSeconds ?? STATE_TTL_DEFAULT_SECONDS) * 1000;
  const nonce = randomHex(32);
  const payload: StatePayload = {
    tenantId: args.tenantId,
    workosUserId: args.workosUserId,
    nonce,
    iat: now,
    exp: expiresAt,
  };
  const payloadEncoded = stringToBase64Url(JSON.stringify(payload));
  const token = `${payloadEncoded}.${await hmacSha256Hex(
    signingSecret,
    payloadEncoded,
  )}`;

  await ctx.runMutation(internal.slack.oauthStateMutations.insertState, {
    tenantId: args.tenantId,
    workosUserId: args.workosUserId,
    stateHash: await sha256Hex(token),
    nonceHash: await sha256Hex(nonce),
    issuedAt: now,
    expiresAt,
  });

  return { token, expiresAt };
}

export async function validateAndConsumeSlackOAuthState(
  ctx: ActionCtx,
  args: { token: string; signingSecret?: string },
): Promise<ValidatedSlackOAuthState | null> {
  const signingSecret = getSigningSecret(args.signingSecret);
  const dotIndex = args.token.lastIndexOf(".");
  if (dotIndex < 0) {
    return null;
  }

  const payloadEncoded = args.token.slice(0, dotIndex);
  const signature = args.token.slice(dotIndex + 1);
  if (!(await verifySignature(payloadEncoded, signature, signingSecret))) {
    return null;
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(base64urlDecodeToString(payloadEncoded)) as StatePayload;
  } catch {
    return null;
  }

  if (
    !payload ||
    typeof payload.tenantId !== "string" ||
    typeof payload.workosUserId !== "string" ||
    typeof payload.nonce !== "string" ||
    typeof payload.exp !== "number" ||
    Date.now() >= payload.exp
  ) {
    return null;
  }

  const consumed = await ctx.runMutation(
    internal.slack.oauthStateMutations.consumeState,
    {
      stateHash: await sha256Hex(args.token),
      nonceHash: await sha256Hex(payload.nonce),
    },
  );

  if (!consumed) {
    return null;
  }

  return {
    tenantId: payload.tenantId,
    workosUserId: payload.workosUserId,
  };
}
