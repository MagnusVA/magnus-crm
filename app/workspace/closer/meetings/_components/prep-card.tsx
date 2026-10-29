"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DetailCard } from "./detail-card";

/** Character threshold above which an answer gets a "Show more" toggle. */
const LONG_ANSWER_THRESHOLD = 160;

const NOTE_TIME = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const NOTE_TIME_FULL = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
});

type PrepCardProps = {
  leadId: Id<"leads">;
  answers: Array<{
    fieldKey: string;
    question: string;
    answer: string;
    capturedAt: number;
  }>;
};

/**
 * What the closer reads before dialing: the Calendly booking answers, then
 * the notes DM closers left in the link portal (`api.leads.notes.listLeadNotes`,
 * open to closers and admins).
 */
export function PrepCard({ leadId, answers }: PrepCardProps) {
  const notes = useQuery(api.leads.notes.listLeadNotes, { leadId });
  const entries = answers.filter(({ answer }) => answer.trim().length > 0);

  return (
    <DetailCard
      title="Prep"
      meta={<span>From the booking form and the DM portal</span>}
    >
      {entries.length === 0 ? (
        <p className="px-4 py-3 text-muted-foreground">
          No answers stored for this booking.
        </p>
      ) : (
        <dl className="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
          {entries.map(({ fieldKey, question, answer, capturedAt }) => (
            <div key={`${capturedAt}:${fieldKey}`} className="contents">
              <dt className="text-muted-foreground max-sm:mt-1.5">
                {question}
              </dt>
              {answer.length > LONG_ANSWER_THRESHOLD ? (
                <CollapsibleAnswer answer={answer} />
              ) : (
                <dd className="font-medium wrap-break-word">{answer}</dd>
              )}
            </div>
          ))}
        </dl>
      )}

      {notes === undefined ? (
        <div
          role="status"
          aria-label="Loading DM notes"
          className="flex flex-col gap-2 border-t px-4 py-3"
        >
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-full" />
        </div>
      ) : notes.length === 0 ? (
        <p className="border-t px-4 py-3 text-muted-foreground">
          No DM notes yet. DM closers add them from the link portal.
        </p>
      ) : (
        <ul aria-label="DM notes">
          {notes.map((note) => (
            <li key={note.noteId} className="border-t px-4 py-2.5">
              <p className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="font-semibold">{note.authorLabel}</span>
                <span className="text-[0.8125rem] text-muted-foreground">
                  {note.authorKind === "dm_closer" ? "DM closer" : "Team"} ·{" "}
                  <time
                    dateTime={new Date(note.createdAt).toISOString()}
                    title={NOTE_TIME_FULL.format(note.createdAt)}
                  >
                    {NOTE_TIME.format(note.createdAt)}
                  </time>
                </span>
              </p>
              <p className="mt-0.5 whitespace-pre-wrap wrap-break-word">
                {note.content}
              </p>
            </li>
          ))}
        </ul>
      )}
    </DetailCard>
  );
}

function CollapsibleAnswer({ answer }: { answer: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <dd className="font-medium">
        <p className={cn("wrap-break-word", !open && "line-clamp-3")}>{answer}</p>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="mt-1 inline-flex min-h-6 items-center gap-1 rounded text-[0.8125rem] font-semibold text-primary-ink hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {open ? "Show less" : "Show more"}
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 transition-transform", open && "rotate-180")}
            />
          </button>
        </CollapsibleTrigger>
      </dd>
    </Collapsible>
  );
}
