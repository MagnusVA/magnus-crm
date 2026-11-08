"use client";

import type { ReactNode } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ENROLLMENT_STATUS_LABELS } from "@/convex/enrollments/validators";
import { personDate } from "@/app/workspace/leads-customers/[leadId]/_components/person-format";
import { NoteLine, StatusWord } from "@/app/workspace/settings/_components/settings-ui";
import { CARD, CardHead, HelpTip, LABEL } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { formatCash } from "@/lib/closer-pipeline";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";
import {
  ENROLLMENT_TONE,
  fieldOutcome,
  identifierList,
  personLabel,
  personWord,
  shortLabel,
  splitIdentifiers,
  type MergePreviewData,
} from "./merge-format";

// Step two: the two people side by side, a row per detail, and what the
// merge moves. Where both have a value the target's stays (merge.ts
// `buildProfileCarryOver`: the target's data wins, and the source only fills
// what the target lacks), so the source's is struck through and the target's
// checked; a value only the source has shows on the target "from" it.

type Mark = "dropped" | "kept" | "same";

type Cell = {
  value: ReactNode | null;
  /** The full text, for a truncated value and for screen readers on "Same". */
  text?: string;
  figure?: boolean;
  muted?: boolean;
  mark?: Mark;
  /** Slate words after the value: where it comes from. */
  note?: ReactNode;
};

type Row = { key: string; label: string; source: Cell; target: Cell };

const FIGURE = "font-condensed text-[15px] leading-none font-semibold tabular-nums";

function fieldRow(
  key: "fullName" | "email" | "phone",
  label: string,
  data: MergePreviewData,
  display: (value: string) => string,
  fromNote: ReactNode,
): Row {
  const sourceValue = data.source.lead[key];
  const targetValue = data.target.lead[key];
  const source = sourceValue?.trim() ? display(sourceValue) : null;
  const target = targetValue?.trim() ? display(targetValue) : null;
  const figure = key === "phone";
  const base = { figure };
  switch (fieldOutcome(key, sourceValue, targetValue)) {
    case "same":
      return { key, label, source: { ...base, value: source, text: source ?? undefined }, target: { value: "Same", text: target ?? undefined, mark: "same" } };
    case "conflict":
      return {
        key,
        label,
        source: { ...base, value: source, text: source ?? undefined, mark: "dropped" },
        target: { ...base, value: target, text: target ?? undefined, mark: "kept" },
      };
    case "fills":
      return { key, label, source: { ...base, value: source, text: source ?? undefined }, target: { ...base, value: source, text: source ?? undefined, note: fromNote } };
    case "kept":
      return { key, label, source: { value: null }, target: { ...base, value: target, text: target ?? undefined } };
    case "none":
      return { key, label, source: { value: null }, target: { value: null } };
  }
}

