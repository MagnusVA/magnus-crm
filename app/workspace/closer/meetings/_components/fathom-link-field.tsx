"use client";

import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { format } from "date-fns";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  LinkIcon,
  SaveIcon,
} from "lucide-react";
import posthog from "posthog-js";

import type { Id } from "@/convex/_generated/dataModel";
import { api } from "@/convex/_generated/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
      posthog.captureException(err);
      setSaveStatus("error");
      setErrorMessage(
        err instanceof Error
          ? err.message
          : "Failed to save. Please try again.",
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
    <Card size="sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <CardTitle className="flex cursor-default items-center gap-2 text-sm">
                <LinkIcon className="size-4 text-muted-foreground" aria-hidden />
                Fathom Recording
              </CardTitle>
            </TooltipTrigger>
            <TooltipContent side="top">
              Paste the Fathom recording link for this meeting
            </TooltipContent>
          </Tooltip>
          <StatusIndicator status={saveStatus} savedAt={savedAt} />
        </div>
      </CardHeader>
      <CardContent>
        <Label htmlFor={inputId} className="sr-only">
          Fathom recording URL
        </Label>
        <InputGroup
          className={cn(saveStatus === "error" && "border-destructive")}
        >
          <InputGroupInput
            id={inputId}
            type="url"
            inputMode="url"
            placeholder="https://fathom.video/call/..."
            value={value}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={saveStatus === "saving"}
            aria-invalid={saveStatus === "error"}
            aria-describedby={errorMessage ? errorId : undefined}
            className="font-mono text-xs"
          />
          <InputGroupAddon align="inline-end">
            <Button
              type="button"
              size="sm"
              className="h-6 px-2"
              onClick={handleSave}
              disabled={
                saveStatus === "saving" || isEmpty || !hasUnsavedChanges
              }
            >
              {saveStatus === "saving" ? (
                <Spinner className="size-3.5" />
              ) : (
                <>
                  <SaveIcon data-icon="inline-start" aria-hidden />
                  Save
                </>
              )}
            </Button>
          </InputGroupAddon>
        </InputGroup>
        {errorMessage && (
          <p
            id={errorId}
            role="alert"
            className="mt-1.5 flex items-center gap-1 text-xs text-destructive"
          >
            <AlertTriangleIcon className="size-3 shrink-0" aria-hidden />
            {errorMessage}
          </p>
        )}
      </CardContent>
    </Card>
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
        className="flex items-center gap-1 text-xs text-muted-foreground"
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
        className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"
        aria-live="polite"
      >
        <CheckCircle2Icon className="size-3 shrink-0" aria-hidden />
        Saved {format(new Date(savedAt), "h:mm a")}
      </span>
    );
  }
  return null;
}
