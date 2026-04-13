"use client";

import { ShieldAlertIcon, Trash2Icon, WebhookIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { Doc } from "@/convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";

type WebhookCleanupStatus =
  | { status: "deleted" | "not_configured" }
  | {
      status: "skipped_missing_access_token" | "failed";
      message: string;
    };

export type ResetTenantResult = {
  tenantId: string;
  deletedTenant: true;
  webhookCleanup: WebhookCleanupStatus;
  tokenCleanup: {
    accessToken: "revoked" | "not_present" | "already_invalid";
    refreshToken: "revoked" | "not_present" | "already_invalid";
  };
  workosCleanup: {
    deletedUsers: number;
    deletedOrganization: boolean;
  };
  deletedRawWebhookEvents: number;
  deletedCalendlyOrgMembers: number;
  deletedUsers: number;
};

type TenantWithWebhookStatus = Doc<"tenants"> & {
  calendlyWebhookUri?: string;
};

export function ResetTenantDialog({
  open,
  tenant,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  tenant: TenantWithWebhookStatus | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (tenant: TenantWithWebhookStatus) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setConfirmation("");
    }
  }, [open, tenant?._id]);

  if (!tenant) {
    return null;
  }

  const currentTenant = tenant;
  const canSubmit =
    !isSubmitting && confirmation.trim() === currentTenant.companyName.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    try {
      await onSubmit(currentTenant);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" showCloseButton={!isSubmitting}>
        <DialogHeader>
          <DialogTitle>Delete Tenant Completely</DialogTitle>
          <DialogDescription>
            This fully deprovisions the tenant and removes the tenant record
            from Convex so onboarding can later start again from zero with a
            brand-new invite.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4 sm:grid-cols-3">
            <SummaryCell label="Company" value={currentTenant.companyName} />
            <SummaryCell
              label="Status"
              value={<Badge variant="outline">{currentTenant.status}</Badge>}
            />
            <SummaryCell
              label="Webhook"
              value={
                currentTenant.calendlyWebhookUri ? (
                  <span className="inline-flex items-center gap-1.5 text-foreground">
                    <WebhookIcon className="size-3.5" aria-hidden="true" />
                    Configured
                  </span>
                ) : (
                  "Not configured"
                )
              }
            />
          </div>

          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-md bg-destructive/10 p-2 text-destructive">
                <ShieldAlertIcon className="size-4" aria-hidden="true" />
              </div>
              <div className="space-y-2 text-sm">
                <p className="font-medium text-foreground">
                  Delete will perform these steps:
                </p>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  <li>
                    Delete the Calendly webhook subscription before any token
                    revocation occurs.
                  </li>
                  <li>Revoke stored Calendly OAuth tokens when they still exist.</li>
                  <li>
                    Delete the tenant&apos;s WorkOS users and remove the old
                    WorkOS organization.
                  </li>
                  <li>
                    Delete tenant-scoped Convex data, including synced Calendly
                    members, webhook events, and app `users` records.
                  </li>
                  <li>
                    Delete the tenant record itself. If you want to onboard the
                    company again, create a new tenant invite afterward.
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="reset-company-confirmation">
                Type the company name to confirm
              </FieldLabel>
              <Input
                id="reset-company-confirmation"
                name="companyName"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                placeholder={currentTenant.companyName}
                spellCheck={false}
                autoComplete="off"
              />
              <FieldDescription>
                Enter{" "}
                <span className="font-medium text-foreground">
                  {currentTenant.companyName}
                </span>{" "}
                exactly to enable the delete action.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Deleting&hellip;
                </>
              ) : (
                <>
                  <Trash2Icon data-icon="inline-start" aria-hidden="true" />
                  Delete Tenant
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SummaryCell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
        {label}
      </p>
      <div className="min-w-0 text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}
