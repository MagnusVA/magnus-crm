"use client";

import { useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ExternalLinkIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DISPOSITION_LABELS, LIFECYCLE_STAGE_LABELS } from "@/convex/leads/lifecycle";
import { Badge } from "@/components/ui/badge";
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
import { meetingAttendanceDisplay, meetingStatusConfig } from "@/lib/status-config";
import { SectionErrorBoundary } from "../../_components/section-error-boundary";
import { cn } from "@/lib/utils";
import { CopyHandleButton } from "./copy-handle-button";
import { bucketSwatchClass, dealText, displayHandle, formatDay } from "./respark-format";

type Panel = NonNullable<FunctionReturnType<typeof api.respark.queries.getResparkPersonPanel>>;

const RESULT_LABELS = { resparked: "Resparked", not_a_fit: "Not a fit", skipped: "Skipped" } as const;

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
        <div className="flex flex-col gap-3 p-4" role="status" aria-label="Loading person">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
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
      <SheetHeader className="gap-3 border-b pr-12">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SheetTitle className="text-lg">{handle ?? panel.identity.name ?? "No Instagram handle"}</SheetTitle>
          <div className="flex items-center gap-2">
            <CopyHandleButton handle={panel.handle} />
            {profileUrl ? (
              <Button variant="outline" size="sm" asChild>
                <a href={profileUrl} target="_blank" rel="noopener noreferrer">
                  Open Instagram
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            ) : null}
          </div>
        </div>
        <SheetDescription className="sr-only">Read-only details for a person in your batch.</SheetDescription>
        <div className="flex flex-wrap gap-1.5">
          <Badge>{LIFECYCLE_STAGE_LABELS[panel.stage]}</Badge>
          <Badge variant="outline">{DISPOSITION_LABELS[panel.disposition]}</Badge>
          <Badge variant="outline">
            <span aria-hidden="true" className={cn("size-2 rounded-[2px]", bucketSwatchClass(bucket))} />
            {resparkBucketLabel(bucket)}
          </Badge>
        </div>
        {panel.dispositionReason ? (
          <p className="text-sm text-muted-foreground">{panel.dispositionReason}</p>
        ) : null}
      </SheetHeader>

      <div className="flex flex-col gap-5 p-4">
        {panel.capped ? (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">Older history omitted.</p>
        ) : null}

        <PanelSection title="Identity">
          <Row label="Instagram" value={handle ?? "None"} />
          {panel.identity.name ? <Row label="Name" value={panel.identity.name} /> : null}
          <Row label="Phone" value={panel.identity.phone ?? "None"} />
          <Row label="Email" value={panel.identity.email ?? "None"} />
          <Row label="Time zone" value={panel.timeZone ? `${panel.timeZone}, from the booking` : "Unknown"} />
        </PanelSection>

        <PanelSection title="Every touch">
          {panel.timeline.length === 0 ? <Empty text="No touches on record." /> : panel.timeline.map((touch) => (
            <Row key={touch.eventId} label={touch.label} value={formatDay(touch.occurredAt, timeZone)} />
          ))}
        </PanelSection>

        <PanelSection title="Deals and calls">
          {panel.deals.length === 0 && panel.calls.length === 0 ? <Empty text="No deals." /> : null}
          {panel.deals.map((deal) => (
            <Row key={deal.opportunityId} label={`Deal · ${dealText(deal)}`} value={formatDay(deal.createdAt, timeZone)} />
          ))}
          {panel.calls.map((call) => (
            <li key={call.meetingId} className="flex flex-col gap-1 py-1.5">
              <div className="flex justify-between gap-3">
                <span>Call · {meetingStatusConfig[meetingAttendanceDisplay(call, now)].label}</span>
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatDay(call.scheduledAt, timeZone)}</span>
              </div>
              {call.bookingAnswers.length > 0 ? (
                <dl className="flex flex-col gap-1 rounded-md bg-muted/50 px-3 py-2 text-xs">
                  {call.bookingAnswers.map((answer, index) => (
                    <div key={index}>
                      <dt className="text-muted-foreground">{answer.question}</dt>
                      <dd className="whitespace-pre-wrap">{answer.answer}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          ))}
        </PanelSection>

        <PanelSection title="Opener notes">
          {panel.notes.length === 0 ? <Empty text="No notes." /> : panel.notes.map((note) => (
            <li key={note.noteId} className="flex justify-between gap-3 py-1.5">
              <span className="min-w-0 whitespace-pre-wrap">{note.content}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">{formatDay(note.createdAt, timeZone)}</span>
            </li>
          ))}
        </PanelSection>

        <PanelSection title="Respark history">
          {worked.length === 0 ? <Empty text="Never resparked." /> : worked.map((entry) => (
            <Row
              key={entry.itemId}
              label={`${RESULT_LABELS[entry.result]} · ${resparkBucketLabel(entry.bucket)}`}
              value={formatDay(entry.workedAt, timeZone)}
            />
          ))}
        </PanelSection>
      </div>
    </>
  );
}

function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="flex flex-col divide-y text-sm">{children}</ul>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex justify-between gap-3 py-1.5">
      <span className="min-w-0">{label}</span>
      <span className="shrink-0 text-right text-muted-foreground tabular-nums">{value}</span>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="py-1.5 text-muted-foreground">{text}</li>;
}
