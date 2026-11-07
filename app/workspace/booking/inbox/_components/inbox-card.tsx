"use client";

import { forwardRef } from "react";
import { ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  NOT_SALES_REASONS,
  type Destination,
  type InboxCard as InboxCardModel,
  type NotSalesReason,
  type Strength,
} from "@/lib/booking-setup/event-type-intel";
import { CalendlyDot } from "../../_components/calendly-dot";
import { KeyHint } from "../../_components/event-types/key-hint";
import type { CoverageEventType } from "../../_components/booking-model";

export type CardFacts = {
  kind: string;
  length: string;
  bookings: string;
  form: string;
  owner: string | null;
  added: string | null;
  url: string | null;
  /** "New · 2 days ago" or "Active". */
  status: { word: string; tone: "new" | "ok" };
};

export type InboxCardProps = {
  card: InboxCardModel;
  members: CoverageEventType[];
  facts: CardFacts;
  memberMeta: (eventType: CoverageEventType) => string;
  /** "File under 25K Accelerator · Priority" */
  acceptLabel: string;
  /** "25K Accelerator · Priority", "Not a sales call · Personal calendar" */
  destination: string | null;
  destinationNote: string | null;
  alternatives: Array<{ destination: Destination; label: string; title: string }>;
  notMenuOpen: boolean;
  canUndo: boolean;
  busy: boolean;
  onAccept: () => void;
  onAlternative: (index: number) => void;
  onPalette: () => void;
  onToggleNotMenu: () => void;
  onNotReason: (reason: NotSalesReason) => void;
  onLater: () => void;
  onUndo: () => void;
  helpButton: React.ReactNode;
};

const STRENGTH: Record<Strength, { word: string; className: string }> = {
  strong: { word: "Strong", className: "text-stage-follow-up-ink" },
  likely: { word: "Likely", className: "text-foreground" },
  possible: { word: "Possible", className: "text-warning-ink" },
};

const LABEL = "font-condensed text-[11px] leading-[1.2] font-semibold tracking-[0.14em] text-muted-foreground uppercase";
const WORD = "font-condensed text-[13px] leading-[1.1] font-bold tracking-[0.08em] whitespace-nowrap uppercase";

