"use client";

import { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FACT_FIGURE, Fact, Facts, NoteLine } from "@/app/workspace/settings/_components/settings-ui";
import { LABEL } from "@/app/workspace/team/_components/team-ui";
import { PAYMENT_TYPE_LABELS } from "@/app/workspace/billing/_components/billing-format";
import { PROVIDER_REASON_SENTENCES } from "@/app/workspace/billing/_components/whop-format";
import { dayTimeFormat } from "@/components/whop/whop-settings-parts";
import { formatAmountMinor } from "@/lib/format-currency";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { AnswerForm, usePersonDeals, type GraderAnswer } from "./answer-form";
import type { KindDefinition } from "./automation-kinds";
import { SEGMENT, SEGMENT_GROUP } from "./automation-ui";
import type { ConfirmChange } from "./confirm-change-dialog";

const ConfirmChangeDialog = dynamic(() => import("./confirm-change-dialog"));

export type GradeSample = "writes" | "abstentions";
export type GradeCase = FunctionReturnType<typeof api.automation.grading.listToGrade>["cases"][number];
type Decision = FunctionReturnType<typeof api.automation.grading.reveal>;
type CommittedAnswer = NonNullable<FunctionReturnType<typeof api.automation.grading.getMyAnswer>>;
type UnsureCase = FunctionReturnType<typeof api.automation.grading.listUnsure>[number];
type Verdict = "correct" | "wrong" | "unsure";
type WrongField = UnsureCase["wrongFields"][number];

const WRONG_FIELD_LABELS: Record<WrongField, string> = {
  person: "Person",
  deal: "Deal",
  amount: "Amount",
  currency: "Currency",
  type: "Type",
  program: "Program",
  credit: "Credit",
  should_abstain: "Should have left it",
  should_write: "Should have written",
};

const WRONG_FIELDS: Record<GradeSample, readonly WrongField[]> = {
  writes: ["person", "deal", "amount", "currency", "type", "program", "credit", "should_abstain"],
  abstentions: ["should_write"],
};

const GATE_LABELS = {
  ...PROVIDER_REASON_SENTENCES,
  task_closer_conflict: "The task is assigned to a different closer.",
  stood_down: "The payment was left for a person.",
};

const EXPOSURE_WARNING = "This grade will not count as blind.";

