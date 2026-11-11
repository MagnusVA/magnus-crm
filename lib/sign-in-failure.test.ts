// @vitest-environment node
// Runs the real callback route, `app/callback/route.ts`. It lives here
// because Vitest only collects tests under `lib/` and `convex/`.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CallbackError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = "CallbackError";
      this.code = code;
    }
  }
  return {
    CallbackError,
    /** What AuthKit's standard handler fails with in this test. */
    standardFailure: { current: undefined as unknown },
    standardHandler: vi.fn(),
    authenticateWithCode: vi.fn(),
    captureImmediate: vi.fn(async (_event: { properties: Record<string, unknown> }) => {}),
    captureExceptionImmediate: vi.fn(async () => {}),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Outside a request scope: run the capture now.
  after: (task: () => unknown) => void task(),
}));
vi.mock("@/lib/posthog-server", () => ({
  getPostHogClient: () => ({
    captureImmediate: mocks.captureImmediate,
    captureExceptionImmediate: mocks.captureExceptionImmediate,
  }),
}));
// AuthKit's handler, reduced to the part under test: it failed, so it calls
// the route's `onError` with the error and the request.
vi.mock("@workos-inc/authkit-nextjs", () => ({
  CallbackError: mocks.CallbackError,
  saveSession: vi.fn(),
  getWorkOS: () => ({
    userManagement: { authenticateWithCode: mocks.authenticateWithCode },
  }),
  handleAuth:
    (options: {
      onError: (params: { error: unknown; request: NextRequest }) => Promise<Response>;
    }) =>
    (request: NextRequest) => {
      mocks.standardHandler();
      return options.onError({ error: mocks.standardFailure.current, request });
    },
}));

import { GET } from "@/app/callback/route";
import {
  parseSignInFailureReason,
  signInFlowAgeSeconds,
} from "@/lib/sign-in-failure";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECRET_CODE = "code_SECRET_01ABC";
const SECRET_VERIFIER = "verifier_SECRET_value";

/** Shaped like AuthKit's sealed state: the sixth field is the expiry in ms. */
function sealedState(startedSecondsAgo: number) {
  const expiresAt = NOW - startedSecondsAgo * 1000 + 600_000;
  return `Fe26.2*1*salt_SECRET*iv*ciphertext_SECRET*${expiresAt}*hmacsalt*hmac_SECRET~2`;
}

function callbackRequest(search: Record<string, string>, cookie?: string) {
  const url = new URL("https://app.example.com/callback");
  for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value);
  return new NextRequest(url, {
    headers: {
      host: "app.example.com",
      "user-agent":
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      ...(cookie ? { cookie } : {}),
    },
  });
}

/** What the WorkOS SDK throws for a code that was already exchanged. */
function replayedCodeError() {
  return Object.assign(
    new Error("Error: invalid_grant\nError Description: The code has already been exchanged."),
    { name: "OauthException", status: 400, error: "invalid_grant" },
  );
}

