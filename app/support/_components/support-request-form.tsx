"use client";

import { useMutation } from "convex/react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
  FormFooter,
  NoteLine,
  SettingRow,
} from "@/app/workspace/settings/_components/settings-ui";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

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

const SUPPORT_EMAIL = "vas.claudio15+supportmagnus@icloud.com";

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
        getErrorMessage(error, "Support request could not be submitted."),
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
    <section aria-labelledby="support-form-title" className={cn(CARD, "@container")}>
      <CardHead
        title={<span id="support-form-title">Send a request</span>}
        meta="A system admin reviews it and replies by email."
      />
      <form onSubmit={handleSubmit} noValidate>
        <FieldGroup className="gap-0 divide-y divide-border">
          <SettingRow
            label="Name"
            htmlFor="support-name"
            invalid={Boolean(errors.name)}
            description={errorLine(errors.name)}
          >
            <Input
              id="support-name"
              name="name"
              autoComplete="name"
              value={form.name}
              onChange={(event) => setField("name", event.target.value)}
              aria-invalid={errors.name ? true : undefined}
            />
          </SettingRow>

          <SettingRow
            label="Email"
            htmlFor="support-email"
            invalid={Boolean(errors.email)}
            description={errorLine(errors.email)}
          >
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
          </SettingRow>

          <SettingRow
            label="Organization"
            htmlFor="support-organization"
            description="Optional. The company your Magnus account belongs to."
          >
            <Input
              id="support-organization"
              name="organizationName"
              autoComplete="organization"
              value={form.organizationName}
              onChange={(event) =>
                setField("organizationName", event.target.value)
              }
            />
          </SettingRow>

          <SettingRow
            label="Slack workspace"
            htmlFor="support-slack-workspace"
            description="Optional. Helps with Slack app issues."
          >
            <Input
              id="support-slack-workspace"
              name="slackWorkspace"
              value={form.slackWorkspace}
              onChange={(event) =>
                setField("slackWorkspace", event.target.value)
              }
            />
          </SettingRow>

          <SettingRow
            label="Subject"
            htmlFor="support-subject"
            invalid={Boolean(errors.subject)}
            description={errorLine(errors.subject)}
          >
            <Input
              id="support-subject"
              name="subject"
              value={form.subject}
              onChange={(event) => setField("subject", event.target.value)}
              aria-invalid={errors.subject ? true : undefined}
            />
          </SettingRow>

          <SettingRow
            label="Message"
            htmlFor="support-message"
            invalid={Boolean(errors.message)}
            description={errorLine(errors.message)}
          >
            <Textarea
              id="support-message"
              name="message"
              rows={5}
              value={form.message}
              onChange={(event) => setField("message", event.target.value)}
              aria-invalid={errors.message ? true : undefined}
            />
          </SettingRow>
        </FieldGroup>

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

        {/* Always mounted, so the sent line is announced when it fills in. */}
        <div
          role="status"
          className={submitted ? "border-t border-border px-4 py-2.5" : undefined}
        >
          {submitted ? (
            <NoteLine tone="ok">
              Request received. We&rsquo;ll reply by email.
            </NoteLine>
          ) : null}
        </div>
        {submitError ? (
          <div className="border-t border-border px-4 py-2.5">
            <NoteLine role="alert" tone="danger">
              Couldn&rsquo;t send the request: {submitError}
            </NoteLine>
          </div>
        ) : null}

        <FormFooter
          aside={
            <>
              Or email{" "}
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="rounded-sm break-all text-foreground underline decoration-foreground/40 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {SUPPORT_EMAIL}
              </a>
            </>
          }
        >
          <Button type="submit" className="font-semibold" disabled={!canSubmit}>
            {isSubmitting ? (
              <>
                <Spinner data-icon="inline-start" />
                Sending&hellip;
              </>
            ) : (
              "Send request"
            )}
          </Button>
        </FormFooter>
      </form>
    </section>
  );
}

/** A field's error, announced when it appears. */
function errorLine(error: string | undefined) {
  return error ? <span role="alert">{error}</span> : undefined;
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
