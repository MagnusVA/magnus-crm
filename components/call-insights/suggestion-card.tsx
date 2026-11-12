"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { SuggestionPanel } from "./suggestion-view";
import {
  prefillFor,
  type MeetingSuggestion,
  type SuggestionDialog,
  type SuggestionPrefill,
} from "./suggestion-context";

/**
 * "Suggested from the call": stamps that the suggestion was shown and gives
 * a confirmed reading the button that opens the matching outcome form filled
 * in. `suggestion-view.tsx` draws the panel. It never saves anything: the person saves in the
 * form. `OutcomeSection` owns the query and the dialogs; this card asks it to
 * open one (`onUse`), or to open the no-show form empty (`onOpenEmpty`).
 */
export function SuggestionCard({
  suggestion,
  onUse,
  onOpenEmpty,
}: {
  suggestion: MeetingSuggestion;
  onUse: (prefill: SuggestionPrefill) => void;
  onOpenEmpty: (dialog: SuggestionDialog) => void;
}) {
  const markShown = useMutation(api.callInsights.queries.markSuggestionShown);
  const marked = useRef(new Set<string>());
  const { stateId, revision, shown } = suggestion;
  useEffect(() => {
    const key = `${stateId}:${revision}`;
    if (shown || marked.current.has(key)) return;
    marked.current.add(key);
    // Exposure is best effort; a failed stamp never blocks the card.
    void markShown({ stateId }).catch(() => undefined);
  }, [stateId, revision, shown, markShown]);

  const use = (dialog: SuggestionDialog, compact?: boolean) => {
    const prefill = prefillFor(suggestion, dialog, { compact });
    if (prefill) onUse(prefill);
  };
  const ready = suggestion.tier === "ready";

  let actions: React.ReactNode = null;
  let actionNote: string | null = null;
  if (ready && suggestion.kind === "paid") {
    actions = (
      <Button size="sm" onClick={() => use("payment")}>
        Use this
      </Button>
    );
  } else if (ready && suggestion.kind === "promised") {
    actions = (
      <>
        <Button size="sm" onClick={() => use("payment")}>
          Log payment
        </Button>
        <Button size="sm" variant="outline" onClick={() => use("follow_up")}>
          Set a reminder
        </Button>
      </>
    );
    actionNote =
      "Log it when the money arrives. Setting a reminder ends this suggestion.";
  } else if (ready && suggestion.kind === "call_back") {
    actions = (
      <Button size="sm" onClick={() => use("follow_up")}>
        Use this
      </Button>
    );
  } else if (ready && suggestion.kind === "lost") {
    actions = (
      <Button size="sm" onClick={() => use("lost")}>
        Use this
      </Button>
    );
  } else if (ready && suggestion.kind === "no_show") {
    actions =
      suggestion.noShowTier === "certain" ? (
        <Button size="sm" onClick={() => use("no_show", true)}>
          Mark no-show
        </Button>
      ) : (
        <Button size="sm" onClick={() => use("no_show")}>
          Review
        </Button>
      );
  } else if (suggestion.kind === "empty_recording") {
    actions = (
      <Button
        size="sm"
        variant="outline"
        onClick={() => onOpenEmpty("no_show")}
      >
        Mark no-show
      </Button>
    );
  }

  return (
    <SuggestionPanel
      suggestion={suggestion}
      actions={actions}
      actionNote={actionNote}
    />
  );
}
