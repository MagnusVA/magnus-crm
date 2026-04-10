"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { format } from "date-fns";
import {
  MeetingOutcomeSelect,
  type MeetingOutcome,
} from "./meeting-outcome-select";

const DEBOUNCE_MS = 800;
const SAVED_INDICATOR_MS = 2000;

type MeetingNotesProps = {
  meetingId: Id<"meetings">;
  initialNotes: string;
  meetingOutcome: MeetingOutcome | undefined;
};

/**
 * Meeting Notes — auto-saving textarea on the meeting detail page.
 *
 * - Debounced saves (800 ms) to avoid excessive mutations
 * - "Saving…" / "✓ Saved" visual feedback with auto-clear
 * - Syncs from the latest parent-provided value when the user is idle
 * - Textarea is **never** disabled — the closer can always keep typing
 */
export function MeetingNotes({ meetingId, initialNotes, meetingOutcome }: MeetingNotesProps) {
  const [notes, setNotes] = useState(initialNotes);
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const updateNotes = useMutation(api.closer.meetingActions.updateMeetingNotes);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const savedTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isEditingRef = useRef(false);
  const lastSavedRef = useRef(initialNotes);

  // Debounced auto-save
  const handleChange = useCallback(
    (value: string) => {
      setNotes(value);
      setErrorMessage(null);
      isEditingRef.current = true;

      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);

      // Skip save if value matches what we last persisted
      if (value === lastSavedRef.current) {
        isEditingRef.current = false;
        return;
      }

      debounceRef.current = setTimeout(async () => {
        setSaveStatus("saving");
        try {
          await updateNotes({ meetingId, notes: value });
          lastSavedRef.current = value;
          setLastSavedAt(Date.now());
          setSaveStatus("saved");
          savedTimerRef.current = setTimeout(
            () => setSaveStatus("idle"),
            SAVED_INDICATOR_MS,
          );
        } catch (error) {
          setSaveStatus("error");
          setErrorMessage(
            error instanceof Error
              ? error.message
              : "Failed to save. Please try again.",
          );
        } finally {
          isEditingRef.current = false;
        }
      }, DEBOUNCE_MS);
    },
    [meetingId, updateNotes],
  );

  // Sync from the latest parent-provided value when not actively editing.
  useEffect(() => {
    if (!isEditingRef.current) {
      setNotes(initialNotes);
      lastSavedRef.current = initialNotes;
    }
  }, [initialNotes]);

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Meeting Notes</CardTitle>
          <SaveIndicator status={saveStatus} lastSavedAt={lastSavedAt} />
        </div>
        {errorMessage && (
          <p className="mt-1 text-xs text-destructive">{errorMessage}</p>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Meeting Outcome Select */}
        <MeetingOutcomeSelect
          meetingId={meetingId}
          currentOutcome={meetingOutcome}
        />

        <Textarea
          value={notes}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Add notes about this meeting. Changes auto-save as you type…"
          className="min-h-[150px] resize-y"
          aria-label="Meeting notes"
        />
      </CardContent>
    </Card>
  );
}

// ─── Internal ────────────────────────────────────────────────────────────────

function SaveIndicator({
  status,
  lastSavedAt,
}: {
  status: "idle" | "saving" | "saved" | "error";
  lastSavedAt: number | null;
}) {
  if (status === "idle") return null;

  return (
    <div className="flex items-center gap-1.5" aria-live="polite">
      {status === "saving" && (
        <>
          <Spinner className="size-3" />
          <span className="text-xs font-medium text-muted-foreground">
            Saving…
          </span>
        </>
      )}
      {status === "saved" && (
        <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
          ✓ Saved{lastSavedAt ? ` at ${format(lastSavedAt, "h:mm a")}` : ""}
        </span>
      )}
    </div>
  );
}
