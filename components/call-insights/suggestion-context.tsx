"use client";

import { useState, type ReactNode } from "react";
import { format } from "date-fns";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type {
  FromSuggestion,
  SuggestionValues,
} from "@/convex/callInsights/validators";
import {
  LOSS_CATEGORIES,
  type SuggestionKind,
} from "@/lib/callInsights/taxonomy";
import { changedFields } from "@/lib/callInsights/display";
import { Button } from "@/components/ui/button";

/**
 * The contract between the suggested-result card and the outcome dialogs.
 *
 * `OutcomeSection` owns the dialogs and their lifetimes, so the card never
 * opens a form itself: it hands `OutcomeSection` a `SuggestionPrefill`, which
 * opens that dialog and passes it a `DialogSuggestion`. The dialog fills its
 * fields from `opened`, watches `latest` (the live query) for a new reading,
 * and on save sends `fromSuggestion` built by `useSuggestionRef`.
 */

export type MeetingSuggestion = NonNullable<
  FunctionReturnType<typeof api.callInsights.queries.suggestionForMeeting>
>;

export type SuggestionDialog = "payment" | "follow_up" | "lost" | "no_show";

export type SuggestionPrefill = {
  dialog: SuggestionDialog;
  from: { stateId: Id<"resultSuggestionStates">; revision: number };
  /** Only this dialog's fields, and only for a ready suggestion. */
  values: SuggestionValues;
  /** The payment amount heard on the call, shown as a hint when it isn't filled. */
  amountHintMinor?: number;
  /** Fill the amount field. Off: leave it empty and show the hint. */
  amountPrefill: boolean;
  /** The no-show dialog's one-step form (reason and Save). */
  compact?: boolean;
};

/** What a dialog opened from a suggestion receives. */
export type DialogSuggestion = {
  /** The prefill the dialog opened with. */
  opened: SuggestionPrefill;
  /** The live suggestion for this dialog: undefined while loading, null once it is gone. */
  latest: SuggestionPrefill | null | undefined;
};

const DIALOG_FIELDS: Record<SuggestionDialog, (keyof SuggestionValues)[]> = {
  payment: [
    "amountMinor",
    "currency",
    "currencyAssumed",
    "paymentType",
    "programId",
  ],
  follow_up: ["callbackAt", "contactMethod"],
  lost: ["lossCategory"],
  no_show: ["noShowReason"],
};

/** Which suggestion kinds each dialog can carry: a promise can also become a reminder. */
const DIALOG_KINDS: Record<SuggestionDialog, SuggestionKind[]> = {
  payment: ["paid", "promised"],
  follow_up: ["call_back", "promised"],
  lost: ["lost"],
  no_show: ["no_show"],
};

/**
 * The prefill a dialog gets from a live suggestion. Values come only from a
 * ready suggestion, and only the dialog's own fields. Null when the
 * suggestion's kind no longer belongs in this dialog.
 */
export function prefillFor(
  suggestion: MeetingSuggestion,
  dialog: SuggestionDialog,
  options: { compact?: boolean } = {},
): SuggestionPrefill | null {
  if (!DIALOG_KINDS[dialog].includes(suggestion.kind)) return null;
  const values: SuggestionValues = {};
  if (suggestion.tier === "ready") {
    for (const field of DIALOG_FIELDS[dialog]) {
      if (suggestion.values[field] !== undefined)
        Object.assign(values, { [field]: suggestion.values[field] });
    }
  }
  return {
    dialog,
    from: { stateId: suggestion.stateId, revision: suggestion.revision },
    values,
    amountHintMinor:
      dialog === "payment" && suggestion.tier === "ready"
        ? suggestion.amountHintMinor
        : undefined,
    amountPrefill: suggestion.amountPrefill,
    compact: options.compact,
  };
}

/**
 * Tracks which reading a dialog's form follows. `prefill` is the reading the
 * fields are compared against on save; it starts as the one the dialog opened
 * with. When the live reading gets a new revision, `changed` is true until
 * the person picks "Use the new values" (`applyNew`, which hands the new prefill
 * to `apply`) or "Keep my values" (`keepMine`); both move to the new revision.
 * `applied` is the prefill last put in the form: the opening one, or the new
 * one after "Use the new values". When the suggestion is gone, `ref` returns
 * undefined and the save goes through without it.
 */
export function useSuggestionRef(
  suggestion: DialogSuggestion | undefined,
  apply: (prefill: SuggestionPrefill) => void = () => undefined,
) {
  const opened = suggestion?.opened ?? null;
  const [current, setCurrent] = useState<SuggestionPrefill | null>(opened);
  const [applied, setApplied] = useState<SuggestionPrefill | null>(opened);
  const [seen, setSeen] = useState<SuggestionPrefill | null>(opened);
  // A new opening starts from what it opened with.
  if (opened !== seen) {
    setSeen(opened);
    setCurrent(opened);
    setApplied(opened);
  }
  const latest = suggestion?.latest;
  const gone = suggestion !== undefined && latest === null;
  const changed =
    !!current && !!latest && latest.from.revision !== current.from.revision;

  return {
    /** The reading the form is compared against, or null when there is none. */
    prefill: gone ? null : current,
    applied,
    changed,
    applyNew: () => {
      if (!latest) return;
      setCurrent(latest);
      setApplied(latest);
      apply(latest);
    },
    keepMine: () => {
      if (latest) setCurrent(latest);
    },
    /** The save's `fromSuggestion`, or undefined when the save isn't from a live suggestion. */
    ref: (changedFields: string[]): FromSuggestion | undefined =>
      gone || !current
        ? undefined
        : {
            stateId: current.from.stateId,
            revision: current.from.revision,
            changedFields,
          },
  };
}

