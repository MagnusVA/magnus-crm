"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/call-insights/item-rows";
import { useRole } from "@/components/auth/role-context";
import { reportClientError } from "@/lib/observability/report-client-error";
import { useDayTime } from "./attendance-question";
import {
  PendingButton,
  QuoteFacts,
  ResultCard,
  ResultError,
  ResultFact,
  ResultFacts,
} from "./call-ask";
import { automationCodeSentence, checkedLine, thrownSentence, type CallAsk } from "./call-result-words";
import { StopRefusalDialog } from "./stop-refusal-dialog";

// A pending loss from a call (`getCallAsk` in state "notice"): the deal closes
// as lost a set number of hours after the closer confirms they've seen it, or
// after an owner or admin takes responsibility for it, unless someone stops
// it. The meeting page shows it in place of the suggestion card; the deal
// page shows the same card as a banner above its calls.

/** States 4 and 5: the notice, before and after someone has seen it. */
export function RefusalNoticeCard({
  ask,
  firstName,
  viewerIsAdmin,
  meetingHref,
  onChanged,
  onActed,
  onStale,
}: {
  ask: CallAsk;
  firstName: string | null;
  viewerIsAdmin: boolean;
  /** On the deal page: the meeting the notice is about. */
  meetingHref?: string;
  onChanged?: () => Promise<void>;
  onActed?: () => void;
  onStale?: () => void;
}) {
  const dayTime = useDayTime();
  const acknowledge = useMutation(api.automation.notice.acknowledgeNotice);
  const closeNow = useMutation(api.automation.notice.closeNow);
  const [pending, setPending] = useState<"seen" | "close" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopOpen, setStopOpen] = useState(false);

  // Seeing the notice changes the card in place: move focus to its heading.
  const heading = useRef<HTMLHeadingElement>(null);
  const seen = ask.notice?.acknowledgedAt !== undefined;
  const lastSeen = useRef(seen);
  const focusOnChange = useRef(false);
  useEffect(() => {
    if (lastSeen.current === seen) return;
    lastSeen.current = seen;
    if (focusOnChange.current) heading.current?.focus();
    focusOnChange.current = false;
  }, [seen]);

  const notice = ask.notice;
  if (!notice) return null;

  const run = async (which: "seen" | "close") => {
    setPending(which);
    setError(null);
    try {
      const result =
        which === "seen"
          ? await acknowledge({ decisionId: ask.decisionId })
          : await closeNow({ decisionId: ask.decisionId });
      if (!result.ok) {
        if (result.code === "stale_preview" && onStale) {
          onActed?.();
          onStale();
        } else {
          setError(automationCodeSentence(result.code));
        }
        return;
      }
      if (which === "seen") {
        focusOnChange.current = true;
      } else {
        onActed?.();
        toast.success("Closed as lost.");
      }
      await onChanged?.();
    } catch (err) {
      reportClientError(err, { flow: which === "seen" ? "call_notice_acknowledge" : "call_notice_close_now" });
      setError(thrownSentence(err));
    } finally {
      setPending(null);
    }
  };

  const who = firstName ?? "the prospect";
  const hours = notice.hours;
  const dueAt = notice.dueAt;
  const waiting = notice.acknowledgedAt === undefined;
  const seenLine = waiting
    ? viewerIsAdmin
      ? `Closes as lost ${hours} hours after the closer confirms they've seen it, or after you take responsibility for it.`
      : `Closes as lost ${hours} hours after you confirm you've seen it.`
    : null;

  return (
    <>
      <ResultCard
        tone="notice"
        headingRef={heading}
        title={<>From the call: {firstName ?? "The prospect"} refused</>}
        chips={
          <>
            <Chip tone="warning">
              {waiting || dueAt === undefined ? "Not seen yet" : `Closes as lost ${dayTime(dueAt)}`}
            </Chip>
            <Chip tone="ink">Automatic</Chip>
          </>
        }
      >
        {seenLine ? <p className="text-sm font-medium text-pretty">{seenLine}</p> : null}
        <ResultFacts>
          <QuoteFacts quotes={ask.quotes} quotesDeleted={ask.quotesDeleted} />
          <ResultFact label="Checked">{checkedLine(ask.kind)}</ResultFact>
          {!waiting && notice.acknowledgedAt !== undefined ? (
            <ResultFact label="Seen by">
              {notice.acknowledgedByName ?? "A team member"}, {dayTime(notice.acknowledgedAt)}
              {notice.acknowledgedAs === "admin" ? " (took responsibility)" : null}
            </ResultFact>
          ) : null}
        </ResultFacts>
        <p className="text-[0.8125rem] leading-[1.45] text-pretty text-muted-foreground">
          Stopping it asks you for the next step. Close as lost now closes the deal with {who} as lost and
          marks this call held.
        </p>
        <div className="flex flex-wrap gap-2">
          {ask.can.acknowledge && waiting ? (
            <PendingButton
              pending={pending === "seen"}
              pendingLabel="Saving…"
              disabled={pending !== null}
              onClick={() => void run("seen")}
            >
              {viewerIsAdmin ? "Take responsibility" : "I've seen this"}
            </PendingButton>
          ) : null}
          {ask.can.stop ? (
            <Button
              type="button"
              variant="destructive"
              className="font-semibold text-danger-ink"
              disabled={pending !== null}
              onClick={() => setStopOpen(true)}
            >
              Stop and set a next step
            </Button>
          ) : null}
          <PendingButton
            pending={pending === "close"}
            pendingLabel="Closing…"
            disabled={pending !== null}
            variant="outline"
            onClick={() => void run("close")}
          >
            Close as lost now
          </PendingButton>
          {meetingHref ? (
            <Button asChild variant="ghost">
              <Link href={meetingHref}>Open the meeting</Link>
            </Button>
          ) : null}
        </div>
        <ResultError>{error}</ResultError>
      </ResultCard>
      <StopRefusalDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        decisionId={ask.decisionId}
        firstName={firstName}
        onStopped={() => {
          onActed?.();
          void onChanged?.();
        }}
      />
    </>
  );
}

