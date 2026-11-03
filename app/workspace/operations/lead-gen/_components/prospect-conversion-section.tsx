"use client";

import { Fragment, useId, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { ChevronDownIcon } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { DetailCard, DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { MemberAvatar, getMemberDisplayName } from "@/app/workspace/_components/member-avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { figureClass, formatCount, formatShare, headClass, plural, reloadingClass } from "./lead-gen-format";

// The page's lead (Funnel first): the people the specialists first captured
// in the range, and how far they went, one cell per stage with its share of
// prospects. "By specialist" opens the same counts per person in place.

export type ConversionReport = FunctionReturnType<typeof api.leadGen.conversions.listProspectConversions>;
type ConversionRow = ConversionReport["rows"][number];
type Stage = keyof ConversionRow["counts"];

const STAGES: ReadonlyArray<{ stage: Stage; label: string; short: string; words: [string, string] }> = [
  { stage: "prospect", label: "Prospects", short: "Prospects", words: ["prospect", "prospects"] },
  { stage: "in_conversation", label: "In conversation", short: "In conv.", words: ["in conversation", "in conversation"] },
  { stage: "qualified", label: "Qualified", short: "Qualified", words: ["qualified", "qualified"] },
  { stage: "booked", label: "Booked", short: "Booked", words: ["booked", "booked"] },
  { stage: "showed", label: "Showed", short: "Showed", words: ["showed", "showed"] },
  { stage: "customer", label: "Customer", short: "Customer", words: ["customer", "customers"] },
];

function stageTotals(rows: ConversionRow[]) {
  const totals = Object.fromEntries(STAGES.map(({ stage }) => [stage, 0])) as Record<Stage, number>;
  let deals = 0;
  for (const row of rows) {
    for (const { stage } of STAGES) totals[stage] += row.counts[stage];
    deals += row.deals;
  }
  return { counts: totals, deals };
}

/** A stage's share of prospects as a 6px bar; Prospects is the full bar. */
function ShareBar({ value, full = false }: { value: number; full?: boolean }) {
  return (
    <div aria-hidden="true" className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", full ? "bg-foreground" : "bg-muted-foreground")}
        style={{ width: full ? "100%" : value > 0 ? `max(3px, ${Math.min(value, 1) * 100}%)` : 0 }}
      />
    </div>
  );
}

function StageStrip({ counts, deals }: { counts: Record<Stage, number>; deals: number }) {
  const prospects = counts.prospect;
  return (
    <dl className="grid grid-cols-2 gap-px border-b bg-border @lg/conv:grid-cols-3 @4xl/conv:grid-cols-[repeat(6,minmax(0,1fr))_minmax(0,0.9fr)]">
      {STAGES.map(({ stage, label }) => {
        const share = prospects > 0 ? counts[stage] / prospects : 0;
        return (
          <div key={stage} className="flex min-w-0 flex-col bg-card px-4 py-3">
            <dt className="truncate font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              {label}
            </dt>
            <dd className="mt-1 font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums">
              {formatCount(counts[stage])}
            </dd>
            <dd className="truncate text-[13px] text-muted-foreground">
              {stage === "prospect" ? "First captured" : `${formatShare(share)} of prospects`}
            </dd>
            <dd>
              <ShareBar value={share} full={stage === "prospect"} />
            </dd>
          </div>
        );
      })}
      <div className="col-span-2 flex min-w-0 flex-col bg-muted/40 px-4 py-3 @lg/conv:col-span-3 @4xl/conv:col-span-1">
        <dt className="font-condensed text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">Deals</dt>
        <dd className="mt-1 font-condensed text-[30px] leading-[1.05] font-semibold tabular-nums">{formatCount(deals)}</dd>
        <dd className="text-[13px] text-muted-foreground">The capture was the person&apos;s first touch</dd>
      </div>
    </dl>
  );
}

function CountCell({ count, prospects, share }: { count: number; prospects: number; share: boolean }) {
  return (
    <td className="px-2.5 py-2 text-right whitespace-nowrap">
      <span className={cn(figureClass, count === 0 && "text-muted-foreground")}>{formatCount(count)}</span>
      {share && prospects > 0 ? (
        <span className="ml-1 text-[13px] text-muted-foreground">{formatShare(count / prospects)}</span>
      ) : null}
    </td>
  );
}

/** Narrow cards: the counts in words, "61 prospects · 28 in conversation · …". */
function CountWords({ counts, deals }: { counts: Record<Stage, number>; deals: number }) {
  const facts: Array<[number, string]> = [
    ...STAGES.map(({ stage, words }): [number, string] => [counts[stage], counts[stage] === 1 ? words[0] : words[1]]),
    [deals, deals === 1 ? "deal" : "deals"],
  ];
  return (
    <p className="text-[13px] text-muted-foreground">
      {facts.map(([value, word], index) => (
        <Fragment key={index}>
          <span className="whitespace-nowrap">
            <span className={cn(figureClass, "text-foreground")}>{formatCount(value)}</span> {word}
          </span>
          {index < facts.length - 1 ? " · " : null}
        </Fragment>
      ))}
    </p>
  );
}

function BySpecialist({ rows, totals }: { rows: ConversionRow[]; totals: ReturnType<typeof stageTotals> }) {
  return (
    <>
      <table className="hidden w-full border-collapse @2xl/conv:table">
        <caption className="sr-only">Prospect conversion by specialist</caption>
        <thead>
          <tr className="border-b">
            <th scope="col" className={headClass("left")}>Specialist</th>
            {STAGES.map(({ stage, short }) => (
              <th key={stage} scope="col" className={headClass()}>{short}</th>
            ))}
            <th scope="col" className={cn(headClass(), "pr-4")}>Deals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.workerId} className="border-b">
              <th scope="row" className="py-2 pr-3 pl-4 text-left font-normal">
                <span className="flex min-w-0 items-center gap-2.5">
                  <MemberAvatar identity={row.worker} />
                  <span className="truncate font-medium">{getMemberDisplayName(row.worker)}</span>
                </span>
              </th>
              {STAGES.map(({ stage }) => (
                <CountCell key={stage} count={row.counts[stage]} prospects={row.counts.prospect} share={stage !== "prospect"} />
              ))}
              <td className={cn("py-2 pr-4 pl-2.5 text-right", figureClass, row.deals === 0 && "text-muted-foreground")}>
                {formatCount(row.deals)}
              </td>
            </tr>
          ))}
          <tr className="bg-muted/40">
            <th scope="row" className="py-2 pr-3 pl-4 text-left font-semibold">Total</th>
            {STAGES.map(({ stage }) => (
              <CountCell key={stage} count={totals.counts[stage]} prospects={totals.counts.prospect} share={stage !== "prospect"} />
            ))}
            <td className={cn("py-2 pr-4 pl-2.5 text-right", figureClass)}>{formatCount(totals.deals)}</td>
          </tr>
        </tbody>
      </table>

      <ul aria-label="Prospect conversion by specialist" className="flex flex-col @2xl/conv:hidden">
        {rows.map((row) => (
          <li key={row.workerId} className="flex flex-col gap-1 border-b px-4 py-2.5">
            <p className="truncate font-semibold">{getMemberDisplayName(row.worker)}</p>
            <CountWords counts={row.counts} deals={row.deals} />
          </li>
        ))}
        <li className="flex flex-col gap-1 bg-muted/40 px-4 py-2.5">
          <p className="font-semibold">Total</p>
          <CountWords counts={totals.counts} deals={totals.deals} />
        </li>
      </ul>
    </>
  );
}

function PartialNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-b px-4 py-2 text-[13px] text-muted-foreground">
      <span className="font-medium text-foreground">Partial.</span> {children}
    </p>
  );
}

export function ConversionStripSkeleton() {
  return (
    <div role="status" aria-label="Loading prospect conversion" className="grid grid-cols-2 gap-px bg-border @lg/conv:grid-cols-3 @4xl/conv:grid-cols-7">
      {Array.from({ length: 7 }, (_, index) => (
        <div key={index} className={cn("flex h-[104px] flex-col gap-2 bg-card px-4 py-3", index === 6 && "col-span-2 @lg/conv:col-span-3 @4xl/conv:col-span-1")}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-12" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  );
}

export function ProspectConversionSection({
  report,
  rangePhrase,
  reloading,
}: {
  report: ConversionReport | undefined;
  /** "today", "this week", "in this range". */
  rangePhrase: string;
  reloading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rows = report?.rows;
  const totals = rows ? stageTotals(rows) : null;
  const quiet = totals !== null && totals.counts.prospect === 0 && totals.deals === 0;

  return (
    <DetailCard
      title="Prospect conversion"
      meta={`People first captured ${rangePhrase} · all sources`}
      className="@container/conv min-w-0"
    >
      <div aria-busy={reloading} className={reloadingClass(reloading)}>
        {report === undefined || totals === null ? (
          <ConversionStripSkeleton />
        ) : quiet ? (
          <SectionEmpty title={`Nobody was first captured ${rangePhrase}.`}>
            People appear here when a specialist captures someone for the first time.
          </SectionEmpty>
        ) : (
          <>
            {report.capped ? <PartialNote>Showing the first 500 specialists only.</PartialNote> : null}
            {report.dealsCapped ? (
              <PartialNote>Deals counts what one read covers; this range holds more deals.</PartialNote>
            ) : null}
            <StageStrip counts={totals.counts} deals={totals.deals} />
            <div
              id={panelId}
              className="grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none"
              style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
              inert={!open}
            >
              <div className="min-h-0 overflow-hidden">
                <BySpecialist rows={report.rows} totals={totals} />
              </div>
            </div>
            <DetailCardFooter className={open ? undefined : "border-t-0"}>
              <span className="text-[13px] font-normal">
                {plural(report.rows.length, "specialist")} captured someone {rangePhrase}
              </span>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen((value) => !value)}
                className="inline-flex min-h-6 items-center gap-1 rounded-sm font-semibold text-foreground underline decoration-foreground/40 underline-offset-[3px] outline-none hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {open ? "Hide by specialist" : "By specialist"}
                <ChevronDownIcon
                  aria-hidden="true"
                  className={cn("size-4 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
                />
              </button>
            </DetailCardFooter>
          </>
        )}
      </div>
    </DetailCard>
  );
}
