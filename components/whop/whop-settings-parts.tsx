"use client";

import { useId, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useAction, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { Code } from "@/app/workspace/team/_components/team-ui";
import { ActionRow, NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import type { WhopConnection } from "@/app/workspace/settings/_components/integrations/integration-status";
import { getErrorCode, getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";

// The pieces the Integrations card and the Whop settings page share.

export const WHOP_SETTINGS_HREF = "/workspace/settings/whop";

/** The scopes the connection needs, and the two more the product and price mapping reads with. */
export const WHOP_REQUIRED_SCOPES = ["payment:basic:read", "member:email:read"] as const;
export const WHOP_DISPUTE_SCOPES = ["payment:dispute:read", "payment:dispute_alert:read"] as const;
export const WHOP_CATALOG_SCOPES = ["plan:basic:read", "access_pass:basic:read"] as const;

type Environment = WhopConnection["environment"];

function useWhopConnectionRows(enabled = true) {
  const live = useQuery(api.payments.connection.getConnection, enabled ? { environment: "live" } : "skip");
  const sandbox = useQuery(api.payments.connection.getConnection, enabled ? { environment: "sandbox" } : "skip");
  return live === undefined || sandbox === undefined ? undefined : { live, sandbox };
}

/** The connected environment or the best available row for the setup status. */
export function useWhopConnection(enabled = true): WhopConnection | null | undefined {
  const rows = useWhopConnectionRows(enabled);
  if (!rows) return undefined;
  const { live, sandbox } = rows;
  if (live?.status === "connected") return live;
  if (sandbox?.status === "connected") return sandbox;
  if (live?.status === "invalid_key") return live;
  if (sandbox?.status === "invalid_key") return sandbox;
  return live ?? sandbox;
}

export const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dayYearFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** "Nov 17", with the year only outside this year. */
export function formatDay(timestamp: number) {
  const sameYear = new Date(timestamp).getFullYear() === new Date().getFullYear();
  return (sameYear ? dayFormat : dayYearFormat).format(timestamp);
}

/** The connection's last failed check, in one plain sentence. */
export function whopErrorSentence(code: WhopConnection["lastErrorCode"]): string | null {
  switch (code) {
    case "unauthorized":
      return "Whop rejected the saved API key. Connect again with a new key.";
    case "forbidden":
      return "The API key is missing a permission Magnus needs. Add payment:basic:read and member:email:read to the key in Whop.";
    case "account_mismatch":
      return "The API key now belongs to a different Whop account than this connection.";
    case "rate_limited":
      return "Whop asked Magnus to slow down. The next check will try again.";
    case "provider_unavailable":
      return "Magnus couldn't reach Whop on the last check. The next check will try again.";
    case "unexpected_response":
      return "Whop sent a reply Magnus couldn't read on the last check. The next check will try again.";
    default:
      return null;
  }
}

/** One plain sentence for a failed Connect. */
function connectErrorSentence(error: unknown) {
  switch (getErrorCode(error)) {
    case "whop.unauthorized":
      return "Whop rejected this API key. Check that you copied the whole key.";
    case "whop.forbidden":
      return "This key is missing a permission. Add payment:basic:read and member:email:read to it in Whop, then try again.";
    case "whop.account_mismatch":
      return "The key and the account id don't match, or this workspace is already tied to a different Whop account.";
    case "whop.account_in_use":
      return "This Whop account is already connected to another workspace.";
    case "whop.other_environment_connected":
      return "Disconnect the other Whop environment first.";
    case "whop.provider_unavailable":
      return "Magnus couldn't reach Whop. Try again in a minute.";
    default:
      return getErrorMessage(error, "Could not connect Whop. Try again.");
  }
}

/** The scope names, set as code. */
export function ScopeList({ scopes }: { scopes: readonly string[] }) {
  return (
    <>
      {scopes.map((scope, index) => (
        <span key={scope}>
          {index > 0 ? (index === scopes.length - 1 ? " and " : ", ") : null}
          <Code>{scope}</Code>
        </span>
      ))}
    </>
  );
}

const connectSchema = z.object({
  accountId: z
    .string()
    .trim()
    .regex(/^biz_[a-zA-Z0-9_]{1,124}$/, "Enter the account id. It starts with biz_."),
  apiKey: z.string().trim().min(8, "Enter the Whop API key.").max(1024, "That key is too long."),
  environment: z.enum(["live", "sandbox"]),
});

/** Setup for either environment, with the account pinned on existing rows. */
export function WhopConnectForm({
  quiet,
  initialEnvironment = "live",
}: {
  quiet: boolean;
  initialEnvironment?: Environment;
}) {
  const connect = useAction(api.payments.connection.connect);
  const connections = useWhopConnectionRows();
  const id = useId();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm({
    resolver: standardSchemaResolver(connectSchema),
    defaultValues: {
      accountId: connections?.[initialEnvironment]?.accountId ?? "",
      apiKey: "",
      environment: initialEnvironment,
    },
  });
  const environment = useWatch({ control: form.control, name: "environment" });
  const accountId = connections?.[environment]?.accountId;

  async function submit(values: z.infer<typeof connectSchema>) {
    setSubmitError(null);
    try {
      await connect({
        accountId: values.accountId,
        apiKey: values.apiKey,
        environment: values.environment,
      });
      form.reset({ ...values, apiKey: "" });
      toast.success("Whop connected.");
    } catch (error) {
      setSubmitError(connectErrorSentence(error));
    }
  }

  const submitting = form.formState.isSubmitting;
  return (
    <form onSubmit={form.handleSubmit(submit)} noValidate>
      <FieldGroup className="gap-0">
        <Controller
          control={form.control}
          name="environment"
          render={({ field }) => (
            <Field className="gap-1.5 px-4 pt-3 pb-1.5">
              <span id={`${id}-environment`} className="text-[13px] font-medium">Environment</span>
              <RadioGroup
                value={field.value}
                disabled={submitting}
                aria-labelledby={`${id}-environment`}
                className="flex gap-4"
                onValueChange={(value) => {
                  if (value !== "live" && value !== "sandbox") return;
                  field.onChange(value);
                  form.resetField("accountId", { defaultValue: connections?.[value]?.accountId ?? "" });
                  form.resetField("apiKey");
                  setSubmitError(null);
                }}
              >
                <Field orientation="horizontal" className="items-center gap-2">
                  <RadioGroupItem id={`${id}-live`} value="live" />
                  <FieldLabel htmlFor={`${id}-live`}>Live</FieldLabel>
                </Field>
                <Field orientation="horizontal" className="items-center gap-2">
                  <RadioGroupItem id={`${id}-sandbox`} value="sandbox" />
                  <FieldLabel htmlFor={`${id}-sandbox`}>Sandbox</FieldLabel>
                </Field>
              </RadioGroup>
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="accountId"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5 px-4 pt-3 pb-1.5">
              <FieldLabel htmlFor={`${id}-account`} className="text-[13px] font-medium">
                Whop account id
              </FieldLabel>
              <Input
                {...field}
                id={`${id}-account`}
                placeholder="biz_…"
                autoComplete="off"
                spellCheck={false}
                translate="no"
                readOnly={accountId !== undefined}
                aria-invalid={fieldState.invalid || undefined}
                className="font-mono text-[13px]"
              />
              <FieldDescription className="text-[13px] leading-[1.45]">
                {accountId
                  ? `This environment is tied to ${accountId}. Payments already read stay with it.`
                  : "Your Whop company id. It starts with biz_ and shows in your Whop dashboard's address."}
              </FieldDescription>
              <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="apiKey"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid || undefined} className="gap-1.5 px-4 py-1.5">
              <FieldLabel htmlFor={`${id}-key`} className="text-[13px] font-medium">
                Whop API key
              </FieldLabel>
              <Input
                {...field}
                id={`${id}-key`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={fieldState.invalid || undefined}
              />
              <FieldDescription className="text-[13px] leading-[1.45]">
                A company API key with <ScopeList scopes={WHOP_REQUIRED_SCOPES} />. Mapping products and prices also
                needs <ScopeList scopes={WHOP_CATALOG_SCOPES} />. To read disputes, add{" "}
                <ScopeList scopes={WHOP_DISPUTE_SCOPES} />. Magnus keeps the key server-side and shows only its
                last four characters.
              </FieldDescription>
              <FieldError className="text-[13px] text-danger-ink" errors={[fieldState.error]} />
            </Field>
          )}
        />
      </FieldGroup>
      {submitError ? (
        <div className="px-4 pb-3">
          <NoteLine tone="danger" role="alert">
            {submitError}
          </NoteLine>
        </div>
      ) : null}
      <ActionRow>
        <Button
          type="submit"
          size="sm"
          variant={quiet ? "outline" : "default"}
          className={cn(!quiet && "font-semibold")}
          disabled={submitting}
        >
          {submitting ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{submitting ? "Checking with Whop…" : "Connect Whop"}</TranslatableText>
        </Button>
      </ActionRow>
    </form>
  );
}
