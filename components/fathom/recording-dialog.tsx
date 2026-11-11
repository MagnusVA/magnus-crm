"use client";

import { ExternalLinkIcon } from "lucide-react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RecordingSummary } from "./recording-summary";

type Recording = NonNullable<
  FunctionReturnType<typeof api.fathom.recordings.forMeeting>
>;

/** The recording's full summary and action items, opened from the recording card. */
export default function RecordingDialog({
  recording,
  open,
  onOpenChange,
}: {
  recording: Recording;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-6 py-4 pr-12">
          <DialogTitle className="text-base leading-snug">
            {recording.title}
          </DialogTitle>
          <DialogDescription>
            Fathom recording ·{" "}
            {new Date(recording.recordedAt).toLocaleString()} ·{" "}
            {Math.round(recording.minutes)} min
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex-1 space-y-6 overflow-y-auto px-6 py-5"
          tabIndex={0}
          role="region"
          aria-label="Recording summary"
        >
          {recording.summary ? (
            <RecordingSummary
              markdown={recording.summary}
              className="text-[0.9375rem]"
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Fathom has no summary for this recording.
            </p>
          )}
          {recording.actionItems.length > 0 && (
            <section className="space-y-2 border-t pt-5">
              <h3 className="text-[0.9375rem] font-semibold">Action items</h3>
              <ul className="list-disc space-y-1.5 pl-5 text-[0.9375rem] leading-relaxed marker:text-muted-foreground">
                {recording.actionItems.map((item, i) => (
                  <li key={i}>{item.description}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
          <Button variant="outline" asChild>
            <a href={recording.url} target="_blank" rel="noopener noreferrer">
              Open in Fathom
              <ExternalLinkIcon data-icon="inline-end" aria-hidden />
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
