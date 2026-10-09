import type { UserIdentity } from "convex/server";
import { SYSTEM_ADMIN_ORG_ID } from "./lib/constants";
import { getIdentityOrgId } from "./lib/identity";
import { rejectRequest } from "./lib/observability/errors";
import { logRequestContext } from "./lib/observability/log";
import { getRawWorkosUserId } from "./lib/workosUserId";

/** Requires an authenticated user whose WorkOS org claim matches the system admin org. */
export function requireSystemAdminSession(
  identity: UserIdentity | null,
): asserts identity is UserIdentity {
  if (identity === null) {
    throw rejectRequest("auth.not_authenticated", "Not authenticated");
  }
  const orgId = getIdentityOrgId(identity);
  if (orgId !== SYSTEM_ADMIN_ORG_ID) {
    throw rejectRequest("auth.not_system_admin", "Not authorized", {
      orgId,
      subject: identity.subject,
    });
  }
  logRequestContext({
    distinctId: getRawWorkosUserId(identity.subject),
    workosOrgId: orgId,
    role: "system_admin",
  });
}
