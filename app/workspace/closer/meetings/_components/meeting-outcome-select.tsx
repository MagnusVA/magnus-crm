"use client";

import { useState, useCallback } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import posthog from "posthog-js";

// ─── Config ─────────────────────────────────────────────────────────────────

const OUTCOME_OPTIONS = [
  {
    value: "interested",
    label: "Interested",
    badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
  {
    value: "needs_more_info",
    label: "Needs more info",
    badgeClass: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  },
  {
    value: "price_objection",
    label: "Price objection",
    badgeClass: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  {
    value: "not_qualified",
    label: "Not qualified",
    badgeClass: "bg-red-500/10 text-red-700 dark:text-red-400",
  },
  {
    value: "ready_to_buy",
    label: "Ready to buy",
    badgeClass: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  },
] as const;

export type MeetingOutcome = (typeof OUTCOME_OPTIONS)[number]["value"];

// ─── Component ──────────────────────────────────────────────────────────────

type MeetingOutcomeSelectProps = {
  meetingId: Id<"meetings">;
  currentOutcome: MeetingOutcome | undefined;
};

/**
 * Meeting Outcome Select — structured dropdown for classifying meetings.
 *
 * Auto-saves on selection change via updateMeetingOutcome mutation.
 * Shows a spinner while saving. Reverts on failure (Convex reactivity).
 */
export function MeetingOutcomeSelect({
  meetingId,
  currentOutcome,
}: MeetingOutcomeSelectProps) {
  const [isSaving, setIsSaving] = useState(false);
  const updateOutcome = useMutation(
    api.closer.meetingActions.updateMeetingOutcome,
  );

  const handleChange = useCallback(
    async (value: string) => {
      setIsSaving(true);
      try {
        await updateOutcome({
          meetingId,
          meetingOutcome: value as MeetingOutcome,
        });
        posthog.capture("meeting_outcome_set", {
          meeting_id: meetingId,
          outcome: value,
        });
        toast.success("Meeting outcome updated");
      } catch (error) {
        posthog.captureException(error);
        toast.error(
          error instanceof Error
            ? error.message
            : "Failed to update outcome",
        );
      } finally {
        setIsSaving(false);
      }
    },
    [meetingId, updateOutcome],
  );

  return (
    <div className="flex items-center gap-3">
      <p className="shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Outcome
      </p>
      <Select
        value={currentOutcome ?? ""}
        onValueChange={handleChange}
        disabled={isSaving}
      >
        <SelectTrigger className="w-[180px]" aria-label="Meeting outcome">
          {isSaving ? (
            <div className="flex items-center gap-2">
              <Spinner className="size-3" />
              <span className="text-xs">Saving...</span>
            </div>
          ) : (
            <SelectValue placeholder="Select outcome" />
          )}
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {OUTCOME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                <Badge
                  variant="secondary"
                  className={cn("text-xs", option.badgeClass)}
                >
                  {option.label}
                </Badge>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
