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
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Validation Rules (must match backend convex/lib/validation.ts)
// ---------------------------------------------------------------------------

const MIN_COMPANY_NAME_LENGTH = 2;
const MAX_COMPANY_NAME_LENGTH = 256;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateCompanyName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < MIN_COMPANY_NAME_LENGTH)
    return `Use at least ${MIN_COMPANY_NAME_LENGTH} characters.`;
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH)
    return `Use ${MAX_COMPANY_NAME_LENGTH} characters or fewer.`;
  return null;
}

function validateEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) return "Enter the contact's email.";
  if (trimmed.length > MAX_EMAIL_LENGTH)
    return `Use ${MAX_EMAIL_LENGTH} characters or fewer.`;
  if (!EMAIL_REGEX.test(trimmed)) return "Enter a full email address, like owner@company.com.";
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CreateTenantPayload = {
  companyName: string;
  contactEmail: string;
  notes: string | undefined;
};

// Form rows in the Settings grammar: a 120px slate label column beside the
// control from the form's @lg, over it narrower (DESIGN.md, Form and Settings Cards).
const ROW =
  "grid gap-1.5 px-4 py-3 data-[invalid=true]:text-foreground @lg:grid-cols-[120px_minmax(0,1fr)] @lg:items-start @lg:gap-x-3";
const ROW_LABEL = "text-[13px] font-normal text-muted-foreground @lg:min-h-8 @lg:items-center";
/** Field errors in danger ink, which reads at 4.5:1 where the fill red doesn't. */
const ERROR = "text-[13px] text-danger-ink";

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
  const [errors, setErrors] = useState({
    companyName: null as string | null,
    contactEmail: null as string | null,
  });

  const canSubmit =
    !isSubmitting &&
    form.companyName.trim() !== "" &&
    form.contactEmail.trim() !== "" &&
    !errors.companyName &&
    !errors.contactEmail;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Validate before submission
    const companyError = validateCompanyName(form.companyName);
    const emailError = validateEmail(form.contactEmail);
    setErrors({ companyName: companyError, contactEmail: emailError });

    if (companyError || emailError) return;

    setIsSubmitting(true);
    try {
      await onSubmit({
        companyName: form.companyName.trim(),
        contactEmail: form.contactEmail.trim(),
        notes: form.notes.trim() || undefined,
      });
      setForm({ companyName: "", contactEmail: "", notes: "" });
      setErrors({ companyName: null, contactEmail: null });
      onOpenChange(false);
    } catch {
      // The parent toasts and reports the failure; keep the dialog open.
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleCompanyChange(value: string) {
    setForm((c) => ({ ...c, companyName: value }));
    // Clear error when user starts typing
    if (errors.companyName) {
      setErrors((e) => ({ ...e, companyName: null }));
    }
  }

  function handleEmailChange(value: string) {
    setForm((c) => ({ ...c, contactEmail: value }));
    // Clear error when user starts typing
    if (errors.contactEmail) {
      setErrors((e) => ({ ...e, contactEmail: null }));
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
          <DialogTitle className="text-[17px] font-semibold">New tenant invite</DialogTitle>
          <DialogDescription className="text-[13px]">
            Creates the company&apos;s WorkOS organization and an invite link to send them.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="@container flex min-h-0 flex-col" noValidate>
          <FieldGroup className="gap-0 divide-y">
            <Field data-invalid={errors.companyName ? true : undefined} className={ROW}>
              <FieldLabel htmlFor="create-company-name" className={ROW_LABEL}>
                Company
              </FieldLabel>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Input
                  id="create-company-name"
                  name="companyName"
                  autoComplete="organization"
                  spellCheck={false}
                  value={form.companyName}
                  onChange={(e) => handleCompanyChange(e.target.value)}
                  placeholder="Acme Sales Co"
                  disabled={isSubmitting}
                  aria-invalid={errors.companyName ? true : undefined}
                  aria-describedby={errors.companyName ? "create-company-name-error" : undefined}
                />
                <FieldError id="create-company-name-error" className={ERROR}>
                  {errors.companyName}
                </FieldError>
              </div>
            </Field>

            <Field data-invalid={errors.contactEmail ? true : undefined} className={ROW}>
              <FieldLabel htmlFor="create-contact-email" className={ROW_LABEL}>
                Contact email
              </FieldLabel>
              <div className="flex min-w-0 flex-col gap-1.5">
                <Input
                  id="create-contact-email"
                  name="contactEmail"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  spellCheck={false}
                  value={form.contactEmail}
                  onChange={(e) => handleEmailChange(e.target.value)}
                  placeholder="owner@acmesales.com"
                  disabled={isSubmitting}
                  aria-invalid={errors.contactEmail ? true : undefined}
                  aria-describedby={errors.contactEmail ? "create-contact-email-error" : undefined}
                />
                <FieldError id="create-contact-email-error" className={ERROR}>
                  {errors.contactEmail}
                </FieldError>
              </div>
            </Field>

            <Field className={ROW}>
              <FieldLabel htmlFor="create-notes" className={`${ROW_LABEL} gap-1`}>
                Notes
                <span aria-hidden="true">·</span>
                <span>Optional</span>
              </FieldLabel>
              <Textarea
                id="create-notes"
                name="notes"
                value={form.notes}
                onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))}
                placeholder="Pilot tenant, onboarding call on Monday"
                disabled={isSubmitting}
                rows={3}
              />
            </Field>
          </FieldGroup>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t bg-background px-4 py-3">
            <Button type="button" variant="outline" disabled={isSubmitting} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} className="font-semibold">
              {isSubmitting ? <Spinner data-icon="inline-start" /> : null}
              {isSubmitting ? "Creating…" : "Create invite"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
