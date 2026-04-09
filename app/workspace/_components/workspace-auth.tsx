import { type ReactNode } from "react";
import { redirect } from "next/navigation";
import { getWorkspaceAccess } from "@/lib/auth";
import { WorkspaceShellClient } from "./workspace-shell-client";
import { NotProvisionedScreen } from "./not-provisioned-screen";

/**
 * Resolves workspace access inside a Suspense boundary.
 * Redirects/shows error states as needed.
 * Streams in after the static frame is already visible.
 */
export async function WorkspaceAuth({ children }: { children: ReactNode }) {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    case "system_admin":
      redirect("/admin");
    case "pending_onboarding":
      redirect("/onboarding/connect");
    case "no_tenant":
    case "not_provisioned":
      return <NotProvisionedScreen />;
    case "ready":
      return (
        <WorkspaceShellClient
          initialRole={access.crmUser.role}
          initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
          initialEmail={access.crmUser.email}
          workosUserId={access.crmUser.workosUserId}
          workosOrgId={access.tenant.workosOrgId}
          tenantName={access.tenant.companyName}
        >
          {children}
        </WorkspaceShellClient>
      );
  }
}
