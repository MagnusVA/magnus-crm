"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { toast } from "sonner";
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react";
import posthog from "posthog-js";
import { reportClientError } from "@/lib/observability/report-client-error";

import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";
import { DetailCard } from "./detail-card";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SaveStatus = "idle" | "saving" | "saved" | "error";

type FathomLinkFieldProps = {
  meetingId: Id<"meetings">;
  /** Current value of `meeting.fathomLink` (may be empty string). */
  initialLink: string;
  /** Current value of `meeting.fathomLinkSavedAt` (may be undefined). */
  savedAt: number | undefined;
};

// ---------------------------------------------------------------------------
// Component
//
// The Fathom recording link is available on every meeting. We expose an
// explicit Save button because the link is a discrete artifact: the
// closer pastes once, clicks Save, and the value sticks.
//
// Keyboard support: Enter submits (when saveable), Escape resets to the
// last persisted value.
// ---------------------------------------------------------------------------

export function FathomLinkField({
  meetingId,
  initialLink,
  savedAt: initialSavedAt,
}: FathomLinkFieldProps) {
  const [value, setValue] = useState(initialLink);
  const [savedAt, setSavedAt] = useState<number | undefined>(initialSavedAt);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const saveFathomLink = useMutation(api.closer.meetingActions.saveFathomLink);

  const trimmed = value.trim();
  const isEmpty = trimmed.length === 0;
  const hasUnsavedChanges = trimmed !== initialLink.trim();

  const handleSave = useCallback(async () => {
    const next = value.trim();
    if (!next) {
      setErrorMessage("Fathom link is required");
      setSaveStatus("error");
      return;
    }
    setErrorMessage(null);
    setSaveStatus("saving");
    try {
      await saveFathomLink({ meetingId, fathomLink: next });
      const now = Date.now();
      setSavedAt(now);
      setSaveStatus("saved");
      // PostHog: track that a link was saved (never log the URL value — privacy).
      posthog.capture("meeting_fathom_link_saved", {
        meeting_id: meetingId,
        has_link: true,
      });
      toast.success("Fathom link saved");
    } catch (err) {
      reportClientError(err, { flow: "meeting_fathom_link_save" });
      setSaveStatus("error");
      setErrorMessage(
        getErrorMessage(err, "Failed to save. Please try again."),
      );
    }
  }, [meetingId, saveFathomLink, value]);

  const handleChange = useCallback(
    (next: string) => {
      setValue(next);
      if (errorMessage) setErrorMessage(null);
      if (saveStatus === "saved" || saveStatus === "error") {
        setSaveStatus("idle");
      }
    },
    [errorMessage, saveStatus],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (hasUnsavedChanges && !isEmpty && saveStatus !== "saving") {
          void handleSave();
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        handleChange(initialLink);
      }
    },
    [hasUnsavedChanges, isEmpty, saveStatus, handleSave, handleChange, initialLink],
  );

  const inputId = `fathom-link-${meetingId}`;
  const errorId = `fathom-link-error-${meetingId}`;

  return (
    <DetailCard
      title="Fathom recording"
      meta={<StatusIndicator status={saveStatus} savedAt={savedAt} />}
    >
      <div className="flex flex-col gap-1.5 px-4 py-3">
        <Label htmlFor={inputId} className="sr-only">
          Fathom recording URL
        </Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            type="url"
            inputMode="url"
            placeholder="https://fathom.video/call/…"
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saveStatus === "saving"}
            aria-invalid={saveStatus === "error"}
            aria-describedby={errorMessage ? errorId : undefined}
            className="h-8 min-w-0 flex-1"
          />
          <Button
            type="button"
            variant={hasUnsavedChanges && !isEmpty ? "default" : "outline"}
            onClick={handleSave}
            disabled={saveStatus === "saving" || isEmpty || !hasUnsavedChanges}
          >
            {saveStatus === "saving" ? (
              <Spinner data-icon="inline-start" aria-hidden />
            ) : null}
            Save
          </Button>
        </div>
        {errorMessage && (
          <p
            id={errorId}
            role="alert"
            className="flex items-center gap-1 text-[0.8125rem] text-danger-ink"
          >
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            {errorMessage}
          </p>
        )}
      </div>
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// StatusIndicator — small inline signal (right of card title)
// ---------------------------------------------------------------------------

function StatusIndicator({
  status,
  savedAt,
}: {
  status: SaveStatus;
  savedAt: number | undefined;
}) {
  if (status === "saving") {
    return (
      <span
        className="flex items-center gap-1"
        aria-live="polite"
      >
        <Spinner className="size-3" aria-hidden />
        Saving…
      </span>
    );
  }
  if ((status === "saved" || status === "idle") && savedAt) {
    return (
      <span
        className="flex items-center gap-1 text-primary-ink"
        aria-live="polite"
      >
        <CheckCircle2Icon className="size-3 shrink-0" aria-hidden />
        Saved {format(new Date(savedAt), "h:mm a")}
      </span>
    );
  }
  return null;
}
