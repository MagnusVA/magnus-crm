"use client";

import { useId, useState } from "react";
import { useMutation } from "convex/react";
import { format, isSameDay } from "date-fns";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import { useHydrated } from "@/hooks/use-hydrated";
import { useNow } from "@/hooks/use-now";
import { formatCurrency } from "@/lib/format-currency";
import { reportClientError } from "@/lib/observability/report-client-error";
import { NO_SHOW_REASONS, type NoShowReason } from "@/lib/callInsights/taxonomy";
import { PAYMENT_TYPE_LABELS, type PaymentTypeValue } from "@/app/workspace/_components/payment-dialog-form";
import {
  paymentCommandSentence,
  paymentErrorSentence,
} from "@/app/workspace/_components/payments/payment-command-words";
import { StageChip } from "./stage-tone";
import { firstNameOf, type MeetingDetail, type MeetingDetailMode } from "./meeting-detail-types";

// A deal a Whop payment won while its call's attendance is unrecorded: the
// meeting page asks "Did Bo attend this call?" and Today's Needs outcome row
// asks the same. Recording attendance changes only the call
// (`closer.attendanceOnly.recordAttendanceOnly`).

/** The no-show reasons, worded as the no-show dialog words them. */
export const NO_SHOW_REASON_LABELS: Record<NoShowReason, string> = {
  no_response: "Lead didn't show up (no communication)",
  late_cancel: "Lead messaged: can't make it",
  technical_issues: "Technical issues prevented meeting",
  other: "Other reason",
};

const LABEL =
  "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";

/** "Today 2:32 PM", "Yesterday 4:10 PM", "Tue Nov 11, 9:05 AM", in the browser's zone once hydrated. */
export function useDayTime() {
  const hydrated = useHydrated();
  const now = useNow();
  return (at: number) => {
    if (!hydrated) return "—";
    if (isSameDay(at, now)) return `Today ${format(at, "h:mm a")}`;
    if (isSameDay(at, now - 86_400_000)) return `Yesterday ${format(at, "h:mm a")}`;
    return format(at, "EEE MMM d, h:mm a");
  };
}

/** Records "held" or "no_show" on the call, with one toast for the outcome. */
export function useRecordAttendance(meetingId: Id<"meetings">, firstName: string | null) {
  const recordAttendanceOnly = useMutation(api.closer.attendanceOnly.recordAttendanceOnly);
  const [pending, setPending] = useState<"held" | "no_show" | null>(null);
  const who = firstName ?? "The lead";

  const record = async (attendance: "held" | "no_show", noShowReason?: NoShowReason) => {
    setPending(attendance);
    try {
      const result = await recordAttendanceOnly({ meetingId, attendance, noShowReason });
      if (!result.ok) {
        toast.error(paymentCommandSentence(result.code));
        return false;
      }
      toast.success(attendance === "held" ? `Recorded: ${who} attended.` : `Recorded: ${who} didn't show.`);
      return true;
    } catch (error) {
      reportClientError(error, { flow: "attendance_only" });
      toast.error(paymentErrorSentence(error, "Attendance wasn't saved. Please try again."));
      return false;
    } finally {
      setPending(null);
    }
  };

  return { record, pending };
}

/**
 * Didn't show, then the reason: the no-show dialog's reason select, inline,
 * with Record no-show and Cancel.
 */
