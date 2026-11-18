"use client";

import { useState } from "react";
import Link from "next/link";
import { useConvexAuth, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import {
  DetailCard,
  DetailCardFooter,
  detailLinkClass,
} from "@/app/workspace/closer/meetings/_components/detail-card";
import { useLocalFormat } from "@/app/workspace/closer/meetings/_components/local-time";
import { useKeptWhileLoading } from "@/app/workspace/operations/lead-gen/_components/use-kept-while-loading";
import {
  COLUMN_HEAD,
  RowsSkeleton,
  StatusWord,
} from "@/app/workspace/reports/_components/report-ui";
import { formatAmountMinor } from "@/lib/format-currency";
import { cn } from "@/lib/utils";
import {
  PROPOSAL_KIND_WORDS,
  PROPOSAL_STATE_FILTERS,
  PROPOSAL_STATE_TONE,
  PROPOSAL_STATE_WORDS,
  WAITING_STATES,
  gateSentence,
  stopSentence,
  type ProposalKind,
  type ProposalState,
} from "./proposal-words";

const PAGE_SIZE = 25;
const AUTOMATIC_RESULTS_HREF = "/workspace/settings/automatic-results";

type ProposalRow = FunctionReturnType<
  typeof api.automation.callDecisions.listCallProposals
>["page"][number];
type KindFilter = "all" | ProposalKind;
type StateFilter = "all" | ProposalState;

const KIND_FILTERS = Object.keys(PROPOSAL_KIND_WORDS) as ProposalKind[];

const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1 px-4 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_auto]";

/**
 * What the system proposed from recorded calls, a page at a time: the kind,
 * its state, why it waits (one sentence per gate), when it was made, and a
 * link to the meeting where a person confirms it. Read only: nothing here
 * confirms a result, and no words from the call appear.
 */
