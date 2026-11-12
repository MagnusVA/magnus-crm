"use client";

import { useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  TIER_BADGES,
  noteSentences,
  quoteLine,
  readingsLine,
  suggestionHeadline,
} from "@/lib/callInsights/display";
import { Button } from "@/components/ui/button";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { Chip } from "./item-rows";
import {
  prefillFor,
  type MeetingSuggestion,
  type SuggestionDialog,
  type SuggestionPrefill,
} from "./suggestion-context";

const TIER_TONE = {
  ready: "lime",
  check: "warning",
  unconfirmed: "muted",
} as const;

/**
 * "Suggested from the call": the result the recording points to, with its
 * quotes and, for a confirmed reading, a button that opens the matching
 * outcome form filled in. It never saves anything: the person saves in the
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
  const format = useLocalFormat();
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

  const headline = suggestionHeadline(suggestion, (at) =>
    format(at, "EEE MMM d, h:mm a"),
  );
  const readings =
    suggestion.tier === "check"
      ? readingsLine(suggestion.claudeReading, suggestion.jevReading)
      : null;
  const notes = noteSentences(suggestion.notes);
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
    <DetailCard
      title="Suggested from the call"
      badge={
        <Chip tone={TIER_TONE[suggestion.tier]}>
          {TIER_BADGES[suggestion.tier]}
        </Chip>
      }
      className="ph-no-capture"
      aria-label="Suggested from the call"
    >
      <div className="flex flex-col gap-2.5 p-4">
        <p className="text-[1.0625rem] leading-snug font-semibold text-balance">
          {headline}
        </p>
        {readings ? (
          <p className="text-sm text-muted-foreground">{readings}.</p>
        ) : null}
        {suggestion.quotes.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-[0.8125rem] leading-[1.45]">
            {suggestion.quotes.map((quote, index) => (
              <li key={`${quote.at}:${index}`} className="flex flex-col">
                <span className="font-condensed text-[0.6875rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                  {quote.label}
                </span>
                <span className="tabular-nums">
                  {quoteLine(quote.at, quote.quote, quote.speaker)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {notes.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-[0.8125rem] text-muted-foreground">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {actions ? (
          <div className="flex flex-col gap-1.5 pt-1">
            <div className="flex flex-wrap gap-2">{actions}</div>
            {actionNote ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                {actionNote}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </DetailCard>
  );
}
