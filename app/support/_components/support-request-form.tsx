"use client";

import { useMutation } from "convex/react";
import { CheckCircle2Icon, SendIcon } from "lucide-react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

const initialForm = {
  name: "",
  email: "",
  organizationName: "",
  slackWorkspace: "",
  subject: "",
  message: "",
  website: "",
};

type SupportFormState = typeof initialForm;
type SupportFormErrors = Partial<Record<keyof SupportFormState, string>>;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SupportRequestForm() {
  const submitSupportRequest = useMutation(api.support.submitSupportRequest);
  const [form, setForm] = useState<SupportFormState>(initialForm);
  const [errors, setErrors] = useState<SupportFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit =
    !isSubmitting &&
    form.name.trim() !== "" &&
    form.email.trim() !== "" &&
    form.subject.trim() !== "" &&
    form.message.trim() !== "";

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(false);
    setSubmitError(null);

    const nextErrors = validateForm(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      await submitSupportRequest({
        name: form.name,
        email: form.email,
        organizationName: form.organizationName || undefined,
        slackWorkspace: form.slackWorkspace || undefined,
        subject: form.subject,
        message: form.message,
        website: form.website || undefined,
      });
      setForm(initialForm);
      setErrors({});
      setSubmitted(true);
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Support request could not be submitted.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  function setField<Key extends keyof SupportFormState>(
    key: Key,
    value: SupportFormState[Key],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) {
      setErrors((current) => ({ ...current, [key]: undefined }));
    }
    if (submitted) {
      setSubmitted(false);
    }
  }

  return (
    <section className="border-t border-border pt-8">
      <div className="mb-5">
        <h2 className="text-xl font-semibold tracking-tight">
          Contact Support
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Submit a request and a system administrator will review it.
        </p>
      </div>

      {submitted ? (
        <Alert className="mb-5 border-primary/30 bg-primary/5">
          <CheckCircle2Icon className="size-4 text-primary" aria-hidden="true" />
          <AlertTitle>Request submitted</AlertTitle>
          <AlertDescription>
            We received your support request and will respond by email.
          </AlertDescription>
        </Alert>
      ) : null}

      {submitError ? (
        <Alert variant="destructive" className="mb-5">
          <AlertTitle>Submission failed</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      ) : null}

      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="support-name">Name</FieldLabel>
              <Input
                id="support-name"
                name="name"
                autoComplete="name"
                value={form.name}
                onChange={(event) => setField("name", event.target.value)}
                aria-invalid={errors.name ? true : undefined}
              />
              <FieldError>{errors.name}</FieldError>
            </Field>

            <Field data-invalid={errors.email ? true : undefined}>
              <FieldLabel htmlFor="support-email">Email</FieldLabel>
              <Input
                id="support-email"
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                value={form.email}
                onChange={(event) => setField("email", event.target.value)}
                aria-invalid={errors.email ? true : undefined}
              />
              <FieldError>{errors.email}</FieldError>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="support-organization">
                Organization
              </FieldLabel>
              <Input
                id="support-organization"
                name="organizationName"
                autoComplete="organization"
                value={form.organizationName}
                onChange={(event) =>
                  setField("organizationName", event.target.value)
                }
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="support-slack-workspace">
                Slack Workspace
              </FieldLabel>
              <Input
                id="support-slack-workspace"
                name="slackWorkspace"
                value={form.slackWorkspace}
                onChange={(event) =>
                  setField("slackWorkspace", event.target.value)
                }
              />
            </Field>
          </div>

          <Field data-invalid={errors.subject ? true : undefined}>
            <FieldLabel htmlFor="support-subject">Subject</FieldLabel>
            <Input
              id="support-subject"
              name="subject"
              value={form.subject}
              onChange={(event) => setField("subject", event.target.value)}
              aria-invalid={errors.subject ? true : undefined}
            />
            <FieldError>{errors.subject}</FieldError>
          </Field>

          <Field data-invalid={errors.message ? true : undefined}>
            <FieldLabel htmlFor="support-message">Message</FieldLabel>
            <Textarea
              id="support-message"
              name="message"
              rows={5}
              value={form.message}
              onChange={(event) => setField("message", event.target.value)}
              aria-invalid={errors.message ? true : undefined}
            />
            <FieldError>{errors.message}</FieldError>
          </Field>

          <div className="hidden" aria-hidden="true">
            <label htmlFor="support-website">Website</label>
            <input
              id="support-website"
              name="website"
              tabIndex={-1}
              autoComplete="off"
              value={form.website}
              onChange={(event) => setField("website", event.target.value)}
            />
          </div>
        </FieldGroup>

        <div>
          <Button type="submit" disabled={!canSubmit}>
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Sending&hellip;
              </>
            ) : (
              <>
                <SendIcon data-icon="inline-start" aria-hidden="true" />
                Send Request
              </>
            )}
          </Button>
        </div>
      </form>
    </section>
  );
}

function validateForm(form: SupportFormState): SupportFormErrors {
  const errors: SupportFormErrors = {};
  if (!form.name.trim()) {
    errors.name = "Name is required.";
  }
  if (!EMAIL_REGEX.test(form.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  if (!form.subject.trim()) {
    errors.subject = "Subject is required.";
  }
  if (!form.message.trim()) {
    errors.message = "Message is required.";
  }
  return errors;
}
