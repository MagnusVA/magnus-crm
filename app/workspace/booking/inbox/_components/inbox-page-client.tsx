"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { CheckIcon } from "lucide-react";
import posthog from "posthog-js";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { usePageTitle } from "@/hooks/use-page-title";
import { getErrorMessage } from "@/lib/errors";
import { reportClientError } from "@/lib/observability/report-client-error";
import {
  buildInboxCards,
  NOT_SALES_REASON_LABEL,
  type Destination,
  type InboxCard as InboxCardModel,
  type IntelMode,
  type NotSalesReason,
} from "@/lib/booking-setup/event-type-intel";
import {
  buildBoard,
  eventTypeStatus,
  modeLabel,
  poolingLabel,
  type Coverage,
  type CoverageEventType,
} from "../../_components/booking-model";
import {
  alternativeLabel,
  destinationLabel,
  shortUrl,
  sortingFor,
  toIntelEventTypes,
  toIntelPrograms,
  type BookingActivity,
  type EventTypeExtras,
} from "../../_components/event-types/intel-adapter";
import { KeyHint } from "../../_components/event-types/key-hint";
import { useSortEventTypes, type SortRequest } from "../../_components/use-sort-event-types";
import { flyAway, riseIn } from "./fly-away";
import { InboxCard, type CardFacts } from "./inbox-card";
import { InboxPageSkeleton } from "./inbox-page-skeleton";
import { SortedThisSession, UpNext, type QueueRow, type SessionRow } from "./inbox-side";
import { ProgramPalette } from "./program-palette";

export function InboxPageClient() {
  usePageTitle("Inbox · Booking setup");
  const coverage = useQuery(api.bookingSetup.queries.getCoverage, {});
  const activity = useQuery(api.bookingSetup.queries.getBookingActivity, {});
  const configs = useQuery(api.eventTypeConfigs.queries.listEventTypeConfigs, {});

  const extras = useMemo<EventTypeExtras | undefined>(() => {
    if (!configs) return undefined;
    return new Map(
      configs.map((config) => {
        const created = config.calendlyCreatedAt ? Date.parse(config.calendlyCreatedAt) : Number.NaN;
        return [
          config._id as string,
          {
            ownerName: config.calendlyProfileName,
            createdAt: Number.isNaN(created) ? config._creationTime : created,
            slug: config.calendlySlug,
          },
        ];
      }),
    );
  }, [configs]);

  if (coverage === undefined || activity === undefined) {
    return <InboxPageSkeleton />;
  }
  return <InboxDesk coverage={coverage} activity={activity} extras={extras} />;
}

type UndoEntry = { sessionId: string; previous: SortRequest[] };

const DAY_MS = 24 * 60 * 60 * 1000;