/** The dialog header's "From the call" chip. */
export function FromCallBadge() {
  return (
    <span className="ml-2 inline-flex h-5 shrink-0 translate-y-[-1px] items-center rounded bg-primary/15 px-1.5 align-middle font-condensed text-[0.6875rem] font-bold tracking-[0.1em] whitespace-nowrap text-primary-ink uppercase">
      From the call
    </span>
  );
}

/** A dialog title with the "From the call" chip after it when it opened from a suggestion. */
export function withFromCall(title: ReactNode, fromCall: boolean): ReactNode {
  if (!fromCall) return title;
  return (
    <>
      {title}
      <FromCallBadge />
    </>
  );
}

/** The ruled notice a dialog shows when the call's reading changes under it. */
export function ReadingChangedNotice({
  onUseNew,
  onKeep,
  disabled,
}: {
  onUseNew: () => void;
  onKeep: () => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-warning-surface px-4 py-3 text-[13px] leading-[1.45] font-medium text-warning-ink"
    >
      <span className="min-w-0 flex-1 basis-48">
        The reading of this call changed.
      </span>
      <span className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onUseNew}
          disabled={disabled}
        >
          Use the new values
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onKeep}
          disabled={disabled}
        >
          Keep my values
        </Button>
      </span>
    </div>
  );
}

/** A hint line under a prefilled field. */
export function PrefillHint({ children }: { children: ReactNode }) {
  return (
    <span className="text-[13px] leading-[1.45] text-muted-foreground">
      {children}
    </span>
  );
}

// ─── The follow-up dialog's reminder path ───────────────────────────────────

/** The reminder form's fields from a call-back suggestion, in the viewer's time zone. */
export type ReminderPrefill = {
  /** Changes whenever the form should take these values again. */
  key: string;
  date: string;
  time: string;
  contactMethod?: "call" | "text";
};

/** What `FollowUpDialogShell` takes when it opened from a suggestion. */
export type FollowUpSuggestion = {
  reminder: ReminderPrefill | null;
  changed: boolean;
  onUseNew: () => void;
  onKeep: () => void;
};

const minuteOf = (at: number) => format(at, "yyyy-MM-dd'T'HH:mm");

function reminderFields(prefill: SuggestionPrefill) {
  return {
    callbackAt:
      prefill.values.callbackAt !== undefined
        ? minuteOf(prefill.values.callbackAt)
        : undefined,
    contactMethod: prefill.values.contactMethod,
  };
}

/**
 * The follow-up dialogs' side of the contract: the reminder prefill for the
 * shell, and the `fromSuggestion` for a reminder or a link saved from it.
 * Compared by the minute, since the form holds a date and a time.
 */
export function useFollowUpSuggestion(
  suggestion: DialogSuggestion | undefined,
) {
  const reading = useSuggestionRef(suggestion);
  const applied = reading.applied;
  const shell: FollowUpSuggestion | undefined = suggestion
    ? {
        reminder:
          applied && applied.values.callbackAt !== undefined
            ? {
                key: `${applied.from.revision}:${applied.values.callbackAt}:${applied.values.contactMethod ?? ""}`,
                date: format(applied.values.callbackAt, "yyyy-MM-dd"),
                time: format(applied.values.callbackAt, "HH:mm"),
                contactMethod: applied.values.contactMethod,
              }
            : applied?.values.contactMethod
              ? {
                  key: `${applied.from.revision}:${applied.values.contactMethod}`,
                  date: "",
                  time: "",
                  contactMethod: applied.values.contactMethod,
                }
              : null,
        changed: reading.changed,
        onUseNew: reading.applyNew,
        onKeep: reading.keepMine,
      }
    : undefined;
  return {
    shell,
    forReminder: (reminder: {
      contactMethod: "call" | "text";
      reminderScheduledAt: number;
    }) =>
      reading.prefill
        ? reading.ref(
            changedFields(reminderFields(reading.prefill), {
              callbackAt: minuteOf(reminder.reminderScheduledAt),
              contactMethod: reminder.contactMethod,
            }),
          )
        : undefined,
    // A link in place of the suggested reminder uses none of its values.
    forLink: () =>
      reading.prefill
        ? reading.ref(changedFields(reminderFields(reading.prefill), {}))
        : undefined,
  };
}

// ─── The lost dialogs ───────────────────────────────────────────────────────

/** What `LostDealDialog` takes when it opened from a suggestion. */
export type LostSuggestion = {
  /** The fixed label for the loss category, never the prospect's words. */
  reason: { key: string; text: string } | null;
  changed: boolean;
  onUseNew: () => void;
  onKeep: () => void;
};

const lossLabel = (prefill: SuggestionPrefill) =>
  prefill.values.lossCategory
    ? LOSS_CATEGORIES[prefill.values.lossCategory]
    : undefined;

/** The lost dialogs' side of the contract: the reason prefill and the save's `fromSuggestion`. */
export function useLostSuggestion(suggestion: DialogSuggestion | undefined) {
  const reading = useSuggestionRef(suggestion);
  const applied = reading.applied;
  const label = applied ? lossLabel(applied) : undefined;
  const dialog: LostSuggestion | undefined = suggestion
    ? {
        reason:
          applied && label
            ? { key: `${applied.from.revision}:${label}`, text: label }
            : null,
        changed: reading.changed,
        onUseNew: reading.applyNew,
        onKeep: reading.keepMine,
      }
    : undefined;
  return {
    dialog,
    ref: (reason: string | undefined) =>
      reading.prefill
        ? reading.ref(
            changedFields(
              { lossCategory: lossLabel(reading.prefill) },
              { lossCategory: reason },
            ),
          )
        : undefined,
  };
}
