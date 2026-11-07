"use client";

import type { ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRightIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DISPOSITION_LABELS, LIFECYCLE_STAGE_LABELS } from "@/convex/leads/lifecycle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useNow } from "@/hooks/use-now";
import { instagramProfileUrl, resparkBucketLabel } from "@/lib/respark/display";
import { meetingAttendanceDisplay, meetingStatusConfig, type MeetingAttendanceStatus } from "@/lib/status-config";
import { SectionErrorBoundary } from "../../_components/section-error-boundary";
import { cn } from "@/lib/utils";
import { CopyHandleButton } from "./copy-handle-button";
import { dealText, displayHandle, formatDay } from "./respark-format";
import { DATE, Fact, LABEL, None, STATUS_WORD, Swatch } from "./respark-ui";

type Panel = NonNullable<FunctionReturnType<typeof api.respark.queries.getResparkPersonPanel>>;

const RESULT_WORDS = {
  resparked: { word: "Entry", ink: "text-foreground" },
  not_a_fit: { word: "Not a fit", ink: "text-muted-foreground" },
  skipped: { word: "Skipped", ink: "text-muted-foreground" },
} as const;

// A call's attendance as one status word: a missed call in danger ink, a
// passed call with no result in amber, held and canceled in slate.
const ATTENDANCE_INK: Record<MeetingAttendanceStatus, string> = {
  scheduled: "text-foreground",
  held: "text-muted-foreground",
  canceled: "text-muted-foreground",
  no_show: "text-danger-ink",
  not_recorded: "text-warning-ink",
};

// The read-only person panel (docs/plans/respark.md §6.2). The server masks
// phone and email and leaves out payments, credit and admin links.
export function ResparkPersonSheet({
  itemId,
  bucket,
  timeZone,
  onClose,
}: {
  itemId: Id<"resparkBatchItems">;
  bucket: number;
  timeZone: string;
  onClose: () => void;
}) {
  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto sm:max-w-md">
        <SectionErrorBoundary key={itemId} sectionName="respark person panel">
          <PanelBody itemId={itemId} bucket={bucket} timeZone={timeZone} />
        </SectionErrorBoundary>
      </SheetContent>
    </Sheet>
  );
}

function PanelBody({ itemId, bucket, timeZone }: { itemId: Id<"resparkBatchItems">; bucket: number; timeZone: string }) {
  const panel = useQuery(api.respark.queries.getResparkPersonPanel, { itemId });

  if (panel === undefined) {
    return (
      <>
        <SheetHeader className="border-b">
          <SheetTitle>Loading person</SheetTitle>
          <SheetDescription className="sr-only">Read-only details for a person in your batch.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading person">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-5 w-full" />
          ))}
        </div>
      </>
    );
  }

  if (panel === null) {
    return (
      <SheetHeader>
        <SheetTitle>Person unavailable</SheetTitle>
        <SheetDescription>This person isn&apos;t in your batch anymore, or the batch ended with the business day.</SheetDescription>
      </SheetHeader>
    );
  }

  return <PanelContent panel={panel} bucket={bucket} timeZone={timeZone} />;
}

