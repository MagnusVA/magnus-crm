// Web Crypto helpers for the default Convex runtime. Slack and Calendly keep
// their own copies of the first two; new code shares these.

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Compares two strings in time that depends only on their length. */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(payload)));
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(input)));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A random base62 string from `byteLength` random bytes. */
export function randomBase62(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = BASE62[Number(value % 62n)] + text;
    value /= 62n;
  }
  // Leading zero bytes still count toward the length.
  const width = Math.ceil((byteLength * 8) / Math.log2(62));
  return text.padStart(width, "0");
}
