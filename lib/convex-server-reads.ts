import "server-only";
import {
  fetchQuery as convexFetchQuery,
  preloadQuery as convexPreloadQuery,
  type NextjsOptions,
} from "convex/nextjs";
import type { Preloaded } from "convex/react";
import type {
  ArgsAndOptions,
  FunctionReference,
  FunctionReturnType,
} from "convex/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

// `fetchQuery` and `preloadQuery` for Server Components, with one recovery
// for each of two failures a reload fixes. Reads only: a write that failed
// may still have run, so `fetchAction` and `fetchMutation` stay unwrapped.
//
// An expired access token. The proxy hands a render the token it verified,
// and refreshes one that is about to expire. A token can still run out
// before Convex checks it: a slow render, or a refresh that lost a race and
// left seconds on the old token. Convex then answers `InvalidAuthHeader`.
// A Server Component can't refresh the session itself. `refreshSession()`
// spends the single-use refresh token and then fails to write the cookie,
// which signs the person out a moment later. So the read redirects to the
// page it is rendering: the proxy sees the expired token on that request,
// refreshes it where the cookie can be saved, and the read runs again.
// `auth_retry` carries the time of that redirect, and a request that
// arrives with a recent one rethrows, so a read retries once.
//
// Convex unavailable. The read runs once more with the same token.

/** Search param holding the time (ms) of the redirect that retried a read. */
export const AUTH_RETRY_PARAM = "auth_retry";

/** A marker this recent means this request is already the retry. */
const AUTH_RETRY_WINDOW_MS = 60_000;
/** Another server instance set the marker, and its clock may run ahead. */
const AUTH_RETRY_CLOCK_SKEW_MS = 5_000;

/**
 * convex/nextjs throws a plain `Error` whose message is the response body,
 * e.g. `{"code":"InvalidAuthHeader","message":"Could not validate token:
 * Token expired 14 seconds ago"}`.
 */
function transportFailure(error: unknown): "expired_token" | "unavailable" | null {
  if (!(error instanceof Error)) return null;
  let body: unknown;
  try {
    body = JSON.parse(error.message);
  } catch {
    return null;
  }
  const { code, message } = (typeof body === "object" && body !== null ? body : {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (code === "ServiceUnavailable") return "unavailable";
  if (code === "InvalidAuthHeader" && typeof message === "string" && /expired/i.test(message)) {
    return "expired_token";
  }
  return null;
}

/**
 * The path to retry on: this request's own path and query with the marker
 * set. Null when this request is already the retry, or when the path can't
 * be trusted as a same-site redirect.
 */
async function authRetryPath(now: number): Promise<string | null> {
  // AuthKit's proxy records the request URL here.
  const requestUrl = (await headers()).get("x-url");
  if (!requestUrl) return null;

  let url: URL;
  let path: string;
  try {
    url = new URL(requestUrl);
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // `//host` and `/\host` would send the browser to another site.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return null;

  const retriedAt = Number(url.searchParams.get(AUTH_RETRY_PARAM));
  if (
    url.searchParams.has(AUTH_RETRY_PARAM) &&
    now - retriedAt > -AUTH_RETRY_CLOCK_SKEW_MS &&
    now - retriedAt < AUTH_RETRY_WINDOW_MS
  ) {
    return null;
  }

  url.searchParams.delete("_rsc");
  url.searchParams.set(AUTH_RETRY_PARAM, String(now));
  return `${url.pathname}${url.search}`;
}

async function readWithRecovery<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const failure = transportFailure(error);
    if (failure === "unavailable") return await read();
    if (failure === "expired_token") {
      const path = await authRetryPath(Date.now());
      // `redirect` throws, which ends this render.
      if (path) redirect(path);
    }
    throw error;
  }
}

/** `fetchQuery` from convex/nextjs for a Server Component read. */
export function fetchQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: ArgsAndOptions<Query, NextjsOptions>
): Promise<FunctionReturnType<Query>> {
  return readWithRecovery(() => convexFetchQuery(query, ...args));
}

/** `preloadQuery` from convex/nextjs for a Server Component read. */
export function preloadQuery<Query extends FunctionReference<"query">>(
  query: Query,
  ...args: ArgsAndOptions<Query, NextjsOptions>
): Promise<Preloaded<Query>> {
  return readWithRecovery(() => convexPreloadQuery(query, ...args));
}
