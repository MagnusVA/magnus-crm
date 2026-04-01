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
  workosOrgId: string;
  inviteUrl: string;
  expiresAt: number;
  webhookCleanup: WebhookCleanupStatus;
  deletedRawWebhookEvents: number;
  deletedCalendlyOrgMembers: number;
};

export function ResetTenantDialog({
  open,
  tenant,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  tenant: Doc<"tenants"> | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (tenant: Doc<"tenants">) => Promise<void>;
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
          <DialogTitle>Reset Tenant for Re-onboarding</DialogTitle>
          <DialogDescription>
            This clears the tenant back to the pre-signup state and issues a
            fresh invite link for a full onboarding retest.
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
                  Reset will perform these steps:
                </p>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  <li>Delete the Calendly webhook subscription when a valid token is available.</li>
                  <li>Clear stored Calendly OAuth tokens, webhook state, and onboarding timestamps.</li>
                  <li>Delete synced Calendly org members and raw webhook events for this tenant.</li>
                  <li>Keep the WorkOS organization and tenant record, then issue a fresh invite.</li>
                </ul>
                <p className="text-destructive">
                  WorkOS users and Convex `users` records are not deleted by this action.
                  Remove those manually before re-testing onboarding.
                </p>
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
                Enter <span className="font-medium text-foreground">{currentTenant.companyName}</span> exactly to enable the reset action.
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
                  Resetting&hellip;
                </>
              ) : (
                <>
                  <Trash2Icon data-icon="inline-start" aria-hidden="true" />
                  Reset Tenant
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