function InboxDesk({
  coverage,
  activity,
  extras,
}: {
  coverage: Coverage;
  activity: BookingActivity;
  extras: EventTypeExtras | undefined;
}) {
  const board = useMemo(() => buildBoard(coverage), [coverage]);
  const intel = useMemo(() => toIntelEventTypes(coverage, board, activity, extras), [coverage, board, activity, extras]);
  const programs = useMemo(() => toIntelPrograms(board), [board]);
  const cards = useMemo(
    () => buildInboxCards(intel.filter((eventType) => eventType.status === "unsorted"), programs, intel),
    [intel, programs],
  );

  const programsById = useMemo(() => new Map(coverage.programs.map((program) => [program._id as string, program.name])), [coverage.programs]);
  // Programs made from the palette, named until the coverage query catches up.
  const [createdNames, setCreatedNames] = useState<Readonly<Record<string, string>>>({});
  const programName = (programId: string) => programsById.get(programId) ?? createdNames[programId] ?? "A removed program";
  const eventTypeName = (id: string) => board.eventTypesById.get(id)?.displayName;

  const laneCount = (programId: string, mode: IntelMode, except: ReadonlySet<string> = new Set()) =>
    coverage.eventTypes.filter(
      (eventType) =>
        !except.has(eventType._id) &&
        eventTypeStatus(eventType) === "sorted" &&
        eventType.bookingProgramId === programId &&
        (eventType.isExtended === true ? "extended" : "normal") === mode,
    ).length;

  // Queue order: the suggestion ranking, "Later" cards at the back, and the
  // card on screen stays on screen until it is filed.
  const [later, setLater] = useState<string[]>([]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const ordered = useMemo(() => {
    const rest = cards.filter((card) => !later.includes(card.id));
    const back = later.flatMap((id) => cards.filter((card) => card.id === id));
    return [...rest, ...back];
  }, [cards, later]);
  const top = ordered.find((card) => card.id === focusId) ?? ordered[0] ?? null;
  if (top && focusId !== top.id) setFocusId(top.id);
  const queue = ordered.filter((card) => card !== top);

  const [notMenuOpen, setNotMenuOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<Array<SessionRow & { count: number }>>([]);
  const [undoStack, setUndoStack] = useState<UndoEntry[]>([]);
  const { sort, undo } = useSortEventTypes();
  const upsertProgram = useMutation(api.tenantPrograms.mutations.upsertProgram);
  const cardRef = useRef<HTMLElement>(null);

  // The incoming card rises from the stack underneath.
  const shownId = top?.id ?? null;
  const firstShown = useRef(true);
  useEffect(() => {
    if (firstShown.current) {
      firstShown.current = false;
      return;
    }
    riseIn(cardRef.current);
  }, [shownId]);

  function membersOf(card: InboxCardModel) {
    return card.eventTypes.flatMap((eventType) => {
      const row = board.eventTypesById.get(eventType.id);
      return row ? [row] : [];
    });
  }

  function cardName(card: InboxCardModel) {
    return card.stackLabel ?? eventTypeName(card.eventTypes[0].id) ?? "Event type";
  }

  function describe(destination: Destination) {
    return destinationLabel(destination, programName, eventTypeName);
  }

  function bandTarget(destination: Destination) {
    const href = destination.kind === "program" ? "/workspace/booking/event-types" : "/workspace/booking/event-types?filter=not_sales_call";
    const links = [...document.querySelectorAll(`a[href="${href}"]`)];
    return links.find((link) => /on a program|not a sales call/i.test(link.textContent ?? "")) ?? links[0] ?? null;
  }

  function forgetSession(sessionId: string) {
    setSession((rows) => rows.filter((row) => row.id !== sessionId));
    setUndoStack((entries) => entries.filter((entry) => entry.sessionId !== sessionId));
  }

  async function file(
    card: InboxCardModel,
    destination: Destination,
    analytics: { suggested: boolean; source: "inbox" | "inbox_bulk" },
    labelOverride?: string,
  ) {
    if (card.id === top?.id) flyAway(cardRef.current, bandTarget(destination));
    const label = labelOverride ?? describe(destination);
    const sessionId = `${card.id}:${Date.now()}`;
    const members = card.eventTypes.map((eventType) => eventType.id as Id<"eventTypeConfigs">);
    setSession((rows) => [
      { id: sessionId, label: cardName(card), destination: label, kind: destination.kind === "program" ? "booking" : "not_sales", count: members.length },
      ...rows,
    ]);
    setNotMenuOpen(false);
    setPaletteOpen(false);
    setLater((ids) => ids.filter((id) => id !== card.id));
    if (focusId === card.id) setFocusId(null);

    const previous = await sort(
      members.map((eventTypeConfigId) => ({ eventTypeConfigId, sorting: sortingFor(destination) })),
      {
        message: (count) =>
          `${count > 1 ? `${count} event types filed` : "Filed"} ${destination.kind === "program" ? "under" : "as"} ${label}.`,
        analytics: {
          source: analytics.source,
          to: destination.kind === "program" ? "program" : "not_sales_call",
          suggested: analytics.suggested,
          reason: destination.kind === "not_sales_call" ? destination.reason : undefined,
        },
        onUndone: () => forgetSession(sessionId),
      },
    );
    if (previous) setUndoStack((entries) => [...entries, { sessionId, previous }]);
    else setSession((rows) => rows.filter((row) => row.id !== sessionId));
  }

  function accept(card: InboxCardModel | null, source: "inbox" | "inbox_bulk" = "inbox") {
    if (!card) return;
    const best = card.result.best;
    if (!best) {
      setPaletteOpen(true);
      return;
    }
    void file(card, best, { suggested: true, source });
  }

  function alternative(index: number) {
    const destination = top?.result.alternatives[index];
    if (top && destination) void file(top, destination, { suggested: false, source: "inbox" });
  }

  function notSalesCall(reason: NotSalesReason) {
    if (!top) return;
    const best = top.result.best;
    const duplicateAlternative = top.result.alternatives.find(
      (alt): alt is Extract<Destination, { kind: "not_sales_call" }> => alt.kind === "not_sales_call" && alt.reason === "duplicate",
    );
    const duplicateOfId =
      reason === "duplicate" ? (best?.kind === "not_sales_call" ? best.duplicateOfId : duplicateAlternative?.duplicateOfId) : undefined;
    const suggested = best?.kind === "not_sales_call" && best.reason === reason;
    void file(top, { kind: "not_sales_call", reason, duplicateOfId }, { suggested, source: "inbox" });
  }

  function laterCard() {
    if (!top) return;
    setLater((ids) => [...ids.filter((id) => id !== top.id), top.id]);
    setFocusId(null);
    setNotMenuOpen(false);
    posthog.capture("booking_inbox_later", { stacked: top.eventTypes.length > 1 });
  }

  async function undoLast() {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setUndoStack((entries) => entries.slice(0, -1));
    const sessionId = entry.sessionId;
    const ok = await undo(entry.previous, () => setSession((rows) => rows.filter((row) => row.id !== sessionId)));
    if (!ok) setUndoStack((entries) => [...entries, entry]);
  }

  async function createProgram(name: string) {
    if (!top || busy) return;
    setBusy(true);
    try {
      const programId = await upsertProgram({ name });
      setCreatedNames((names) => ({ ...names, [programId]: name.trim() }));
      posthog.capture("booking_program_created", { source: "inbox_palette" });
      const mode: IntelMode = /\b(extended|standard)\b/i.test(name) ? "extended" : "normal";
      await file(top, { kind: "program", programId, mode }, { suggested: false, source: "inbox" }, `${name.trim()} · ${modeLabel(mode)}`);
    } catch (error) {
      reportClientError(error, { flow: "booking_inbox_create_program" });
      toast.error(getErrorMessage(error, "Couldn't create the program. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
    if (paletteOpen || target?.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")) return;
    if (document.querySelector("[data-slot='dialog-content'], [data-slot='sheet-content']")) return;

    const key = event.key;
    const lower = key.toLowerCase();
    if (lower === "u" && !busy) {
      event.preventDefault();
      void undoLast();
      return;
    }
    if (!top) return;
    if (key === "Escape") {
      if (notMenuOpen || helpOpen) {
        event.preventDefault();
        setNotMenuOpen(false);
        setHelpOpen(false);
      }
      return;
    }
    if (key === "?") {
      event.preventDefault();
      setHelpOpen((open) => !open);
      return;
    }
    if (busy) return;
    if (key === "Enter") {
      // Enter on another control does that control's job.
      const control = target?.closest("button, a, [role='button']");
      if (control && !control.hasAttribute("data-inbox-accept")) return;
      event.preventDefault();
      accept(top);
    } else if (/^[1-5]$/.test(key)) {
      const index = Number(key) - 1;
      if (notMenuOpen) {
        event.preventDefault();
        notSalesCall(["personal", "follow_up", "internal", "group", "duplicate"][index] as NotSalesReason);
      } else if (top.result.alternatives[index]) {
        event.preventDefault();
        alternative(index);
      }
    } else if (lower === "p") {
      event.preventDefault();
      setPaletteOpen(true);
    } else if (lower === "n") {
      event.preventDefault();
      setNotMenuOpen((open) => !open);
    } else if (lower === "s") {
      event.preventDefault();
      laterCard();
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const sessionTotal = session.reduce((sum, row) => sum + row.count, 0);
  const sessionCard = (
    <SortedThisSession rows={session} total={sessionTotal} onUndo={() => void undoLast()} canUndo={undoStack.length > 0} />
  );

  if (!top) {
    const counts = { sorted: 0, notSales: 0, gone: 0 };
    for (const eventType of coverage.eventTypes) {
      const status = eventTypeStatus(eventType);
      if (status === "sorted") counts.sorted += 1;
      else if (status === "not_sales_call") counts.notSales += 1;
      else if (status === "gone") counts.gone += 1;
    }
    return (
      <div className="@container flex min-w-0 flex-col gap-3.5">
        <InboxZero counts={counts} />
        {session.length > 0 ? <div className="@4xl:max-w-[420px]">{sessionCard}</div> : null}
      </div>
    );
  }

  const members = membersOf(top);
  const memberIds = new Set(members.map((member) => member._id as string));
  const best = top.result.best;
  const facts = factsFor(members[0], activity, extras);

  const acceptLabel = (() => {
    const all = top.eventTypes.length > 1 ? `all ${top.eventTypes.length} ` : "";
    if (!best) return "Pick a program…";
    if (best.kind === "program") return `File ${all}under ${programName(best.programId)} · ${modeLabel(best.mode)}`;
    if (best.reason === "duplicate") return top.eventTypes.length > 1 ? `File ${all}as duplicates` : "File as a duplicate";
    const reason = NOT_SALES_REASON_LABEL[best.reason].toLowerCase();
    return top.eventTypes.length > 1 ? `File ${all}as ${reason}s` : `File as a ${reason}`;
  })();

  const destinationNote = (() => {
    if (!best) return null;
    if (best.kind === "program") {
      const count = laneCount(best.programId, best.mode, memberIds);
      return count === 0 ? "first event type in this lane" : `joins ${count} event ${count === 1 ? "type" : "types"} in this lane`;
    }
    return "leaves triage until someone brings it back";
  })();

  const queueRows: QueueRow[] = queue.map((card) => ({
    id: card.id,
    name: cardName(card),
    color: board.eventTypesById.get(card.eventTypes[0].id)?.calendlyColor,
    count: card.eventTypes.length,
    meta: card.result.best ? describe(card.result.best) : "No suggestion yet",
    later: later.includes(card.id),
  }));

  const helpButton = (
    <Popover open={helpOpen} onOpenChange={setHelpOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2" aria-label="Keyboard shortcuts" aria-keyshortcuts="?">
          <KeyHint>?</KeyHint>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] p-3" onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <p className="mb-1 text-sm font-semibold">Inbox shortcuts</p>
        <dl className="text-[13.5px]">
          {[
            ["Take the suggestion", "↵"],
            ["Alternatives", "1 · 2"],
            ["Pick a program and lane", "P"],
            ["Not a sales call, then a reason", "N, 1–5"],
            ["Later", "S"],
            ["Undo", "U"],
            ["Close", "Esc"],
          ].map(([label, keys]) => (
            <div key={label} className="flex items-center justify-between border-t border-border py-1 first:border-t-0">
              <dt>{label}</dt>
              <dd>
                <KeyHint>{keys}</KeyHint>
              </dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );

  return (
    <div className="@container min-w-0">
      <div className="grid items-start gap-3.5 @4xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <div className="relative pb-[18px]">
            {queue.length > 1 ? (
              <div aria-hidden="true" className="absolute inset-x-0 top-0 bottom-[18px] z-0 translate-y-[18px] scale-[0.95] rounded-xl border border-border bg-card opacity-60" />
            ) : null}
            {queue.length > 0 ? (
              <div aria-hidden="true" className="absolute inset-x-0 top-0 bottom-[18px] z-[1] translate-y-[9px] scale-[0.975] rounded-xl border border-border bg-card opacity-90" />
            ) : null}
            <InboxCard
              key={top.id}
              ref={cardRef}
              card={top}
              members={members}
              facts={facts}
              memberMeta={(eventType) => memberMeta(eventType, activity)}
              acceptLabel={acceptLabel}
              destination={best ? describe(best) : null}
              destinationNote={destinationNote}
              alternatives={top.result.alternatives.map((destination) => ({
                destination,
                label: alternativeLabel(destination, programName),
                title: describe(destination),
              }))}
              notMenuOpen={notMenuOpen}
              canUndo={undoStack.length > 0}
              busy={busy}
              onAccept={() => accept(top)}
              onAlternative={alternative}
              onPalette={() => setPaletteOpen(true)}
              onToggleNotMenu={() => setNotMenuOpen((open) => !open)}
              onNotReason={notSalesCall}
              onLater={laterCard}
              onUndo={() => void undoLast()}
              helpButton={helpButton}
            />
          </div>
        </div>
        <aside aria-label="Inbox queue" className="flex min-w-0 flex-col gap-3.5">
          <UpNext
            rows={queueRows}
            busy={busy}
            onFocus={(id) => {
              setFocusId(id);
              setNotMenuOpen(false);
            }}
            onAcceptStack={(id) => accept(cards.find((card) => card.id === id) ?? null, "inbox_bulk")}
          />
          {sessionCard}
        </aside>
      </div>
      <ProgramPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        programs={programs}
        laneCount={(programId, mode) => laneCount(programId, mode, memberIds)}
        onPick={(programId, mode) => void file(top, { kind: "program", programId, mode }, { suggested: false, source: "inbox" })}
        onCreate={(name) => void createProgram(name)}
      />
    </div>
  );
}

function kindWord(eventType: CoverageEventType) {
  if (eventType.calendlyKind === "group") return "Group event";
  if (!eventType.calendlyPoolingType) return "One-on-one";
  return poolingLabel(eventType.calendlyPoolingType);
}

function bookingsWord(eventType: CoverageEventType, activity: BookingActivity) {
  const count = activity.bookings30d.eventTypes[eventType._id] ?? 0;
  return `${count}${activity.capped ? "+" : ""}`;
}

function memberMeta(eventType: CoverageEventType, activity: BookingActivity) {
  const parts = [];
  if (eventType.calendlyDurationMinutes !== undefined) parts.push(`${eventType.calendlyDurationMinutes} min`);
  parts.push(kindWord(eventType));
  const count = activity.bookings30d.eventTypes[eventType._id] ?? 0;
  parts.push(`${count} ${count === 1 ? "booking" : "bookings"}`);
  return parts.join(" · ");
}

function factsFor(eventType: CoverageEventType, activity: BookingActivity, extras: EventTypeExtras | undefined): CardFacts {
  const extra = extras?.get(eventType._id);
  const createdAt = extra?.createdAt ?? eventType._creationTime;
  const age = Date.now() - createdAt;
  const questions = eventType.formQuestionCount;
  return {
    kind: kindWord(eventType),
    length: eventType.calendlyDurationMinutes !== undefined ? `${eventType.calendlyDurationMinutes} min` : "Not synced",
    bookings: bookingsWord(eventType, activity),
    form: questions === 0 ? "None seen yet" : `${questions} ${questions === 1 ? "question" : "questions"}`,
    owner: extra?.ownerName ?? null,
    added: format(createdAt, "MMM d, yyyy"),
    url: shortUrl(eventType.calendlySchedulingUrl ?? eventType.bookingBaseUrl),
    status:
      age < 14 * DAY_MS
        ? { word: age < DAY_MS ? "New · today" : `New · ${formatDistanceToNowStrict(createdAt, { addSuffix: true })}`, tone: "new" }
        : { word: "Active", tone: "ok" },
  };
}

function InboxZero({ counts }: { counts: { sorted: number; notSales: number; gone: number } }) {
  return (
    <section aria-labelledby="inbox-zero" className="rounded-xl border border-border bg-card px-6 pt-12 pb-10 text-center">
      <span className="mx-auto mb-3.5 grid size-[72px] place-items-center rounded-full bg-foreground text-background animate-in zoom-in-50 fade-in-0 duration-500">
        <CheckIcon className="size-[34px]" aria-hidden="true" />
      </span>
      <h2 id="inbox-zero" className="text-[26px] font-semibold">
        Inbox zero
      </h2>
      <p className="mx-auto mt-2 mb-[18px] max-w-[540px] text-muted-foreground">
        Every Calendly event type is sorted: {counts.sorted} book a program, {counts.notSales}{" "}
        {counts.notSales === 1 ? "isn’t a sales call" : "aren’t sales calls"}, {counts.gone} {counts.gone === 1 ? "is" : "are"} gone
        from Calendly. New ones land here after each sync.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline" className="bg-card">
          <Link href="/workspace/booking">Back to coverage</Link>
        </Button>
        <Button asChild variant="outline" className="bg-card">
          <Link href="/workspace/booking/event-types?filter=all">See every event type</Link>
        </Button>
      </div>
    </section>
  );
}

