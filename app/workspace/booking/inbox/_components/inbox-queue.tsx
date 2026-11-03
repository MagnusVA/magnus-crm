"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { calendlyNameIfDifferent, eventTypeFacts, modeLabel } from "../../_components/booking-model";
import { CalendlyDot } from "../../_components/calendly-dot";
import type { InboxItem, SuggestionGroup } from "./inbox-shared";

const ROW =
  "relative flex w-full flex-col gap-0.5 border-b px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-[current=true]:bg-primary/10 aria-[current=true]:shadow-[inset_3px_0_0_var(--color-primary)]";

/**
 * The inbox's left pane: every unsorted event type, the focused one marked.
 * Similar ones (the same suggestion) can be accepted together from the
 * strip above the list.
 */
export function InboxQueue({
  items,
  selectedId,
  groups,
  programName,
  busy,
  onSelect,
  onAcceptGroup,
}: {
  items: readonly InboxItem[];
  selectedId: string | null;
  groups: readonly SuggestionGroup[];
  programName: (programId: string) => string;
  busy: boolean;
  onSelect: (id: string) => void;
  onAcceptGroup: (group: SuggestionGroup) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the focused row in view as J/K move through the queue.
  useEffect(() => {
    if (!selectedId) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-id="${selectedId}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return (
    <section aria-labelledby="inbox-queue-title" className="flex min-h-0 flex-col">
      <div className="flex min-h-11 items-center gap-2 border-b px-4 py-2">
        <h2 id="inbox-queue-title" className="text-[15px] font-semibold">
          To sort
        </h2>
        <span className="ml-auto text-[13px] text-muted-foreground">
          <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">{items.length}</span>{" "}
          {items.length === 1 ? "event type" : "event types"}
        </span>
      </div>
      {groups.length > 0 ? (
        <ul aria-label="Similar event types" className="border-b bg-background">
          {groups.map((group) => {
            const label = `${programName(group.programId)} · ${modeLabel(group.mode)}`;
            return (
              <li key={group.key} className="flex items-center gap-2 border-b px-4 py-2 last:border-b-0">
                <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
                  <span className="font-condensed text-[15px] font-semibold text-foreground tabular-nums">
                    {group.items.length}
                  </span>{" "}
                  look like <span className="font-medium text-foreground">{label}</span>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => onAcceptGroup(group)}
                  aria-label={`Accept all ${group.items.length} as ${label}`}
                >
                  Accept all
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ul ref={listRef} aria-label="Event types to sort" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {items.map((item) => {
          const calendlyName = calendlyNameIfDifferent(item.eventType);
          return (
            <li key={item.eventType._id}>
              <button
                type="button"
                data-id={item.eventType._id}
                aria-current={item.eventType._id === selectedId ? "true" : undefined}
                onClick={() => onSelect(item.eventType._id)}
                className={ROW}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <CalendlyDot color={item.eventType.calendlyColor} />
                  <span className="truncate font-medium">{item.eventType.displayName}</span>
                </span>
                <span className="truncate pl-4 text-[13px] text-muted-foreground">
                  {eventTypeFacts(item.eventType)}
                  {calendlyName ? ` · ${calendlyName}` : null}
                </span>
                {item.suggestion ? (
                  <span className={cn("truncate pl-4 text-[12px] text-muted-foreground")}>
                    Suggested:{" "}
                    <span className="font-medium text-foreground">
                      {programName(item.suggestion.programId)} · {modeLabel(item.suggestion.mode)}
                    </span>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