export function ProposalsTab() {
  const [kind, setKind] = useState<KindFilter>("all");
  const [state, setState] = useState<StateFilter>("all");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const cursor = cursors.at(-1) ?? null;
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.automation.callDecisions.listCallProposals,
    isAuthenticated
      ? {
          paginationOpts: { numItems: PAGE_SIZE, cursor },
          ...(kind === "all" ? {} : { kind }),
          ...(state === "all" ? {} : { state }),
        }
      : "skip",
  );
  const { data, reloading } = useKeptWhileLoading(
    result,
    `${kind}:${state}:${cursor ?? ""}`,
  );
  const filtered = kind !== "all" || state !== "all";
  const hasPagination = data !== undefined && (cursors.length > 1 || !data.isDone);

  return (
    <DetailCard
      title="Proposals from calls"
      metaClassName="flex-wrap"
      meta={
        <>
          <Select
            value={kind}
            onValueChange={(next) => {
              setKind(next as KindFilter);
              setCursors([null]);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Show proposals by kind"
              className="w-40"
            >
              <SelectValue>
                {kind === "all" ? "Every kind" : PROPOSAL_KIND_WORDS[kind]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Every kind</SelectItem>
                {KIND_FILTERS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {PROPOSAL_KIND_WORDS[option]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={state}
            onValueChange={(next) => {
              setState(next as StateFilter);
              setCursors([null]);
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label="Show proposals by state"
              className="w-40"
            >
              <SelectValue>
                {state === "all" ? "Every state" : PROPOSAL_STATE_WORDS[state]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">Every state</SelectItem>
                {PROPOSAL_STATE_FILTERS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {PROPOSAL_STATE_WORDS[option]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </>
      }
    >
      <div className="@container">
        {data === undefined ? (
          <RowsSkeleton rows={6} rowHeight="h-16" label="Loading proposals" />
        ) : data.page.length === 0 ? (
          !filtered && cursors.length === 1 && data.isDone ? (
            <SectionEmpty title="No proposals yet.">
              They appear once a call kind is switched on in{" "}
              <Link
                href={AUTOMATIC_RESULTS_HREF}
                className={cn(detailLinkClass, "inline")}
              >
                Automatic results
              </Link>
              .
            </SectionEmpty>
          ) : data.isDone ? (
            <SectionEmpty title="No more proposals match these filters." />
          ) : (
            <SectionEmpty title="No proposals match on this page.">
              Next looks further.
            </SectionEmpty>
          )
        ) : (
          <div
            aria-busy={reloading || undefined}
            className={cn(
              "transition-opacity duration-200",
              reloading && "opacity-60",
            )}
          >
            <div
              aria-hidden="true"
              className={cn(ROW_GRID, "hidden border-b @3xl:grid")}
            >
              <span className={cn(COLUMN_HEAD, "px-0")}>Proposal</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>State</span>
              <span className={cn(COLUMN_HEAD, "px-0")}>Meeting</span>
            </div>
            <ul aria-label="Proposals from recorded calls">
              {data.page.map((row) => (
                <ProposalRowItem key={row._id} row={row} />
              ))}
            </ul>
          </div>
        )}
      </div>
      {data !== undefined && (hasPagination || data.postFiltered) ? (
        <DetailCardFooter>
          <span className="text-[13px] font-normal">
            {data.postFiltered
              ? "This page excludes Whop payment proposals."
              : `Up to ${PAGE_SIZE} a page`}
          </span>
          {hasPagination ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={cursors.length === 1 || reloading}
                onClick={() => setCursors((previous) => previous.slice(0, -1))}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={data.isDone || reloading}
                onClick={() =>
                  setCursors((previous) => [...previous, data.continueCursor])
                }
              >
                Next
              </Button>
            </div>
          ) : null}
        </DetailCardFooter>
      ) : null}
    </DetailCard>
  );
}

function ProposalRowItem({ row }: { row: ProposalRow }) {
  const format = useLocalFormat();
  const kind = row.kind as ProposalKind;
  const waiting = WAITING_STATES.has(row.state);
  const reasons = waiting ? row.gates.map(gateSentence) : [];
  const proposed = proposedWords(row, (at) => format(at, "MMM d, h:mm a"));
  const facts = [
    `Made ${format(row.createdAt, "MMM d, h:mm a")}`,
    row.mode === "automatic" ? "automatic" : null,
    row.resolvedAt !== undefined
      ? `closed ${format(row.resolvedAt, "MMM d, h:mm a")}`
      : null,
  ].filter(Boolean);

  return (
    <li className={cn(ROW_GRID, "min-h-16 border-b py-2.5 last:border-b-0")}>
      <div className="min-w-0">
        <p className="font-medium">
          {PROPOSAL_KIND_WORDS[kind] ?? "Proposal"}
        </p>
        <p className="text-[13px]">
          <span translate="no">{row.personName}</span> ·{" "}
          {row.closerName ? <span translate="no">{row.closerName}</span> : "No closer"}
        </p>
        <p className="text-[13px] text-muted-foreground">
          <span className="font-condensed text-sm font-semibold tabular-nums">
            {facts.join(" · ")}
          </span>
        </p>
        {proposed ? (
          <p className="text-[13px] text-muted-foreground">{proposed}</p>
        ) : null}
        {reasons.length ? (
          <ul aria-label="Why it waits" className="mt-1 flex flex-col gap-0.5">
            {[...new Set(reasons)].map((reason) => (
              <li key={reason} className="text-[13px]">
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
        {row.state === "stopped" && row.stopCode ? (
          <p className="mt-1 text-[13px]">{stopSentence(row.stopCode)}</p>
        ) : null}
      </div>
      <div className="min-w-0 text-right @3xl:text-left">
        <StatusWord tone={PROPOSAL_STATE_TONE[row.state]}>
          {PROPOSAL_STATE_WORDS[row.state]}
        </StatusWord>
      </div>
      <div className="col-span-2 @3xl:col-span-1 @3xl:text-right">
        {row.meetingId ? (
          <Link
            href={`/workspace/pipeline/meetings/${row.meetingId}`}
            className={cn(detailLinkClass, "text-sm")}
          >
            Open meeting
          </Link>
        ) : (
          <span className="text-[13px] text-muted-foreground">No meeting</span>
        )}
      </div>
    </li>
  );
}

/** What the proposal would set: "Reminder Nov 20, 3:00 PM by call · 500.00 USD". Numbers only. */
function proposedWords(
  row: ProposalRow,
  at: (time: number) => string,
): string | null {
  const proposal = row.proposal;
  if (!proposal || !("type" in proposal) || proposal.type !== "task")
    return null;
  const parts = [
    `Reminder ${at(proposal.reminderScheduledAt)} by ${proposal.contactMethod === "text" ? "text" : "call"}`,
  ];
  if (
    proposal.expectedAmountMinor !== undefined &&
    proposal.expectedCurrency !== undefined
  )
    parts.push(
      formatAmountMinor(proposal.expectedAmountMinor, proposal.expectedCurrency),
    );
  return parts.join(" · ");
}
