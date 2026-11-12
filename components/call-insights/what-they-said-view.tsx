"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  checkLine,
  moneyFigure,
  moneyPhrase,
} from "@/lib/callInsights/display";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DetailCard } from "@/app/workspace/closer/meetings/_components/detail-card";
import {
  InsightChip,
  InsightChips,
  InsightDetail,
  InsightFigure,
  InsightGroup,
  InsightMeta,
  InsightUnit,
  InsightQuote,
  InsightTime,
  Insights,
  StatusWord,
} from "./insight-parts";
import { Chip } from "./item-rows";

export type MeetingInsights = NonNullable<
  FunctionReturnType<typeof api.callInsights.queries.forMeeting>
>;
export type InsightItem = MeetingInsights["items"][number];
export type RejectedItem = NonNullable<
  MeetingInsights["admin"]
>["rejected"][number];

const TITLE = "What they said";

/** The card while the call is being read, or waiting for room to be read. */
export function WhatTheySaidPending({
  waiting,
  footer,
}: {
  /** Waiting for room under the month's limit, which only an admin is told. */
  waiting: boolean;
  footer?: ReactNode;
}) {
  return (
    <DetailCard title={TITLE}>
      <div className="flex flex-col gap-2 p-4" role="status">
        <p className="text-sm text-muted-foreground">
          {waiting
            ? "Waiting for room under this month's limit."
            : "Reading the call…"}
        </p>
        {waiting ? null : (
          <>
            <Skeleton className="h-3 w-4/5" />
            <Skeleton className="h-3 w-[62%]" />
          </>
        )}
      </div>
      {footer}
    </DetailCard>
  );
}

/** The card for a call that wasn't read, which only an admin sees. */
export function WhatTheySaidNotRead({
  reason,
  footer,
}: {
  reason: string;
  footer?: ReactNode;
}) {
  return (
    <DetailCard title={TITLE} badge={<Chip>Not read</Chip>}>
      <p className="p-4 text-sm text-muted-foreground">{reason}</p>
      {footer}
    </DetailCard>
  );
}

/**
 * What the prospect said on a read call: income as figures, then objections,
 * struggles and goals as chips that open the words behind them. The main
 * objection starts open, so the card answers "what is in the way?" at rest.
 * Prospect words sit under `ph-no-capture` so session replay never records them.
 */
export function WhatTheySaidRead({
  data,
  hidden,
  footer,
}: {
  data: MeetingInsights;
  /** An admin's group of items Jev's check hid. */
  hidden?: ReactNode;
  footer: ReactNode;
}) {
  const of = (kind: InsightItem["kind"]) =>
    data.items.filter((item) => item.kind === kind);
  const income = of("income");
  const objections = of("objection");
  const struggles = of("struggle");
  const goals = of("goal");
  const empty = data.items.length === 0;
  const startsOpen =
    objections.find((item) => item.isPrimary) ??
    objections.find((item) => item.resolution === "unresolved") ??
    objections[0];

  return (
    <DetailCard
      title={TITLE}
      badge={<Chip>Machine-read</Chip>}
      className="ph-no-capture"
    >
      {data.rereading ? (
        <Notice>
          Reading again. This result stays until the new one is saved.
        </Notice>
      ) : null}
      {data.speakerUncertain ? (
        <Notice tone="warning">
          The recording doesn&apos;t make clear who is speaking, so treat this
          with care.
        </Notice>
      ) : null}
      {empty && !hidden ? (
        <p className="p-4 text-sm text-muted-foreground">
          {data.readKind === "attendance_only"
            ? "Only the closer is heard on this recording, so there is nothing to list."
            : "The prospect didn't state an objection, a struggle, a goal or an income on this call."}
        </p>
      ) : (
        <Insights defaultOpenKey={startsOpen?.key ?? null}>
          {income.length > 0 ? (
            <InsightGroup label="Income">
              <div className="flex flex-col gap-2">
                {income.map((item) => (
                  <IncomeLine key={item.key} item={item} />
                ))}
              </div>
            </InsightGroup>
          ) : null}
          {objections.length > 0 ? (
            <InsightGroup label="Objections">
              <InsightChips>
                {objections.map((item) => (
                  <InsightChip
                    key={item.key}
                    itemKey={item.key}
                    status={<ObjectionStatus item={item} />}
                  >
                    {item.label}
                  </InsightChip>
                ))}
              </InsightChips>
              {objections.map((item) => (
                <ItemDetail key={item.key} item={item} />
              ))}
            </InsightGroup>
          ) : null}
          {struggles.length > 0 ? (
            <InsightGroup label="Struggles">
              <InsightChips>
                {struggles.map((item) => (
                  <InsightChip
                    key={item.key}
                    itemKey={item.key}
                    status={<Unsure item={item} />}
                  >
                    {item.label}
                  </InsightChip>
                ))}
              </InsightChips>
              {struggles.map((item) => (
                <ItemDetail key={item.key} item={item} />
              ))}
            </InsightGroup>
          ) : null}
          {goals.length > 0 ? (
            <InsightGroup label="Goals">
              <InsightChips>
                {goals.map((item) => {
                  const amount = moneyPhrase(item);
                  return (
                    <InsightChip
                      key={item.key}
                      itemKey={item.key}
                      status={
                        <>
                          {amount ? (
                            <StatusWord tone="figure">{amount}</StatusWord>
                          ) : null}
                          <Unsure item={item} />
                        </>
                      }
                    >
                      {item.label}
                    </InsightChip>
                  );
                })}
              </InsightChips>
              {goals.map((item) => (
                <ItemDetail key={item.key} item={item}>
                  {item.deadline ? (
                    <span>Deadline: {item.deadline}</span>
                  ) : null}
                </ItemDetail>
              ))}
            </InsightGroup>
          ) : null}
          {hidden}
        </Insights>
      )}
      {footer}
    </DetailCard>
  );
}

