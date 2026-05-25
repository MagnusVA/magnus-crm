import type { Doc } from "../_generated/dataModel";
import { normalizeSocialHandle } from "../lib/normalization";

type Source = Doc<"leadGenSubmissions">["source"];
type OriginKind = Doc<"leadGenSubmissions">["originKind"];

const INSTAGRAM_HANDLE_PATTERN = /^(?=.{1,30}$)(?=.*[a-z0-9])[a-z0-9._]+$/;
const URL_PROTOCOL_PATTERN = /^[a-z][a-z\d+\-.]*:\/\//i;
const MAX_ORIGIN_LABEL_LENGTH = 300;
const MAX_RANKABLE_ORIGIN_URL_LENGTH = 1000;

export type NormalizedLeadGenProspectInput = {
  normalizedHandle: string;
  profileUrl: string;
  dedupeKey: string;
};

export type NormalizedLeadGenOrigin = {
  originValue?: string;
  originKey?: string;
};

export function normalizeLeadGenProspectInput(args: {
  source: Source;
  rawHandleOrProfileUrl: string;
}): NormalizedLeadGenProspectInput {
  const normalizedHandle = normalizeSocialHandle(
    args.rawHandleOrProfileUrl,
    "instagram",
  );

  if (
    !normalizedHandle ||
    !INSTAGRAM_HANDLE_PATTERN.test(normalizedHandle)
  ) {
    throw new Error("Enter an Instagram handle or profile URL");
  }

  return {
    normalizedHandle,
    profileUrl: `https://instagram.com/${normalizedHandle}`,
    dedupeKey: `instagram:${normalizedHandle}`,
  };
}

export function normalizeLeadGenOrigin(args: {
  originKind: OriginKind;
  originUrlOrLabel?: string;
}): NormalizedLeadGenOrigin {
  if (args.originKind === "source_only") return {};

  const value = args.originUrlOrLabel?.trim();
  if (!value) return {};

  if (args.originKind === "post" || args.originKind === "reel") {
    return normalizeRankableOriginUrl(value);
  }

  const normalizedLabel = value.toLowerCase().replace(/\s+/g, " ");
  if (normalizedLabel.length > MAX_ORIGIN_LABEL_LENGTH) {
    throw new Error("Origin label is too long");
  }

  return {
    originValue: value,
    originKey: `${args.originKind}:${normalizedLabel}`,
  };
}

export function isRankableLeadGenOrigin(originKind: OriginKind) {
  return originKind === "post" || originKind === "reel";
}

function normalizeRankableOriginUrl(value: string): NormalizedLeadGenOrigin {
  if (value.length > MAX_RANKABLE_ORIGIN_URL_LENGTH) {
    throw new Error("Origin URL is too long");
  }

  try {
    const url = new URL(
      URL_PROTOCOL_PATTERN.test(value) ? value : `https://${value}`,
    );

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported URL protocol");
    }
    if (!url.hostname.includes(".")) {
      throw new Error("Invalid URL hostname");
    }

    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    const port = url.port ? `:${url.port}` : "";
    const pathname = url.pathname || "/";

    // Convex's V8 runtime does not implement URL username/password setters.
    // Rebuild the canonical URL instead of mutating the URL object. Query and
    // hash are intentionally dropped so Instagram tracking params do not split
    // the same post/reel into separate report origins.
    const originValue = `${protocol}//${hostname}${port}${pathname}`;
    return {
      originValue,
      originKey: originValue.toLowerCase(),
    };
  } catch {
    throw new Error("Enter a valid post or reel URL");
  }
}
