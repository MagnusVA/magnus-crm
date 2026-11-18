"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { addBusinessDays, businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatAmountMinor } from "@/lib/format-currency";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TranslatableText } from "@/components/translatable-text";
import {
  paymentCommandSentence,
  paymentErrorSentence,
} from "@/app/workspace/_components/payments/payment-command-words";
import { automationCommandSentence } from "./automation-command-words";
import { formatBusinessDate, formatClock, formatShortDate } from "./today-time";

const PaymentOwedDialog = dynamic(() =>
  import("@/app/workspace/closer/reminders/[followUpId]/_components/payment-owed-dialog").then((m) => ({
    default: m.PaymentOwedDialog,
  })),
);

type PinnedLine = FunctionReturnType<typeof api.closer.pinnedLines.listMyPinnedLines>[number];
type Notice = FunctionReturnType<typeof api.automation.notice.listMyNotices>["notices"][number];
type Alert = FunctionReturnType<typeof api.automation.alert.listMyAlerts>[number];

/** Where "Not paid yet" offers a payment-owed reminder. */
type OwedTarget = {
  opportunityId: Id<"opportunities">;
  meetingId?: Id<"meetings">;
  personName: string | null;
};

const ROW = "border-t px-4 py-2.5 first:border-t-0";
const CHIP =
  "shrink-0 rounded-[4px] px-1.5 font-condensed text-[11px] leading-[18px] font-bold tracking-[0.1em] uppercase";
const LOSS_CHIP = `${CHIP} bg-stage-lost/12 text-stage-lost-ink`;
const CHECK_CHIP = `${CHIP} bg-warning-surface text-warning-ink`;
const NAME_LINK = "font-semibold underline-offset-2 hover:underline focus-visible:underline";

// ─── Words for days and times ────────────────────────────────────────────────

/** How many business days `at` is from today, when within a week either way. */
function daysFrom(at: number, now: number, setting: BusinessDaySetting): number | null {
  const today = businessDateForInstant(now, setting);
  const day = businessDateForInstant(at, setting);
  for (let offset = -6; offset <= 6; offset += 1) {
    if (addBusinessDays(today, offset) === day) return offset;
  }
  return null;
}

function upcomingDay(at: number, now: number, setting: BusinessDaySetting): string | null {
  const offset = daysFrom(at, now, setting);
  if (offset === 0) return "today";
  if (offset === 1) return "tomorrow";
  if (offset !== null && offset > 1) {
    return formatBusinessDate(businessDateForInstant(at, setting), { weekday: "short" });
  }
  return null;
}

/** "today 3:00 PM", "tomorrow 3:00 PM", "Thu 3:00 PM", or "Nov 28, 3:00 PM". */
function whenAt(at: number, now: number, setting: BusinessDaySetting): string {
  const clock = formatClock(at, setting.timeZone);
  const day = upcomingDay(at, now, setting);
  return day ? `${day} ${clock}` : `${formatShortDate(at, setting.timeZone)}, ${clock}`;
}