function rejectionEvents() {
  return mocks.captureImmediate.mock.calls.map(([event]) => event);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  vi.stubEnv("NEXT_PUBLIC_WORKOS_REDIRECT_URI", "https://app.example.com/callback");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a sign-in callback that fails", () => {
  it.each([
    ["missing_pkce_cookie", "expired"],
    ["oauth_state_mismatch", "expired"],
    ["missing_auth_params", "incomplete"],
  ])("sends %s to the sign-in problem page as a rejection", async (code, reason) => {
    mocks.standardFailure.current = new mocks.CallbackError("Sign-in could not be verified", code);

    const response = await GET(callbackRequest({ code: SECRET_CODE, state: sealedState(30) }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`/sign-in/error?reason=${reason}`);
    expect(rejectionEvents()).toHaveLength(1);
    expect(rejectionEvents()[0]).toMatchObject({
      event: "next_request_rejected",
      properties: {
        handled_event: "auth.callback.failed",
        error_kind: "expected",
        error_code: code,
        integration: "workos",
      },
    });
    expect(mocks.captureExceptionImmediate).not.toHaveBeenCalled();
  });

  it("treats a replayed code as a rejection, not an exception", async () => {
    mocks.standardFailure.current = replayedCodeError();

    const response = await GET(callbackRequest({ code: SECRET_CODE, state: sealedState(30) }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in/error?reason=used");
    expect(rejectionEvents()[0].properties).toMatchObject({
      error_code: "invalid_grant",
      http_status: 400,
    });
    expect(mocks.captureExceptionImmediate).not.toHaveBeenCalled();
  });

  it("records what a triage needs to name the cause, and nothing secret", async () => {
    mocks.standardFailure.current = new mocks.CallbackError("no cookie", "missing_pkce_cookie");
    const state = sealedState(754);

    await GET(
      callbackRequest(
        { code: SECRET_CODE, state },
        `wos-auth-verifier-0a1b2c3d=${SECRET_VERIFIER}; ph_phc_test_posthog=%7B%7D`,
      ),
    );

    const { properties } = rejectionEvents()[0];
    expect(properties).toMatchObject({
      request_host: "app.example.com",
      host_matches_redirect_uri: true,
      browser_family: "Mobile Safari",
      os_family: "iOS",
      device_type: "mobile",
      flow_age_seconds: 754,
      has_code: true,
      has_state: true,
      pkce_cookie_count: 1,
      has_posthog_cookie: true,
    });
    const sent = JSON.stringify(rejectionEvents()[0]);
    for (const secret of [SECRET_CODE, SECRET_VERIFIER, state, "SECRET", "Mozilla"]) {
      expect(sent).not.toContain(secret);
    }
  });

  it("keeps a WorkOS or app fault as an exception, and still shows the page", async () => {
    mocks.standardFailure.current = new mocks.CallbackError("response is missing tokens", "missing_tokens");

    const response = await GET(callbackRequest({ code: SECRET_CODE, state: sealedState(5) }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in/error?reason=failed");
    expect(mocks.captureExceptionImmediate).toHaveBeenCalledTimes(1);
    expect(rejectionEvents()).toHaveLength(0);
  });

  it("names the OAuth error WorkOS sent back, and keeps a WorkOS outage as an exception", async () => {
    // AuthKit reports any callback without a code as `missing_auth_params`.
    mocks.standardFailure.current = new mocks.CallbackError("Missing required auth parameter", "missing_auth_params");

    const denied = await GET(
      callbackRequest({ error: "access_denied", error_description: "SECRET text", state: sealedState(5) }),
    );
    expect(denied.headers.get("location")).toBe("/sign-in/error?reason=incomplete");
    expect(rejectionEvents()[0].properties).toMatchObject({ oauth_error: "access_denied", has_code: false });
    expect(JSON.stringify(rejectionEvents()[0])).not.toContain("SECRET");

    await GET(callbackRequest({ error: "made_up_SECRET", state: sealedState(5) }));
    expect(rejectionEvents()[1].properties).toMatchObject({ oauth_error: "other" });
    expect(mocks.captureExceptionImmediate).not.toHaveBeenCalled();

    const outage = await GET(callbackRequest({ error: "server_error", state: sealedState(5) }));
    expect(outage.headers.get("location")).toBe("/sign-in/error?reason=failed");
    expect(rejectionEvents()).toHaveLength(2);
    expect(mocks.captureExceptionImmediate).toHaveBeenCalledTimes(1);
  });

  it("never sends a replayed invitation code to the standard handler", async () => {
    mocks.authenticateWithCode.mockRejectedValue(replayedCodeError());

    // An invitation callback has a code and no state.
    const response = await GET(callbackRequest({ code: SECRET_CODE }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in/error?reason=used");
    expect(mocks.authenticateWithCode).toHaveBeenCalledTimes(1);
    expect(mocks.standardHandler).not.toHaveBeenCalled();
    expect(rejectionEvents()).toHaveLength(1);
    expect(rejectionEvents()[0].properties).toMatchObject({
      handled_event: "auth.invite_callback.failed",
      error_code: "invalid_grant",
      has_state: false,
    });
    expect(mocks.captureExceptionImmediate).not.toHaveBeenCalled();
  });
});

describe("sign-in failure helpers", () => {
  it("reads the flow's age only from a well-formed seal", () => {
    expect(signInFlowAgeSeconds(sealedState(0), NOW)).toBe(0);
    expect(signInFlowAgeSeconds(sealedState(3600), NOW)).toBe(3600);
    expect(signInFlowAgeSeconds(null, NOW)).toBeUndefined();
    expect(signInFlowAgeSeconds("not-a-seal", NOW)).toBeUndefined();
    expect(signInFlowAgeSeconds("a*b*c*d*e*not-a-number*g*h", NOW)).toBeUndefined();
    // A forged expiry far in the past or the future is dropped, not reported.
    expect(signInFlowAgeSeconds(`a*b*c*d*e*1*g*h`, NOW)).toBeUndefined();
    expect(signInFlowAgeSeconds(`a*b*c*d*e*${NOW + 10 * 600_000}*g*h`, NOW)).toBeUndefined();
  });

  it("shows the generic problem for a reason it doesn't know", () => {
    expect(parseSignInFailureReason("used")).toBe("used");
    expect(parseSignInFailureReason("<script>")).toBe("failed");
    expect(parseSignInFailureReason(["expired", "used"])).toBe("failed");
    expect(parseSignInFailureReason(undefined)).toBe("failed");
  });
});