// ─── The deal page ───────────────────────────────────────────────────────────

type BannerMeeting = { _id: Id<"meetings">; status: string; scheduledAt: number };

/**
 * State 12: on the deal page, the notice for each of the deal's calls that
 * has one, above the list of calls. Nothing renders for a call without a
 * notice or for a role that can't answer one.
 */
export function DealRefusalNoticeBanners({
  meetings,
  meetingBasePath,
  now,
}: {
  meetings: ReadonlyArray<BannerMeeting>;
  meetingBasePath: string;
  now: number;
}) {
  const { role, isAdmin } = useRole();
  if (role !== "closer" && !isAdmin) return null;
  // A notice only follows a call that has started and has no result yet.
  const candidates = meetings.filter((meeting) => meeting.status === "scheduled" && meeting.scheduledAt <= now);
  if (candidates.length === 0) return null;
  return (
    <>
      {candidates.map((meeting) => (
        <MeetingNoticeBanner
          key={meeting._id}
          meetingId={meeting._id}
          meetingHref={`${meetingBasePath}/${meeting._id}`}
          viewerIsAdmin={isAdmin}
        />
      ))}
    </>
  );
}

function MeetingNoticeBanner({
  meetingId,
  meetingHref,
  viewerIsAdmin,
}: {
  meetingId: Id<"meetings">;
  meetingHref: string;
  viewerIsAdmin: boolean;
}) {
  const ask = useQuery(api.automation.confirmCall.getCallAsk, { meetingId });
  if (!ask || ask.state !== "notice") return null;
  return (
    <div className="border-b px-4 py-3 sm:px-5">
      <RefusalNoticeCard ask={ask} firstName={null} viewerIsAdmin={viewerIsAdmin} meetingHref={meetingHref} />
    </div>
  );
}
