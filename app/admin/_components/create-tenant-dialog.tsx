"use client";

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
    return `Company name must be at least ${MIN_COMPANY_NAME_LENGTH} characters.`;
  if (trimmed.length > MAX_COMPANY_NAME_LENGTH)
    return `Company name must not exceed ${MAX_COMPANY_NAME_LENGTH} characters.`;
  return null;
}

function validateEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  if (trimmed.length === 0) return "Email is required.";
  if (trimmed.length > MAX_EMAIL_LENGTH)
    return `Email must not exceed ${MAX_EMAIL_LENGTH} characters.`;
  if (!EMAIL_REGEX.test(trimmed)) return "Invalid email format.";
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
  const companyRef = useRef<HTMLInputElement>(null);

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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Tenant Invite</DialogTitle>
          <DialogDescription>
            Provisions a WorkOS organization, inserts the tenant record, signs an
            invite token, and returns the onboarding URL.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <FieldGroup>
            <Field data-invalid={errors.companyName ? true : undefined}>
              <FieldLabel htmlFor="create-company-name">
                Company Name
              </FieldLabel>
              <Input
                ref={companyRef}
                id="create-company-name"
                name="companyName"
                autoComplete="organization"
                spellCheck={false}
                value={form.companyName}
                onChange={(e) => handleCompanyChange(e.target.value)}
                placeholder="Acme Sales Co&hellip;"
                aria-invalid={errors.companyName ? true : undefined}
                aria-describedby={
                  errors.companyName
                    ? "create-company-name-error"
                    : undefined
                }
              />
              <FieldError id="create-company-name-error">
                {errors.companyName}
              </FieldError>
            </Field>

            <Field data-invalid={errors.contactEmail ? true : undefined}>
              <FieldLabel htmlFor="create-contact-email">
                Contact Email
              </FieldLabel>
              <Input
                id="create-contact-email"
                name="contactEmail"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                value={form.contactEmail}
                onChange={(e) => handleEmailChange(e.target.value)}
                placeholder="owner@example.com"
                aria-invalid={errors.contactEmail ? true : undefined}
                aria-describedby={
                  errors.contactEmail
                    ? "create-contact-email-error"
                    : undefined
                }
              />
              <FieldError id="create-contact-email-error">
                {errors.contactEmail}
              </FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="create-notes">
                Notes{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </FieldLabel>
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
            </Field>
          </FieldGroup>

          <DialogFooter>
            <Button type="submit" disabled={!canSubmit}>
              {isSubmitting ? (
                <>
                  <Spinner data-icon="inline-start" />
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
