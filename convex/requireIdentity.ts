import type { Auth, UserIdentity } from "convex/server";

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
    console.error("[Auth] requireIdentity failed: no identity");
    throw new Error("Not authenticated");
  }
  return identity;
}
