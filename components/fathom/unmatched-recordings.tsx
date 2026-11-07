"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { getErrorMessage } from "@/lib/errors";

const AssignDialog = dynamic(() => import("./assign-recording-dialog"));

type Recording = FunctionReturnType<typeof api.fathom.recordings.unmatched>["recordings"][number];

const recordedAtFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Fathom recordings Magnus couldn't tie to a meeting: a labelled heading row,
 * then one ruled 44px row each with Assign and Not a sales call. Sits edge
 * to edge in a card.
 */
export function UnmatchedRecordingList({ recordings, capped = false }: { recordings: Recording[]; capped?: boolean }) {
  const attach = useMutation(api.fathom.recordings.attach);
  const [selected, setSelected] = useState<Recording>();
  const [busy, setBusy] = useState<string>();

  async function ignore(recording: Recording) {
    setBusy(recording.recordingId);
    try {
      await attach({ recordingId: recording.recordingId, notASalesCall: true });
    } catch (error) {
      toast.error(getErrorMessage(error, "Could not ignore recording."));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div>
      <div className="flex min-h-9 items-center gap-2 border-b border-border px-4 py-1">
        <span className={LABEL}>
          <HelpTip tip="Fathom recordings Magnus couldn't tie to a meeting by time and attendees. Assign each to its meeting, or mark it not a sales call.">
            Recordings without a meeting
          </HelpTip>
        </span>
        {recordings.length > 0 ? (
          <span className="font-condensed text-[13px] leading-none font-semibold text-warning-ink tabular-nums">
            {recordings.length}
            {capped ? "+" : ""}
          </span>
        ) : null}
      </div>
      {recordings.length === 0 ? (
        <p className="px-4 py-2.5 text-[13px] text-muted-foreground">Every recording has a meeting.</p>
      ) : (
        <ul>
          {recordings.map((recording) => (
            <li
              key={recording.recordingId}
              className="flex min-h-11 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-sm font-medium">{recording.title}</p>
                <p className="text-[13px] text-muted-foreground">
                  <span className="font-condensed text-[14px] tabular-nums">
                    {recordedAtFormat.format(recording.recordedAt)}
                  </span>{" "}
                  · <span className="font-condensed text-[14px] tabular-nums">{Math.round(recording.minutes)}</span> min
                </p>
              </div>
              <Button size="xs" variant="outline" onClick={() => setSelected(recording)}>
                Assign
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy === recording.recordingId}
                onClick={() => void ignore(recording)}
              >
                Not a sales call
              </Button>
            </li>
          ))}
        </ul>
      )}
      {capped ? (
        <p className="border-t border-border px-4 py-2 text-[13px] text-muted-foreground">
          Showing a partial list. Resolve these recordings to see more.
        </p>
      ) : null}
      {selected ? (
        <AssignDialog
          recording={selected}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

/** The closer's own unmatched recordings, under Needs outcome. Nothing when there are none. */
export function UnmatchedRecordings() {
  const result = useQuery(api.fathom.recordings.unmatched, {});
  if (!result || (!result.recordings.length && !result.capped)) return null;
  return (
    <div className="border-t border-border">
      <UnmatchedRecordingList recordings={result.recordings} capped={result.capped} />
    </div>
  );
}
