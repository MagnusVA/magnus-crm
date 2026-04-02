import type { UserIdentity } from "convex/server";
import { SYSTEM_ADMIN_ORG_ID } from "./lib/constants";
import { getIdentityOrgId } from "./lib/identity";

/** Requires an authenticated user whose WorkOS org claim matches the system admin org. */
export function requireSystemAdminSession(
  identity: UserIdentity | null,
): asserts identity is UserIdentity {
  if (identity === null) {
    throw new Error("Not authenticated");
  }
  const orgId = getIdentityOrgId(identity);
  if (orgId !== SYSTEM_ADMIN_ORG_ID) {
    throw new Error("Not authorized");
  }
}
