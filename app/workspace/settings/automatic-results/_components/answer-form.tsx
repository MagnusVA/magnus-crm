"use client";

import { useId } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import { useQuery } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PAYMENT_TYPES, type PaymentType } from "@/convex/lib/paymentTypes";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { FormRow } from "@/app/workspace/_components/action-dialog";
import { PAYMENT_TYPE_LABELS } from "@/app/workspace/billing/_components/billing-format";
import { dealStageLabel } from "@/app/workspace/billing/_components/whop-format";
import { LeadCombobox } from "@/app/workspace/opportunities/new/_components/lead-combobox";
import { formatDay } from "@/components/whop/whop-settings-parts";
import { inputToMinor } from "./automation-kinds";

/** The grader's own answer, in the shape `commitAnswer` takes. */
export type GraderAnswer = FunctionArgs<typeof api.automation.grading.commitAnswer>["answer"];

const schema = z
  .object({
    choice: z.enum(["write", "abstain"]),
    leadId: z.string(),
    opportunityId: z.string(),
    amount: z.string(),
    currency: z.string(),
    paymentType: z.string(),
    programId: z.string(),
    attributedCloserId: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.choice === "abstain") return;
    const require = (ok: boolean, path: keyof typeof values, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    require(values.leadId !== "", "leadId", "Pick the person.");
    require(values.opportunityId !== "", "opportunityId", "Pick the deal.");
    require(inputToMinor(values.amount) !== undefined, "amount", "Enter the amount, such as 1500.00.");
    require(/^[A-Za-z]{3}$/.test(values.currency.trim()), "currency", "Enter a three-letter currency code, such as USD.");
    require((PAYMENT_TYPES as readonly string[]).includes(values.paymentType), "paymentType", "Pick the type.");
    require(values.programId !== "", "programId", "Pick the program.");
    require(values.attributedCloserId !== "", "attributedCloserId", "Pick who gets the credit.");
  });

type FormValues = z.infer<typeof schema>;

/**
 * Step 1 of grading: the grader's own answer, before seeing the system's.
 * Either "Leave it for a person", or the person, deal, amount, currency,
 * type, program and credit the grader would have recorded.
 */