function useRows(data: MergePreviewData): { fields: Row[]; counts: Row[] } {
  const { setting } = useBusinessDay();
  const now = useNow();
  const sourceShort = shortLabel(data.source.lead);
  const from = <>from {sourceShort}</>;
  const sourceWord = personWord(data.source.lead.status);
  const targetWord = personWord(data.target.lead.status);
  // The target's programs re-derive from every payment it then holds, which
  // makes it a customer when the source was one (merge.ts, `syncPersonEnrollments`).
  const becomesCustomer = data.source.lead.status === "converted" && data.target.lead.status !== "converted";

  const fields: Row[] = [
    fieldRow("fullName", "Name", data, (value) => value.trim(), from),
    fieldRow(
      "email",
      "Email",
      data,
      (value) => value.trim(),
      <HelpTip tip="Moves over unless another person already has this email.">from {sourceShort}</HelpTip>,
    ),
    fieldRow("phone", "Phone", data, formatPhone, from),
    {
      key: "status",
      label: "Status",
      source: { value: <StatusWord tone={sourceWord.tone}>{sourceWord.word}</StatusWord> },
      target: becomesCustomer
        ? { value: <StatusWord tone="ok">Customer</StatusWord>, note: from }
        : { value: <StatusWord tone={targetWord.tone}>{targetWord.word}</StatusWord> },
    },
  ];

  const calls = (summary: MergePreviewData["source"]["summary"]): Cell =>
    summary
      ? {
          value: (
            <>
              <span className={FIGURE}>{summary.meetingCount}</span>
              {summary.latestMeetingAt !== null ? (
                <span className="text-[13px] text-muted-foreground"> · last {personDate(summary.latestMeetingAt, setting, now)}</span>
              ) : null}
            </>
          ),
        }
      : { value: null };
  const paid = (summary: MergePreviewData["source"]["summary"]): Cell => {
    if (!summary) return { value: null };
    if (summary.totalPaidMinor > 0 && summary.paymentCurrency) {
      return { value: formatCash(summary.totalPaidMinor, summary.paymentCurrency), figure: true };
    }
    // The search row keeps a currency only when every payment shares one.
    if (summary.totalPaidMinor > 0) return { value: "Several currencies" };
    return { value: "None", muted: true };
  };
  const count = (value: number | undefined): Cell => (value === undefined ? { value: null } : { value: String(value), figure: true });

  const counts: Row[] = [
    { key: "identifiers", label: "Identifiers", source: count(data.source.identifiers.length), target: count(data.target.identifiers.length) },
    { key: "deals", label: "Deals", source: count(data.source.opportunityCount), target: count(data.target.opportunityCount) },
    {
      key: "won",
      label: "Won deals",
      source: count(data.source.summary?.wonOpportunityCount),
      target: count(data.target.summary?.wonOpportunityCount),
    },
    { key: "calls", label: "Calls", source: calls(data.source.summary), target: calls(data.target.summary) },
    { key: "paid", label: "Paid", source: paid(data.source.summary), target: paid(data.target.summary) },
  ];
  return { fields, counts };
}

function CellValue({ cell }: { cell: Cell }) {
  if (cell.value === null) return <span className="text-muted-foreground">—</span>;
  if (cell.mark === "same") {
    return (
      <span className="flex items-center gap-1.5" title={cell.text}>
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={3} />
        Same
        {cell.text ? <span className="sr-only">: {cell.text}</span> : null}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {cell.mark === "kept" ? (
        <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 self-center" strokeWidth={3} />
      ) : null}
      <span
        title={cell.text}
        translate={cell.text ? "no" : undefined}
        className={cn(
          "min-w-0 truncate",
          cell.figure && FIGURE,
          cell.muted && "text-muted-foreground",
          cell.mark === "dropped" && "text-muted-foreground line-through decoration-muted-foreground/70",
        )}
      >
        {cell.value}
      </span>
      {cell.mark === "dropped" ? <span className="sr-only">, not kept</span> : null}
      {cell.mark === "kept" ? <span className="sr-only">, kept</span> : null}
      {cell.note ? <span className="shrink-0 text-[13px] whitespace-nowrap text-muted-foreground">{cell.note}</span> : null}
    </span>
  );
}

function PersonHead({ name, kept, as: Heading = "span" }: { name: string; kept: boolean; as?: "span" | "h3" }) {
  return (
    <>
      <Heading className="block text-[15px] leading-tight font-semibold break-words" translate="no">
        {name}
      </Heading>
      <StatusWord tone={kept ? "ok" : "muted"} className="mt-1 block">
        {kept ? "Kept" : "Absorbed"}
      </StatusWord>
    </>
  );
}

function Legend({ source, target }: { source: string; target: string }) {
  return (
    <HelpTip
      tip={`Where both have a value, ${target}'s stays and ${source}'s is struck through. What only ${source} has moves over to ${target}.`}
      className="text-[12px] whitespace-nowrap text-muted-foreground"
    >
      How to read
    </HelpTip>
  );
}

/** Below @3xl of the card: one block per person, label and value rows. */
function PersonBlock({ name, kept, rows, side, legend }: { name: string; kept: boolean; rows: Row[][]; side: "source" | "target"; legend?: ReactNode }) {
  return (
    <div className={cn("relative px-4 pt-2.5 pb-1.5", side === "target" && "border-t border-border")}>
      {legend ? <span className="absolute top-2.5 right-4">{legend}</span> : null}
      <PersonHead name={name} kept={kept} as="h3" />
      {rows.map((group, index) => (
        <dl key={index} className={cn("mt-1.5", index > 0 && "border-t border-border pt-0.5")}>
          {group.map((row) => (
            <div key={row.key} className="grid min-h-8 grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3 text-[14px]">
              <dt className="text-[13px] text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0">
                <CellValue cell={row[side]} />
              </dd>
            </div>
          ))}
        </dl>
      ))}
    </div>
  );
}

function MoveRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-8 grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-x-3 border-t border-border/60 px-4 py-1.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-[14px]">{children}</dd>
    </div>
  );
}

