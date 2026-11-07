"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { LABEL } from "@/app/workspace/team/_components/team-ui";
import { TenantStatusWord, type TenantRow } from "./admin-ui";

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

/** What Delete does, in the order the server does it. */
const STEPS = [
  "Removes its Calendly webhook.",
  "Revokes its stored Calendly tokens.",
  "Deletes its WorkOS users and organization.",
  "Erases its data in Magnus: people, calls, synced Calendly members, webhook events and users.",
  "Deletes the tenant, so a new invite starts over.",
];

/**
 * Delete a tenant everywhere: the record, what will happen, then the company's
 * name typed to confirm (DESIGN.md, a choice's consequence stated before it's confirmed).
 */
export function ResetTenantDialog({
  open,
  tenant,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  tenant: TenantRow | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (tenant: TenantRow) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Clear the confirmation each time the dialog opens for a tenant.
  const sessionKey = open ? (tenant?._id ?? null) : null;
  const [loadedSessionKey, setLoadedSessionKey] = useState<string | null>(null);
  if (sessionKey !== loadedSessionKey) {
    setLoadedSessionKey(sessionKey);
    setConfirmation("");
  }

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
    } catch {
      // The parent toasts and reports the failure; keep the dialog open.
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!isSubmitting) onOpenChange(next);
      }}
    >
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={!isSubmitting}>
        <DialogHeader className="border-b px-4 pt-4 pr-12 pb-3.5">
          <DialogTitle className="text-[17px] font-semibold text-balance">
            Delete <span translate="no">{currentTenant.companyName}</span>?
          </DialogTitle>
          <DialogDescription className="text-[13px] text-danger-ink">
            This removes the company everywhere. It can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          {/* The title names the company; the facts say what else is being removed. */}
          <dl className="border-b py-1">
            <Fact label="Contact">
              <span className="break-all" translate="no">
                {currentTenant.contactEmail}
              </span>
            </Fact>
            <Fact label="Status">
              <TenantStatusWord status={currentTenant.status} />
            </Fact>
            <Fact label="Calendly webhook">{currentTenant.calendlyWebhookUri ? "Set up" : "None"}</Fact>
          </dl>

          <div className="border-b pt-2.5">
            <p className={`${LABEL} px-4 pb-1.5`}>What happens</p>
            <ol className="text-[13px] leading-[1.45]">
              {STEPS.map((step, index) => (
                <li key={step} className="flex gap-2.5 border-t px-4 py-[7px]">
                  <span className="w-3 shrink-0 font-condensed text-[14px] font-semibold text-muted-foreground tabular-nums">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>

          <Field className="gap-1.5 px-4 py-3">
            <FieldLabel htmlFor="reset-company-confirmation" className="text-[13px] font-normal text-muted-foreground">
              Type the company name to confirm
            </FieldLabel>
            <Input
              id="reset-company-confirmation"
              name="companyName"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={currentTenant.companyName}
              disabled={isSubmitting}
              spellCheck={false}
              autoComplete="off"
              translate="no"
            />
          </Field>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!canSubmit} className="font-semibold">
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {isSubmitting ? "Deleting…" : "Delete tenant"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One dense fact: a slate label column beside the value, about 32px. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[8rem_minmax(0,1fr)] items-baseline gap-x-3 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}
