"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { ExternalLinkIcon, PanelRightOpenIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DISPOSITION_LABELS, LIFECYCLE_STAGE_LABELS } from "@/convex/leads/lifecycle";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Progress } from "@/components/ui/progress";
import { CopyHandleButton } from "./copy-handle-button";
import { Spinner } from "@/components/ui/spinner";
import { getErrorMessage } from "@/lib/errors";
import {
  instagramProfileUrl,
  isOverlayActive,
  isTypingTarget,
  resparkBucketLabel,
  summarizeBatch,
} from "@/lib/respark/display";
import { cn } from "@/lib/utils";
import { bucketSwatchClass, dealText, displayHandle, formatClock, formatDay } from "./respark-format";
import { BATCH_ENDED_MESSAGE, useNotAFitUndo } from "./use-respark-undo";

const ResparkPersonSheet = dynamic(
  () => import("./respark-person-sheet").then((module) => module.ResparkPersonSheet),
);

type Batch = NonNullable<FunctionReturnType<typeof api.respark.queries.getMyResparkBatch>>;
type Item = Batch["items"][number];
type ItemId = Id<"resparkBatchItems">;
type Action = "resparked" | "not_a_fit" | "skipped";

const RESULT_LINES: Record<Action, { text: string; badge: string; className: string }> = {
  resparked: {
    text: "Resparked · counts as an entry",
    badge: "Entry",
    className: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
  },
  not_a_fit: { text: "Not a fit · back of the pool", badge: "Not a fit", className: "" },
  skipped: { text: "Skipped · back in the pool", badge: "Skipped", className: "text-muted-foreground" },
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

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 border-b pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-normal text-pretty">Your respark batch</h1>
          <p className="text-sm text-muted-foreground">
            {batch.size} people · held for you until {formatClock(batch.heldUntil, timeZone)} ({timeZone})
          </p>
          <Progress
            value={summary.total === 0 ? 0 : (summary.worked / summary.total) * 100}
            className="mt-2 max-w-md"
            aria-label={`${summary.worked} of ${summary.total} worked`}
          />
        </div>
        <div className="flex flex-col gap-1.5 text-sm text-muted-foreground lg:items-end">
          <p className="tabular-nums">
            {summary.entries} resparked · {summary.notAFit} not a fit
            {summary.skipped > 0 ? ` · ${summary.skipped} skipped` : ""} · {summary.total - summary.worked} to go
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span>Keys:</span>
            <KeyHint letter="O" label="open" />
            <KeyHint letter="R" label="resparked" />
            <KeyHint letter="N" label="not a fit" />
            <KeyHint letter="S" label="skip" />
            <KeyHint letter="J" label="next" />
            <KeyHint letter="K" label="previous" />
          </p>
        </div>
      </header>

      {batch.capped ? (
        <p className="text-xs text-muted-foreground">Some cards leave out older history.</p>
      ) : null}

      <ol className="flex flex-col gap-2.5">
        {batch.items.map((item) => (
          <li key={item.itemId}>
            {item.result !== null ? (
              <WorkedLine handle={handleOf(item)} result={item.result} />
            ) : undo.isSent(item.itemId) ? (
              <WorkedLine handle={handleOf(item)} result="not_a_fit" />
            ) : undo.isSending(item.itemId) ? (
              <SendingLine handle={handleOf(item)} />
            ) : undo.isPending(item.itemId) ? (
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
        ))}
      </ol>

      {panelItem !== null ? (
        <ResparkPersonSheet
          itemId={panelItem.itemId}
          bucket={panelItem.bucket}
          timeZone={timeZone}
          onClose={() => setPanelItem(null)}
        />
      ) : null}
    </div>
  );
}

function KeyHint({ letter, label }: { letter: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Kbd>{letter}</Kbd>
      {label}
    </span>
  );
}

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

  return (
    <article
      ref={ref}
      tabIndex={-1}
      aria-label={handle}
      aria-current={focused || undefined}
      onFocus={onFocus}
      onPointerDown={onFocus}
      className={cn(
        "grid gap-4 rounded-lg border bg-card p-4 outline-none transition-shadow md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]",
        focused && "ring-2 ring-ring/50 border-ring",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={onView}
            className="truncate text-left text-lg font-semibold hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {handle}
          </button>
          <CopyHandleButton handle={person?.handle} />
          <span className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <span aria-hidden="true" className={cn("size-2.5 rounded-[3px]", bucketSwatchClass(item.bucket))} />
            {resparkBucketLabel(item.bucket)}
          </span>
        </div>
        {person ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <Fact label="Stage">
              {LIFECYCLE_STAGE_LABELS[person.stage]}
              {person.disposition !== "open" ? ` · ${DISPOSITION_LABELS[person.disposition]}` : ""}
            </Fact>
            <Fact label="Captured">
              {person.capturedAt !== null
                ? `${formatDay(person.capturedAt, timeZone)}${person.capturedBy ? `, by ${person.capturedBy}` : ""}`
                : "Not captured by lead gen"}
            </Fact>
            <Fact label="Qualified">
              {person.qualifiedAt !== null ? formatDay(person.qualifiedAt, timeZone) : "Never"}
            </Fact>
            {person.newestDeal ? (
              <Fact label="Deal">
                {dealText(person.newestDeal)}, opened {formatDay(person.newestDeal.createdAt, timeZone)}
              </Fact>
            ) : null}
            {person.timeZone ? <Fact label="Time zone">{person.timeZone}, from the booking</Fact> : null}
          </dl>
        ) : null}
        {blocked ? (
          <Alert>
            <AlertDescription>{item.blockedReason} Skip them instead.</AlertDescription>
          </Alert>
        ) : null}
      </div>

      <div className="min-w-0">
        {person && person.lastTouches.length > 0 ? (
          <ol className="flex flex-col gap-1.5 border-l-2 pl-3 text-sm">
            {person.lastTouches.slice(0, 3).map((touch) => (
              <li key={touch.eventId} className="flex gap-2">
                <time className="w-14 shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums">
                  {formatDay(touch.occurredAt, timeZone)}
                </time>
                <span className="min-w-0">{touch.label}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted-foreground">No touches on record.</p>
        )}
      </div>

      <div className="flex min-w-40 flex-col gap-1.5">
        {!blocked ? (
          <>
            <Button variant="link" className="justify-start px-0" disabled={!hasProfile} onClick={onOpenInstagram}>
              Open Instagram
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
            <Button className="h-auto flex-col items-start gap-0 py-1.5" disabled={sending} onClick={() => onAct("resparked")}>
              <span className="inline-flex items-center gap-1.5">
                {sending ? <Spinner /> : null}
                Resparked
              </span>
              <small className="text-xs font-normal opacity-80">Counts as an entry</small>
            </Button>
            <Button
              variant="outline"
              className="h-auto flex-col items-start gap-0 py-1.5"
              disabled={sending}
              onClick={() => onAct("not_a_fit")}
            >
              Not a fit
              <small className="text-xs font-normal text-muted-foreground">Stays in the pool, last</small>
            </Button>
          </>
        ) : null}
        <Button variant="outline" disabled={sending} onClick={() => onAct("skipped")}>
          Skip
        </Button>
        <Button variant="ghost" size="sm" className="justify-start" onClick={onView}>
          <PanelRightOpenIcon data-icon="inline-start" />
          View
        </Button>
      </div>
    </article>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs font-medium uppercase leading-5 tracking-wide text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function WorkedLine({ handle, result }: { handle: string; result: Action }) {
  const line = RESULT_LINES[result];
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-2 text-sm">
      <span className="min-w-0 truncate">
        <span className="mr-2 font-medium">{handle}</span>
        <span className="text-muted-foreground">{line.text}</span>
      </span>
      <Badge variant="outline" className={line.className}>{line.badge}</Badge>
    </div>
  );
}

function PendingLine({ handle, dueAt, onUndo }: { handle: string; dueAt: number | null; onUndo: () => void }) {
  const seconds = useSecondsLeft(dueAt);
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-2 text-sm">
      <span className="min-w-0 truncate">
        <span className="mr-2 font-medium">{handle}</span>
        <span className="text-muted-foreground">Not a fit · back of the pool</span>
      </span>
      <Button variant="link" size="sm" className="h-auto px-0" onClick={onUndo}>
        Undo · {seconds}s
      </Button>
    </div>
  );
}

function SendingLine({ handle }: { handle: string }) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border border-dashed px-4 py-2 text-sm"
      role="status"
    >
      <span className="min-w-0 truncate">
        <span className="mr-2 font-medium">{handle}</span>
        <span className="text-muted-foreground">Not a fit · back of the pool</span>
      </span>
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
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
