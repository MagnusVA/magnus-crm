import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { withAuth } from "@workos-inc/authkit-nextjs";
import { fetchAction, fetchQuery } from "convex/nextjs";
import { api } from "@/convex/_generated/api";
import { SYSTEM_ADMIN_ORG_ID } from "@/lib/system-admin-org";
import type { Doc } from "@/convex/_generated/dataModel";
import type { CrmRole } from "@/convex/lib/roleMapping";

type AuthResult = Awaited<ReturnType<typeof withAuth>>;

type CurrentTenant = {
  tenantId: string;
  companyName: string;
  workosOrgId: string;
  status:
    | "pending_signup"
    | "pending_calendly"
    | "provisioning_webhooks"
    | "active"
    | "calendly_disconnected"
    | "suspended"
    | "invite_expired";
  calendlyWebhookUri?: string;
  onboardingCompletedAt?: number;
};

export type VerifiedSession = AuthResult & {
  user: NonNullable<AuthResult["user"]>;
  accessToken: string;
  organizationId: string;
};

export type WorkspaceAccess =
  | { kind: "system_admin"; session: VerifiedSession }
  | { kind: "no_tenant"; session: VerifiedSession }
  | {
      kind: "pending_onboarding";
      session: VerifiedSession;
      tenant: CurrentTenant;
    }
  | {
      kind: "not_provisioned";
      session: VerifiedSession;
      tenant: CurrentTenant | null;
    }
  | {
      kind: "ready";
      session: VerifiedSession;
      tenant: CurrentTenant;
      crmUser: Doc<"users">;
    };

/**
 * Verify that a request has a valid, authenticated session.
 * Redirects to /sign-in if not authenticated.
 * Cached per-request via React's cache() function.
 */
export const verifySession = cache(async (): Promise<VerifiedSession> => {
  const auth = await withAuth({ ensureSignedIn: true });

  if (!auth.user || !auth.accessToken || !auth.organizationId) {
    redirect("/sign-in");
  }

  return auth as VerifiedSession;
});

/**
 * Resolve the CRM user for a verified session. If no user exists,
 * attempts to claim an invited account and re-fetches.
 * Cached per-request so multiple consumers share a single result.
 */
const resolveCrmUser = cache(async (session: VerifiedSession) => {
  let crmUser = await fetchQuery(
    api.users.queries.getCurrentUser,
    {},
    { token: session.accessToken }
  );

  if (!crmUser) {
    await fetchAction(
      api.workos.userActions.claimInvitedAccount,
      {},
      { token: session.accessToken }
    );

    crmUser = await fetchQuery(
      api.users.queries.getCurrentUser,
      {},
      { token: session.accessToken }
    );
  }

  return crmUser;
});

/**
 * Resolve the full workspace access state for the current request.
 * Returns a discriminated union describing system admin, tenant lifecycle,
 * or ready-to-use workspace access.
 */
export const getWorkspaceAccess = cache(
  async (): Promise<WorkspaceAccess> => {
    const session = await verifySession();

    // System admin check: organization-based, not role-based
    if (session.organizationId === SYSTEM_ADMIN_ORG_ID) {
      return { kind: "system_admin", session };
    }

    // Fetch tenant for this organization
    const tenant = await fetchQuery(
      api.tenants.getCurrentTenant,
      {},
      { token: session.accessToken }
    );

    if (!tenant) {
      return { kind: "no_tenant", session };
    }

    // Pending tenants should not access the active workspace
    if (tenant.status !== "active") {
      return { kind: "pending_onboarding", session, tenant };
    }

    // Resolve CRM user (may trigger invite claim)
    const crmUser = await resolveCrmUser(session);
    if (!crmUser) {
      return { kind: "not_provisioned", session, tenant };
    }

    return { kind: "ready", session, tenant, crmUser };
  }
);

/**
 * Require a fully provisioned workspace user.
 * Redirects non-ready access kinds to the appropriate route.
 * Returns the "ready" access state.
 */
export async function requireWorkspaceUser() {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    case "system_admin":
      redirect("/admin");
    case "pending_onboarding":
      redirect("/onboarding/connect");
    case "no_tenant":
      redirect("/");
    case "not_provisioned":
      redirect("/");
    case "ready":
      return access;
  }
}

/**
 * Require a workspace user with one of the specified CRM roles.
 * Redirects to a role-appropriate fallback if the user lacks permission.
 */
export async function requireRole(allowedRoles: CrmRole[]) {
  const access = await requireWorkspaceUser();
  const fallback =
    access.crmUser.role === "closer" ? "/workspace/closer" : "/workspace";

  if (!allowedRoles.includes(access.crmUser.role)) {
    redirect(fallback);
  }

  return access;
}

/**
 * Require system admin access. Redirects to /workspace if the
 * session does not belong to the system admin organization.
 */
export async function requireSystemAdmin() {
  const session = await verifySession();

  if (session.organizationId !== SYSTEM_ADMIN_ORG_ID) {
    redirect("/workspace");
  }

  return session;
}

// ---------------------------------------------------------------------------
// Phase 6 — WorkOS Session Refresh Integration Points
// ---------------------------------------------------------------------------
//
// When WorkOS permissions become the authoritative source for authorization
// (replacing CRM role lookups in this layer), the following changes are needed:
//
// 1. After role-changing mutations in Server Actions, call:
//
//    import { refreshSession } from "@workos-inc/authkit-nextjs";
//    await refreshSession();
//
//    This updates the session cookie with the latest WorkOS membership role
//    and permissions so that subsequent requests to getWorkspaceAccess()
//    can read permissions directly from the session instead of querying CRM.
//
// 2. Update getWorkspaceAccess() to read permissions from session claims:
//
//    const { permissions } = session;
//    // Use permissions instead of (or in addition to) crmUser.role
//
// 3. Update requireRole() to accept permission slugs as an alternative to
//    CRM role arrays, allowing a gradual migration path.
//
// Until Phase 6 is implemented, CRM role data remains the authoritative
// source and session claims are not trusted for authorization decisions.
// ---------------------------------------------------------------------------
