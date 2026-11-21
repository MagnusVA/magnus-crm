"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { LinkIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { DealOutcome, DealStage } from "@/convex/opportunities/stages";
import { PAYMENT_TYPES, type PaymentType } from "@/convex/lib/paymentTypes";
import { useRole } from "@/components/auth/role-context";
import { TranslatableText } from "@/components/translatable-text";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatAmountMinor } from "@/lib/format-currency";
import { getErrorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { DetailCard, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { LeadCombobox } from "@/app/workspace/opportunities/new/_components/lead-combobox";
import { ChoiceGroup } from "./billing-choice-group";
import { FIGURE, formatPaidAt, formatPaidClock, formatPaidDate, PAYMENT_TYPE_LABELS, plural } from "./billing-format";
import { useMemberNames } from "./billing-member-names";
import { paymentCommandSentence } from "./payment-command-words";
import { AUTOMATIC_RESULTS_HREF, dealStageLabel, UNKNOWN_PAYER_NOTE } from "./whop-format";

// "Record it as a payment" on a waiting Whop payment (build contract §2.5):
// pick the deal, read what recording it changes, then Record payment. The
// button sends the fingerprint of the preview on screen.

type Detail = NonNullable<FunctionReturnType<typeof api.payments.review.getProviderPayment>>;
type ConfirmPreview = FunctionReturnType<typeof api.payments.confirm.previewWhopConfirm>;

type DealOption = {
  opportunityId: Id<"opportunities">;
  stage: DealStage;
  outcome: DealOutcome;
  programName: string | null;
  latestMeetingAt: number | null;
  createdAt: number;
};

const CHANGED = "Something changed. Check the new preview.";
const meetingWeekday = new Intl.DateTimeFormat("en-US", { weekday: "short" });
const meetingTimeList = new Intl.ListFormat("en-US");

function dealLabel(deal: DealOption) {
  return `${dealStageLabel(deal.stage, deal.outcome)}${deal.programName ? ` · ${deal.programName}` : ""}`;
}

/** The quiet line shown in place of the section when recording from Whop is off. */
export function RecordingOffLine() {
  const { hasPermission } = useRole();
  if (!hasPermission("result-automation:view")) return null;
  return (
    <p className="px-1 text-[13px] text-muted-foreground">
      Recording from Whop is switched off. Turn it on in{" "}
      <Link href={AUTOMATIC_RESULTS_HREF} className={cn(detailLinkClass, "inline font-normal")}>
        Settings › Automatic results
      </Link>
      .
    </p>
  );
}

/**
 * The section, for an owner or admin with `billing:review`, while the Whop
 * payment waits and nothing counts for it. After a save it keeps a line
 * pointing to the recorded payment.
 */
export function WhopRecordPaymentCard({ detail, now }: { detail: Detail; now: number }) {
  const { hasPermission } = useRole();
  const { payment, candidatePerson, candidateDeals } = detail;
  const [recorded, setRecorded] = useState<{ paymentRecordId: Id<"paymentRecords">; alreadyApplied: boolean } | null>(null);
  const [choosingOther, setChoosingOther] = useState(false);
  const [pickedLeadId, setPickedLeadId] = useState<Id<"leads"> | undefined>(undefined);
  const [selected, setSelected] = useState<DealOption | null>(null);

  const waiting = payment.reviewState === "needs_person" && payment.status === "paid" && !payment.paymentRecordId;
  const canReview = hasPermission("billing:review");
  // With no deal chosen yet, the first candidate's preview says whether
  // recording from Whop is on for this kind of deal.
  const probeDeal = candidateDeals[0];
  const sameKind = probeDeal !== undefined &&
    candidateDeals.every((deal) => (deal.outcome === "won") === (probeDeal.outcome === "won"));
  const probe = useQuery(
    api.payments.confirm.previewWhopConfirm,
    waiting && canReview && probeDeal && sameKind && !choosingOther
      ? { providerPaymentId: payment._id, opportunityId: probeDeal.opportunityId }
      : "skip",
  );

  if (recorded) {
    return (
      <DetailCard title="Record it as a payment">
        <div role="status" className="flex flex-col gap-2 px-4 py-3">
          <p className="text-[15px] font-medium">
            {recorded.alreadyApplied
              ? "This Whop payment was already recorded as a CRM payment."
              : "Recorded as a CRM payment. It counts in cash from today."}
          </p>
          <Link href={`/workspace/billing/${recorded.paymentRecordId}`} className={cn(detailLinkClass, "w-fit gap-1")}>
            <LinkIcon aria-hidden="true" className="size-3.5" />
            Open the CRM payment
          </Link>
        </div>
      </DetailCard>
    );
  }
  if (!waiting || !canReview) return null;
  if (probe && !probe.preview.ok && probe.preview.code === "kind_off") return <RecordingOffLine />;

  const picking = candidatePerson === null || choosingOther;

  return (
    <DetailCard title="Record it as a payment">
      <div className="flex flex-col gap-3 px-4 py-3">
        <p className="text-[13px] text-muted-foreground">
          Records a CRM payment from this Whop payment, on the deal you pick. It counts in cash from the day it is recorded,
          and Whop is its proof.
        </p>
        {picking ? (
          <Field>
            <FieldLabel htmlFor={`whop-record-person-${payment._id}`}>Person</FieldLabel>
            <LeadCombobox
              id={`whop-record-person-${payment._id}`}
              value={pickedLeadId}
              onChange={(leadId) => {
                setPickedLeadId(leadId);
                setSelected(null);
              }}
              emptyText="Nobody matches. Try an email, a phone number or another spelling."
            />
            <FieldDescription className="text-[13px]">{UNKNOWN_PAYER_NOTE}</FieldDescription>
            {candidatePerson ? (
              <button
                type="button"
                className={cn(detailLinkClass, "w-fit text-[13px] font-normal")}
                onClick={() => {
                  setChoosingOther(false);
                  setPickedLeadId(undefined);
                  setSelected(null);
                }}
              >
                Back to {candidatePerson.displayName}
              </button>
            ) : null}
          </Field>
        ) : (
          <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted-foreground">
            <span>
              Deals for{" "}
              <span className="font-medium text-foreground" translate="no">
                {candidatePerson.displayName}
              </span>
            </span>
            <button
              type="button"
              className={cn(detailLinkClass, "font-normal")}
              onClick={() => {
                setChoosingOther(true);
                setSelected(null);
              }}
            >
              Pick someone else
            </button>
          </p>
        )}
        {picking ? (
          pickedLeadId ? (
            <SectionErrorBoundary
              key={pickedLeadId}
              sectionName="this person's deals"
              fallback={<p role="alert" className="text-[13px] text-danger-ink">Billing can&apos;t load this person&apos;s deals.</p>}
            >
              <PickedPersonDeals leadId={pickedLeadId} value={selected?.opportunityId ?? ""} onChange={setSelected} now={now} />
            </SectionErrorBoundary>
          ) : (
            <p className="text-[13px] text-muted-foreground">Pick the person to see their deals.</p>
          )
        ) : (
          <DealPicker deals={candidateDeals} value={selected?.opportunityId ?? ""} onChange={setSelected} now={now} />
        )}
      </div>
      {selected ? (
        <SectionErrorBoundary
          key={selected.opportunityId}
          sectionName="the preview"
          fallback={<p role="alert" className="border-t px-4 py-3 text-[13px] text-danger-ink">Billing can&apos;t work out what recording this would change.</p>}
        >
          <ConfirmPreviewBody
            detail={detail}
            opportunityId={selected.opportunityId}
            deal={selected}
            now={now}
            onRecorded={setRecorded}
          />
        </SectionErrorBoundary>
      ) : null}
    </DetailCard>
  );
}

function DealPicker({
  deals,
  value,
  onChange,
  now,
}: {
  deals: ReadonlyArray<DealOption>;
  value: Id<"opportunities"> | "";
  onChange: (deal: DealOption) => void;
  now: number;
}) {
  if (deals.length === 0) {
    return <p className="text-[13px] text-muted-foreground">This person has no deal this payment could be for.</p>;
  }
  return (
    <ChoiceGroup
      legend="Which deal is this payment for?"
      value={value}
      onChange={(opportunityId) => {
        const deal = deals.find((candidate) => candidate.opportunityId === opportunityId);
        if (deal) onChange(deal);
      }}
      options={deals.map((deal) => ({
        value: deal.opportunityId,
        label: dealLabel(deal),
        description:
          deal.latestMeetingAt !== null
            ? `Call ${formatPaidAt(deal.latestMeetingAt, now)}`
            : `Created ${formatPaidAt(deal.createdAt, now)}`,
      }))}
    />
  );
}

function PickedPersonDeals({
  leadId,
  value,
  onChange,
  now,
}: {
  leadId: Id<"leads">;
  value: Id<"opportunities"> | "";
  onChange: (deal: DealOption) => void;
  now: number;
}) {
  const lead = useQuery(api.leads.queries.getLeadDetail, { leadId });
  if (lead === undefined) {
    return <p role="status" className="text-[13px] text-muted-foreground">Loading this person&apos;s deals…</p>;
  }
  const deals: DealOption[] = lead.opportunities.map((deal) => ({
    opportunityId: deal._id,
    stage: deal.stage,
    outcome: deal.outcome,
    programName: deal.soldProgramName ?? deal.firstBookingProgramName ?? null,
    latestMeetingAt: deal.latestMeetingAt ?? null,
    createdAt: deal.createdAt,
  }));
  return <DealPicker deals={deals} value={value} onChange={onChange} now={now} />;
}

function Effects({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[13px] font-medium text-muted-foreground">What recording it changes</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] marker:text-muted-foreground">{children}</ul>
    </div>
  );
}

/** The key the preview on screen is pinned to: its fingerprint, or its refusal. */
function previewKey(data: ConfirmPreview) {
  return data.preview.ok ? `ok:${data.preview.fingerprint}:${data.preview.allocationRevision}` : `refused:${data.preview.code}`;
}

function ConfirmPreviewBody({
  detail,
  opportunityId,
  deal,
  now,
  onRecorded,
}: {
  detail: Detail;
  opportunityId: Id<"opportunities">;
  deal: DealOption;
  now: number;
  onRecorded: (result: { paymentRecordId: Id<"paymentRecords">; alreadyApplied: boolean }) => void;
}) {
  const { payment } = detail;
  const live = useQuery(api.payments.confirm.previewWhopConfirm, { providerPaymentId: payment._id, opportunityId });
  const confirm = useMutation(api.payments.confirm.confirmWhopPayment);
  const names = useMemberNames();
  const [shown, setShown] = useState<ConfirmPreview | null>(null);
  const [changed, setChanged] = useState(false);
  const [programId, setProgramId] = useState<Id<"tenantPrograms"> | "">("");
  const [paymentType, setPaymentType] = useState<PaymentType | "">("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (live && (shown === null || previewKey(live) !== previewKey(shown))) {
    if (shown?.preview.ok) {
      setChanged(true);
      setError(null);
    }
    setShown(live);
  }

  const proposal = shown?.preview.ok ? shown.preview.proposal : null;
  const needsProgram = proposal !== null && proposal.programId === undefined;
  const needsType = proposal !== null && proposal.paymentType === undefined;
  const programs = useQuery(api.tenantPrograms.queries.listPrograms, needsProgram ? { includeArchived: false } : "skip");

  if (!shown) {
    return (
      <p role="status" className="border-t px-4 py-3 text-[13px] text-muted-foreground">
        Working out what recording it changes…
      </p>
    );
  }

  const { preview, waiting } = shown;
  if (!preview.ok) {
    if (preview.code === "kind_off") {
      return (
        <div className="border-t py-3">
          <RecordingOffLine />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2 border-t px-4 py-3">
        {changed ? <ChangedNotice /> : null}
        <p role="alert" className="text-[14px]">
          {paymentCommandSentence(preview.code)}
        </p>
      </div>
    );
  }

  const closerName = (id: Id<"users"> | undefined) => (id && names?.get(id)) || null;
  const creditName = closerName(preview.proposal.attributedCloserId) ?? "the deal's closer";
  const waitingOnCloser =
    waiting?.waitsOn === "closer" && waiting.billingAvailableAt !== undefined && waiting.billingAvailableAt > now;
  const label = dealLabel(deal);
  const owed = shown.attendanceOwedMeetings.length;
  const meetingTimes = shown.attendanceOwedMeetings.slice(0, 3).map(({ scheduledAt }) =>
    `${meetingWeekday.format(scheduledAt)} ${formatPaidClock(scheduledAt)}`);
  if (owed > 3) meetingTimes.push(`${owed - 3} more`);
  const ready = !waitingOnCloser && (!needsProgram || programId !== "") && (!needsType || paymentType !== "");

  async function submit() {
    if (!preview.ok || !ready) return;
    setPending(true);
    setError(null);
    setChanged(false);
    try {
      const result = await confirm({
        providerPaymentId: payment._id,
        opportunityId,
        ...(shown?.decisionId ? { decisionId: shown.decisionId } : {}),
        ...(needsProgram && programId ? { programId } : {}),
        ...(needsType && paymentType ? { paymentType } : {}),
        expectedFingerprint: preview.fingerprint,
        expectedAllocationRevision: preview.allocationRevision,
      });
      if (result.ok) {
        toast.success(result.alreadyApplied ? "This Whop payment was already recorded." : "Payment recorded.");
        onRecorded({ paymentRecordId: result.paymentRecordId, alreadyApplied: result.alreadyApplied });
      } else if (result.code === "stale_preview") {
        setChanged(true);
      } else if (result.code === "not_owner") {
        setError(`${closerName(waiting?.closerId) ?? "The closer"} can still confirm this. Billing can confirm it after a business day.`);
      } else {
        setError(paymentCommandSentence(result.code));
      }
    } catch (caught) {
      setError(getErrorMessage(caught, "Couldn't record the payment. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t px-4 py-3">
      {changed ? <ChangedNotice /> : null}
      <Effects>
        <li>
          Adds <span className={FIGURE}>{formatAmountMinor(preview.proposal.amountMinor, preview.proposal.currency)}</span> to cash on{" "}
          {formatPaidDate(now, now)}.
        </li>
        {preview.kind === "additional_payment" ? (
          <li>Adds a payment to a won deal. Its first-payment date stays the same.</li>
        ) : preview.position === "system_loss" ? (
          <li>
            Reopens <span translate="no">{label}</span>, which the system closed, and closes it as won.
          </li>
        ) : (
          <li>
            Closes <span translate="no">{label}</span> as won.
          </li>
        )}
        <li>
          Credits <span translate="no">{creditName}</span>.
        </li>
        {preview.proposal.expiresFollowUpIds.length > 0 ? (
          <li>Expires {plural(preview.proposal.expiresFollowUpIds.length, "open task")} on the deal.</li>
        ) : null}
        {owed > 0 ? (
          <li>
            {owed === 1 ? "The call" : "The calls"} on {meetingTimeList.format(meetingTimes)} will need{" "}
            {owed === 1 ? "its" : "their"} attendance from <span translate="no">{creditName}</span>.
          </li>
        ) : null}
      </Effects>

      {needsProgram || needsType ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-muted-foreground">
            This Whop product or price has no mapping yet. Choose them for this payment.
          </p>
          {needsProgram ? (
            <Field>
              <FieldLabel htmlFor={`whop-record-program-${payment._id}`}>Program</FieldLabel>
              <Select value={programId} onValueChange={(value) => setProgramId(value as Id<"tenantPrograms">)} disabled={pending}>
                <SelectTrigger id={`whop-record-program-${payment._id}`} className="w-full sm:w-72" aria-required>
                  <SelectValue placeholder={programs === undefined ? "Loading programs…" : "Choose a program"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {(programs ?? []).map((program) => (
                      <SelectItem key={program._id} value={program._id}>
                        <span translate="no">{program.name}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          {needsType ? (
            <Field>
              <FieldLabel htmlFor={`whop-record-type-${payment._id}`}>Payment type</FieldLabel>
              <Select value={paymentType} onValueChange={(value) => setPaymentType(value as PaymentType)} disabled={pending}>
                <SelectTrigger id={`whop-record-type-${payment._id}`} className="w-full sm:w-72" aria-required>
                  <SelectValue placeholder="Choose a payment type" />
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
            </Field>
          ) : null}
        </div>
      ) : null}

      <Button type="button" className="w-fit font-semibold" disabled={!ready || pending} onClick={() => void submit()}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        <TranslatableText>Record payment</TranslatableText>
      </Button>
      {waitingOnCloser && waiting?.billingAvailableAt !== undefined ? (
        <p className="text-[13px] text-muted-foreground">
          <span translate="no">{closerName(waiting.closerId) ?? "The closer"}</span> can confirm this from their meeting page.
          Billing can confirm it after {formatPaidAt(waiting.billingAvailableAt, now)}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-danger-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChangedNotice() {
  return (
    <p role="status" className="rounded-[7px] border border-warning/60 bg-warning-surface px-3 py-2 text-[13px] font-medium">
      {CHANGED}
    </p>
  );
}
