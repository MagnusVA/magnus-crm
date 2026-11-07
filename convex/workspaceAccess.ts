import { query } from "./_generated/server";
import { loadCurrentTenant } from "./tenants";
import { loadCurrentUser } from "./users/queries";

/**
 * The caller's tenant and CRM user in one call, for `getWorkspaceAccess` in
 * `lib/auth.ts`. Every workspace document load waits on it, and each Convex
 * call from the server costs a round trip. The user is read only for an
 * active tenant, the only case where the workspace uses it.
 */
// eslint-disable-next-line @convex-dev/require-access-control -- returns nulls when signed out; reads only the caller's tenant and user
export const getCurrentWorkspaceAccess = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { tenant: null, user: null };
    }

    const tenant = await loadCurrentTenant(ctx, identity);
    const user =
      tenant?.status === "active" ? await loadCurrentUser(ctx, identity) : null;
    return { tenant, user };
  },
});
