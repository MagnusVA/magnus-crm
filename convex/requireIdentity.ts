import type { Auth, UserIdentity } from "convex/server";
import { expectedError, rejectRequest } from "./lib/observability/errors";

/**
 * Returns the caller's identity, or throws if the request isn't signed in.
 *
 * Prefer `requireTenantUser` or `requireTenantUserFromAction`, which also
 * resolve the tenant and role. Use this only in functions that authorize the
 * caller themselves, such as onboarding before a tenant user exists.
 */
export async function requireIdentity(ctx: {
  auth: Auth;
}): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    // Queries (no scheduler) re-run on every update; skip the log line there.
    throw "scheduler" in ctx
      ? rejectRequest("auth.not_authenticated", "Not authenticated")
      : expectedError("auth.not_authenticated", "Not authenticated");
  }
  return identity;
}
