"use client";

import { useAction } from "convex/react";
import dynamic from "next/dynamic";
import { LogOutIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import { StandaloneShell } from "@/components/standalone-shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { usePageTitle } from "@/hooks/use-page-title";
import { useAuthPostHogIdentify } from "@/hooks/use-posthog-identify";
import { useSignOut } from "@/hooks/use-sign-out";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";

import { ADMIN_ROOT, plural, type InviteResult, type TenantRow, type TenantStatus } from "./admin-ui";
import type { CreateTenantPayload } from "./create-tenant-dialog";
import { InviteLinkCard } from "./invite-link-card";
import type { ResetTenantResult } from "./reset-tenant-dialog";
import { SupportRequestsCard, SupportRequestsError } from "./support-requests-card";
import { TenantsBand } from "./tenants-band";
import { TenantsCard, TenantsCardError } from "./tenants-card";

const CreateTenantDialog = dynamic(() =>
  import("./create-tenant-dialog").then((m) => ({ default: m.CreateTenantDialog })),
);
const ResetTenantDialog = dynamic(() =>
  import("./reset-tenant-dialog").then((m) => ({ default: m.ResetTenantDialog })),
);

/**
 * The System admin console (DESIGN.md, Layout): the Tenants band with its
 * status tabs, the invite link after a create or a new link, the tenants, and
 * the support page's requests, in the standalone frame.
 */
export function AdminPageClient() {
  usePageTitle("System admin");
  const signOut = useSignOut();
  useAuthPostHogIdentify({ role: "system_admin" });

  const [statusFilter, setStatusFilter] = useState<TenantStatus | undefined>(undefined);
  const [summary, setSummary] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [tenantToReset, setTenantToReset] = useState<TenantRow | null>(null);

  const createTenantInvite = useAction(api.admin.tenants.createTenantInvite);
  const regenerateInvite = useAction(api.admin.tenants.regenerateInvite);
  const deleteTenant = useAction(api.admin.tenants.resetTenantForReonboarding);

  const handleCreate = async (payload: CreateTenantPayload) => {
    try {
      const result = await createTenantInvite(payload);
      setInviteResult({ ...result, companyName: payload.companyName });
    } catch (error) {
      reportClientError(error, { flow: "admin_tenant_invite_create" });
      toast.error("Tenant invite failed.", {
        description: getErrorMessage(error, "The tenant invite could not be created."),
      });
      // Rethrown so the dialog stays open with the entered values.
      throw error;
    }
  };

  const handleRegenerate = async (tenant: TenantRow) => {
    try {
      const result = await regenerateInvite({ tenantId: tenant._id });
      setInviteResult({
        tenantId: tenant._id,
        workosOrgId: tenant.workosOrgId,
        companyName: tenant.companyName,
        inviteUrl: result.inviteUrl,
        expiresAt: result.expiresAt,
      });
    } catch (error) {
      reportClientError(error, { flow: "admin_tenant_invite_regenerate" });
      toast.error("Invite regeneration failed.", {
        description: getErrorMessage(error, "The invite could not be regenerated."),
      });
    }
  };

  const handleReset = async (tenant: TenantRow) => {
    try {
      const result = await deleteTenant({ tenantId: tenant._id });

      toast.success(getResetToastTitle(result, tenant.companyName), {
        description: getResetToastDescription(result),
      });
      // A link for a company that no longer exists would only mislead.
      setInviteResult((current) => (current?.tenantId === tenant._id ? null : current));
    } catch (error) {
      reportClientError(error, { flow: "admin_tenant_reset" });
      toast.error("Tenant deletion failed.", {
        description: getErrorMessage(error, "The tenant could not be deleted."),
      });
      throw error;
    }
  };

  return (
    <StandaloneShell
      area="System admin"
      homeHref="/admin"
      controls={
        <>
          <ThemeToggle />
          <Button
            variant="ghost"
            className="h-9 px-2.5 text-[13px] text-board-muted hover:bg-board-foreground/10 hover:text-board-foreground dark:hover:bg-board-foreground/10"
            onClick={() => signOut()}
          >
            <LogOutIcon data-icon="inline-start" aria-hidden="true" />
            Sign out
          </Button>
        </>
      }
    >
      <div className={ADMIN_ROOT}>
        <TenantsBand
          status={statusFilter}
          onStatus={setStatusFilter}
          summary={summary}
          onCreate={() => setDialogOpen(true)}
        />

        {inviteResult ? <InviteLinkCard result={inviteResult} onDismiss={() => setInviteResult(null)} /> : null}

        <SectionErrorBoundary
          sectionName="tenants"
          fallback={<TenantsCardError status={statusFilter} onSummary={setSummary} />}
        >
          <TenantsCard
            status={statusFilter}
            onSummary={setSummary}
            onRegenerate={handleRegenerate}
            onDeleteRequest={setTenantToReset}
          />
        </SectionErrorBoundary>

        <SectionErrorBoundary sectionName="support requests" fallback={<SupportRequestsError />}>
          <SupportRequestsCard />
        </SectionErrorBoundary>
      </div>

      <CreateTenantDialog open={dialogOpen} onOpenChange={setDialogOpen} onSubmit={handleCreate} />
      <ResetTenantDialog
        open={tenantToReset !== null}
        tenant={tenantToReset}
        onOpenChange={(open) => {
          if (!open) {
            setTenantToReset(null);
          }
        }}
        onSubmit={handleReset}
      />
    </StandaloneShell>
  );
}

function getResetToastTitle(result: ResetTenantResult, companyName: string) {
  if (
    result.webhookCleanup.status === "deleted" &&
    result.workosCleanup.deletedOrganization
  ) {
    return `${companyName} deleted`;
  }

  if (result.webhookCleanup.status === "not_configured") {
    return `${companyName} deleted. It had no Calendly webhook.`;
  }

  return `${companyName} deleted. Check what couldn't be cleaned up.`;
}

function getResetToastDescription(result: ResetTenantResult) {
  const problems = [
    result.webhookCleanup.status === "failed" || result.webhookCleanup.status === "skipped_missing_access_token"
      ? `Calendly webhook not removed: ${result.webhookCleanup.message}`
      : null,
    result.workosCleanup.deletedOrganization ? null : "WorkOS organization not deleted.",
  ].filter(Boolean);

  const removed = `Removed ${plural(result.workosCleanup.deletedUsers, "WorkOS user")}, ${plural(
    result.deletedUsers,
    "app user",
  )}, ${plural(result.deletedRawWebhookEvents, "webhook event")} and ${plural(
    result.deletedCalendlyOrgMembers,
    "Calendly member",
  )}.`;

  const tokens = `Calendly access token ${formatTokenCleanupStatus(
    result.tokenCleanup.accessToken,
  )}, refresh token ${formatTokenCleanupStatus(result.tokenCleanup.refreshToken)}.`;

  return [...problems, removed, tokens, "A new invite starts over."].join(" ");
}

function formatTokenCleanupStatus(
  status: ResetTenantResult["tokenCleanup"]["accessToken"],
) {
  if (status === "revoked") {
    return "revoked";
  }

  if (status === "already_invalid") {
    return "already invalid";
  }

  return "not present";
}
