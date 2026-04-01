"use client";

import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateTenantPayload = {
  companyName: string;
  contactEmail: string;
  notes: string | undefined;
};

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export function CreateTenantDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: CreateTenantPayload) => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [form, setForm] = useState({
    companyName: "",
    contactEmail: "",
    notes: "",
  });
  const companyRef = useRef<HTMLInputElement>(null);

  const canSubmit =
    !isSubmitting &&
    form.companyName.trim() !== "" &&
    form.contactEmail.trim() !== "";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        companyName: form.companyName.trim(),
        contactEmail: form.contactEmail.trim(),
        notes: form.notes.trim() || undefined,
      });
      setForm({ companyName: "", contactEmail: "", notes: "" });
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Tenant Invite</DialogTitle>
          <DialogDescription>
            Provisions a WorkOS organization, inserts the tenant record, signs an
            invite token, and returns the onboarding URL.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-4">
            <div className="space-y-2">
              <label
                htmlFor="create-company-name"
                className="text-sm font-medium text-foreground"
              >
                Company Name
              </label>
              <Input
                ref={companyRef}
                id="create-company-name"
                name="companyName"
                autoComplete="organization"
                spellCheck={false}
                value={form.companyName}
                onChange={(e) =>
                  setForm((c) => ({ ...c, companyName: e.target.value }))
                }
                placeholder="Acme Sales Co&hellip;"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="create-contact-email"
                className="text-sm font-medium text-foreground"
              >
                Contact Email
              </label>
              <Input
                id="create-contact-email"
                name="contactEmail"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                value={form.contactEmail}
                onChange={(e) =>
                  setForm((c) => ({ ...c, contactEmail: e.target.value }))
                }
                placeholder="owner@example.com"
              />
            </div>

            <div className="space-y-2">
              <label
                htmlFor="create-notes"
                className="text-sm font-medium text-foreground"
              >
                Notes{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <Textarea
                id="create-notes"
                name="notes"
                value={form.notes}
                onChange={(e) =>
                  setForm((c) => ({ ...c, notes: e.target.value }))
                }
                placeholder="Pilot tenant, high-priority onboarding&hellip;"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Loader2
                    className="size-4 animate-spin"
                    aria-hidden="true"
                  />
                  Creating&hellip;
                </>
              ) : (
                "Create Tenant"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
