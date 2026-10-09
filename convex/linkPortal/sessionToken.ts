"use node";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Id } from "../_generated/dataModel";
import { env } from "../_generated/server";
import { log, logRequestContext } from "../lib/observability/log";

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

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function sign(data: string) {
  return createHmac("sha256", secret()).update(data).digest("base64url");
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

export function issuePortalSessionToken(args: {
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
    jti: randomBytes(18).toString("base64url"),
  };
  const body = base64urlJson(payload);
  return `${body}.${sign(body)}`;
}

/**
 * Verify a signed portal session token. Once the signature checks out, the
 * request is attributed to the token's tenant. With `expectedSlug`, also
 * require the token to be bound to that portal slug. The tenant always comes
 * from the signed token, never from client args.
 */
export function verifyPortalSessionToken(token: string, expectedSlug?: string) {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    log.warn("link_portal.session.rejected", { reason: "malformed_token" });
    throw new Error("Invalid portal session.");
  }

  const expected = sign(body);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    log.warn("link_portal.session.rejected", { reason: "signature_mismatch" });
    throw new Error("Invalid portal session.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
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

