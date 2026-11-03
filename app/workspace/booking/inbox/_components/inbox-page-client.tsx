"use client";

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { CheckIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  eventTypeStatus,
  modeLabel,
  suggestSorting,
  type Coverage,
  type CoverageProgram,
  type SchedulingMode,
} from "../../_components/booking-model";
import { InboxFocusCard } from "./inbox-focus-card";
import { INBOX_DESCRIPTION, INBOX_DESK } from "./inbox-layout";
import { InboxPageSkeleton } from "./inbox-page-skeleton";
import { InboxQueue } from "./inbox-queue";
import type { InboxItem, SuggestionGroup } from "./inbox-shared";
import { useSortEventTypes } from "../../_components/use-sort-event-types";

export function InboxPageClient() {
  usePageTitle("Inbox · Booking setup");
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  // Event types links here with ?id= to open one event type first.
  const requestedId = useSearchParams().get("id");

  if (coverage === undefined) {
    return <InboxPageSkeleton />;
  }
  return <InboxDesk coverage={coverage} requestedId={requestedId} />;
}

const byName = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function InboxDesk({ coverage, requestedId }: { coverage: Coverage; requestedId: string | null }) {
  const programs = useMemo(
    () => coverage.programs.filter((program) => program.archivedAt === undefined),
    [coverage.programs],
  );
  const programsById = useMemo(
    () => new Map(coverage.programs.map((program) => [program._id as string, program])),
    [coverage.programs],
  );
  const programName = (programId: string) => programsById.get(programId)?.name ?? "A removed program";

  // Alphabetical, so look-alikes ("25K Accelerator – Ana", "– Bo") sit together.
  const items = useMemo<InboxItem[]>(
    () =>
      coverage.eventTypes
        .filter((eventType) => eventTypeStatus(eventType) === "unsorted")
        .sort((left, right) => byName.compare(left.displayName, right.displayName))
        .map((eventType) => ({ eventType, suggestion: suggestSorting(eventType, programs) })),
    [coverage.eventTypes, programs],
  );

  const groups = useMemo<SuggestionGroup[]>(() => {
    const byKey = new Map<string, SuggestionGroup>();
    for (const item of items) {
      if (!item.suggestion) continue;
      const key = `${item.suggestion.programId}:${item.suggestion.mode}`;
      const group = byKey.get(key) ?? { key, programId: item.suggestion.programId, mode: item.suggestion.mode, items: [] };
      group.items.push(item);
      byKey.set(key, group);
    }
    return [...byKey.values()]
      .filter((group) => group.items.length >= 2)
      .sort((left, right) => right.items.length - left.items.length);
  }, [items]);

  const goneCount = useMemo(
    () => coverage.eventTypes.filter((eventType) => eventTypeStatus(eventType) === "gone").length,
    [coverage.eventTypes],
  );

  // The focused item by id; when it leaves the queue, whatever now sits at
  // its place takes over, so a decision moves on to the next one.
  const [cursor, setCursor] = useState<{ id: string | null; index: number }>({ id: requestedId, index: 0 });
  const foundIndex = items.findIndex((item) => item.eventType._id === cursor.id);
  const selectedIndex = items.length === 0 ? -1 : foundIndex >= 0 ? foundIndex : Math.min(cursor.index, items.length - 1);
  const selected = selectedIndex >= 0 ? items[selectedIndex] : null;

  // The decision being made on the focused item; the suggestion until changed.
  const [draft, setDraft] = useState<{
    forId: string;
    programId: CoverageProgram["_id"] | null;
    mode: SchedulingMode;
  } | null>(null);
  const decision =
    selected && draft?.forId === selected.eventType._id
      ? draft
      : {
          forId: selected?.eventType._id ?? "",
          programId: selected?.suggestion?.programId ?? null,
          mode: selected?.suggestion?.mode ?? ("normal" as SchedulingMode),
        };

  const [bulkBusy, setBulkBusy] = useState(false);
  const sort = useSortEventTypes();

  function selectAt(index: number) {
    const item = items[index];
    if (item) setCursor({ id: item.eventType._id, index });
  }

  function move(delta: 1 | -1, wrap = false) {
    if (selectedIndex < 0 || items.length === 0) return;
    let next = selectedIndex + delta;
    if (wrap) next = (next + items.length) % items.length;
    if (next < 0 || next >= items.length) return;
    selectAt(next);
  }

  // Focus the one after the decided item (or before it, at the end).
  function advancePast(index: number) {
    const next = items[index + 1] ?? items[index - 1] ?? null;
    setCursor({ id: next?.eventType._id ?? null, index });
  }

  function setProgram(programId: CoverageProgram["_id"]) {
    if (!selected) return;
    setDraft({ ...decision, forId: selected.eventType._id, programId });
  }

  function setMode(mode: SchedulingMode) {
    if (!selected) return;
    setDraft({ ...decision, forId: selected.eventType._id, mode });
  }

  function sortSelected() {
    if (!selected || !decision.programId) return;
    const { programId, mode } = decision;
    const name = selected.eventType.displayName;
    const suggested = selected.suggestion?.programId === programId && selected.suggestion.mode === mode;
    advancePast(selectedIndex);
    void sort([{ eventTypeConfigId: selected.eventType._id, sorting: { kind: "program", programId, mode } }], {
      message: () => `${name} sorted into ${programName(programId)} · ${modeLabel(mode)}.`,
      analytics: { source: "inbox", to: "program", suggested },
    });
  }

  function markNotSalesCall() {
    if (!selected) return;
    const name = selected.eventType.displayName;
    advancePast(selectedIndex);
    void sort([{ eventTypeConfigId: selected.eventType._id, sorting: { kind: "not_sales_call" } }], {
      message: () => `${name} set aside as not a sales call.`,
      analytics: { source: "inbox", to: "not_sales_call" },
    });
  }

  async function acceptGroup(group: SuggestionGroup) {
    const ids = new Set(group.items.map((item) => item.eventType._id as string));
    // Keep the focus where it is, or on the next item the group leaves behind.
    if (selected && ids.has(selected.eventType._id)) {
      const rest = items.filter((item) => !ids.has(item.eventType._id));
      const after = items.slice(selectedIndex + 1).find((item) => !ids.has(item.eventType._id));
      const next = after ?? rest[rest.length - 1] ?? null;
      setCursor({ id: next?.eventType._id ?? null, index: next ? rest.indexOf(next) : 0 });
    }
    const label = `${programName(group.programId)} · ${modeLabel(group.mode)}`;
    setBulkBusy(true);
    try {
      await sort(
        group.items.map((item) => ({
          eventTypeConfigId: item.eventType._id,
          sorting: { kind: "program", programId: group.programId, mode: group.mode },
        })),
        {
          message: (count) => `${count} event ${count === 1 ? "type" : "types"} sorted into ${label}.`,
          analytics: { source: "inbox_bulk", to: "program", suggested: true },
        },
      );
    } finally {
      setBulkBusy(false);
    }
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
    // Leave keys alone while a dialog, menu or popover has focus.
    if (target?.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")) return;
    if (!selected) return;

    const key = event.key;
    const lower = key.toLowerCase();
    if (/^[1-9]$/.test(key)) {
      const program = programs[Number(key) - 1];
      if (program) {
        event.preventDefault();
        setProgram(program._id);
      }
    } else if (lower === "p" || lower === "s") {
      if (programs.length === 0) return;
      event.preventDefault();
      setMode(lower === "p" ? "normal" : "extended");
    } else if (key === "Enter") {
      // Enter on another button or a link does that control's own job;
      // on a program or scheduling choice, or nowhere in particular, it sorts.
      const control = target?.closest("button, a, [role='button']");
      if (control && !control.hasAttribute("data-inbox-choice")) return;
      if (!decision.programId) return;
      event.preventDefault();
      sortSelected();
    } else if (lower === "n") {
      event.preventDefault();
      markNotSalesCall();
    } else if (lower === "j" || key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (lower === "k" || key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-3.5 short:gap-3">
      {selected ? (
        <Card className={INBOX_DESK}>
          <div className="order-2 flex max-h-[22rem] min-h-0 flex-col border-t @4xl:order-none @4xl:max-h-none @4xl:border-t-0 @4xl:border-r">
            <InboxQueue
              items={items}
              selectedId={selected.eventType._id}
              groups={programs.length > 0 ? groups : []}
              programName={programName}
              busy={bulkBusy}
              onSelect={(id) => {
                const index = items.findIndex((item) => item.eventType._id === id);
                if (index >= 0) selectAt(index);
              }}
              onAcceptGroup={(group) => void acceptGroup(group)}
            />
          </div>
          <div className="order-1 flex min-h-0 flex-col @4xl:order-none">
            <InboxFocusCard
              key={selected.eventType._id}
              item={selected}
              position={selectedIndex + 1}
              total={items.length}
              programs={programs}
              programName={programName}
              programId={decision.programId}
              mode={decision.mode}
              busy={bulkBusy}
              onProgram={setProgram}
              onMode={setMode}
              onSort={sortSelected}
              onNotSalesCall={markNotSalesCall}
              onSkip={() => move(1, true)}
              onMove={(delta) => move(delta)}
            />
          </div>
        </Card>
      ) : (
        <InboxZero goneCount={goneCount} />
      )}
    </div>
  );
}

const LINK =
  "font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] hover:decoration-foreground";

function InboxZero({ goneCount }: { goneCount: number }) {
  return (
    <Card className="items-start gap-3 px-4 py-6 @4xl:px-6">
      <span className="flex size-8 items-center justify-center rounded-full bg-muted">
        <CheckIcon className="size-4" aria-hidden="true" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Inbox zero. Every Calendly event type is sorted.</h2>
        <p className="max-w-[65ch] text-sm text-muted-foreground">
          New event types land here after each Calendly sync.
          {goneCount > 0 ? (
            <>
              {" "}
              {goneCount} that Calendly no longer {goneCount === 1 ? "offers is" : "offers are"} kept under{" "}
              <Link href="/workspace/booking/event-types?filter=gone" className={LINK}>
                Gone
              </Link>
              .
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="outline">
          <Link href="/workspace/booking">Open Coverage</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/workspace/booking/event-types">See every event type</Link>
        </Button>
      </div>
    </Card>
  );
}