export function NoShowReasonPicker({
  pending,
  onSave,
  onCancel,
  saveLabel = "Record no-show",
}: {
  pending: boolean;
  onSave: (reason: NoShowReason) => void;
  onCancel: () => void;
  saveLabel?: string;
}) {
  const id = useId();
  const [reason, setReason] = useState<NoShowReason | "">("");
  const [missing, setMissing] = useState(false);

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (reason === "") {
          setMissing(true);
          return;
        }
        onSave(reason);
      }}
    >
      <Field data-invalid={missing || undefined} className="gap-1.5">
        <FieldLabel htmlFor={`${id}-reason`} className="text-[13px] font-normal text-muted-foreground">
          Why didn&rsquo;t they show?
        </FieldLabel>
        <Select
          value={reason}
          onValueChange={(value) => {
            setReason(value as NoShowReason);
            setMissing(false);
          }}
        >
          <SelectTrigger id={`${id}-reason`} aria-invalid={missing} className="w-full max-w-sm" disabled={pending}>
            <SelectValue placeholder="Pick a reason" />
          </SelectTrigger>
          <SelectContent>
            {NO_SHOW_REASONS.map((value) => (
              <SelectItem key={value} value={value}>
                {NO_SHOW_REASON_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {missing ? (
          <p role="alert" className="text-[13px] text-danger-ink">
            Pick a reason.
          </p>
        ) : null}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          <TranslatableText>{pending ? "Saving…" : saveLabel}</TranslatableText>
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Payment = MeetingDetail["payments"][number];

/** The oldest counting payment, as payments arrive newest first. */
export function winningPayment(detail: MeetingDetail): Payment | undefined {
  return detail.payments.findLast((payment) => payment.status !== "disputed");
}

/** A won deal's call whose attendance is owed after a Whop payment won it. */
export function isAttendanceOwed(detail: MeetingDetail): boolean {
  const { meeting, opportunity, payments } = detail;
  return (
    meeting.status === "scheduled" &&
    meeting.attendanceOwedSince !== undefined &&
    opportunity.position === "won" &&
    payments.length > 0
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className={LABEL}>{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * Won, attendance owed: the WON chip, who recorded the payment from Whop,
 * the payment's facts, then "Did Bo attend this call?" with Attended,
 * Didn't show (then its reason) and, for the closer, This isn't my sale.
 */
export function AttendanceOwedCard({
  detail,
  mode,
  viewerIsCloser,
  onStatusChanged,
}: {
  detail: MeetingDetail;
  mode: MeetingDetailMode;
  viewerIsCloser: boolean;
  onStatusChanged?: () => Promise<void>;
}) {
  const { meeting, lead } = detail;
  const payment = winningPayment(detail);
  const firstName = firstNameOf(lead.fullName);
  const who = firstName ?? "the lead";
  const headingId = useId();
  const dayTime = useDayTime();
  const { record, pending } = useRecordAttendance(meeting._id, firstName);
  const [askingReason, setAskingReason] = useState(false);
  const [notMine, setNotMine] = useState<"closed" | "asking" | "sending">("closed");
  const flagNotMySale = useMutation(api.payments.notMySale.flagNotMySale);

  if (!payment) return null;
  const typeLabel = PAYMENT_TYPE_LABELS[payment.paymentType as PaymentTypeValue];
  const isFlagged = payment.notMySaleAt != null;
  const canFlag = viewerIsCloser && mode === "closer" && payment.providerPaymentId !== undefined && !isFlagged;

  const done = async (ok: boolean) => {
    if (ok) await onStatusChanged?.();
  };

  const sendNotMySale = async () => {
    setNotMine("sending");
    try {
      const result = await flagNotMySale({ paymentRecordId: payment._id });
      if (!result.ok) {
        toast.error(paymentCommandSentence(result.code));
        setNotMine("closed");
        return;
      }
      toast.success("Sent to Billing. Nothing changes until they decide.");
      setNotMine("closed");
    } catch (error) {
      reportClientError(error, { flow: "flag_not_my_sale" });
      toast.error(paymentErrorSentence(error, "That wasn't sent. Please try again."));
      setNotMine("asking");
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="@container overflow-hidden rounded-xl border-2 border-primary bg-card"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-4 pt-3.5 @md:px-5">
        <StageChip position="won" />
        {payment.providerByline ? (
          <p className="text-[0.8125rem] text-muted-foreground">{payment.providerByline}</p>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 @md:px-5 @xl:grid-cols-4">
        <Fact label="Amount">
          <span className="font-condensed text-[15px] font-semibold tabular-nums">
            {formatCurrency(payment.amount, payment.currency)}
          </span>
          <span className="text-muted-foreground"> {typeLabel.toLowerCase()}</span>
        </Fact>
        <Fact label="Collected">
          <span className="tabular-nums">
            {payment.providerPaidAt !== undefined ? dayTime(payment.providerPaidAt) : "—"}
          </span>
        </Fact>
        <Fact label="Recorded">
          <span className="tabular-nums">{dayTime(payment.recordedAt)}</span>
        </Fact>
        <Fact label="Credit">{payment.attributedCloserName ?? "—"}</Fact>
      </dl>
      <div className="flex flex-col gap-3 border-t px-4 py-3.5 @md:px-5">
        <div className="flex flex-col gap-0.5">
          <h2 id={headingId} className="text-lg leading-tight font-semibold text-balance">
            Did {who} attend this call?
          </h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            The payment is recorded. Your answer changes only the call, not the deal.
          </p>
        </div>
        {askingReason ? (
          <NoShowReasonPicker
            pending={pending === "no_show"}
            onCancel={() => setAskingReason(false)}
            onSave={(reason) => {
              void record("no_show", reason).then(done);
            }}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending !== null}
              onClick={() => {
                void record("held").then(done);
              }}
            >
              {pending === "held" ? <Spinner data-icon="inline-start" /> : null}
              <TranslatableText>{pending === "held" ? "Saving…" : "Attended"}</TranslatableText>
            </Button>
            <Button type="button" variant="outline" disabled={pending !== null} onClick={() => setAskingReason(true)}>
              Didn&rsquo;t show
            </Button>
            {canFlag ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => setNotMine("asking")}
              >
                This isn&rsquo;t my sale
              </Button>
            ) : null}
          </div>
        )}
        {viewerIsCloser && mode === "closer" && isFlagged ? (
          <p role="status" className="text-[0.8125rem] text-muted-foreground">
            You told Billing this isn&rsquo;t your sale.
          </p>
        ) : null}
      </div>

      {canFlag ? (
        <AlertDialog
          open={notMine === "asking" || notMine === "sending"}
          onOpenChange={(open) => {
            if (notMine !== "sending") setNotMine(open ? "asking" : "closed");
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>This isn&rsquo;t your sale?</AlertDialogTitle>
              <AlertDialogDescription>
                Billing will look at this payment. Nothing changes until they decide.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={notMine === "sending"}>Cancel</AlertDialogCancel>
              <Button type="button" disabled={notMine === "sending"} onClick={() => void sendNotMySale()}>
                {notMine === "sending" ? <Spinner data-icon="inline-start" /> : null}
                <TranslatableText>{notMine === "sending" ? "Sending…" : "Send to Billing"}</TranslatableText>
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </section>
  );
}

/**
 * Attendance recorded on a deal a Whop payment won: one line for the won
 * summary, "Attended · recorded Tue 2:05 PM" or "Didn't show · recorded by
 * you, Tue 2:05 PM". Null for any other deal or call.
 */
export function useAttendanceRecordedLine(detail: MeetingDetail, viewerIsCloser: boolean): string | null {
  const dayTime = useDayTime();
  const { meeting, opportunity } = detail;
  const payment = winningPayment(detail);
  if (opportunity.position !== "won" || !payment?.providerByline) return null;
  if (meeting.status === "held" && meeting.heldMarkedAt !== undefined) {
    return `Attended · recorded ${dayTime(meeting.heldMarkedAt)}`;
  }
  if (meeting.status === "no_show" && meeting.noShowMarkedAt !== undefined) {
    const byYou = viewerIsCloser && meeting.noShowMarkedByUserId === opportunity.assignedCloserId;
    return `Didn't show · recorded ${byYou ? "by you, " : ""}${dayTime(meeting.noShowMarkedAt)}`;
  }
  return null;
}

