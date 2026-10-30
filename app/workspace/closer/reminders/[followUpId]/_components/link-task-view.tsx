"use client";

import { Suspense, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { CheckIcon, CopyIcon, Link2OffIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { dealPositionLabel } from "@/convex/opportunities/stageLabels";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useIdle } from "@/hooks/use-idle";
import { useNow } from "@/hooks/use-now";
import { businessDateForInstant, type BusinessDaySetting } from "@/lib/businessDay";
import { formatPastDue } from "@/lib/closer-tasks";
import {
  formatBusinessDate,
  formatClock,
  formatDateTime,
  formatShortDate,
} from "@/app/workspace/closer/_components/today-time";
import { DealCard } from "@/app/workspace/closer/meetings/_components/deal-card";
import { firstNameOf } from "@/app/workspace/closer/meetings/_components/meeting-detail-types";
import { ChoiceButton } from "@/app/workspace/closer/meetings/_components/outcome-section";
import { StageChip } from "@/app/workspace/closer/meetings/_components/stage-tone";
import { DealCallsCard } from "./deal-calls-card";
import { ReachCard } from "./reach-card";
import { paymentsFact } from "./task-detail-view";
import { StripCell, StripFrame, StripStatus } from "./task-strip";
import type { LinkTaskDetail } from "./task-detail-types";

const LinkCancelDialog = dynamic(() =>
  import("./link-task-dialogs").then((m) => ({ default: m.LinkCancelDialog })),
);
const LinkLostDialog = dynamic(() =>
  import("./link-task-dialogs").then((m) => ({ default: m.LinkLostDialog })),
);

type LinkDialog = "cancel" | "lost";
type FollowedMeeting = LinkTaskDetail["followedMeeting"];

const COLUMNS =
  "@3xl:grid-cols-[5.75rem_minmax(0,2fr)_minmax(0,1fr)_minmax(5.5rem,0.7fr)_minmax(8rem,auto)]";

/** "after the Oct 26 no-show", "after the Oct 20 call": the call the link followed. */
function afterCall(meeting: FollowedMeeting, timeZone: string, withDate: boolean): string | null {
  if (!meeting) return null;
  const day = withDate ? `${formatShortDate(meeting.scheduledAt, timeZone)} ` : "";
  switch (meeting.status) {
    case "no_show":
      return `after the ${day}no-show`;
    case "canceled":
      return `after the ${day}cancellation`;
    default:
      return `after the ${day}call`;
  }
}

/** "Reschedule link · after the Oct 26 no-show", or just the kind with no call before it. */
function linkWhy(detail: LinkTaskDetail, timeZone: string): string {
  const kind =
    detail.followUp.reason === "no_show_follow_up" ? "Reschedule link" : "Scheduling link";
  const after = afterCall(detail.followedMeeting, timeZone, true);
  return after ? `${kind} · ${after}` : kind;
}

/** "Follow-up", or the stage the deal is at: where cancelling leaves it. */
function staysWhere(label: string): string {
  return label === "Follow-up" ? "in Follow-up" : `at ${label}`;
}

/**
 * A scheduling link waiting on the person, on the closer's task page: the
 * link as a board row, the link card with Copy link as the next action, the
 * reach card (Call, Text and Copy, none lime), and "Not booking?" with its
 * two choices; the deal and its calls on the right. A booking through the
 * link closes the task on its own.
 */
export function LinkTaskView({
  detail,
  onCompleted,
}: {
  detail: LinkTaskDetail;
  /** After the closer cancels the link or marks the deal lost. */
  onCompleted: () => void;
}) {
  const now = useNow();
  const { setting } = useBusinessDay();
  const { followUp, opportunity, lead, dealMeetings, payments } = detail;

  const personName = lead.fullName ?? lead.email ?? "Unknown person";
  const firstName = firstNameOf(lead.fullName) ?? personName;
  const programName =
    (opportunity.position === "won" ? opportunity.soldProgramName : null) ??
    opportunity.firstBookingProgramName ??
    null;
  const stageLabel = dealPositionLabel(opportunity.position, opportunity.systemLoss);
  const dealLine =
    dealMeetings.length === 0
      ? "no calls yet"
      : dealMeetings.length === 1
        ? "1 call"
        : `${dealMeetings.length} calls`;
  const pending = followUp.status === "pending";

  return (
    <div className="@container flex flex-col gap-3.5">
      <LinkStrip
        detail={detail}
        now={now}
        setting={setting}
        personName={personName}
        programName={programName}
        stageLabel={stageLabel}
        dealLine={dealLine}
      />

      <div className="grid grid-cols-1 gap-3.5 @3xl:grid-cols-[minmax(0,1fr)_20rem] @3xl:gap-x-[1.125rem] @5xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <LinkCard detail={detail} setting={setting} firstName={firstName} />
          <ReachCard
            personName={personName}
            phone={lead.phone ?? null}
            email={lead.email ?? null}
            personHref={`/workspace/leads-customers/${lead._id}`}
            method="call"
            // The link is the next action, so neither Call nor Text is lime.
            open={false}
          />
          {pending ? (
            <NotBooking
              detail={detail}
              firstName={firstName}
              stageLabel={stageLabel}
              onCompleted={onCompleted}
            />
          ) : (
            <LinkSummary detail={detail} setting={setting} />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-3.5">
          <DealCard
            detail={{
              opportunity,
              meeting: null,
              lead,
              dealAttribution: detail.dealAttribution,
              attributionTeam: detail.attributionTeam,
              dmCloser: detail.dmCloser,
              assignedCloser: detail.dealCloser,
            }}
            fact={paymentsFact(payments)}
          />
          <DealCallsCard
            meetings={dealMeetings}
            now={now}
            setting={setting}
            meetingBasePath="/workspace/closer/meetings"
          />
        </div>
      </div>
    </div>
  );
}

// ─── The strip ───────────────────────────────────────────────────────────────

/** The link's one status word: Waiting while it is open, then how it ended. */
function linkStatus(
  detail: LinkTaskDetail,
  now: number,
  setting: BusinessDaySetting,
): { word: string; detail: React.ReactNode; wordClass: string; dotClass: string } {
  const { followUp, bookedMeeting } = detail;
  switch (followUp.status) {
    case "pending":
      return {
        word: "Waiting",
        detail: `${formatPastDue(now - followUp.createdAt)}, no booking`,
        wordClass: "text-board-foreground",
        dotClass: "bg-stage-held",
      };
    case "booked":
      return {
        word: "Booked",
        detail: bookedMeeting ? (
          <Link
            href={`/workspace/closer/meetings/${bookedMeeting._id}`}
            className="rounded-sm font-medium text-board-foreground underline decoration-board-foreground/40 underline-offset-[3px] outline-none hover:decoration-board-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Call {formatDateTime(bookedMeeting.scheduledAt, setting.timeZone)}
          </Link>
        ) : followUp.bookedAt ? (
          `On ${formatShortDate(followUp.bookedAt, setting.timeZone)}`
        ) : (
          "Through this link"
        ),
        wordClass: "text-board-foreground",
        dotClass: "bg-stage-booked",
      };
    case "expired":
      return {
        word: "Canceled",
        detail: "No booking through it",
        wordClass: "text-board-muted",
        dotClass: "bg-board-muted",
      };
    case "completed":
      return {
        word: "Done",
        detail: followUp.completedAt
          ? `Deal lost ${formatShortDate(followUp.completedAt, setting.timeZone)}`
          : "Deal lost",
        wordClass: "text-board-foreground",
        dotClass: "bg-stage-held",
      };
  }
}

function LinkStrip({
  detail,
  now,
  setting,
  personName,
  programName,
  stageLabel,
  dealLine,
}: {
  detail: LinkTaskDetail;
  now: number;
  setting: BusinessDaySetting;
  personName: string;
  programName: string | null;
  stageLabel: string;
  dealLine: string;
}) {
  const { followUp } = detail;
  const sentDay = formatShortDate(followUp.createdAt, setting.timeZone);
  const sentWeekday = formatBusinessDate(businessDateForInstant(followUp.createdAt, setting), {
    weekday: "short",
  });
  const why = linkWhy(detail, setting.timeZone);
  const status = linkStatus(detail, now, setting);
  const reach =
    followUp.status === "pending"
      ? "Not booked yet"
      : followUp.status === "booked"
        ? "Booked"
        : "Closed";

  return (
    <StripFrame labels={["Sent", "Person", "Deal", "Reach by", "Status"]} columns={COLUMNS}>
      <StripCell label="Sent">
        <p className="font-condensed text-[1.625rem] leading-none font-semibold tabular-nums">
          {sentDay}
        </p>
        <p className="mt-1 truncate text-[0.8125rem] text-board-muted tabular-nums">
          {sentWeekday} · {formatClock(followUp.createdAt, setting.timeZone)}
        </p>
      </StripCell>

      <StripStatus {...status} />

      <StripCell label="Person" className="col-span-2 @3xl:col-span-1">
        <h1 className="truncate text-lg leading-tight font-semibold" title={personName}>
          {personName}
        </h1>
        <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted" title={why}>
          {why}
        </p>
      </StripCell>

      <StripCell label="Deal" className="col-span-2 @3xl:col-span-1">
        <p className="truncate font-semibold" title={programName ?? undefined}>
          {programName ?? "No program mapped"}
        </p>
        <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted tabular-nums">
          {stageLabel} · {dealLine}
        </p>
      </StripCell>

      <StripCell label="Reach by" className="col-span-2 @3xl:col-span-1">
        <p className="truncate font-semibold">Link</p>
        <p className="mt-0.5 truncate text-[0.8125rem] text-board-muted">{reach}</p>
      </StripCell>
    </StripFrame>
  );
}

// ─── The link ────────────────────────────────────────────────────────────────

/** Who sent the link and when, and what a booking through it does. */
function linkLine(detail: LinkTaskDetail, setting: BusinessDaySetting, firstName: string): string {
  const { followUp } = detail;
  switch (followUp.status) {
    case "booked":
      return followUp.bookedAt
        ? `${firstName} booked through this link on ${formatShortDate(followUp.bookedAt, setting.timeZone)}, which closed this task.`
        : `${firstName} booked through this link, which closed this task.`;
    case "expired":
      return "This link was closed without a booking, so it no longer waits as a task.";
    case "completed":
      return "This link closed when the deal was marked lost.";
    case "pending": {
      const byAdmin =
        followUp.createdSource === "admin" || followUp.reason === "admin_initiated";
      const after = afterCall(detail.followedMeeting, setting.timeZone, false);
      const sent = `Sent by ${byAdmin ? "an admin" : "you"} on ${formatShortDate(followUp.createdAt, setting.timeZone)}${after ? ` ${after}` : ""}.`;
      return `${sent} When ${firstName} books through it, the call lands on your Today board and this task closes.`;
    }
  }
}

function LinkCard({
  detail,
  setting,
  firstName,
}: {
  detail: LinkTaskDetail;
  setting: BusinessDaySetting;
  firstName: string;
}) {
  const [copied, setCopied] = useState(false);
  const url = detail.followUp.schedulingLinkUrl ?? null;
  const pending = detail.followUp.status === "pending";

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy the link. Select it and copy it instead.");
    }
  };

  return (
    <Card className="gap-2.5 px-4 py-3.5" aria-label="The scheduling link">
      {url ? (
        <div className="flex flex-col gap-2 @md:flex-row @md:items-center">
          {/* One row: the whole URL stays selectable (select-all) and in the
              title, and Copy link copies it. */}
          <p
            className="flex h-10 min-w-0 shrink-0 items-center rounded-lg border bg-background px-3 text-sm font-medium select-all @md:flex-1 @md:shrink"
            translate="no"
            title={url}
          >
            <span className="truncate">
            {url}</span>
          </p>
          <Button
            type="button"
            // Copying the link is the next action while it waits.
            variant={pending ? "default" : "outline"}
            size="lg"
            className="shrink-0 px-3.5 font-semibold @md:self-auto self-start"
            onClick={copy}
          >
            {copied ? (
              <CheckIcon data-icon="inline-start" aria-hidden />
            ) : (
              <CopyIcon data-icon="inline-start" aria-hidden />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : (
        <p className="font-medium">No link was saved on this task.</p>
      )}
      <p className="text-[0.8125rem] text-pretty text-muted-foreground">
        {linkLine(detail, setting, firstName)}
      </p>
    </Card>
  );
}

// ─── Not booking? ────────────────────────────────────────────────────────────

function NotBooking({
  detail,
  firstName,
  stageLabel,
  onCompleted,
}: {
  detail: LinkTaskDetail;
  firstName: string;
  stageLabel: string;
  onCompleted: () => void;
}) {
  const { followUp, opportunity, lead } = detail;
  const [dialog, setDialog] = useState<LinkDialog | null>(null);
  // A dialog stays mounted once opened, so the task closing underneath never
  // unmounts it mid-flow; once the browser is idle both mount closed, so a
  // pick opens its dialog at once.
  const [mounted, setMounted] = useState<ReadonlySet<LinkDialog>>(new Set());
  const idle = useIdle();
  const shown = (key: LinkDialog) => idle || mounted.has(key);
  const open = (next: LinkDialog) => {
    setMounted((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setDialog(next);
  };
  const dialogState = (key: LinkDialog) => ({
    open: dialog === key,
    onOpenChange: (value: boolean) => setDialog(value ? key : null),
    onSuccess: onCompleted,
  });
  // A deal already won or lost elsewhere has nothing left to close but the link.
  const dealOpen = opportunity.outcome === "open";

  return (
    <>
      <section
        aria-labelledby="not-booking-heading"
        className="@container overflow-hidden rounded-xl border bg-card"
      >
        <div className="px-4 pt-3.5 pb-1 @md:px-5">
          <h2
            id="not-booking-heading"
            className="text-lg leading-tight font-semibold text-balance"
          >
            Not booking?
          </h2>
          <p className="mt-1 text-muted-foreground">
            {dealOpen
              ? `The link stays open until ${firstName} books. If that isn’t going to happen:`
              : `The deal is already ${stageLabel.toLowerCase()}, so only the link is left to close.`}
          </p>
        </div>
        <div className="grid gap-2.5 p-4 @md:px-5 @lg:grid-cols-2">
          <ChoiceButton
            tone="quiet"
            icon={<Link2OffIcon />}
            title="Cancel the link"
            detail={`Closes this task. The deal stays ${staysWhere(stageLabel)}.`}
            onClick={() => open("cancel")}
          />
          {dealOpen ? (
            <ChoiceButton
              tone="lost"
              icon={<XIcon />}
              title="Mark the deal lost"
              detail="Closes this task and the deal as lost."
              onClick={() => open("lost")}
            />
          ) : null}
        </div>
      </section>

      {/* A dialog suspends on its first render; this boundary keeps that wait
          to the dialog instead of the page's loading skeleton. */}
      <Suspense fallback={null}>
        {shown("cancel") ? (
          <LinkCancelDialog
            followUpId={followUp._id}
            firstName={firstName}
            dealStageLabel={stageLabel}
            {...dialogState("cancel")}
          />
        ) : null}
        {shown("lost") && dealOpen ? (
          <LinkLostDialog
            followUpId={followUp._id}
            firstName={firstName}
            leadName={lead.fullName ?? lead.email ?? null}
            {...dialogState("lost")}
          />
        ) : null}
      </Suspense>
    </>
  );
}

// ─── After it closed ─────────────────────────────────────────────────────────

/** How the link ended, in a line: booked, canceled, or the deal marked lost. */
function LinkSummary({ detail, setting }: { detail: LinkTaskDetail; setting: BusinessDaySetting }) {
  const { followUp, opportunity, bookedMeeting } = detail;
  const note = followUp.completionNote?.trim();

  let headline: React.ReactNode;
  switch (followUp.status) {
    case "booked":
      headline = bookedMeeting
        ? `Booked. The call is on ${formatDateTime(bookedMeeting.scheduledAt, setting.timeZone)}.`
        : "Booked through this link.";
      break;
    case "completed":
      headline = note ? (
        <>Closed the deal as lost: &ldquo;{note}&rdquo;</>
      ) : (
        "Closed the deal as lost, no reason given."
      );
      break;
    default:
      headline = "Link canceled. No booking came through it.";
  }

  return (
    <section
      aria-label="Outcome"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3"
    >
      <StageChip position={opportunity.position} systemLoss={opportunity.systemLoss} />
      <p className="min-w-0 flex-1 basis-56 font-medium">{headline}</p>
      {followUp.status === "booked" && bookedMeeting ? (
        <Button asChild variant="outline" size="sm">
          <Link href={`/workspace/closer/meetings/${bookedMeeting._id}`}>Open the call</Link>
        </Button>
      ) : followUp.completedAt ? (
        <p className="text-[0.8125rem] text-muted-foreground tabular-nums">
          Closed {formatDateTime(followUp.completedAt, setting.timeZone)}
        </p>
      ) : null}
    </section>
  );
}
