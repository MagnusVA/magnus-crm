"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";
import { SectionEmpty, SectionError } from "@/app/workspace/closer/_components/section-state";
import { CARD, CardHead } from "@/app/workspace/team/_components/team-ui";
import { formatDayTime, formatFull, STATUS_WORD } from "./admin-ui";

const PAGE_SIZE = 10;

type SupportTicket = Doc<"supportTickets">;

const TICKET_STATUS: Record<SupportTicket["status"], { label: string; ink: string }> = {
  new: { label: "New", ink: "text-warning-ink" },
  reviewed: { label: "Reviewed", ink: "text-muted-foreground" },
  closed: { label: "Closed", ink: "text-muted-foreground" },
};

/** Requests sent from the public support page, newest first. */
export function SupportRequestsCard() {
  const now = useNow();
  const tickets = usePaginatedQuery(api.admin.supportTickets.listSupportTickets, {}, { initialNumItems: PAGE_SIZE });

  return (
    <SupportFrame>
      {tickets.status === "LoadingFirstPage" ? (
        <TicketRowsSkeleton />
      ) : tickets.results.length === 0 ? (
        <SectionEmpty title="No support requests yet." />
      ) : (
        <>
          <ul aria-label="Support requests">
            {tickets.results.map((ticket) => (
              <TicketRow key={ticket._id} ticket={ticket} now={now} />
            ))}
          </ul>
          {tickets.status === "CanLoadMore" || tickets.status === "LoadingMore" ? (
            <div className="flex min-h-10 items-center border-t px-4 py-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7"
                disabled={tickets.status === "LoadingMore"}
                onClick={() => tickets.loadMore(PAGE_SIZE)}
              >
                {tickets.status === "LoadingMore" ? <Spinner data-icon="inline-start" /> : null}
                {tickets.status === "LoadingMore" ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </SupportFrame>
  );
}

function SupportFrame({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="admin-support-title" className={CARD}>
      <CardHead title={<span id="admin-support-title">Support requests</span>} meta="from the support page · newest first" />
      {children}
    </section>
  );
}

export function SupportRequestsError() {
  return (
    <SupportFrame>
      <SectionError what="support requests" />
    </SupportFrame>
  );
}

// Line 1: the subject and who sent it, then when and the status word. Line 2:
// the message, two lines at most until it's opened. On a phone, who sent it
// takes its own line under the subject.
function TicketRow({ ticket, now }: { ticket: SupportTicket; now: number }) {
  const [open, setOpen] = useState(false);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const clamped = useIsClamped(messageRef, open);
  const status = TICKET_STATUS[ticket.status];
  // Closed, blank lines would spend the two lines on "Hi team,".
  const preview = ticket.message.replace(/\n\s*\n+/g, "\n").trim();
  const messageId = `ticket-${ticket._id}-message`;

  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 border-b px-4 py-2.5 last:border-b-0">
      <div className="contents @xl:col-start-1 @xl:row-start-1 @xl:flex @xl:min-w-0 @xl:items-baseline @xl:gap-x-2.5">
        <p className="col-start-1 row-start-1 min-w-0 truncate leading-5 font-semibold @xl:max-w-[65%] @xl:shrink-0" title={ticket.subject}>
          {ticket.subject}
        </p>
        <p className="col-start-1 row-start-2 min-w-0 truncate text-[13px] leading-[18px] text-muted-foreground @xl:col-auto @xl:row-auto">
          <a
            href={`mailto:${ticket.email}`}
            title={ticket.email}
            className="rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {ticket.name}
          </a>
          {ticket.organizationName ? <> · {ticket.organizationName}</> : null}
          {ticket.slackWorkspace ? <> · Slack: {ticket.slackWorkspace}</> : null}
        </p>
      </div>
      {/* On a phone the status word stays by the subject and the time drops beside the sender. */}
      <div className="contents @xl:col-start-2 @xl:row-start-1 @xl:flex @xl:items-baseline @xl:justify-end @xl:gap-3">
        <time
          dateTime={new Date(ticket.createdAt).toISOString()}
          title={formatFull(ticket.createdAt)}
          className="col-start-2 row-start-2 justify-self-end font-condensed text-[14px] leading-[18px] font-semibold whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {formatDayTime(ticket.createdAt, now)}
        </time>
        <span className={cn(STATUS_WORD, status.ink, "col-start-2 row-start-1 justify-self-end text-right @xl:min-w-[4.75rem]")}>
          {status.label}
        </span>
      </div>
      <p
        ref={messageRef}
        id={messageId}
        className={cn(
          "col-span-2 text-[13px] leading-[19px] whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere] @xl:col-span-1",
          !open && "line-clamp-2",
        )}
      >
        {open ? ticket.message : preview}
      </p>
      {clamped || open ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={messageId}
          onClick={() => setOpen((value) => !value)}
          className="col-span-2 inline-flex min-h-6 items-center self-end justify-self-end rounded-sm text-[13px] font-medium text-foreground underline decoration-foreground/40 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring @xl:col-span-1 @xl:col-start-2"
        >
          {open ? "Show less" : "Show all"}
        </button>
      ) : null}
    </li>
  );
}

/** Whether a clamped paragraph hides text, rechecked as its width changes. */
function useIsClamped(ref: React.RefObject<HTMLElement | null>, open: boolean) {
  const [clamped, setClamped] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || open) return;
    const check = () => setClamped(element.scrollHeight > element.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, open]);
  return clamped;
}

function TicketRowsSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading support requests">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 border-b px-4 py-3 last:border-b-0">
          <div className="flex items-center gap-3">
            <Skeleton className="h-3.5 w-64 max-w-[60%]" />
            <Skeleton className="ml-auto h-3.5 w-14 @xl:w-28" />
          </div>
          {/* On a phone the sender and the time take a line of their own. */}
          <div className="flex items-center gap-3 @xl:hidden">
            <Skeleton className="h-3 w-40 max-w-[50%]" />
            <Skeleton className="ml-auto h-3 w-24" />
          </div>
          <Skeleton className="h-3 w-[85%]" />
          <Skeleton className="h-3 w-[55%] @xl:hidden" />
        </div>
      ))}
    </div>
  );
}