export function GradingCase({
  definition,
  sample,
  gradeCase,
}: {
  definition: KindDefinition;
  sample: GradeSample;
  gradeCase: GradeCase;
}) {
  const { decisionId, evidence } = gradeCase;
  const commitAnswer = useMutation(api.automation.grading.commitAnswer);
  const reveal = useMutation(api.automation.grading.reveal);
  const [commitSucceeded, setCommitSucceeded] = useState(false);
  const [earlyDecision, setEarlyDecision] = useState<Decision>();
  const [committing, setCommitting] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmChange | null>(null);
  const committed = gradeCase.answerCommitted || commitSucceeded;
  const myAnswer = useQuery(api.automation.grading.getMyAnswer, committed ? { decisionId } : "skip");

  const commit = async (answer: GraderAnswer) => {
    setCommitting(true);
    try {
      await commitAnswer({ decisionId, answer });
      setCommitSucceeded(true);
    } catch (error) {
      toast.error(getErrorMessage(error, "Couldn't commit your answer."));
    } finally {
      setCommitting(false);
    }
  };

  const showFirst = () =>
    setConfirm({
      title: "Show the proposal first?",
      description: EXPOSURE_WARNING,
      note: "Seeing the proposal now is saved with this case.",
      confirmLabel: "Show the proposal",
      pendingLabel: "Opening…",
      danger: true,
      run: async () => {
        setEarlyDecision(await reveal({ decisionId }));
      },
    });

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        <p className="text-[13px] font-semibold">
          {committed ? "Step 2 of 2: compare and grade" : "Step 1 of 2: your answer, before seeing the system's"}
        </p>
        <p className="text-[13px] text-muted-foreground">
          Decided {dayTimeFormat.format(gradeCase.createdAt)}
        </p>
      </div>

      <Evidence evidence={evidence} />

      {committed ? (
        myAnswer ? (
          <CompareAndGrade
            decisionId={decisionId}
            kindName={definition.shortName}
            sample={sample}
            myAnswer={myAnswer}
            earlyDecision={earlyDecision}
          />
        ) : (
          <NoteLine role={myAnswer === null ? "alert" : "status"} className="px-4 py-3">
            {myAnswer === null ? "Couldn't load your committed answer." : "Loading your committed answer…"}
          </NoteLine>
        )
      ) : (
        <>
          {earlyDecision ? (
            <>
              <NoteLine tone="warning" className="px-4 pt-2.5">{EXPOSURE_WARNING}</NoteLine>
              <DecisionComparison decision={earlyDecision} />
            </>
          ) : null}
          <AnswerForm
            defaultCurrency={evidence?.currency ?? "USD"}
            payerEmail={evidence?.payerEmail}
            pending={committing}
            onCommit={(answer) => void commit(answer)}
          />
          {earlyDecision ? null : (
            <div className="border-t border-border px-4 py-2">
              <button
                type="button"
                onClick={showFirst}
                className="min-h-6 rounded-sm text-[13px] text-muted-foreground underline decoration-current/40 underline-offset-[3px] outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Show the proposal first
              </button>
              <span className="text-[13px] text-muted-foreground"> · {EXPOSURE_WARNING}</span>
            </div>
          )}
        </>
      )}
      {confirm ? <ConfirmChangeDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}

function Evidence({ evidence }: { evidence: GradeCase["evidence"] }) {
  if (!evidence) {
    return (
      <NoteLine tone="warning" className="border-b border-border px-4 py-3">
        This Whop payment is no longer available.
      </NoteLine>
    );
  }
  const product = [evidence.productTitle, evidence.variantTitle].filter(Boolean).join(" · ");
  return (
    <div className="border-b border-border">
      <p className={cn(LABEL, "px-4 pt-2.5")}>The Whop payment</p>
      <Facts className="border-b-0">
        <Fact label="Amount">
          {evidence.amountMinor === undefined ? (
            <span className="text-muted-foreground">Not in a two-decimal currency ({evidence.currency})</span>
          ) : (
            <span className={FACT_FIGURE}>{formatAmountMinor(evidence.amountMinor, evidence.currency)}</span>
          )}
        </Fact>
        <Fact label="Currency">{evidence.currency}</Fact>
        <Fact label="Paid">
          {evidence.paidAt === undefined ? (
            <span className="text-muted-foreground">No paid time</span>
          ) : (
            <span className={FACT_FIGURE}>{dayTimeFormat.format(evidence.paidAt)}</span>
          )}
        </Fact>
        <Fact label="Product">{product || <span className="text-muted-foreground">Not given</span>}</Fact>
        <Fact label="Payer email">
          {evidence.payerEmail ? (
            <span translate="no" className="break-words select-text">{evidence.payerEmail}</span>
          ) : (
            <span className="text-muted-foreground">No email</span>
          )}
        </Fact>
        <Fact label="Billing reason">{evidence.billingReason?.replaceAll("_", " ") || "Not given"}</Fact>
        <Fact label="Membership">{evidence.hasMembership ? "Yes" : "No"}</Fact>
        <Fact label="Environment">
          {evidence.environment === "sandbox" ? "Sandbox" : evidence.environment === "live" ? "Live" : "Unknown"}
        </Fact>
      </Facts>
    </div>
  );
}

function CompareAndGrade({
  decisionId,
  kindName,
  sample,
  myAnswer,
  earlyDecision,
}: {
  decisionId: GradeCase["decisionId"];
  kindName: string;
  sample: GradeSample;
  myAnswer: CommittedAnswer;
  earlyDecision?: Decision;
}) {
  const reveal = useMutation(api.automation.grading.reveal);
  const [revealedDecision, setRevealedDecision] = useState<Decision>();
  const [revealError, setRevealError] = useState<string | null>(null);
  const decision = earlyDecision ?? revealedDecision;

  useEffect(() => {
    if (earlyDecision) return;
    let active = true;
    reveal({ decisionId }).then(
      (result) => { if (active) setRevealedDecision(result); },
      (error: unknown) => { if (active) setRevealError(getErrorMessage(error, "Couldn't load the proposal.")); },
    );
    return () => { active = false; };
  }, [reveal, decisionId, earlyDecision]);

  if (!decision) {
    return revealError
      ? <NoteLine role="alert" tone="danger" className="px-4 py-3">{revealError}</NoteLine>
      : <NoteLine role="status" className="px-4 py-3">Loading the proposal…</NoteLine>;
  }

  return (
    <>
      {myAnswer.blind ? null : <NoteLine tone="warning" className="px-4 pt-2.5">{EXPOSURE_WARNING}</NoteLine>}
      <DecisionComparison decision={decision} answer={myAnswer.answer} answerLabel="You" />
      <VerdictForm decisionId={decisionId} sample={sample} kindName={kindName} />
    </>
  );
}

function usePersonAndDeal(leadId?: Id<"leads">, opportunityId?: Id<"opportunities">) {
  const person = useQuery(api.leads.queries.getLeadForPicker, leadId ? { leadId } : "skip");
  const deals = usePersonDeals(opportunityId ? leadId : undefined);
  return {
    personName: leadId ? (person === undefined ? "Loading…" : person?.fullName?.trim() || person?.email || leadId) : undefined,
    dealLabel: opportunityId
      ? deals === undefined ? "Loading…" : deals.find((deal) => deal.id === opportunityId)?.label ?? opportunityId
      : undefined,
  };
}

function DecisionComparison({
  decision,
  answer,
  answerLabel,
}: {
  decision: Decision;
  answer?: GraderAnswer | null;
  answerLabel?: string;
}) {
  const { proposal, wouldWrite } = decision;
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, { includeArchived: true });
  const members = useQuery(api.users.queries.listTeamMembers, {});
  const system = usePersonAndDeal(decision.leadId, decision.opportunityId);
  const grader = usePersonAndDeal(answer?.leadId, answer?.opportunityId);
  const compare = answerLabel !== undefined;
  const comparePayment = proposal !== undefined && answer?.abstain === false;

  const programName = (id?: Id<"tenantPrograms">) =>
    id ? programs === undefined ? "Loading…" : programs.find((program) => program._id === id)?.name ?? id : undefined;
  const memberName = (id?: Id<"users">) => {
    if (!id) return undefined;
    if (members === undefined) return "Loading…";
    const member = members.find((row) => row._id === id);
    return member?.fullName?.trim() || member?.email || id;
  };
  const amount = (minor?: number, currency?: string) =>
    minor === undefined || !currency ? undefined : <span className={FACT_FIGURE}>{formatAmountMinor(minor, currency)}</span>;

  const rows: Array<{ label: string; system: ReactNode; answer?: ReactNode; differs?: boolean }> = [
    {
      label: "Decision",
      system: wouldWrite ? "Record it" : "Leave it for a person",
      answer: answer ? (answer.abstain ? "Leave it for a person" : "Record it") : "Unavailable",
      differs: answer?.abstain === wouldWrite,
    },
  ];
  if (decision.leadId || decision.opportunityId || answer?.abstain === false) {
    rows.push(
      {
        label: "Person",
        system: system.personName,
        answer: grader.personName,
        differs: comparePayment && answer.leadId !== decision.leadId,
      },
      {
        label: "Deal",
        system: system.dealLabel,
        answer: grader.dealLabel,
        differs: comparePayment && answer.opportunityId !== decision.opportunityId,
      },
    );
  }
  if (proposal || answer?.abstain === false) {
    rows.push(
      {
        label: "Amount",
        system: amount(proposal?.amountMinor, proposal?.currency),
        answer: amount(answer?.amountMinor, answer?.currency),
        differs: comparePayment && answer.amountMinor !== proposal.amountMinor,
      },
      {
        label: "Currency",
        system: proposal?.currency,
        answer: answer?.currency,
        differs: comparePayment && answer.currency !== proposal.currency,
      },
      {
        label: "Type",
        system: proposal ? PAYMENT_TYPE_LABELS[proposal.paymentType] : undefined,
        answer: answer?.paymentType ? PAYMENT_TYPE_LABELS[answer.paymentType] : undefined,
        differs: comparePayment && answer.paymentType !== proposal.paymentType,
      },
      {
        label: "Program",
        system: programName(proposal?.programId),
        answer: programName(answer?.programId),
        differs: comparePayment && answer.programId !== proposal.programId,
      },
      {
        label: "Credit",
        system: memberName(proposal?.attributedCloserId),
        answer: memberName(answer?.attributedCloserId),
        differs: comparePayment && answer.attributedCloserId !== proposal.attributedCloserId,
      },
    );
  }
  if (proposal?.completesFollowUpId) {
    rows.push({ label: "Complete follow-up", system: proposal.completesFollowUpId });
  }
  if (proposal?.expiresFollowUpIds.length) {
    rows.push({ label: "Expire follow-ups", system: proposal.expiresFollowUpIds.join(", ") });
  }
  if (decision.gates.length) {
    rows.push({ label: "Reasons to wait", system: decision.gates.map((gate) => GATE_LABELS[gate]).join(" ") });
  }

  return (
    <div className="border-b border-border">
      <div className="overflow-x-auto">
        <table className={cn("mt-1 w-full text-left text-[13px] leading-[1.45]", compare && "min-w-[30rem]")}>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={cn(LABEL, "w-28 px-4 py-1.5 font-semibold")}><span className="sr-only">Field</span></th>
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

export function UnsureGradingCase({ entry }: { entry: UnsureCase }) {
  const resolveUnsure = useMutation(api.automation.grading.resolveUnsure);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"correct" | "wrong" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (verdict: "correct" | "wrong") => {
    setPending(verdict);
    setError(null);
    try {
      await resolveUnsure({ decisionId: entry.decisionId, verdict });
      toast.success("Second look saved.");
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the second look."));
    } finally {
      setPending(null);
    }
  };

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)} className="border-t border-border">
      <summary className="cursor-pointer px-4 py-2.5 text-[13px]">
        <span className="font-semibold">Decided {dayTimeFormat.format(entry.createdAt)}</span>
        <span className="text-muted-foreground">
          {" · "}Graded by {entry.gradedByName ?? "an unavailable team member"} on {dayTimeFormat.format(entry.gradedAt)}
        </span>
      </summary>
      {open ? (
        <>
          <Evidence evidence={entry.evidence} />
          <DecisionComparison decision={entry.proposal} answer={entry.answer} answerLabel="Grader" />
          {entry.wrongFields.length ? (
            <NoteLine className="px-4 pt-2.5">
              Marked wrong · {entry.wrongFields.map((field) => WRONG_FIELD_LABELS[field]).join(", ")}
            </NoteLine>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
            {error ? <NoteLine tone="danger" role="alert" className="mr-auto">{error}</NoteLine> : null}
            <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void resolve("correct")}>
              {pending === "correct" ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>Correct</TranslatableText>
            </Button>
            <Button type="button" variant="outline" disabled={pending !== null} onClick={() => void resolve("wrong")}>
              {pending === "wrong" ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>Wrong</TranslatableText>
            </Button>
          </div>
        </>
      ) : null}
    </details>
  );
}

function VerdictForm({
  decisionId,
  sample,
  kindName,
}: {
  decisionId: Id<"resultAutomationDecisions">;
  sample: GradeSample;
  kindName: string;
}) {
  const recordGrade = useMutation(api.automation.grading.recordGrade);
  const [verdict, setVerdict] = useState<Verdict | "">("");
  const [wrong, setWrong] = useState<WrongField[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields = WRONG_FIELDS[sample];
  const needsFields = verdict === "wrong" && wrong.length === 0;

  const save = async () => {
    if (!verdict || needsFields) return;
    setPending(true);
    setError(null);
    try {
      await recordGrade({ decisionId, verdict, wrongFields: verdict === "wrong" ? wrong : [] });
      toast.success(`Grade saved for ${kindName}.`);
    } catch (cause) {
      setError(getErrorMessage(cause, "Couldn't save the grade."));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-2.5 px-4 py-3">
        <p id={`verdict-${decisionId}`} className="text-[13px] font-semibold">Was the system right?</p>
        <ToggleGroup
          type="single"
          value={verdict}
          aria-labelledby={`verdict-${decisionId}`}
          className={SEGMENT_GROUP}
          onValueChange={(next) => setVerdict((next as Verdict) || "")}
        >
          <ToggleGroupItem value="correct" className={SEGMENT}>Correct</ToggleGroupItem>
          <ToggleGroupItem value="wrong" className={SEGMENT}>Wrong</ToggleGroupItem>
          <ToggleGroupItem value="unsure" className={SEGMENT}>Unsure</ToggleGroupItem>
        </ToggleGroup>
        {verdict === "wrong" ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-[13px] text-muted-foreground">What was wrong? Tick each one.</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {fields.map((field) => (
                <label key={field} className="flex min-h-6 items-center gap-2 text-sm">
                  <Checkbox
                    checked={wrong.includes(field)}
                    onCheckedChange={(checked) =>
                      setWrong((current) =>
                        checked === true ? [...current, field] : current.filter((value) => value !== field),
                      )
                    }
                  />
                  {WRONG_FIELD_LABELS[field]}
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {verdict === "unsure" ? (
          <NoteLine>An unsure grade waits for a second look by the owner. Until then it counts against the record.</NoteLine>
        ) : null}
        {error ? <NoteLine tone="danger" role="alert">{error}</NoteLine> : null}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t border-border bg-background px-4 py-3">
        {needsFields ? <p className="mr-auto text-[13px] text-muted-foreground">Tick what was wrong.</p> : null}
        <Button type="button" className="font-semibold" disabled={!verdict || needsFields || pending} onClick={() => void save()}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{pending ? "Saving…" : "Save grade"}</TranslatableText>
        </Button>
      </div>
    </div>
  );
}
