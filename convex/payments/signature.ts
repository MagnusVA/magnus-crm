const TOLERANCE_SECONDS = 300;
const MAX_SIGNATURES = 8;
const encoder = new TextEncoder();

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export function parseWebhookSecret(secret?: string): Uint8Array<ArrayBuffer> | null {
  if (!secret || secret.length > 1024) return null;
  const match = /^(ws_|whsec_)([!-~]+)$/.exec(secret);
  if (!match) return null;
  try {
    // Whop uses the full ws_ secret as the HMAC key.
    const bytes = match[1] === "ws_" ? encoder.encode(secret) : decodeBase64(match[2]);
    const materialLength = match[1] === "ws_" ? match[2].length : bytes.length;
    return materialLength >= 24 ? bytes : null;
  } catch {
    return null;
  }
}

type SigningConnection = {
  webhookSecret?: string;
  previousWebhookSecret?: string;
  previousWebhookSecretUntil?: number;
};

export function prepareWhopSignature(
  connection: SigningConnection,
  headers: Headers,
  now = Date.now(),
) {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const header = headers.get("webhook-signature");
  if (
    !id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id) ||
    !timestamp || !/^\d{1,12}$/.test(timestamp) ||
    !header || header.length > 1024 ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > TOLERANCE_SECONDS
  ) return null;

  const candidates = header.split(/\s+/);
  if (candidates.length > MAX_SIGNATURES) return null;
  const signatures = candidates.flatMap((candidate) => {
    const match = /^v1,([a-zA-Z0-9+/]{43}=?$)/.exec(candidate);
    return match ? [decodeBase64(match[1])] : [];
  });
  if (!signatures.length) return null;

  const secrets = [connection.webhookSecret];
  if (now < (connection.previousWebhookSecretUntil ?? 0)) {
    secrets.push(connection.previousWebhookSecret);
  }
  const keys = secrets.map(parseWebhookSecret).filter((key) => key !== null);
  return keys.length ? { id, timestamp, signatures, keys } : null;
}

export async function verifyPreparedWhopSignature(
  { id, timestamp, signatures, keys }: NonNullable<ReturnType<typeof prepareWhopSignature>>,
  rawBody: Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const content = new Uint8Array(prefix.length + rawBody.length);
  content.set(prefix);
  content.set(rawBody, prefix.length);
  for (const bytes of keys) {
    const key = await crypto.subtle.importKey(
      "raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
    );
    for (const signature of signatures) {
      if (await crypto.subtle.verify("HMAC", key, signature, content)) return true;
    }
  }
  return false;
}

export async function verifyWhopSignature(
  connection: SigningConnection,
  headers: Headers,
  rawBody: Uint8Array<ArrayBuffer>,
  now = Date.now(),
): Promise<boolean> {
  const prepared = prepareWhopSignature(connection, headers, now);
  return prepared !== null && await verifyPreparedWhopSignature(prepared, rawBody);
}
