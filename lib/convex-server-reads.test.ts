// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What Next's `redirect()` does: stop rendering by throwing. */
class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}

const mocks = vi.hoisted(() => ({
  fetchQuery: vi.fn(),
  preloadQuery: vi.fn(),
  fetchAction: vi.fn(),
  redirect: vi.fn(),
  /** The request URL AuthKit's proxy puts in `x-url`. */
  requestUrl: { current: null as string | null },
  session: { current: null as unknown },
}));

vi.mock("server-only", () => ({}));
vi.mock("convex/nextjs", () => ({
  fetchQuery: mocks.fetchQuery,
  preloadQuery: mocks.preloadQuery,
  fetchAction: mocks.fetchAction,
}));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(mocks.requestUrl.current ? { "x-url": mocks.requestUrl.current } : {}),
}));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@workos-inc/authkit-nextjs", () => ({
  withAuth: async () => mocks.session.current,
}));
vi.mock("@/lib/system-admin-org", () => ({ SYSTEM_ADMIN_ORG_ID: "org_system_admin" }));

import { api } from "@/convex/_generated/api";
import { getWorkspaceAccess } from "@/lib/auth";
import { fetchQuery, preloadQuery } from "@/lib/convex-server-reads";

const NOW = Date.UTC(2026, 10, 3, 15, 0, 0);
const query = api.workspaceAccess.getCurrentWorkspaceAccess;
const options = { token: "token-from-the-proxy" };

/** convex/nextjs throws a plain Error whose message is the response body. */
function convexFailure(code: string, message: string) {
  return new Error(JSON.stringify({ code, message }));
}
const expiredToken = () =>
  convexFailure("InvalidAuthHeader", "Could not validate token: Token expired 14 seconds ago");
const serviceUnavailable = () =>
  convexFailure("ServiceUnavailable", "Service temporarily unavailable");

function redirectedTo() {
  expect(mocks.redirect).toHaveBeenCalledTimes(1);
  return new URL(mocks.redirect.mock.calls[0][0], "https://app.example.com");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  mocks.redirect.mockImplementation((url: string) => {
    throw new RedirectSignal(url);
  });
  mocks.requestUrl.current = "https://app.example.com/workspace/pipeline?stage=open&_rsc=1a2b3";
});