export function AnswerForm({
  defaultCurrency,
  payerEmail,
  pending,
  onCommit,
}: {
  /** The Whop payment's currency, a fact of the evidence. */
  defaultCurrency: string;
  payerEmail?: string;
  pending: boolean;
  onCommit: (answer: GraderAnswer) => void;
}) {
  const id = useId();
  const form = useForm<FormValues>({
    resolver: standardSchemaResolver(schema),
    defaultValues: {
      choice: "write",
      leadId: "",
      opportunityId: "",
      amount: "",
      currency: defaultCurrency,
      paymentType: "",
      programId: "",
      attributedCloserId: "",
    },
  });
  const choice = useWatch({ control: form.control, name: "choice" });
  const leadId = useWatch({ control: form.control, name: "leadId" });

  const submit = form.handleSubmit((values) => {
    if (values.choice === "abstain") {
      onCommit({ abstain: true });
      return;
    }
    onCommit({
      abstain: false,
      leadId: values.leadId as Id<"leads">,
      opportunityId: values.opportunityId as Id<"opportunities">,
      amountMinor: inputToMinor(values.amount),
      currency: values.currency.trim().toUpperCase(),
      paymentType: values.paymentType as PaymentType,
      programId: values.programId as Id<"tenantPrograms">,
      attributedCloserId: values.attributedCloserId as Id<"users">,
    });
  });

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="@container">
      <FieldGroup className="gap-0 divide-y divide-border">
        <Controller
          control={form.control}
          name="choice"
          render={({ field }) => (
            <FormRow label="Your answer">
              <RadioGroup
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                aria-label="Your answer"
                className="flex flex-col gap-2"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="write" />
                  Record it as below
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="abstain" />
                  Leave it for a person
                </label>
              </RadioGroup>
            </FormRow>
          )}
        />
        {choice === "write" ? (
          <>
            <Controller
              control={form.control}
              name="leadId"
              render={({ field, fieldState }) => (
                <FormRow
                  label="Person"
                  htmlFor={`${id}-person`}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  description={payerEmail ? "Use the payer email above to search for the person." : undefined}
                >
                  <LeadCombobox
                    id={`${id}-person`}
                    value={field.value ? (field.value as Id<"leads">) : undefined}
                    onChange={(value) => {
                      field.onChange(value ?? "");
                      form.setValue("opportunityId", "");
                    }}
                    invalid={fieldState.invalid}
                    emptyText="Nobody matches. Try an email, a phone number or another spelling."
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="opportunityId"
              render={({ field, fieldState }) => (
                <FormRow label="Deal" htmlFor={`${id}-deal`} invalid={fieldState.invalid} error={fieldState.error}>
                  <DealSelect
                    id={`${id}-deal`}
                    leadId={leadId ? (leadId as Id<"leads">) : undefined}
                    value={field.value}
                    onChange={field.onChange}
                    invalid={fieldState.invalid}
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="amount"
              render={({ field, fieldState }) => (
                <FormRow label="Amount" htmlFor={`${id}-amount`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    id={`${id}-amount`}
                    inputMode="decimal"
                    autoComplete="off"
                    className="w-40 font-condensed text-[15px] tabular-nums"
                    aria-invalid={fieldState.invalid || undefined}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="currency"
              render={({ field, fieldState }) => (
                <FormRow label="Currency" htmlFor={`${id}-currency`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Input
                    id={`${id}-currency`}
                    autoComplete="off"
                    maxLength={3}
                    className="w-24 uppercase"
                    aria-invalid={fieldState.invalid || undefined}
                    value={field.value}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="paymentType"
              render={({ field, fieldState }) => (
                <FormRow label="Type" htmlFor={`${id}-type`} invalid={fieldState.invalid} error={fieldState.error}>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id={`${id}-type`} className="w-48 max-w-full" aria-invalid={fieldState.invalid || undefined}>
                      <SelectValue placeholder="Choose a type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {PAYMENT_TYPES.map((type) => (
                          <SelectItem key={type} value={type}>
                            {PAYMENT_TYPE_LABELS[type]}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="programId"
              render={({ field, fieldState }) => (
                <FormRow label="Program" htmlFor={`${id}-program`} invalid={fieldState.invalid} error={fieldState.error}>
                  <ProgramSelect
                    id={`${id}-program`}
                    value={field.value}
                    onChange={field.onChange}
                    invalid={fieldState.invalid}
                  />
                </FormRow>
              )}
            />
            <Controller
              control={form.control}
              name="attributedCloserId"
              render={({ field, fieldState }) => (
                <FormRow label="Credit" htmlFor={`${id}-credit`} invalid={fieldState.invalid} error={fieldState.error}>
                  <MemberSelect
                    id={`${id}-credit`}
                    value={field.value}
                    onChange={field.onChange}
                    invalid={fieldState.invalid}
                  />
                </FormRow>
              )}
            />
          </>
        ) : null}
      </FieldGroup>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-background px-4 py-3">
        <p className="mr-auto min-w-0 text-[13px] text-muted-foreground">
          Once committed, your answer can&apos;t change.
        </p>
        <Button type="submit" disabled={pending} className="font-semibold">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{pending ? "Committing…" : "Commit my answer"}</TranslatableText>
        </Button>
      </div>
    </form>
  );
}

/** The person's deals, newest first, as "Program · Stage · Nov 3". */
export function DealSelect({
  id,
  leadId,
  value,
  onChange,
  invalid,
}: {
  id: string;
  leadId: Id<"leads"> | undefined;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const deals = usePersonDeals(leadId);
  return (
    <Select value={value} onValueChange={onChange} disabled={!leadId || deals === undefined}>
      <SelectTrigger id={id} className="w-80 max-w-full" aria-invalid={invalid || undefined}>
        <SelectValue
          placeholder={!leadId ? "Pick the person first" : deals === undefined ? "Loading deals…" : deals.length ? "Choose a deal" : "This person has no deals"}
        />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {(deals ?? []).map((deal) => (
            <SelectItem key={deal.id} value={deal.id}>
              {deal.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** A person's deals with a one-line label each; undefined while loading. */
export function usePersonDeals(leadId: Id<"leads"> | undefined) {
  const detail = useQuery(api.leadCustomers.detail.getEntityDetail, leadId ? { leadId } : "skip");
  if (!leadId) return [];
  if (detail === undefined) return undefined;
  if (detail?.kind !== "detail") return [];
  return detail.opportunities.map(({ opportunity }) => ({
    id: opportunity._id,
    label: [
      opportunity.soldProgramName ?? opportunity.firstBookingProgramName ?? "No program",
      dealStageLabel(opportunity.stage, opportunity.outcome),
      formatDay(opportunity.createdAt),
    ].join(" · "),
  }));
}

function ProgramSelect({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, {});
  return (
    <Select value={value} onValueChange={onChange} disabled={programs === undefined}>
      <SelectTrigger id={id} className="w-64 max-w-full" aria-invalid={invalid || undefined}>
        <SelectValue placeholder={programs === undefined ? "Loading programs…" : "Choose a program"} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {(programs ?? []).map((program) => (
            <SelectItem key={program._id} value={program._id}>
              {program.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function MemberSelect({
  id,
  value,
  onChange,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  const members = useQuery(api.users.queries.listTeamMembers, {});
  const active = (members ?? []).filter((member) => member.isActive !== false && !member.isPendingInvite);
  return (
    <Select value={value} onValueChange={onChange} disabled={members === undefined}>
      <SelectTrigger id={id} className="w-64 max-w-full" aria-invalid={invalid || undefined}>
        <SelectValue placeholder={members === undefined ? "Loading the team…" : "Choose who gets the credit"} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {active.map((member) => (
            <SelectItem key={member._id} value={member._id}>
              {member.fullName?.trim() || member.email}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