/** The focused inbox card: what the event type is, where it probably goes and why, and one key per choice. */
export const InboxCard = forwardRef<HTMLElement, InboxCardProps>(function InboxCard(props, ref) {
  const { card, members, facts } = props;
  const best = card.result.best;
  const strength = best ? STRENGTH[best.strength] : null;
  const first = members[0];
  const stacked = card.stackLabel !== null;

  return (
    <article
      ref={ref}
      aria-labelledby="inbox-card-title"
      className="@container/card relative z-[2] overflow-hidden rounded-xl border border-border bg-card"
    >
      {stacked ? (
        <>
          <header className="flex items-start gap-3 px-5 pt-4 pb-3">
            <span
              aria-hidden="true"
              className="grid size-[30px] shrink-0 place-items-center rounded-[7px] bg-foreground font-condensed text-[15px] font-bold text-background shadow-[3px_3px_0_#c9d0dc,6px_6px_0_#e3e7ed] dark:shadow-[3px_3px_0_#3a4256,6px_6px_0_#262c3a]"
            >
              {members.length}
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="inbox-card-title" className="text-xl leading-tight font-semibold">
                {card.stackLabel}
              </h2>
              <p className="text-[13px] text-muted-foreground">Stacked because one suggestion fits all of them.</p>
            </div>
            <span className={cn(WORD, "mt-1.5 text-stage-follow-up-ink")}>Active</span>
          </header>
          <ul className="mx-5 mb-2.5 rounded-lg border border-border" aria-label="Event types in this card">
            {members.map((eventType) => (
              <li key={eventType._id} className="flex items-center gap-2.5 border-t border-border px-3 py-1.5 text-[13.5px] first:border-t-0">
                <CalendlyDot color={eventType.calendlyColor} className="size-2.5" />
                <span className="min-w-0 truncate">{eventType.displayName}</span>
                <small className="ml-auto shrink-0 text-xs text-muted-foreground">{props.memberMeta(eventType)}</small>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <header className="flex items-start gap-3 px-5 pt-4 pb-3">
            <CalendlyDot color={first.calendlyColor} className="mt-[9px] size-2.5" />
            <div className="min-w-0 flex-1">
              <h2 id="inbox-card-title" className="text-xl leading-tight font-semibold [overflow-wrap:anywhere]">
                {first.displayName}
              </h2>
              {facts.url ? (
                <span className="mt-[3px] block truncate font-mono text-[13px] text-muted-foreground">{facts.url}</span>
              ) : null}
            </div>
            <span className={cn(WORD, "mt-1.5", facts.status.tone === "new" ? "text-stage-booked-ink" : "text-stage-follow-up-ink")}>
              {facts.status.word}
            </span>
          </header>
          <dl className="mx-5 grid grid-cols-2 border-t border-l border-border @md/card:grid-cols-3">
            <Fact label="Kind" value={facts.kind} />
            <Fact label="Length" value={facts.length} />
            <Fact label="Bookings · 30 days" value={facts.bookings} />
            <Fact label="Form" value={facts.form} />
            {facts.owner ? <Fact label="Calendly owner" value={facts.owner} /> : null}
            {facts.added ? <Fact label="Added" value={facts.added} /> : null}
          </dl>
        </>
      )}

      <section aria-label="Suggestion" className="mx-5 mt-3.5 rounded-[10px] border border-border bg-background px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className={LABEL}>Suggestion</span>
          <span className={cn(WORD, strength?.className ?? "text-muted-foreground")}>{strength?.word ?? "None"}</span>
        </div>
        <p className="mt-1.5 mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xl font-semibold">
          <ArrowRightIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          <span>{props.destination ?? "Pick a program"}</span>
          {props.destinationNote ? (
            <small className="text-[13px] font-normal text-muted-foreground">{props.destinationNote}</small>
          ) : null}
        </p>
        <ul className="list-disc pl-[18px] text-[13.5px] marker:text-stage-held">
          {(best?.reasons ?? ["No program’s name is in it, and nothing already filed looks like it."]).map((reason) => (
            <li key={reason} className="mt-0.5">
              {reason}
            </li>
          ))}
        </ul>
      </section>

      <footer className="flex flex-wrap gap-2 px-5 pt-3.5 pb-2">
        <Button
          size="lg"
          className="h-9 gap-2 px-3.5 font-semibold"
          onClick={props.onAccept}
          disabled={props.busy}
          aria-keyshortcuts="Enter"
          data-inbox-accept=""
        >
          <KeyHint tone="lime">↵</KeyHint>
          {props.acceptLabel}
        </Button>
        {props.alternatives.map((alternative, index) => (
          <Button
            key={alternative.title}
            variant="outline"
            size="lg"
            className="h-9 max-w-[300px] gap-2 bg-card px-3.5"
            title={alternative.title}
            onClick={() => props.onAlternative(index)}
            disabled={props.busy}
            aria-keyshortcuts={String(index + 1)}
          >
            <KeyHint>{index + 1}</KeyHint>
            <span className="truncate">{alternative.label}</span>
          </Button>
        ))}
      </footer>

      <div className="flex flex-wrap items-center gap-0.5 px-3.5 pb-3">
        <QuietButton hint="P" onClick={props.onPalette} disabled={props.busy}>
          Other program…
        </QuietButton>
        <QuietButton
          hint="N"
          onClick={props.onToggleNotMenu}
          disabled={props.busy}
          pressed={props.notMenuOpen}
          ariaExpanded={props.notMenuOpen}
          ariaControls="inbox-not-sales"
        >
          Not a sales call
        </QuietButton>
        <QuietButton hint="S" onClick={props.onLater} disabled={props.busy}>
          Later
        </QuietButton>
        <span className="flex-1" />
        <QuietButton hint="U" onClick={props.onUndo} disabled={!props.canUndo}>
          Undo
        </QuietButton>
        {props.helpButton}
      </div>

      {props.notMenuOpen ? (
        <div
          id="inbox-not-sales"
          role="group"
          aria-label="Why isn’t it a sales call?"
          className="mx-5 mb-[18px] overflow-hidden rounded-[10px] border border-foreground animate-in fade-in-0 slide-in-from-top-1"
        >
          <span className={cn(LABEL, "block border-b border-border bg-background px-3 py-2.5")}>Why isn’t it a sales call?</span>
          {NOT_SALES_REASONS.map((reason, index) => (
            <button
              key={reason.key}
              type="button"
              onClick={() => props.onNotReason(reason.key)}
              disabled={props.busy}
              aria-keyshortcuts={String(index + 1)}
              className="flex w-full items-center gap-2.5 border-t border-border px-3 py-2 text-left text-[13.5px] outline-none first-of-type:border-t-0 hover:bg-muted focus-visible:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <KeyHint>{index + 1}</KeyHint>
              <span>{reason.label}</span>
              <small className="ml-auto text-[12.5px] text-muted-foreground">{reason.hint}</small>
            </button>
          ))}
          <p className="border-t border-border bg-background px-3 py-2.5 text-[12.5px] text-muted-foreground">
            It leaves triage and every picker until someone brings it back from Event types › Not sales calls. Its
            bookings don’t count for a program.
          </p>
        </div>
      ) : null}
    </article>
  );
});

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-r border-b border-border px-3 py-2">
      <dt className="font-condensed text-[10.5px] leading-none font-semibold tracking-[0.14em] text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-1 truncate text-[13.5px]" title={value}>
        {value}
      </dd>
    </div>
  );
}

function QuietButton({
  hint,
  children,
  onClick,
  disabled,
  pressed,
  ariaExpanded,
  ariaControls,
}: {
  hint: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  ariaExpanded?: boolean;
  ariaControls?: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-keyshortcuts={hint}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      className={cn(
        "h-7 gap-1.5 px-2 text-[13px] font-normal text-muted-foreground",
        pressed && "border-foreground bg-muted text-foreground",
      )}
    >
      <KeyHint>{hint}</KeyHint>
      {children}
    </Button>
  );
}

export { QuietButton };