function Notice({
  tone = "plain",
  children,
}: {
  tone?: "plain" | "warning";
  children: ReactNode;
}) {
  return (
    <p
      className={
        tone === "warning"
          ? "border-b bg-warning-surface px-4 py-2 text-[0.8125rem] text-warning-ink"
          : "border-b px-4 py-2 text-[0.8125rem] text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}

function Unsure({ item }: { item: Pick<InsightItem, "check"> }) {
  return item.check === "unsure" ? (
    <StatusWord tone="unsure">Not confirmed</StatusWord>
  ) : null;
}

/** "Open · Main" in red, "Resolved" in lime ink, then "Not confirmed". */
function ObjectionStatus({ item }: { item: InsightItem }) {
  const open = item.resolution === "unresolved";
  const resolved = item.resolution === "resolved";
  const words = [
    open ? "Open" : resolved ? "Resolved" : null,
    item.isPrimary ? "Main" : null,
  ].filter(Boolean);
  return (
    <>
      {words.length > 0 ? (
        <StatusWord tone={resolved ? "resolved" : open ? "open" : "muted"}>
          {words.join(" · ")}
        </StatusWord>
      ) : null}
      <Unsure item={item} />
    </>
  );
}

const CHECK_INK = {
  confirmed: "text-primary-ink",
  unsure: "text-warning-ink",
  plain: "",
} as const;

/** The words behind a chip: the quote, what it means, when, and Jev's check. */
function ItemDetail({
  item,
  children,
}: {
  item: InsightItem;
  /** Extra facts for the small line, such as a goal's deadline. */
  children?: ReactNode;
}) {
  const check = checkLine(item.check);
  return (
    <InsightDetail
      itemKey={item.key}
      tone={check.tone === "plain" ? "hidden" : check.tone}
    >
      <InsightQuote quote={item.quote} />
      {item.statement ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          {item.statement}
        </p>
      ) : null}
      {item.kind === "objection" &&
      item.resolution === "resolved" &&
      item.resolutionQuote ? (
        <p className="text-[0.8125rem]">
          <span className="text-muted-foreground">Then: </span>
          &ldquo;{item.resolutionQuote}&rdquo;
        </p>
      ) : null}
      <InsightMeta>
        <InsightTime at={item.at} />
        {children}
        <span className={CHECK_INK[check.tone]}>{check.text}</span>
      </InsightMeta>
    </InsightDetail>
  );
}

/** One amount the prospect said, with a chip that opens the quote. */
function IncomeLine({ item }: { item: InsightItem }) {
  const money = moneyFigure(item);
  const what = [
    money?.unit,
    item.label.toLowerCase(),
    item.scenario === "target" ? "target" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div>
      {/* On a narrow card the words drop under the figure and its chip. */}
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        {money ? (
          <>
            <InsightFigure>{money.figure}</InsightFigure>
            <InsightUnit className="@max-md:order-last @max-md:basis-full">
              {what}
              {item.currency ? null : (
                <span className="text-muted-foreground">
                  {" "}
                  · currency not stated
                </span>
              )}
            </InsightUnit>
          </>
        ) : (
          <span className="text-sm font-medium">{item.label}</span>
        )}
        <span className="self-center">
          <InsightChip itemKey={item.key} status={<Unsure item={item} />}>
            Quote
          </InsightChip>
        </span>
      </div>
      <ItemDetail item={item} />
    </div>
  );
}

const REVIEW_STATE_WORDS: Record<RejectedItem["reviewState"], string | null> = {
  open: null,
  restored: "Shown",
  dismissed: "Left hidden",
  superseded: "Replaced",
};

/**
 * The items Jev's check hid, for an admin to show or leave hidden. Each chip
 * opens the item's words and the two decisions.
 */
export function HiddenGroup({
  items,
  pending,
  onDecide,
}: {
  items: RejectedItem[];
  /** The decision being saved, as `<item key>:<decision>`. */
  pending: string | null;
  /** Absent when the reading can no longer be changed. */
  onDecide?: (itemKey: string, decision: "restore" | "dismiss") => void;
}) {
  if (items.length === 0) return null;
  return (
    <InsightGroup label="Hidden by Jev">
      <InsightChips>
        {items.map((item) => {
          const word = REVIEW_STATE_WORDS[item.reviewState];
          return (
            <InsightChip
              key={item.key}
              itemKey={`hidden:${item.key}`}
              status={
                word ? <StatusWord tone="muted">{word}</StatusWord> : null
              }
            >
              <span className="text-muted-foreground">{item.label}</span>
            </InsightChip>
          );
        })}
      </InsightChips>
      {items.map((item) => (
        <InsightDetail
          key={item.key}
          itemKey={`hidden:${item.key}`}
          tone="hidden"
        >
          <InsightQuote quote={item.quote} />
          {item.statement ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              {item.statement}
            </p>
          ) : null}
          {onDecide && item.reviewState === "open" ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => onDecide(item.key, "restore")}
              >
                {pending === `${item.key}:restore` ? "Showing…" : "Show it"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending !== null}
                onClick={() => onDecide(item.key, "dismiss")}
              >
                {pending === `${item.key}:dismiss` ? "Saving…" : "Leave hidden"}
              </Button>
              <span className="text-[0.8125rem] text-muted-foreground">
                Jev didn&apos;t find this in the lines it was read from.
              </span>
            </div>
          ) : null}
        </InsightDetail>
      ))}
    </InsightGroup>
  );
}
