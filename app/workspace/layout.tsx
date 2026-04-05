import { getWorkspaceAccess } from "@/lib/auth";
import { redirect } from "next/navigation";
import { WorkspaceShell } from "./_components/workspace-shell";
import { NotProvisionedScreen } from "./_components/not-provisioned-screen";

export default async function WorkspaceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const access = await getWorkspaceAccess();

  switch (access.kind) {
    // System admins should use the admin panel, not the workspace
    case "system_admin":
      redirect("/admin");

    // Pending tenants should complete onboarding first
    case "pending_onboarding":
      redirect("/onboarding/connect");

    // No tenant or not provisioned: show a friendly message
    case "no_tenant":
    case "not_provisioned":
      return <NotProvisionedScreen />;

    // Tenant is active and user is provisioned: render the workspace shell
    case "ready":
      return (
        <WorkspaceShell
          initialRole={access.crmUser.role}
          initialDisplayName={access.crmUser.fullName ?? access.crmUser.email}
          initialEmail={access.crmUser.email}
        >
          {children}
        </WorkspaceShell>
      );
  }
}