function PanelContent({ panel, bucket, timeZone }: { panel: Panel; bucket: number; timeZone: string }) {
  const now = useNow();
  const handle = displayHandle(panel.handle);
  const profileUrl = instagramProfileUrl(panel.handle);
  const worked = panel.resparkHistory.flatMap((entry) =>
    entry.result !== null && entry.workedAt !== null ? [{ ...entry, result: entry.result, workedAt: entry.workedAt }] : []);

  return (
    <>
      <SheetHeader className="gap-1.5 border-b px-4 pt-4 pb-3 pr-12">
        <SheetTitle className="truncate text-lg leading-tight font-semibold">
          {handle ?? panel.identity.name ?? "No Instagram handle"}
        </SheetTitle>
        <SheetDescription className="sr-only">Read-only details for a person in your batch.</SheetDescription>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn(STATUS_WORD, "text-foreground")}>{LIFECYCLE_STAGE_LABELS[panel.stage]}</span>
          {panel.disposition !== "open" ? (
            <span className={cn(STATUS_WORD, panel.disposition === "do_not_contact" ? "text-danger-ink" : "text-muted-foreground")}>
              {DISPOSITION_LABELS[panel.disposition]}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Swatch bucket={bucket} />
            {resparkBucketLabel(bucket)}
          </span>
        </p>
        {panel.dispositionReason ? <p className="text-[13px] text-muted-foreground">{panel.dispositionReason}</p> : null}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <CopyHandleButton handle={panel.handle} />
          {profileUrl ? (
            <Button variant="outline" size="xs" asChild>
              <a href={profileUrl} target="_blank" rel="noopener noreferrer">
                Open Instagram
                <ArrowUpRightIcon data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
        </div>
      </SheetHeader>

      {panel.capped ? (
        <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">Older history left out.</p>
      ) : null}

      <Section title="Identity">
        <dl className="px-4 py-1">
          <Fact label="Instagram">{handle ?? <None />}</Fact>
          {panel.identity.name ? <Fact label="Name">{panel.identity.name}</Fact> : null}
          <Fact label="Phone">
            {panel.identity.phone ? <span className="font-condensed text-[15px] font-semibold tabular-nums">{panel.identity.phone}</span> : <None />}
          </Fact>
          <Fact label="Email">{panel.identity.email ?? <None />}</Fact>
          <Fact label="Time zone">{panel.timeZone ? `${panel.timeZone.replaceAll("_", " ")}, from the booking` : <None>Unknown</None>}</Fact>
        </dl>
      </Section>

      <Section title="Every touch" count={panel.timeline.length}>
        {panel.timeline.length === 0 ? <Empty text="No touches on record." /> : (
          <ol>
            {panel.timeline.map((touch) => (
              <DatedRow key={touch.eventId} at={touch.occurredAt} timeZone={timeZone}>
                {touch.label}
              </DatedRow>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Deals and calls">
        {panel.deals.length === 0 && panel.calls.length === 0 ? <Empty text="No deals." /> : (
          <ol>
            {panel.deals.map((deal) => (
              <DatedRow key={deal.opportunityId} at={deal.createdAt} timeZone={timeZone}>
                <span className="text-muted-foreground">Deal · </span>
                {dealText(deal)}
              </DatedRow>
            ))}
            {panel.calls.map((call) => {
              const attendance = meetingAttendanceDisplay(call, now);
              return (
                <DatedRow key={call.meetingId} at={call.scheduledAt} timeZone={timeZone}>
                  <span className="flex items-baseline gap-2">
                    <span className="text-muted-foreground">Call</span>
                    <span className={cn(STATUS_WORD, ATTENDANCE_INK[attendance])}>
                      {meetingStatusConfig[attendance].label}
                    </span>
                  </span>
                  {call.bookingAnswers.length > 0 ? (
                    <dl className="mt-1 mb-0.5 flex flex-col gap-1 border-l-2 pl-2.5 text-[13px]">
                      {call.bookingAnswers.map((answer, index) => (
                        <div key={index}>
                          <dt className="text-muted-foreground">{answer.question}</dt>
                          <dd className="whitespace-pre-wrap">{answer.answer}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </DatedRow>
              );
            })}
          </ol>
        )}
      </Section>

      <Section title="Opener notes">
        {panel.notes.length === 0 ? <Empty text="No notes." /> : (
          <ol>
            {panel.notes.map((note) => (
              <DatedRow key={note.noteId} at={note.createdAt} timeZone={timeZone}>
                <span className="whitespace-pre-wrap">{note.content}</span>
              </DatedRow>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Respark history">
        {worked.length === 0 ? <Empty text="Never resparked." /> : (
          <ol>
            {worked.map((entry) => (
              <DatedRow key={entry.itemId} at={entry.workedAt} timeZone={timeZone}>
                <span className="flex items-center gap-2">
                  <span className={cn(STATUS_WORD, "w-[4.5rem]", RESULT_WORDS[entry.result].ink)}>
                    {RESULT_WORDS[entry.result].word}
                  </span>
                  <Swatch bucket={entry.bucket} />
                  <span className="truncate text-[13px] text-muted-foreground">{resparkBucketLabel(entry.bucket)}</span>
                </span>
              </DatedRow>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}

/** A group of rows under an 11px label that sits on the rule above them. */
function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="border-b last:border-b-0">
      <h3 className={cn(LABEL, "flex min-h-7 items-end px-4 pt-2.5 pb-1")}>
        {title}
        {count ? <span className="ml-1.5 tabular-nums"> · {count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** One ruled 32px row: a condensed slate date column, then the fact. */
function DatedRow({ at, timeZone, children }: { at: number; timeZone: string; children: ReactNode }) {
  return (
    <li className="grid min-h-8 grid-cols-[3.75rem_minmax(0,1fr)] items-baseline gap-x-2 border-t px-4 py-1.5 text-sm leading-5">
      <time dateTime={new Date(at).toISOString()} className={DATE}>
        {formatDay(at, timeZone)}
      </time>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <p className="border-t px-4 py-1.5 text-[13px] leading-5 text-muted-foreground">{text}</p>;
}