function WhatMoves({ data }: { data: MergePreviewData }) {
  const { preview } = data;
  const sourceShort = shortLabel(data.source.lead);
  const targetShort = shortLabel(data.target.lead);
  const { moving, duplicates } = splitIdentifiers(data);
  const programs = [
    ...preview.enrollmentsToMove.map((enrollment) => ({ kind: "move" as const, ...enrollment })),
    ...preview.enrollmentsToCombine.map((enrollment) => ({ kind: "combine" as const, ...enrollment })),
  ];

  return (
    <div className="border-t border-border pt-2.5">
      <h3 className={cn(LABEL, "px-4 pb-1.5")}>What moves</h3>
      <dl>
        <MoveRow label="Identifiers">
          {moving.length === 0 && duplicates.length === 0 ? (
            <span className="text-muted-foreground">None</span>
          ) : (
            <>
              {moving.length > 0 ? (
                <HelpTip tip={identifierList(moving)}>
                  <span className={FIGURE}>{moving.length}</span> {moving.length === 1 ? "moves" : "move"}
                </HelpTip>
              ) : (
                <span>None move</span>
              )}
              {duplicates.length > 0 ? (
                <span className="text-muted-foreground">
                  {" · "}
                  <HelpTip tip={`Dropped, as ${targetShort} has ${duplicates.length === 1 ? "it" : "them"}: ${identifierList(duplicates)}`}>
                    <span className={FIGURE}>{duplicates.length}</span> already on {targetShort}
                  </HelpTip>
                </span>
              ) : null}
            </>
          )}
        </MoveRow>
        <MoveRow label="Deals">
          {preview.opportunitiesToMove === 0 ? (
            <span className="text-muted-foreground">None to move</span>
          ) : (
            <>
              All move with their calls and payments
              <span className="text-muted-foreground">
                {" · "}
                {targetShort} then has <span className={cn(FIGURE, "text-foreground")}>{preview.totalOpportunitiesAfterMerge}</span>{" "}
                {preview.totalOpportunitiesAfterMerge === 1 ? "deal" : "deals"}
              </span>
            </>
          )}
        </MoveRow>
        {programs.length === 0 ? (
          <MoveRow label="Programs">
            <span className="text-muted-foreground">None</span>
          </MoveRow>
        ) : (
          programs.map((program, index) => (
            <MoveRow key={program.programId} label={index === 0 ? (programs.length === 1 ? "Program" : "Programs") : ""}>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="min-w-0 truncate font-medium" translate="no" title={program.programName}>
                  {program.programName}
                </span>
                {program.kind === "move" ? (
                  <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <StatusWord tone={ENROLLMENT_TONE[program.status]}>{ENROLLMENT_STATUS_LABELS[program.status]}</StatusWord>
                    <span className="text-[13px] text-muted-foreground">moves to {targetShort}</span>
                  </span>
                ) : (
                  <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span className="sr-only">{sourceShort}&apos;s </span>
                    <StatusWord tone={ENROLLMENT_TONE[program.sourceStatus]}>{ENROLLMENT_STATUS_LABELS[program.sourceStatus]}</StatusWord>
                    <span aria-hidden="true" className="text-muted-foreground">+</span>
                    <span className="sr-only">and {targetShort}&apos;s </span>
                    <StatusWord tone={ENROLLMENT_TONE[program.targetStatus]}>{ENROLLMENT_STATUS_LABELS[program.targetStatus]}</StatusWord>
                    <span aria-hidden="true" className="text-muted-foreground">→</span>
                    <span className="sr-only">become </span>
                    <StatusWord tone={ENROLLMENT_TONE[program.status]}>{ENROLLMENT_STATUS_LABELS[program.status]}</StatusWord>
                    <HelpTip
                      tip="Both are in this program, so the two become one, with the status an admin changed most recently."
                      className="text-[13px] text-muted-foreground"
                    >
                      combined
                    </HelpTip>
                  </span>
                )}
              </span>
            </MoveRow>
          ))
        )}
      </dl>
    </div>
  );
}

