export type DetectedInstagramOrigin = {
  originKind: "post" | "reel";
  originUrl: string;
  shortcode: string;
};

const IG_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "m.instagram.com",
]);
const URL_PROTOCOL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const SHORTCODE_PATTERN = /^[A-Za-z0-9_-]+$/;

export function detectInstagramOriginUrl(
  rawValue: string,
): DetectedInstagramOrigin | null {
  const value = rawValue.trim();
  if (!value) return null;

  try {
    const url = new URL(
      URL_PROTOCOL_PATTERN.test(value) ? value : `https://${value}`,
    );
    const hostname = url.hostname.toLowerCase();
    if (!IG_HOSTS.has(hostname)) return null;

    const [kind, shortcode] = url.pathname.split("/").filter(Boolean);
    if (
      (kind !== "p" && kind !== "reel") ||
      !shortcode ||
      !SHORTCODE_PATTERN.test(shortcode)
    ) {
      return null;
    }

    return {
      originKind: kind === "p" ? "post" : "reel",
      originUrl: `https://instagram.com/${kind}/${shortcode}/`,
      shortcode,
    };
  } catch {
    return null;
  }
}
