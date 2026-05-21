"use node";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Id } from "../_generated/dataModel";

export type PortalSessionPayload = {
  tenantId: Id<"tenants">;
  publicSlug: string;
  sessionVersion: number;
  iat: number;
  exp: number;
  jti: string;
};

function secret() {
  const value = process.env.LINK_PORTAL_SESSION_SECRET;
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

export function verifyPortalSessionToken(token: string) {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) {
    throw new Error("Invalid portal session.");
  }

  const expected = sign(body);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid portal session.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid portal session.");
  }

  if (!isPortalSessionPayload(parsed)) {
    throw new Error("Invalid portal session.");
  }
  if (parsed.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Portal session expired.");
  }

  return parsed;
}
