import type { Doc, Id } from "../_generated/dataModel";
import { CALENDLY_FETCH_TIMEOUT_MS } from "../calendly/apiErrors";
import { extractQuestionsAndAnswers } from "../lib/meetingFormResponses";
import { normalizeEmail } from "../lib/normalization";
import { isRecord, getString } from "../lib/payloadExtraction";
import { answerKey, keyToIdentifier, phoneKey } from "./identityKeys";

// Phase 2 of docs/plans/polluted-lead-split.md (§5.3): one read of the
// Calendly invitee behind each meeting.

type FieldMappings = NonNullable<Doc<"eventTypeConfigs">["customFieldMappings"]>;

export type InviteeTarget = {
  meetingId: Id<"meetings">;
  inviteeUri: string;
  mappings?: FieldMappings;
};

export type InviteeSnapshot = Omit<
  Doc<"leadSplitInviteeSnapshots">,
  "_id" | "_creationTime" | "tenantId"
>;

const MAX_ATTEMPTS = 4;
const MAX_BACKOFF_MS = 60_000;

/**
 * The access token only goes to an invitee resource on Calendly's API over
 * HTTPS (§6.1, snapshot token).
 */
export function isCalendlyInviteeUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "api.calendly.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    /^\/scheduled_events\/[^/]+\/invitees\/[^/]+$/.test(url.pathname)
  );
}

/** The invitee's email, name, phone and handle, normalized. */
export function parseInvitee(
  body: unknown,
  mappings: FieldMappings | undefined,
): Pick<InviteeSnapshot, "email" | "name" | "phone" | "social"> {
  const resource = isRecord(body) && isRecord(body.resource) ? body.resource : undefined;
  if (!resource) return {};
  const rawEmail = getString(resource, "email");
  const name =
    getString(resource, "name")?.trim() ||
    [getString(resource, "first_name"), getString(resource, "last_name")]
      .filter(Boolean)
      .join(" ")
      .trim() ||
    undefined;

  let phone: string | undefined;
  let social: InviteeSnapshot["social"];
  for (const { question, answer } of extractQuestionsAndAnswers(resource.questions_and_answers)) {
    const key = answerKey({ label: question, text: answer }, mappings);
    if (!key) continue;
    const { type, value } = keyToIdentifier(key);
    if (type === "phone") phone ??= value;
    else if (type !== "email") social ??= { platform: type, handle: value };
  }
  const reminderPhone = phoneKey(getString(resource, "text_reminder_number"));
  phone ??= reminderPhone ? keyToIdentifier(reminderPhone).value : undefined;

  return {
    email: rawEmail ? normalizeEmail(rawEmail) : undefined,
    name,
    phone,
    social,
  };
}

function backoffMs(response: Response | undefined, attempt: number): number {
  const retryAfter = Number(
    response?.headers.get("retry-after") ?? response?.headers.get("x-ratelimit-reset"),
  );
  const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
  return Math.min(ms, MAX_BACKOFF_MS);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Fetches one invitee, retrying rate limits, server errors and network
 * failures with backoff. Never throws: a failure becomes the snapshot's
 * outcome, and the plan falls back to stored keys (`snapshot_missing`).
 */
export async function fetchInviteeSnapshot(
  target: InviteeTarget,
  deps: {
    accessToken: string;
    fetchFn?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<InviteeSnapshot> {
  const now = deps.now ?? Date.now;
  const base = { meetingId: target.meetingId, inviteeUri: target.inviteeUri };
  if (!isCalendlyInviteeUri(target.inviteeUri)) {
    return { ...base, outcome: "invalid_uri", fetchedAt: now() };
  }
  const fetchFn = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetchFn(target.inviteeUri, {
        headers: { Authorization: `Bearer ${deps.accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(CALENDLY_FETCH_TIMEOUT_MS),
      });
    } catch {
      lastStatus = undefined;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(undefined, attempt));
      continue;
    }
    lastStatus = response.status;
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        break;
      }
      return {
        ...base,
        outcome: "ok",
        httpStatus: response.status,
        ...parseInvitee(body, target.mappings),
        fetchedAt: now(),
      };
    }
    if (response.status === 404) {
      return { ...base, outcome: "not_found", httpStatus: 404, fetchedAt: now() };
    }
    if (response.status !== 429 && response.status < 500) break;
    if (attempt < MAX_ATTEMPTS - 1) await sleep(backoffMs(response, attempt));
  }
  return {
    ...base,
    outcome: lastStatus === undefined ? "network_error" : "http_error",
    httpStatus: lastStatus,
    fetchedAt: now(),
  };
}