/** "today's call", "yesterday's call", "Tuesday's call", or "the Nov 10 call". */
function callOn(at: number, now: number, setting: BusinessDaySetting): string {
  const offset = daysFrom(at, now, setting);
  if (offset === 0) return "today’s call";
  if (offset === -1) return "yesterday’s call";
  if (offset !== null && offset < -1) {
    const weekday = formatBusinessDate(businessDateForInstant(at, setting), { weekday: "long" });
    return `${weekday}’s call`;
  }
  return `the ${formatShortDate(at, setting.timeZone)} call`;
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── The lines ───────────────────────────────────────────────────────────────

/** "$500.00 ", or nothing when the line carries no amount. */
function money(line: PinnedLine) {
  return line.amountMinor !== undefined && line.currency ? `${formatAmountMinor(line.amountMinor, line.currency)} ` : "";
}

/**
 * What changed, in one line, such as "Eli Park · A $500.00 win was removed"
 * or "Eli Park's deal was reopened".
 */
function lineText(
  line: PinnedLine,
  now: number,
  setting: BusinessDaySetting,
): string {
  const amount = money(line);
  const name = line.personName;
  const withName = (change: string) => (name ? `${name} · ${change}` : change);
  switch (line.kind) {
    case "win_recorded_from_whop":
      return withName(`A ${amount}win was recorded from Whop`);
    case "instalment_credited":
      return withName(`A ${amount}payment was added from Whop`);
    case "win_removed":
      return withName(`A ${amount}win was removed`);
    case "payment_removed":
      return withName(`A ${amount}payment was removed`);
    case "payment_restored":
      return withName(`A ${amount}payment was restored`);
    case "call_result_set": {
      const { taskPurpose, taskContactMethod, taskScheduledAt } = line;
      let what = "a task";
      if (taskPurpose === "payment_owed") {
        const day = taskScheduledAt === null ? null
          : upcomingDay(taskScheduledAt, now, setting) ??
            formatBusinessDate(businessDateForInstant(taskScheduledAt, setting), { month: "short", day: "numeric" });
        what = day ? `payment-owed task for ${day}` : "a payment-owed task";
      } else if (taskScheduledAt !== null && taskContactMethod !== null) {
        const method = taskContactMethod === "text" ? "text-back" : "call-back";
        what = `${method} ${whenAt(taskScheduledAt, now, setting)}`;
      }
      return `Call with ${name ?? "this person"} marked held: ${what} set from the call`;
    }
    case "refusal_recorded":
      return name
        ? `${name}’s deal was closed as lost after they refused on the call`
        : "A deal was closed as lost after the person refused on the call";
    case "refusal_notice_withdrawn":
      return `The pending loss for ${name ?? "this person"} was withdrawn`;
    case "refusal_reopened":
      return name ? `${name}’s deal was reopened` : "A deal closed as lost after a refusal was reopened";
  }
}

/** Where a line's text leads: the task a call result set, else the deal. */
function lineHref(line: PinnedLine): string {
  if (line.kind === "call_result_set" && line.followUpId) {
    return `/workspace/closer/reminders/${line.followUpId}`;
  }
  return `/workspace/opportunities/${line.opportunityId}`;
}

/** Where a removed win left the deal. */
function positionAfter(line: PinnedLine): string | null {
  if (line.kind !== "win_removed" || !line.dealPositionAfter) return null;
  switch (line.dealPositionAfter) {
    case "follow_up":
      return "The deal is back at Follow-up with a reminder due now.";
    case "booked":
      return "The deal is back at Booked.";
    case "lost":
      return "The deal is closed as lost.";
    default:
      return `The deal is back at ${dealPositionLabel(line.dealPositionAfter)}.`;
  }
}

/** Unacknowledged notices first, then by when they close. */
function noticeOrder(a: Notice, b: Notice) {
  const seenA = a.acknowledgedAt !== undefined ? 1 : 0;
  const seenB = b.acknowledgedAt !== undefined ? 1 : 0;
  return seenA - seenB || (a.dueAt ?? 0) - (b.dueAt ?? 0) || a.createdAt - b.createdAt;
}

// ─── The group ───────────────────────────────────────────────────────────────

/**
 * What is waiting on the closer, above Tasks so eight task rows never bury
 * it: pending losses from a refusal on a call (I've seen this, Stop), then
 * "paid on the call, no payment found" alerts (three answers), then changes
 * others made to the closer's numbers or results the system set from a call,
 * each kept until the closer taps Got it. Titled "Waiting on you" while it
 * holds a notice or an alert, else "Changes to your numbers". Renders nothing
 * while loading or when there is nothing to show.
 */
export function PinnedGroupCard({ setting, now }: { setting: BusinessDaySetting; now: number }) {
  const lines = useQuery(api.closer.pinnedLines.listMyPinnedLines, {});
  const noticeList = useQuery(api.automation.notice.listMyNotices, {});
  const alerts = useQuery(api.automation.alert.listMyAlerts, {});
  // Kept here, not on the alert's row: answering removes the row.
  const [owed, setOwed] = useState<(OwedTarget & { open: boolean }) | null>(null);

  const dialog = owed ? (
    <Suspense fallback={null}>
      <PaymentOwedDialog
        open={owed.open}
        onOpenChange={(open) => setOwed((prev) => (prev ? { ...prev, open } : prev))}
        opportunityId={owed.opportunityId}
        meetingId={owed.meetingId}
        personName={owed.personName}
        setting={setting}
      />
    </Suspense>
  ) : null;

  if (lines === undefined || noticeList === undefined || alerts === undefined) return dialog;
  const notices = [...noticeList.notices].sort(noticeOrder);
  const total = notices.length + alerts.length + lines.length;
  if (total === 0) return dialog;

  const waiting = notices.length + alerts.length > 0;

  return (
    <>
      <section
        aria-labelledby="pinned-group-title"
        className="rounded-xl border bg-card text-sm text-card-foreground"
      >
        <header className="flex min-h-[46px] items-center gap-2 border-b px-4 py-2">
          <h2 id="pinned-group-title" className="text-[15px] font-semibold">
            <TranslatableText>{waiting ? "Waiting on you" : "Changes to your numbers"}</TranslatableText>
          </h2>
          <span className="rounded-full bg-secondary px-[7px] text-xs leading-[18px] font-semibold tabular-nums">
            {total}
          </span>
        </header>
        <ul>
          {notices.map((notice) => (
            <NoticeRow key={notice.decisionId} notice={notice} now={now} setting={setting} />
          ))}
          {alerts.map((alert) => (
            <AlertRow
              key={alert.decisionId}
              alert={alert}
              now={now}
              setting={setting}
              onNotPaid={(target) => setOwed({ ...target, open: true })}
            />
          ))}
          {lines.map((line) => (
            <PinnedLineRow
              key={line._id}
              line={line}
              text={lineText(line, now, setting)}
            />
          ))}
        </ul>
      </section>
      {dialog}
    </>
  );
}

// ─── A pending loss ──────────────────────────────────────────────────────────

/**
 * A refusal the system will close as lost. Before the closer has seen it:
 * I've seen this starts the notice period, Stop opens the call, where the
 * full Stop flow asks for the next step. After: when it closes, and Stop.
 */
function NoticeRow({ notice, now, setting }: { notice: Notice; now: number; setting: BusinessDaySetting }) {
  const acknowledge = useMutation(api.automation.notice.acknowledgeNotice);
  const [pending, setPending] = useState(false);
  const name = notice.personName ?? "This person";
  const seen = notice.acknowledgedAt !== undefined;
  const meetingHref = `/workspace/closer/meetings/${notice.meetingId}`;
  const status = seen
    ? notice.dueAt !== undefined
      ? `closes as lost ${whenAt(notice.dueAt, now, setting)}`
      : "closes as lost when the notice ends"
    : `refused on ${callOn(notice.callAt, now, setting)}`;

  const seenIt = async () => {
    setPending(true);
    try {
      const result = await acknowledge({ decisionId: notice.decisionId });
      if (!result.ok) toast.error(automationCommandSentence(result.code));
    } catch (error) {
      reportClientError(error, { flow: "acknowledge_refusal_notice" });
      toast.error(getErrorMessage(error, "That didn't save. Please try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className={`flex flex-col gap-2 ${ROW}`}>
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Link href={meetingHref} className={`min-w-0 ${NAME_LINK}`}>
            {name}
          </Link>
          <span className="min-w-0 text-muted-foreground">· {status}</span>
          {seen ? null : <span className={LOSS_CHIP}>Closes as lost</span>}
        </p>
        {seen ? (
          <p className="text-[13px] text-muted-foreground">
            The deal closes as lost then unless you or an admin stop it.
          </p>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            <TranslatableText>
              {`Nothing changes until you confirm you've seen it. Then the deal closes as lost ${notice.noticeHours} hours later unless someone stops it.`}
            </TranslatableText>
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {seen ? null : (
          <Button
            type="button"
            className="h-8 px-3 font-semibold"
            disabled={pending}
            aria-label={`I've seen this: ${name} refused on the call`}
            onClick={() => void seenIt()}
          >
            {pending ? <Spinner data-icon="inline-start" /> : null}
            <TranslatableText>I&rsquo;ve seen this</TranslatableText>
          </Button>
        )}
        <Button asChild variant="outline" className="h-8 px-3">
          <Link href={meetingHref} aria-label={`Stop the pending loss for ${name}`}>
            Stop
          </Link>
        </Button>
      </div>
    </li>
  );
}

// ─── Paid on the call, no payment found ──────────────────────────────────────

type Answer = "add_payment" | "paid_in_whop_by_someone_else" | "not_paid_yet";

/**
 * The closer said on the call that the payment came through and Whop shows
 * nothing for the person. Add payment opens the call or the task with the
 * payment dialog; Paid in Whop by someone else hands it to Billing; Not paid
 * yet offers a reminder to check on it.
 */
function AlertRow({
  alert,
  now,
  setting,
  onNotPaid,
}: {
  alert: Alert;
  now: number;
  setting: BusinessDaySetting;
  onNotPaid: (target: OwedTarget) => void;
}) {
  const answerAlert = useMutation(api.automation.alert.answerAlert);
  const router = useRouter();
  const [pending, setPending] = useState<Answer | null>(null);
  const name = alert.personName;

  const answer = async (choice: Answer) => {
    setPending(choice);
    try {
      const result = await answerAlert({ decisionId: alert.decisionId, answer: choice });
      if (!result.ok) {
        toast.error(
          choice === "add_payment" && result.code === "not_ready"
            ? "This deal has no open call or task that can take a payment. Add it from the deal."
            : automationCommandSentence(result.code),
        );
        return;
      }
      const next = result.next;
      if (choice === "paid_in_whop_by_someone_else") {
        toast.success(result.alreadyApplied ? "This was already answered." : "Billing will look for it.");
        return;
      }
      if (next?.type === "payment") {
        const target = next.target;
        router.push(
          "meetingId" in target
            ? `/workspace/closer/meetings/${target.meetingId}?logPayment=1`
            : `/workspace/closer/reminders/${target.followUpId}?logPayment=1`,
        );
        return;
      }
      if (next?.type === "reminder") {
        onNotPaid({ opportunityId: next.opportunityId, meetingId: next.meetingId, personName: name });
        return;
      }
      toast.info("This was already answered.");
    } catch (error) {
      reportClientError(error, { flow: "answer_paid_on_call_alert" });
      toast.error(getErrorMessage(error, "That didn't save. Please try again."));
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  const label = (choice: Answer, text: string) => (
    <>
      {pending === choice ? <Spinner data-icon="inline-start" /> : null}
      <TranslatableText>{text}</TranslatableText>
    </>
  );

  return (
    <li className={`flex flex-col gap-2 ${ROW}`}>
      <div className="min-w-0">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <Link href={`/workspace/closer/meetings/${alert.meetingId}`} className={`min-w-0 ${NAME_LINK}`}>
            {name}
          </Link>
          <span className="min-w-0 text-muted-foreground">· no matching Whop payment yet</span>
          <span className={CHECK_CHIP}>Check</span>
        </p>
        <p className="text-[13px] text-muted-foreground">
          {capitalize(`on ${callOn(alert.callAt, now, setting)}`)} you said the payment came through.
          Paid another way? Add it.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Answer for ${name}`}>
        <Button
          type="button"
          className="h-8 px-3 font-semibold"
          disabled={busy}
          onClick={() => void answer("add_payment")}
        >
          {label("add_payment", "Add payment")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-8 px-3"
          disabled={busy}
          onClick={() => void answer("paid_in_whop_by_someone_else")}
        >
          {label("paid_in_whop_by_someone_else", "Paid in Whop by someone else")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-8 px-3"
          disabled={busy}
          onClick={() => void answer("not_paid_yet")}
        >
          {label("not_paid_yet", "Not paid yet")}
        </Button>
      </div>
    </li>
  );
}

// ─── A change to the closer's numbers ────────────────────────────────────────

function PinnedLineRow({ line, text }: { line: PinnedLine; text: string }) {
  const dismiss = useMutation(api.closer.pinnedLines.dismissPinnedLine);
  const [pending, setPending] = useState(false);
  const after = positionAfter(line);

  const gotIt = async (lineId: Id<"closerPinnedLines">) => {
    setPending(true);
    try {
      const result = await dismiss({ lineId });
      if (!result.ok) toast.error(paymentCommandSentence(result.code));
    } catch (error) {
      reportClientError(error, { flow: "dismiss_pinned_line" });
      toast.error(paymentErrorSentence(error, "That didn't save. Please try again."));
    } finally {
      setPending(false);
    }
  };

  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 ${ROW}`}>
      <div className="min-w-0">
        <p>
          <Link href={lineHref(line)} className={NAME_LINK}>
            {text}
          </Link>
        </p>
        {after ? <p className="text-[13px] text-muted-foreground">{after}</p> : null}
      </div>
      <Button
        type="button"
        variant="outline"
        className="h-8 px-3"
        disabled={pending}
        aria-label={`Got it: ${text}`}
        onClick={() => void gotIt(line._id)}
      >
        {pending ? <Spinner data-icon="inline-start" /> : null}
        <TranslatableText>Got it</TranslatableText>
      </Button>
    </li>
  );
}
