"use client";

import { useId, useState, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useMutation } from "convex/react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { CARD, CardHead, Code } from "@/app/workspace/team/_components/team-ui";
import { NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import type { WhopConnection } from "@/app/workspace/settings/_components/integrations/integration-status";
import { getErrorMessage } from "@/lib/errors";

const secretSchema = z.object({
  webhookSecret: z.string().trim().min(8, "Paste the webhook secret from Whop.").max(1024, "That secret is too long."),
});

/**
 * The webhook in three numbered steps: the URL to copy, the events to pick,
 * and the signing secret Whop shows once. Saving the secret is the page's one
 * lime action while it's missing.
 */
export function WhopWebhookCard({ connection }: { connection: WhopConnection }) {
  const [replacing, setReplacing] = useState(false);
  const hasSecret = connection.hasWebhookSecret;

  return (
    <section aria-label="Whop webhook" className={CARD}>
      <CardHead title="Webhook">
        <StatusWord tone={hasSecret ? "ok" : "warning"}>{hasSecret ? "Secret saved" : "Secret needed"}</StatusWord>
      </CardHead>
      <ol>
        <Step number={1} title="In your Whop dashboard, create a webhook with this URL.">
          {connection.webhookUrl ? (
            <CopyField value={connection.webhookUrl} label="Webhook URL" />
          ) : (
            <NoteLine tone="danger">Magnus can&apos;t show the webhook URL right now. Contact support.</NoteLine>
          )}
        </Step>
        <Step number={2} title="Subscribe it to these events.">
          <ul className="flex flex-wrap gap-1.5" aria-label="Events to subscribe to">
            {connection.webhookEvents.map((event) => (
              <li key={event}>
                <Code>{event}</Code>
              </li>
            ))}
          </ul>
        </Step>
        <Step number={3} title="Paste the signing secret Whop shows once you save the webhook.">
          {hasSecret && !replacing ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <NoteLine className="flex items-center gap-1.5 text-foreground">
                <CheckIcon className="size-3.5 text-primary-ink" aria-hidden="true" />
                Secret saved
              </NoteLine>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setReplacing(true)}>
                Replace secret
              </Button>
            </div>
          ) : (
            <SecretForm
              connectionId={connection.connectionId}
              replacing={hasSecret}
              onDone={() => setReplacing(false)}
              onCancel={hasSecret ? () => setReplacing(false) : undefined}
            />
          )}
        </Step>
      </ol>
    </section>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-2.5 border-b border-border px-4 py-3 last:border-b-0">
      <span
        aria-hidden="true"
        className="w-3 shrink-0 font-condensed text-[15px] leading-[1.35] font-semibold text-muted-foreground tabular-nums"
      >
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm leading-[1.4]">
          <span className="sr-only">Step {number}: </span>
          {title}
        </p>
        {children}
      </div>
    </li>
  );
}

/** A read-only value with a copy button beside it. */
function CopyField({ value, label }: { value: string; label: string }) {
  const id = useId();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(`${label} copied.`);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Could not copy. Select the text and copy it instead.");
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Input
        id={id}
        readOnly
        value={value}
        translate="no"
        spellCheck={false}
        onFocus={(event) => event.currentTarget.select()}
        className="min-w-0 flex-1 font-mono text-[12.5px]"
      />
      <Button type="button" variant="outline" size="sm" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <CheckIcon data-icon="inline-start" aria-hidden="true" /> : <CopyIcon data-icon="inline-start" aria-hidden="true" />}
        <TranslatableText>{copied ? "Copied" : "Copy"}</TranslatableText>
      </Button>
    </div>
  );
}

function SecretForm({
  connectionId,
  replacing,
  onDone,
  onCancel,
}: {
  connectionId: WhopConnection["connectionId"];
  replacing: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const id = useId();
  const save = useMutation(api.payments.connection.setWebhookSecret);
  const form = useForm({
    resolver: standardSchemaResolver(secretSchema),
    defaultValues: { webhookSecret: "" },
  });

  async function submit(values: z.infer<typeof secretSchema>) {
    try {
      await save({ connectionId, webhookSecret: values.webhookSecret });
      form.reset({ webhookSecret: "" });
      toast.success(replacing ? "Webhook secret replaced." : "Webhook secret saved.");
      onDone();
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not save the webhook secret."));
    }
  }

  const submitting = form.formState.isSubmitting;
  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-2">
      <Controller
        control={form.control}
        name="webhookSecret"
        render={({ field, fieldState }) => (
          <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5">
            <FieldLabel htmlFor={`${id}-secret`} className="text-[13px] font-normal text-muted-foreground">
              {replacing ? "New webhook secret" : "Webhook secret"}
            </FieldLabel>
            <Input
              {...field}
              id={`${id}-secret`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={fieldState.invalid || undefined}
            />
            {replacing ? (
              <FieldDescription className="text-[13px] leading-[1.45]">
                The old secret keeps working for 24 hours after a replacement.
              </FieldDescription>
            ) : null}
            <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
          </Field>
        )}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="submit"
          size="sm"
          variant={replacing ? "outline" : "default"}
          className={replacing ? undefined : "font-semibold"}
          disabled={submitting}
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{replacing ? "Replace secret" : "Save secret"}</TranslatableText>
        </Button>
        {onCancel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={() => {
              form.reset({ webhookSecret: "" });
              onCancel();
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
