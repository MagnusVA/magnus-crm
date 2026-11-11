import type { Doc } from "../_generated/dataModel";
import { rejectRequest } from "../lib/observability/errors";
import {
  INVALID_INSTAGRAM_HANDLE_MESSAGE,
  normalizeInstagramHandle,
} from "../../lib/lead-gen/instagram-handle";

type Source = Doc<"leadGenSubmissions">["source"];
type OriginKind = Doc<"leadGenSubmissions">["originKind"];

/** The code a capture is rejected with when its handle isn't an Instagram one. */
export const INVALID_INSTAGRAM_HANDLE_CODE = "lead_gen.invalid_instagram_handle";
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

/**
 * The prospect a handle or profile URL names, or `undefined` when it names
 * none. For callers that answer "not a handle" themselves, such as a lookup.
 * The rules are the capture form's own (`normalizeInstagramHandle`).
 */
export function tryNormalizeLeadGenProspectInput(args: {
  source: Source;
  rawHandleOrProfileUrl: string;
}): NormalizedLeadGenProspectInput | undefined {
  const normalizedHandle = normalizeInstagramHandle(args.rawHandleOrProfileUrl);
  if (!normalizedHandle) return undefined;

  return {
    normalizedHandle,
    profileUrl: `https://instagram.com/${normalizedHandle}`,
    dedupeKey: `instagram:${normalizedHandle}`,
  };
}

/**
 * The prospect a capture names. A handle that isn't one is the setter's to
 * fix, so it is rejected with a code and the sentence the form shows.
 */
export function normalizeLeadGenProspectInput(args: {
  source: Source;
  rawHandleOrProfileUrl: string;
}): NormalizedLeadGenProspectInput {
  const normalized = tryNormalizeLeadGenProspectInput(args);
  if (!normalized) {
    throw rejectRequest(
      INVALID_INSTAGRAM_HANDLE_CODE,
      INVALID_INSTAGRAM_HANDLE_MESSAGE,
      { source: args.source },
    );
  }
  return normalized;
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
