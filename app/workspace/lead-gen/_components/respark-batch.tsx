"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowUpRightIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DISPOSITION_LABELS, LIFECYCLE_STAGE_LABELS } from "@/convex/leads/lifecycle";
import { Button } from "@/components/ui/button";
import { CopyHandleButton } from "./copy-handle-button";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";
import {
  instagramProfileUrl,
  isOverlayActive,
  isTypingTarget,
  summarizeBatch,
} from "@/lib/respark/display";
import { cn } from "@/lib/utils";
import { PageBand } from "@/app/workspace/_components/page-band";
import { detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { dealText, displayHandle, formatClock, formatDay } from "./respark-format";
import {
  BandZones,
  BucketWord,
  DATE,
  Fact,
  KeyHints,
  LABEL,
  None,
  RESPARK_CARD,
  STATUS_WORD,
  Zone,
  ZONE_FIGURE,
} from "./respark-ui";
import { BATCH_ENDED_MESSAGE, useNotAFitUndo } from "./use-respark-undo";

const ResparkPersonSheet = dynamic(
  () => import("./respark-person-sheet").then((module) => module.ResparkPersonSheet),
);

type Batch = NonNullable<FunctionReturnType<typeof api.respark.queries.getMyResparkBatch>>;
type Item = Batch["items"][number];
type ItemId = Id<"resparkBatchItems">;
type Action = "resparked" | "not_a_fit" | "skipped";

// A worked person's line: what happened in 13px slate, then one status word.
const RESULT_LINES: Record<Action, { text: string; word: string; ink: string }> = {
  resparked: { text: "Resparked", word: "Entry", ink: "text-foreground" },
  not_a_fit: { text: "Back of the pool", word: "Not a fit", ink: "text-muted-foreground" },
  skipped: { text: "Back in the pool", word: "Skipped", ink: "text-muted-foreground" },
};

function handleOf(item: Item) {
  return displayHandle(item.person?.handle) ?? "No Instagram handle";
}

export function ResparkBatch({ batch, timeZone }: { batch: Batch; timeZone: string }) {
  const markResparked = useMutation(api.respark.batches.markResparked);
  const skip = useMutation(api.respark.batches.skipResparkItem);
  const undo = useNotAFitUndo(batch.heldUntil);
  const [sending, setSending] = useState<ReadonlySet<ItemId>>(() => new Set());
  const [focusedId, setFocusedId] = useState<ItemId | null>(null);
  const [panelItem, setPanelItem] = useState<{ itemId: ItemId; bucket: number } | null>(null);
  const cardRefs = useRef(new Map<ItemId, HTMLElement>());
  const moveFocusRef = useRef(false);
  // State lags a fast double press; this set stops a second send at once.
  const inFlightRef = useRef(new Set<ItemId>());

  // A Not a fit that is held, on its way, or accepted but not yet in the query.
  const notAFitTaken = (itemId: ItemId) => undo.isPending(itemId) || undo.isSending(itemId) || undo.isSent(itemId);
  // Cards still to decide on, in batch order.
  const open = batch.items.filter((item) => item.result === null && !notAFitTaken(item.itemId));
  const focused = open.find((item) => item.itemId === focusedId) ?? open[0] ?? null;
  const summary = summarizeBatch(batch);

  useEffect(() => {
    if (!moveFocusRef.current || !focused) return;
    moveFocusRef.current = false;
    const element = cardRefs.current.get(focused.itemId);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  // J and K stop at the ends. Only a card that leaves the list falls back to
  // the one before it, when it was the last.
  const focusAfter = (itemId: ItemId, step: 1 | -1 = 1, leaving = false) => {
    const index = open.findIndex((item) => item.itemId === itemId);
    const next = open[index + step] ?? (leaving ? open[index - 1] : undefined);
    if (next) {
      moveFocusRef.current = true;
      setFocusedId(next.itemId);
    }
  };

  const act = async (item: Item, action: Action) => {
    if (inFlightRef.current.has(item.itemId) || notAFitTaken(item.itemId) || item.result !== null) return;
    if (item.blockedReason && action !== "skipped") return;
    if (Date.now() >= batch.heldUntil) {
      toast.error(BATCH_ENDED_MESSAGE);
      return;
    }
    // Acting on a card sends any Not a fit still waiting on another one.
    undo.flush(item.itemId);
    focusAfter(item.itemId, 1, true);
    if (action === "not_a_fit") {
      undo.hold(item.itemId, handleOf(item));
      return;
    }
    inFlightRef.current.add(item.itemId);
    setSending((current) => new Set(current).add(item.itemId));
    try {
      await (action === "resparked" ? markResparked : skip)({ itemId: item.itemId });
    } catch (error) {
      toast.error(getErrorMessage(error, action === "resparked" ? "Couldn't mark them resparked." : "Couldn't skip them."));
    } finally {
      inFlightRef.current.delete(item.itemId);
      setSending((current) => {
        const next = new Set(current);
        next.delete(item.itemId);
        return next;
      });
    }
  };

  const openInstagram = (item: Item) => {
    const url = instagramProfileUrl(item.person?.handle ?? null);
    if (url && !item.blockedReason) window.open(url, "_blank", "noopener,noreferrer");
  };

  // Latest handlers for the document listener, which is attached once.
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyHandlerRef.current = (event) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (panelItem !== null || isTypingTarget(event.target) || isOverlayActive(event.target, document)) return;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      if (!focused || !["o", "r", "n", "s", "j", "k"].includes(key)) return;
      event.preventDefault();
      if (key === "o") openInstagram(focused);
      else if (key === "r") void act(focused, "resparked");
      else if (key === "n") void act(focused, "not_a_fit");
      else if (key === "s") void act(focused, "skipped");
      else focusAfter(focused.itemId, key === "j" ? 1 : -1);
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);


  // Worked people stay in batch order; consecutive ones share one ruled card.
  type Row = { item: Item; kind: "worked" | "sent" | "sending" | "pending" | "open" };
  const rows: Row[] = batch.items.map((item) => ({
    item,
    kind:
      item.result !== null ? "worked"
        : undo.isSent(item.itemId) ? "sent"
          : undo.isSending(item.itemId) ? "sending"
            : undo.isPending(item.itemId) ? "pending"
              : "open",
  }));
  const segments: Row[][] = [];
  for (const row of rows) {
    const last = segments.at(-1);
    const isLine = row.kind === "worked" || row.kind === "sent";
    if (isLine && last && (last[0].kind === "worked" || last[0].kind === "sent")) last.push(row);
    else segments.push([row]);
  }

  return (
    <>
      <PageBand
        title="Respark batch"
        description={
          <>
            {batch.size} people ·{" "}
            <HelpTip tip={`The end of the business day, ${timeZone} time. Then the batch ends.`}>
              held until {formatClock(batch.heldUntil, timeZone)}
            </HelpTip>
            {batch.capped ? (
              <>
                {" · "}
                <HelpTip tip="Some cards leave out older history. View shows the person's full record.">
                  older history left out
                </HelpTip>
              </>
            ) : null}
          </>
        }
        actions={<KeyHints />}
      >
        <BandZones label="This batch" className="grid-cols-3 @3xl:grid-cols-5">
          <Zone label="Worked">
            <p className={ZONE_FIGURE}>
              {summary.worked}
              <span className="text-[17px] text-board-muted">/{summary.total}</span>
            </p>
            <div
              role="progressbar"
              aria-label="Worked"
              aria-valuemin={0}
              aria-valuemax={summary.total}
              aria-valuenow={summary.worked}
              className="mt-0.5 h-1 w-full max-w-36 overflow-hidden rounded-full bg-board-raised"
            >
              <div
                className="h-full rounded-full bg-board-foreground/75 transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${summary.total === 0 ? 0 : (summary.worked / summary.total) * 100}%` }}
              />
            </div>
          </Zone>
          <Zone label="Entries">
            <p className={ZONE_FIGURE}>{summary.entries}</p>
          </Zone>
          <Zone label="Not a fit">
            <p className={ZONE_FIGURE}>{summary.notAFit}</p>
          </Zone>
          <Zone label="Skipped">
            <p className={ZONE_FIGURE}>{summary.skipped}</p>
          </Zone>
          <Zone label="To go" className="col-span-2 @3xl:col-span-1">
            <p className={ZONE_FIGURE}>{summary.total - summary.worked}</p>
          </Zone>
        </BandZones>
      </PageBand>

      <ul className="flex flex-col gap-3.5" aria-label="People in this batch">
        {segments.map((segment) => {
          const [first] = segment;
          const { item } = first;
          if (first.kind === "worked" || first.kind === "sent") {
            return (
              <li key={item.itemId} className={RESPARK_CARD}>
                <ul aria-label="Worked">
                  {segment.map((row) => (
                    <WorkedLine
                      key={row.item.itemId}
                      handle={handleOf(row.item)}
                      result={row.kind === "sent" ? "not_a_fit" : (row.item.result ?? "not_a_fit")}
                    />
                  ))}
                </ul>
              </li>
            );
          }
          return (
            <li key={item.itemId}>
              {first.kind === "sending" ? (
                <SendingLine handle={handleOf(item)} />
              ) : first.kind === "pending" ? (
                <PendingLine
                  handle={handleOf(item)}
                  dueAt={undo.dueAt(item.itemId)}
                  onUndo={() => {
                    undo.undo(item.itemId);
                    moveFocusRef.current = true;
                    setFocusedId(item.itemId);
                  }}
                />
              ) : (
                <ResparkCard
                  ref={(element) => {
                    if (element) cardRefs.current.set(item.itemId, element);
                    else cardRefs.current.delete(item.itemId);
                  }}
                  item={item}
                  timeZone={timeZone}
                  focused={focused?.itemId === item.itemId}
                  sending={sending.has(item.itemId)}
                  onFocus={() => setFocusedId(item.itemId)}
                  onAct={(action) => void act(item, action)}
                  onOpenInstagram={() => openInstagram(item)}
                  onView={() => setPanelItem({ itemId: item.itemId, bucket: item.bucket })}
                />
              )}
            </li>
          );
        })}
      </ul>

      {panelItem !== null ? (
        <ResparkPersonSheet
          itemId={panelItem.itemId}
          bucket={panelItem.bucket}
          timeZone={timeZone}
          onClose={() => setPanelItem(null)}
        />
      ) : null}
    </>
  );
}

/** A 36px action in the card's column (or its row on a narrow card). View joins the title row from @3xl. */

function ResparkCard({
  ref,
  item,
  timeZone,
  focused,
  sending,
  onFocus,
  onAct,
  onOpenInstagram,
  onView,
}: {
  ref: (element: HTMLElement | null) => void;
  item: Item;
  timeZone: string;
  focused: boolean;
  sending: boolean;
  onFocus: () => void;
  onAct: (action: Action) => void;
  onOpenInstagram: () => void;
  onView: () => void;
}) {
  const person = item.person;
  const handle = handleOf(item);
  const blocked = item.blockedReason !== null;
  const hasProfile = instagramProfileUrl(person?.handle ?? null) !== null;
  const touches = person?.lastTouches.slice(0, 3) ?? [];

  const instagram = (className: string) =>
    !blocked && hasProfile ? (
      <button type="button" onClick={onOpenInstagram} className={cn(detailLinkClass, "gap-0.5 text-[13px]", className)}>
        Open Instagram
        <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
      </button>
    ) : null;

  // Lime only on the card being worked: it is the one next action.
  const actions = (size: string) => (
    <>
      {!blocked ? (
        <>
          <Button
            variant={focused ? "default" : "outline"}
            className={cn(size, focused && "font-semibold")}
            disabled={sending}
            title="Counts as an entry"
            onClick={() => onAct("resparked")}
          >
            {sending ? <Spinner data-icon="inline-start" /> : null}
            Resparked
          </Button>
          <Button
            variant="outline"
            className={size}
            disabled={sending}
            title="They stay in the CRM, last in the pool"
            onClick={() => onAct("not_a_fit")}
          >
            Not a fit
          </Button>
        </>
      ) : null}
      <Button variant="outline" className={size} disabled={sending} title="Back in the pool" onClick={() => onAct("skipped")}>
        Skip
      </Button>
    </>
  );

  return (
    <article
      ref={ref}
      tabIndex={-1}
      aria-label={handle}
      aria-current={focused || undefined}
      onFocus={onFocus}
      onPointerDown={onFocus}
      className={cn(
        RESPARK_CARD,
        "@container/card outline-none",
        // The card being worked: a 3px inset ink bar on its left edge.
        focused && "border-foreground/30 shadow-[inset_3px_0_0_var(--color-foreground)]",
      )}
    >
      <div className="flex min-h-11 items-center gap-x-2.5 border-b border-border py-1.5 pr-4 pl-4">
        <h2 className="min-w-0 shrink truncate">
          <button
            type="button"
            onClick={onView}
            title="View this person"
            className="max-w-full truncate rounded-sm text-left text-[15px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {handle}
          </button>
        </h2>
        <CopyHandleButton handle={person?.handle} />
        <BucketWord bucket={item.bucket} className="hidden @md/card:inline-flex" />
        <span className="ml-auto hidden shrink-0 items-center gap-4 @2xl/card:flex">
          {instagram("")}
          <button type="button" onClick={onView} className={cn(detailLinkClass, "hidden text-[13px] @3xl/card:inline-flex")}>
            View
          </button>
          {/* From @3xl the actions sit in the title row, so a card is its facts' height. */}
          <span className="hidden items-center gap-1.5 @3xl/card:flex">{actions("h-8 px-3")}</span>
        </span>
      </div>

      <div className="grid gap-x-6 gap-y-3 px-4 py-2.5 @xl/card:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <BucketWord bucket={item.bucket} className="mb-1 flex @md/card:hidden" />
          {person ? (
            <dl>
              <Fact label="Stage">
                {LIFECYCLE_STAGE_LABELS[person.stage]}
                {person.disposition !== "open" ? (
                  <span className="text-muted-foreground"> · {DISPOSITION_LABELS[person.disposition]}</span>
                ) : null}
              </Fact>
              <Fact label="Captured">
                {person.capturedAt !== null ? (
                  <>
                    <span className={DATE.replace("text-muted-foreground", "text-foreground")}>{formatDay(person.capturedAt, timeZone)}</span>
                    {person.capturedBy ? <span className="text-muted-foreground"> · {person.capturedBy}</span> : null}
                  </>
                ) : (
                  <None>Not by lead gen</None>
                )}
              </Fact>
              <Fact label="Qualified">
                {person.qualifiedAt !== null ? (
                  <span className={DATE.replace("text-muted-foreground", "text-foreground")}>{formatDay(person.qualifiedAt, timeZone)}</span>
                ) : (
                  <None>Never</None>
                )}
              </Fact>
              {person.newestDeal ? (
                <Fact label="Deal">
                  {dealText(person.newestDeal)}
                  <span className="text-muted-foreground"> · {formatDay(person.newestDeal.createdAt, timeZone)}</span>
                </Fact>
              ) : null}
              {person.timeZone ? (
                <Fact label={<HelpTip tip="From the person's booking.">Time zone</HelpTip>}>{person.timeZone}</Fact>
              ) : null}
            </dl>
          ) : null}
          {blocked ? (
            <p className="mt-1 text-[13px] leading-5 text-danger-ink">{item.blockedReason} Skip them instead.</p>
          ) : null}
        </div>

        <div className="min-w-0">
          <p className={cn(LABEL, "flex min-h-7 items-center")}>Last touches</p>
          {touches.length > 0 ? (
            <ol>
              {touches.map((touch) => (
                <li key={touch.eventId} className="grid min-h-7 grid-cols-[3.25rem_minmax(0,1fr)] items-baseline gap-x-2 py-1">
                  <time dateTime={new Date(touch.occurredAt).toISOString()} className={DATE}>
                    {formatDay(touch.occurredAt, timeZone)}
                  </time>
                  <span className="min-w-0 truncate text-sm leading-5">{touch.label}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-1 text-[13px] leading-5 text-muted-foreground">No touches on record.</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 @xl/card:col-span-2 @3xl/card:hidden">
          {actions("h-9 px-3")}
          <Button variant="ghost" className="h-9 px-3" onClick={onView}>
            View
          </Button>
          {instagram("self-center px-1 @2xl/card:hidden")}
        </div>
      </div>
    </article>
  );
}

/** A worked person: one 40px ruled line, the result, then its status word. */
function WorkedLine({ handle, result }: { handle: string; result: Action }) {
  const line = RESULT_LINES[result];
  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-border px-4 py-1.5 last:border-b-0">
      <span className="min-w-0 truncate text-sm">
        <span className="font-medium">{handle}</span>
        <span className="text-[13px] text-muted-foreground"> · {line.text}</span>
      </span>
      <span className={cn(STATUS_WORD, line.ink, "ml-auto")}>{line.word}</span>
    </li>
  );
}

/** A Not a fit still inside its Undo window: a dashed line. */
function PendingLine({ handle, dueAt, onUndo }: { handle: string; dueAt: number | null; onUndo: () => void }) {
  const seconds = useSecondsLeft(dueAt);
  return (
    <div className="flex min-h-10 items-center gap-3 rounded-xl border border-dashed border-input bg-card px-4 py-1.5">
      <span className="min-w-0 truncate text-sm">
        <span className="font-medium">{handle}</span>
        <span className="text-[13px] text-muted-foreground"> · Not a fit · back of the pool</span>
      </span>
      <button type="button" onClick={onUndo} className={cn(detailLinkClass, "ml-auto shrink-0 text-[13px] tabular-nums")}>
        Undo · {seconds}s
      </button>
    </div>
  );
}

function SendingLine({ handle }: { handle: string }) {
  return (
    <div className="flex min-h-10 items-center gap-3 rounded-xl border border-dashed border-input bg-card px-4 py-1.5" role="status">
      <span className="min-w-0 truncate text-sm">
        <span className="font-medium">{handle}</span>
        <span className="text-[13px] text-muted-foreground"> · Not a fit · back of the pool</span>
      </span>
      <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground">
        <Spinner />
        Saving
      </span>
    </div>
  );
}

function useSecondsLeft(dueAt: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (dueAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [dueAt]);
  return dueAt === null ? 0 : Math.max(0, Math.ceil((dueAt - now) / 1000));
}
