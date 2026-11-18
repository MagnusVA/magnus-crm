const TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();

function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
}

export async function verifyWhopSignature(
  connection: {
    webhookSecret?: string;
    previousWebhookSecret?: string;
    previousWebhookSecretUntil?: number;
  },
  headers: Headers,
  rawBody: Uint8Array<ArrayBuffer>,
  now = Date.now(),
): Promise<boolean> {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const header = headers.get("webhook-signature");
  if (
    !id ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !header ||
    Math.abs(Math.floor(now / 1000) - Number(timestamp)) > TOLERANCE_SECONDS
  ) return false;

  const signatures = [];
  for (const signature of header.split(/\s+/)) {
    const match = /^v1,([^,]+)$/.exec(signature);
    if (!match) continue;
    try {
      const bytes = decodeBase64(match[1]);
      if (bytes.length === 32) signatures.push(bytes);
    } catch {
      continue;
    }
  }
  if (!signatures.length) return false;

  const prefix = encoder.encode(`${id}.${timestamp}.`);
  const content = new Uint8Array(prefix.length + rawBody.length);
  content.set(prefix);
  content.set(rawBody, prefix.length);
  const secrets = [connection.webhookSecret];
  if (now < (connection.previousWebhookSecretUntil ?? 0)) {
    secrets.push(connection.previousWebhookSecret);
  }
  for (const secret of secrets) {
    if (!secret) continue;
    try {
      // @whop/sdk 2.8.1's verifyWebhook helper uses the full UTF-8 Whop secret.
      const bytes = secret.startsWith("whsec_")
        ? decodeBase64(secret.slice("whsec_".length))
        : encoder.encode(secret);
      const key = await crypto.subtle.importKey(
        "raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
      );
      for (const signature of signatures) {
        if (await crypto.subtle.verify("HMAC", key, signature, content)) return true;
      }
    } catch {
      // A malformed stored key must not prevent verification with the other key.
      continue;
    }
  }
  return false;
}
