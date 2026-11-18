"use client";

import { useId, type ReactNode } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import { z } from "zod";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { FormRow } from "@/app/workspace/_components/action-dialog";
import { gateSentence } from "@/app/workspace/pipeline/call-insights/_components/proposal-words";
import { LABEL } from "@/app/workspace/team/_components/team-ui";
import { NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import type { GraderAnswer } from "./answer-form";
import { inputToMinor } from "./automation-kinds";
import { RecordLinks } from "./record-links";

type CallReference = NonNullable<
  FunctionReturnType<typeof api.automation.grading.listToGrade>["cases"][number]["call"]
>;
type Decision = FunctionReturnType<typeof api.automation.grading.reveal>;

/**
 * What the grader has before committing a call case: a link to the meeting,
 * which opens in a new tab with its recording. Nothing from the transcript
 * and nothing the system proposed is shown here.
 */
export function CallEvidence({ call }: { call: CallReference | undefined }) {
  if (!call) {
    return (
      <NoteLine tone="warning" className="border-b border-border px-4 py-3">
        This call is no longer available.
      </NoteLine>
    );
  }
  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-2.5">
      <p className={LABEL}>The recorded call</p>
      {call.meetingId ? (
        <p className="text-[13px]">
          <RecordLinks meetingId={call.meetingId} newTab />
          <span className="text-muted-foreground">
            {" "}· Listen to or read the whole call there, then answer here what should have happened.
          </span>
        </p>
      ) : (
        <NoteLine tone="warning">The recording is no longer tied to a meeting.</NoteLine>
      )}
    </div>
  );
}

type Outcome = "nothing" | "call_back" | "payment_owed" | "refused";

const OUTCOMES: ReadonlyArray<{ value: Outcome; label: string }> = [
  { value: "nothing", label: "Nothing: leave it for a person" },
  { value: "call_back", label: "Call back" },
  { value: "payment_owed", label: "Payment owed" },
  { value: "refused", label: "Refused: close as lost" },
];

const schema = z
  .object({
    outcome: z.enum(["nothing", "call_back", "payment_owed", "refused"]),
    happened: z.enum(["yes", "no", ""]),
    time: z.string(),
    method: z.enum(["call", "text", ""]),
    amount: z.string(),
    currency: z.string(),
  })
  .superRefine((values, ctx) => {
    const require = (ok: boolean, path: keyof typeof values, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", path: [path], message });
    };
    require(values.happened !== "", "happened", "Say whether the call happened.");
    if (values.outcome === "call_back" || values.outcome === "payment_owed") {
      require(values.time !== "" && Number.isFinite(new Date(values.time).getTime()), "time", "Enter the day and time.");
      require(values.method !== "", "method", "Pick call or text.");
    }
    if (values.outcome === "payment_owed") {
      const minor = inputToMinor(values.amount);
      require(minor !== undefined && minor > 0, "amount", "Enter the amount promised, such as 500.00.");
      require(/^[A-Za-z]{3}$/.test(values.currency.trim()), "currency", "Enter a three-letter currency code, such as USD.");
    }
  });

type FormValues = z.infer<typeof schema>;

/**
 * Step 1 of grading a call: what should have happened, from the call alone.
 * Nothing, a call-back, a promised payment, or a refusal, and whether the
 * call happened; a task adds its time and Call or Text, a payment its amount.
 */
