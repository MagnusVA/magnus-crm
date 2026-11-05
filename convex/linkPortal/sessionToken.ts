// Web Crypto, not node:crypto, so the portal bootstrap can verify a session
// in a query instead of a Node action.

import type { Id } from "../_generated/dataModel";
import { env } from "../_generated/server";
import { log, logRequestContext } from "../lib/observability/log";
import { timingSafeEqualString } from "../lib/webCrypto";

export type PortalSessionPayload = {
  tenantId: Id<"tenants">;
  publicSlug: string;
  sessionVersion: number;
  iat: number;
  exp: number;
  jti: string;
};

function secret() {
  const value = env.LINK_PORTAL_SESSION_SECRET;
  if (!value) {
    throw new Error("LINK_PORTAL_SESSION_SECRET is not configured.");
  }
  if (value.length < 32) {
    throw new Error("LINK_PORTAL_SESSION_SECRET must be at least 32 characters.");
  }
  return value;
}

const encoder = new TextEncoder();

function bytesToBase64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToText(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function base64urlJson(value: unknown) {
  return bytesToBase64url(encoder.encode(JSON.stringify(value)));
}

async function sign(data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToBase64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data))),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPortalSessionPayload(value: unknown): value is PortalSessionPayload {
  return (
    isRecord(value) &&
    typeof value.tenantId === "string" &&
    typeof value.publicSlug === "string" &&
    typeof value.sessionVersion === "number" &&
    typeof value.iat === "number" &&
    typeof value.exp === "number" &&
    typeof value.jti === "string"
  );
}

export async function issuePortalSessionToken(args: {
  tenantId: Id<"tenants">;
  publicSlug: string;
  sessionVersion: number;
  ttlSeconds: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const payload: PortalSessionPayload = {
    tenantId: args.tenantId,
    publicSlug: args.publicSlug,
    sessionVersion: args.sessionVersion,
    iat: now,
    exp: now + args.ttlSeconds,
    jti: bytesToBase64url(crypto.getRandomValues(new Uint8Array(18))),
  };
  const body = base64urlJson(payload);
  return `${body}.${await sign(body)}`;
}

/**
 * Verify a signed portal session token. Once the signature checks out, the
 * request is attributed to the token's tenant. With `expectedSlug`, also
 * require the token to be bound to that portal slug. The tenant always comes
 * from the signed token, never from client args.
 */
export async function verifyPortalSessionToken(token: string, expectedSlug?: string) {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    log.warn("link_portal.session.rejected", { reason: "malformed_token" });
    throw new Error("Invalid portal session.");
  }

  if (!timingSafeEqualString(signature, await sign(body))) {
    log.warn("link_portal.session.rejected", { reason: "signature_mismatch" });
    throw new Error("Invalid portal session.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(base64urlToText(body));
  } catch {
    log.warn("link_portal.session.rejected", { reason: "invalid_payload_json" });
    throw new Error("Invalid portal session.");
  }

  if (!isPortalSessionPayload(parsed)) {
    log.warn("link_portal.session.rejected", { reason: "invalid_payload" });
    throw new Error("Invalid portal session.");
  }
  logRequestContext({ tenantId: parsed.tenantId });
  if (parsed.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Portal session expired.");
  }
  if (expectedSlug !== undefined && parsed.publicSlug !== expectedSlug) {
    throw new Error("Portal session is no longer valid.");
  }

  return parsed;
}