describe("a server read whose access token expired on the way to Convex", () => {
  it("goes back through the proxy once, and the read then succeeds", async () => {
    mocks.fetchQuery.mockRejectedValueOnce(expiredToken());

    await expect(fetchQuery(query, {}, options)).rejects.toBeInstanceOf(RedirectSignal);

    // Same page and query, without the router's `_rsc`, plus the marker.
    const target = redirectedTo();
    expect(mocks.redirect.mock.calls[0][0]).toMatch(/^\/workspace\/pipeline\?/);
    expect(target.searchParams.get("stage")).toBe("open");
    expect(target.searchParams.has("_rsc")).toBe(false);
    expect(target.searchParams.get("auth_retry")).toBe(String(NOW));
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(1);

    // The redirected request: the proxy has refreshed the session.
    mocks.requestUrl.current = target.href;
    mocks.fetchQuery.mockResolvedValueOnce({ tenant: null, user: null });
    await expect(fetchQuery(query, {}, { token: "refreshed-token" })).resolves.toEqual({
      tenant: null,
      user: null,
    });
    expect(mocks.fetchQuery).toHaveBeenLastCalledWith(query, {}, { token: "refreshed-token" });
    expect(mocks.redirect).toHaveBeenCalledTimes(1);
  });

  it("gives up with the original error when the retried request fails too", async () => {
    const failure = expiredToken();
    mocks.requestUrl.current = `https://app.example.com/workspace?auth_retry=${NOW - 2_000}`;
    mocks.fetchQuery.mockRejectedValue(failure);

    await expect(fetchQuery(query, {}, options)).rejects.toBe(failure);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("still gives up when the marker is a moment in the future", async () => {
    // The instance that set it had a clock slightly ahead of this one.
    const failure = expiredToken();
    mocks.requestUrl.current = `https://app.example.com/workspace?auth_retry=${NOW + 1_500}`;
    mocks.fetchQuery.mockRejectedValue(failure);

    await expect(fetchQuery(query, {}, options)).rejects.toBe(failure);

    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("retries again once the marker is old, and keeps a single marker", async () => {
    mocks.requestUrl.current = `https://app.example.com/workspace?auth_retry=${NOW - 61_000}`;
    mocks.fetchQuery.mockRejectedValueOnce(expiredToken());

    await expect(fetchQuery(query, {}, options)).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirectedTo().searchParams.getAll("auth_retry")).toEqual([String(NOW)]);
  });

  it("recovers a preloaded read the same way", async () => {
    mocks.preloadQuery.mockRejectedValueOnce(expiredToken());

    await expect(preloadQuery(query, {}, options)).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirectedTo().pathname).toBe("/workspace/pipeline");
  });

  it.each([
    ["a token Convex rejects for another reason", convexFailure("InvalidAuthHeader", "Could not decode token")],
    ["an application error", new Error("Report job not found.")],
    ["a non-JSON body", new Error("<html>502 Bad Gateway</html>")],
  ])("doesn't retry %s", async (_label, failure) => {
    mocks.fetchQuery.mockRejectedValue(failure);

    await expect(fetchQuery(query, {}, options)).rejects.toBe(failure);

    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["no request URL", null],
    ["a path that would leave the site", "https://app.example.com//evil.example/x"],
    ["a path with a backslash", "https://app.example.com/%5Cevil.example"],
  ])("rethrows instead of redirecting with %s", async (_label, requestUrl) => {
    const failure = expiredToken();
    mocks.requestUrl.current = requestUrl;
    mocks.fetchQuery.mockRejectedValue(failure);

    await expect(fetchQuery(query, {}, options)).rejects.toBe(failure);

    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe("a server read that finds Convex unavailable", () => {
  it("runs the read once more with the same token", async () => {
    mocks.fetchQuery
      .mockRejectedValueOnce(serviceUnavailable())
      .mockResolvedValueOnce({ tenant: null, user: null });

    await expect(fetchQuery(query, {}, options)).resolves.toEqual({ tenant: null, user: null });

    expect(mocks.fetchQuery).toHaveBeenCalledTimes(2);
    expect(mocks.fetchQuery).toHaveBeenLastCalledWith(query, {}, options);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("gives up after that one retry", async () => {
    const second = serviceUnavailable();
    mocks.fetchQuery.mockRejectedValueOnce(serviceUnavailable()).mockRejectedValueOnce(second);

    await expect(fetchQuery(query, {}, options)).rejects.toBe(second);

    expect(mocks.fetchQuery).toHaveBeenCalledTimes(2);
  });
});

describe("workspace access", () => {
  const tenant = { tenantId: "t1", companyName: "Acme", workosOrgId: "org_1", status: "active" };

  beforeEach(() => {
    mocks.session.current = {
      user: { id: "user_1" },
      accessToken: "token-from-the-proxy",
      organizationId: "org_1",
    };
  });

  it("recovers its read through the proxy", async () => {
    mocks.fetchQuery.mockRejectedValueOnce(expiredToken());

    await expect(getWorkspaceAccess()).rejects.toBeInstanceOf(RedirectSignal);

    expect(redirectedTo().searchParams.get("auth_retry")).toBe(String(NOW));
  });

  it("sends the page load to /unavailable when Convex fails the access query", async () => {
    // What a disabled production deployment answers: the message is redacted.
    mocks.fetchQuery.mockRejectedValueOnce(new Error("[Request ID: 5f2c9a1b7d3e4f60] Server Error"));

    await expect(getWorkspaceAccess()).rejects.toBeInstanceOf(RedirectSignal);

    expect(mocks.redirect).toHaveBeenCalledExactlyOnceWith("/unavailable");
    expect(mocks.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("still throws an access-query failure that Convex did not report", async () => {
    const rejection = Object.assign(new Error("[Request ID: 5f2c9a1b7d3e4f60] Server Error"), { name: "ConvexError" });
    const network = new TypeError("fetch failed");
    mocks.fetchQuery.mockRejectedValueOnce(rejection).mockRejectedValueOnce(network);

    await expect(getWorkspaceAccess()).rejects.toBe(rejection);
    await expect(getWorkspaceAccess()).rejects.toBe(network);

    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("never retries the invitation claim, which writes", async () => {
    const failure = serviceUnavailable();
    mocks.fetchQuery.mockResolvedValueOnce({ tenant, user: null });
    mocks.fetchAction.mockRejectedValue(failure);

    await expect(getWorkspaceAccess()).rejects.toBe(failure);

    expect(mocks.fetchAction).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
