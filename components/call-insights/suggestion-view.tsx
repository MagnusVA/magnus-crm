"use client";

import type { ReactNode } from "react";
import {
  TIER_BADGES,
  noteSentences,
  readingsLine,
  suggestionHeadline,
} from "@/lib/callInsights/display";
import { cn } from "@/lib/utils";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { InsightTime } from "./insight-parts";
import { Chip } from "./item-rows";
import type { MeetingSuggestion } from "./suggestion-context";

/**
 * How sure the reading is, as the panel's left rule and tint: lime when Jev
 * confirmed it and the form can be filled, amber when the two readings
 * differ, and plain when nothing confirms it.
 */
const TIER_LOOK = {
  ready: {
    panel:
      "border-l-primary bg-[color-mix(in_srgb,var(--primary)_7%,var(--card))]",
    chip: "lime",
  },
  check: {
    panel:
      "border-l-warning bg-[color-mix(in_srgb,var(--warning)_8%,var(--card))]",
    chip: "warning",
  },
  unconfirmed: {
    panel: "border-l-muted-foreground/50 bg-card",
    chip: "muted",
  },
} as const;

/**
 * "Suggested from the call": the result the recording points to, the lines it
 * rests on, and why anything was left unfilled. `actions` are the buttons
 * that open an outcome form; a reading nobody confirmed has none.
 */
export function SuggestionPanel({
  suggestion,
  actions,
  actionNote,
}: {
  suggestion: MeetingSuggestion;
  actions?: ReactNode;
  /** A line under the headline about what the buttons do. */
  actionNote?: string | null;
}) {
  const format = useLocalFormat();
  const headline = suggestionHeadline(suggestion, (at) =>
    format(at, "EEE MMM d, h:mm a"),
  );
  const readings =
    suggestion.tier === "check"
      ? readingsLine(suggestion.claudeReading, suggestion.jevReading)
      : null;
  const notes = noteSentences(suggestion.notes);
  // A reading nobody confirmed fills nothing: say where the result goes instead.
  const unfilled =
    suggestion.tier === "unconfirmed" && suggestion.kind !== "no_decision";
  const look = TIER_LOOK[suggestion.tier];

  return (
    <section
      aria-label="Suggested from the call"
      className={cn(
        "ph-no-capture flex flex-col gap-3 rounded-[var(--radius)] border border-l-[3px] px-4 py-3.5",
        look.panel,
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-condensed text-[0.6875rem] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Suggested from the call
            </h2>
            <Chip tone={look.chip}>{TIER_BADGES[suggestion.tier]}</Chip>
          </div>
          <p className="text-[1.0625rem] leading-snug font-semibold text-balance">
            {headline}
          </p>
          {readings ? (
            <p className="text-sm text-muted-foreground">{readings}.</p>
          ) : null}
          {actionNote ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              {actionNote}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
      {suggestion.quotes.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {suggestion.quotes.map((quote, index) => (
            <li
              key={`${quote.at}:${index}`}
              className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-baseline gap-x-2 border-l-2 border-input pl-2.5"
            >
              <InsightTime at={quote.at} />
              <div className="min-w-0">
                <p className="text-[0.84375rem] leading-[1.45] text-pretty break-words">
                  &ldquo;{quote.quote}&rdquo;
                </p>
                <p className="font-condensed text-[0.6875rem] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                  {quote.speaker ? `${quote.speaker} · ` : ""}
                  {quote.label}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {notes.length > 0 || unfilled ? (
        <ul className="flex flex-col gap-0.5 text-[0.8125rem] text-muted-foreground">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
          {unfilled ? <li>Record the result yourself below.</li> : null}
        </ul>
      ) : null}
    </section>
  );
}
