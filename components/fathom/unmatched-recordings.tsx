"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { getErrorMessage } from "@/lib/errors";

const AssignDialog = dynamic(() => import("./assign-recording-dialog"));
type Recording = FunctionReturnType<
  typeof api.fathom.recordings.unmatched
>["recordings"][number];
export function UnmatchedRecordingList({
  recordings,
  capped = false,
}: {
  recordings: Recording[];
  capped?: boolean;
}) {
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
    <div className="space-y-2">
      <h3 className="text-sm font-medium">
        Recordings without a meeting{" "}
        {recordings.length > 0 && `(${recordings.length}${capped ? "+" : ""})`}
      </h3>
      {recordings.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every recording has a meeting.
        </p>
      ) : (
        <ul className="divide-y">
          {recordings.map((r) => (
            <li
              key={r.recordingId}
              className="flex flex-wrap items-center gap-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.title}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(r.recordedAt).toLocaleString()} ·{" "}
                  {Math.round(r.minutes)} min
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setSelected(r)}
              >
                Assign
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === r.recordingId}
                onClick={() => ignore(r)}
              >
                Not a sales call
              </Button>
            </li>
          ))}
        </ul>
      )}
      {capped && (
        <p className="text-xs text-muted-foreground">
          Showing a partial list. Resolve these recordings to see more.
        </p>
      )}
      {selected && (
        <AssignDialog
          recording={selected}
          open
          onOpenChange={(open) => {
            if (!open) setSelected(undefined);
          }}
        />
      )}
    </div>
  );
}
export function UnmatchedRecordings() {
  const result = useQuery(api.fathom.recordings.unmatched, {});
  if (!result || (!result.recordings.length && !result.capped)) return null;
  return (
    <div className="border-t px-4 py-3">
      <UnmatchedRecordingList
        recordings={result.recordings}
        capped={result.capped}
      />
    </div>
  );
}
