import type { UserIdentity } from "convex/server";

/** WorkOS organization for system admins; keep in sync with `lib/system-admin-org.ts`. */
const SYSTEM_ADMIN_ORG_ID = "org_01KN2GSWBZAQWJ2CBRAZ6CSVBP";

/**
 * Requires a valid Convex auth identity. If the WorkOS JWT includes an organization
 * claim, it must match the system admin org (sign-in/sign-up use org-scoped URLs).
 */
export function requireSystemAdminSession(
  identity: UserIdentity | null,
): asserts identity is UserIdentity {
  if (identity === null) {
    throw new Error("Not authenticated");
  }
  const orgId =
    (identity.organization_id as string | undefined) ??
    (identity.organizationId as string | undefined) ??
    (identity.org_id as string | undefined);
  if (orgId !== undefined && orgId !== SYSTEM_ADMIN_ORG_ID) {
    throw new Error("Not authorized for this organization.");
  }
}
