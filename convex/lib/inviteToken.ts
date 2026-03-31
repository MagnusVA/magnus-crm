"use node";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface InvitePayload {
  tenantId: string;
  workosOrgId: string;
  contactEmail: string;
  createdAt: number;
}

const INVITE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

export function generateInviteToken(
  payload: InvitePayload,
  signingSecret: string,
): { token: string; tokenHash: string; expiresAt: number } {
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson).toString("base64url");
  const signature = createHmac("sha256", signingSecret)
    .update(payloadB64)
    .digest("base64url");
  const token = `${payloadB64}.${signature}`;

  return {
    token,
    tokenHash: hashInviteToken(token),
    expiresAt: payload.createdAt + INVITE_EXPIRY_MS,
  };
}

export function validateInviteToken(
  token: string,
  signingSecret: string,
): InvitePayload | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) {
    return null;
  }

  const payloadB64 = token.slice(0, dotIndex);
  const providedSignature = token.slice(dotIndex + 1);
  const expectedSignature = createHmac("sha256", signingSecret)
    .update(payloadB64)
    .digest("base64url");

  if (providedSignature.length !== expectedSignature.length) {
    return null;
  }

  if (
    !timingSafeEqual(
      Buffer.from(providedSignature),
      Buffer.from(expectedSignature),
    )
  ) {
    return null;
  }

  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf-8");
    return JSON.parse(payloadJson) as InvitePayload;
  } catch {
    return null;
  }
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