export function CallAnswerForm({
  pending,
  onCommit,
}: {
  pending: boolean;
  onCommit: (answer: GraderAnswer) => void;
}) {
  const id = useId();
  const form = useForm<FormValues>({
    resolver: standardSchemaResolver(schema),
    defaultValues: { outcome: "nothing", happened: "", time: "", method: "", amount: "", currency: "USD" },
  });
  const outcome = useWatch({ control: form.control, name: "outcome" });
  const isTask = outcome === "call_back" || outcome === "payment_owed";

  const submit = form.handleSubmit((values) => {
    const attendanceHeld = values.happened === "yes";
    if (values.outcome === "nothing") {
      onCommit({ abstain: true, attendanceHeld });
      return;
    }
    if (values.outcome === "refused") {
      onCommit({ abstain: false, refusal: true, attendanceHeld });
      return;
    }
    onCommit({
      abstain: false,
      refusal: false,
      attendanceHeld,
      taskPurpose: values.outcome,
      reminderAt: new Date(values.time).getTime(),
      contactMethod: values.method === "text" ? "text" : "call",
      ...(values.outcome === "payment_owed"
        ? {
            expectedAmountMinor: inputToMinor(values.amount),
            expectedCurrency: values.currency.trim().toUpperCase(),
          }
        : {}),
    });
  });

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="@container">
      <FieldGroup className="gap-0 divide-y divide-border">
        <Controller
          control={form.control}
          name="outcome"
          render={({ field }) => (
            <FormRow label="What should happen">
              <RadioGroup
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                aria-label="What should happen"
                className="flex flex-col gap-2"
              >
                {OUTCOMES.map((option) => (
                  <label key={option.value} className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value={option.value} />
                    {option.label}
                  </label>
                ))}
              </RadioGroup>
            </FormRow>
          )}
        />
        <Controller
          control={form.control}
          name="happened"
          render={({ field, fieldState }) => (
            <FormRow label="Did the call happen?" invalid={fieldState.invalid} error={fieldState.error}>
              <RadioGroup
                value={field.value}
                onValueChange={(value) => field.onChange(value)}
                aria-label="Did the call happen?"
                aria-invalid={fieldState.invalid || undefined}
                className="flex flex-wrap gap-x-5 gap-y-2"
              >
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="yes" />
                  Yes
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <RadioGroupItem value="no" />
                  No
                </label>
              </RadioGroup>
            </FormRow>
          )}
        />
        {isTask ? (
          <>
            <Controller
              control={form.control}
              name="time"
              render={({ field, fieldState }) => (
                <FormRow
                  label={outcome === "payment_owed" ? "Promised for" : "Call back at"}
                  htmlFor={`${id}-time`}
                  invalid={fieldState.invalid}
                  error={fieldState.error}
                  description="In your browser's time zone."
                >
                  <Input
                    id={`${id}-time`}
                    type="datetime-local"
                    className="w-60 max-w-full tabular-nums"
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
              name="method"
              render={({ field, fieldState }) => (
                <FormRow label="Call or text" invalid={fieldState.invalid} error={fieldState.error}>
                  <RadioGroup
                    value={field.value}
                    onValueChange={(value) => field.onChange(value)}
                    aria-label="Call or text"
                    aria-invalid={fieldState.invalid || undefined}
                    className="flex flex-wrap gap-x-5 gap-y-2"
                  >
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="call" />
                      Call
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value="text" />
                      Text
                    </label>
                  </RadioGroup>
                </FormRow>
              )}
            />
          </>
        ) : null}
        {outcome === "payment_owed" ? (
          <>
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
          </>
        ) : null}
      </FieldGroup>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-background px-4 py-3">
        <p className="mr-auto min-w-0 text-[13px] text-muted-foreground">Once committed, your answer can&apos;t change.</p>
        <Button type="submit" disabled={pending} className="font-semibold">
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{pending ? "Committing…" : "Commit my answer"}</TranslatableText>
        </Button>
      </div>
    </form>
  );
}

function systemOutcome(decision: Decision): string {
  const proposal = decision.callProposal;
  if (!decision.wouldWrite || !proposal) return "Nothing: leave it for a person";
  if (proposal.type === "refusal") return "Refused: close as lost";
  return proposal.purpose === "payment_owed" ? "Payment owed" : "Call back";
}

function answerOutcome(answer: GraderAnswer): string {
  if (answer.abstain) return "Nothing: leave it for a person";
  if (answer.refusal) return "Refused: close as lost";
  return answer.taskPurpose === "payment_owed" ? "Payment owed" : answer.taskPurpose === "call_back" ? "Call back" : "Not given";
}

const methodWords = (method?: "call" | "text") => (method === "text" ? "Text" : method === "call" ? "Call" : undefined);

/**
 * Step 2 for a call case: the system's proposal beside the grader's answer,
 * field by field, with "Differs" in words where they part. No quote and no
 * transcript text: only the outcome, time, method, amount and attendance.
 */
export function CallComparison({
  decision,
  answer,
  answerLabel,
}: {
  decision: Decision;
  answer?: GraderAnswer | null;
  answerLabel?: string;
}) {
  const proposal = decision.callProposal;
  const task = proposal?.type === "task" ? proposal : undefined;
  const compare = answerLabel !== undefined;
  const amount = (minor?: number, currency?: string) =>
    minor === undefined || !currency ? undefined : (
      <span className="font-condensed text-[15px] font-semibold tabular-nums">{formatAmountMinor(minor, currency)}</span>
    );
  const time = (at?: number) => (at === undefined ? undefined : <span className="tabular-nums">{dayTimeFormat.format(at)}</span>);
  const answerTask = answer && !answer.abstain && !answer.refusal;

  const rows: Array<{ label: string; system: ReactNode; answer?: ReactNode; differs?: boolean }> = [
    {
      label: "What should happen",
      system: systemOutcome(decision),
      answer: answer ? answerOutcome(answer) : "Unavailable",
      differs: answer ? systemOutcome(decision) !== answerOutcome(answer) : false,
    },
  ];
  if (task || answerTask) {
    rows.push(
      {
        label: "Time",
        system: time(task?.reminderScheduledAt),
        answer: time(answer?.reminderAt),
        differs: Boolean(task && answerTask) &&
          Math.abs((task?.reminderScheduledAt ?? 0) - (answer?.reminderAt ?? 0)) >= 60_000,
      },
      {
        label: "Call or text",
        system: methodWords(task?.contactMethod),
        answer: methodWords(answer?.contactMethod),
        differs: Boolean(task && answerTask) && task?.contactMethod !== answer?.contactMethod,
      },
    );
  }
  if (task?.purpose === "payment_owed" || answer?.taskPurpose === "payment_owed") {
    rows.push({
      label: "Amount",
      system: amount(task?.expectedAmountMinor, task?.expectedCurrency),
      answer: amount(answer?.expectedAmountMinor, answer?.expectedCurrency),
      differs: Boolean(task && answerTask) &&
        (task?.expectedAmountMinor !== answer?.expectedAmountMinor || task?.expectedCurrency !== answer?.expectedCurrency),
    });
    if (task?.promisedPaymentAt !== undefined) rows.push({ label: "Promised for", system: time(task.promisedPaymentAt) });
  }
  rows.push({
    label: "Call happened",
    system: decision.wouldWrite && proposal ? "Yes, marked held" : "Not decided",
    answer: answer?.attendanceHeld === undefined ? undefined : answer.attendanceHeld ? "Yes" : "No",
    differs: Boolean(decision.wouldWrite && proposal) && answer?.attendanceHeld === false,
  });
  if (decision.gates.length) {
    rows.push({ label: "Reasons to wait", system: decision.gates.map((gate) => gateSentence(gate)).join(" ") });
  }

  return (
    <div className="border-b border-border">
      <div className="overflow-x-auto">
        <table className={cn("mt-1 w-full text-left text-[13px] leading-[1.45]", compare && "min-w-[30rem]")}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={cn(LABEL, "w-32 px-4 py-1.5 font-semibold")}><span className="sr-only">Field</span></th>
              <th scope="col" className={cn(LABEL, "px-3 py-1.5 font-semibold")}>The system</th>
              {compare ? (
                <>
                  <th scope="col" className={cn(LABEL, "px-3 py-1.5 font-semibold")}>{answerLabel}</th>
                  <th scope="col" className={cn(LABEL, "w-20 px-4 py-1.5 font-semibold")}><span className="sr-only">Match</span></th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border last:border-b-0">
                <th scope="row" className="px-4 py-1.5 align-top font-normal text-muted-foreground">{row.label}</th>
                <td className="px-3 py-1.5 align-top wrap-anywhere">{row.system ?? <span className="text-muted-foreground">None</span>}</td>
                {compare ? (
                  <>
                    <td className="px-3 py-1.5 align-top wrap-anywhere">{row.answer ?? <span className="text-muted-foreground">None</span>}</td>
                    <td className="px-4 py-1.5 align-top">
                      {row.differs ? (
                        <span className="font-condensed text-[12px] font-bold tracking-[0.08em] text-warning-ink uppercase">Differs</span>
                      ) : null}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