export function MergePreviewCard({
  data,
  onChangePerson,
  onReview,
}: {
  data: MergePreviewData;
  onChangePerson: () => void;
  onReview: () => void;
}) {
  const { fields, counts } = useRows(data);
  const source = personLabel(data.source.lead);
  const target = personLabel(data.target.lead);
  const blocked = data.preview.exceedsMergeLimit;
  const legend = <Legend source={shortLabel(data.source.lead)} target={shortLabel(data.target.lead)} />;

  return (
    <section aria-labelledby="merge-preview-title" className={cn(CARD, "@container/cmp")}>
      <CardHead title={<span id="merge-preview-title">Merge preview</span>} />

      {/* From @3xl of the card: one table, the person absorbed beside the person kept. */}
      <table className="hidden w-full table-fixed border-collapse text-[14px] @3xl/cmp:table">
        <colgroup>
          <col className="w-[7.5rem]" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr className="align-top">
            <td className="py-2.5 pl-4 align-bottom">{legend}</td>
            <th scope="col" className="px-3 py-2.5 text-left font-normal">
              <PersonHead name={source} kept={false} />
            </th>
            <th scope="col" className="px-3 py-2.5 pr-4 text-left font-normal">
              <PersonHead name={target} kept />
            </th>
          </tr>
        </thead>
        {[fields, counts].map((group, index) => (
          <tbody key={index} className="border-t border-border">
            {group.map((row) => (
              <tr key={row.key} className="h-[34px] border-t border-border/60 first:border-t-0">
                <th scope="row" className="pl-4 text-left text-[13px] font-normal text-muted-foreground">
                  {row.label}
                </th>
                <td className="px-3">
                  <CellValue cell={row.source} />
                </td>
                <td className="px-3 pr-4">
                  <CellValue cell={row.target} />
                </td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>

      {/* Below @3xl: a block per person, the marks kept. */}
      <div className="@3xl/cmp:hidden">
        <PersonBlock name={source} kept={false} rows={[fields, counts]} side="source" legend={legend} />
        <PersonBlock name={target} kept rows={[fields, counts]} side="target" />
      </div>

      <WhatMoves data={data} />

      {blocked ? (
        <div className="border-t border-border px-4 py-2.5">
          <NoteLine tone="danger" role="alert">
            These two have too many deals between them to merge in one step.
          </NoteLine>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-2.5">
        <Button type="button" variant="outline" onClick={onChangePerson}>
          Change person
        </Button>
        <Button type="button" onClick={onReview} disabled={blocked} className="font-semibold">
          <span>
            Merge into <span translate="no">{shortLabel(data.target.lead)}</span>…
          </span>
        </Button>
      </div>
    </section>
  );
}
