const REPLAY_WINDOW_SECONDS = 60 * 5;

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

export async function verifySlackSignature(
  args: VerifySlackSignatureArgs,
): Promise<boolean> {
  if (!args.signingSecret) {
    return false;
  }

  const ts = Number(args.timestamp);
  if (!Number.isFinite(ts)) {
    return false;
  }

  if (Math.abs(Date.now() / 1000 - ts) > REPLAY_WINDOW_SECONDS) {
    return false;
  }

  const base = `v0:${args.timestamp}:${args.rawBody}`;
  const candidateSecrets = [
    args.signingSecret,
    args.previousSigningSecret,
  ].filter((secret): secret is string => Boolean(secret));

  for (const secret of candidateSecrets) {
    const expected = `v0=${await hmacSha256Hex(secret, base)}`;
    if (timingSafeEqualString(expected, args.signature)) {
      return true;
    }
  }

  return false;
}
