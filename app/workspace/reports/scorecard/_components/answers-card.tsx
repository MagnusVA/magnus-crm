"use client";

import { useState, type ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { AnswersOutput } from "@/convex/reports/scorecard";
import type { AnalyticsSource } from "@/app/workspace/_components/analytics/use-analytics-report";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { COLUMN_HEAD, FIGURE_15, ReportCard, ReportNote, RowsSkeleton } from "../../_components/report-ui";
import { formatCount, formatShare } from "./report-money";

// What predicts a sale (§08): for each answer to one booking-form question,
// how many people gave it, and how many of their deals held a call and were
// won. ClickHouse answers the whole range as of the last sync, since the
// people and their deals can't be split at today (merge `null`).

type Catalog = FunctionReturnType<typeof api.reports.formFields.getFieldCatalog>;

const SHOWN = 12;

/** One option per field key: the same question on two event types shares a key. */
export function answerFields(catalog: Catalog | undefined) {
  return catalog?.filter((field, index) => catalog.findIndex((other) => other.fieldKey === field.fieldKey) === index);
}

/** The field the card opens on: an income-like question when the form has one. */
export function defaultAnswerField(catalog: Catalog | undefined): string | null {
  const fields = answerFields(catalog) ?? [];
  const income = fields.find((field) => /income|revenue|earn|salary|budget|invest|make per/iu.test(field.currentLabel));
  return (income ?? fields[0])?.fieldKey ?? null;
}

export function AnswersCard({
  catalog,
  fieldKey,
  onFieldKeyChange,
  answers,
  source,
  freshness,
  reloading,
  phrase,
}: {
  catalog: Catalog | undefined;
  fieldKey: string | null;
  onFieldKeyChange: (next: string) => void;
  answers: AnswersOutput | undefined;
  source: AnalyticsSource;
  /** This card's own freshness line: it reads the whole range as of the last sync. */
  freshness: ReactNode;
  reloading: boolean;
  phrase: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const fields = answerFields(catalog);
  const rows = answers?.answers ?? [];
  const shown = showAll ? rows : rows.slice(0, SHOWN);
  return (
    <ReportCard
      title="What predicts a sale"
      container="@container/answers"
      reloading={reloading}
      meta={
        fields && fields.length > 0 ? (
          <Select value={fieldKey ?? undefined} onValueChange={onFieldKeyChange}>
            <SelectTrigger
              aria-label="Booking-form question"
              className="h-[30px]! w-[20rem] max-w-full min-w-0 rounded-[7px] bg-background text-[13px] text-foreground [&>span]:truncate"
            >
              <SelectValue placeholder="Pick a question" />
            </SelectTrigger>
            <SelectContent align="end">
              {fields.map((field) => (
                <SelectItem key={field.id} value={field.fieldKey}>
                  {field.currentLabel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined
      }
      footer={
        rows.length > SHOWN ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              {showAll ? `All ${formatCount(rows.length)} answers` : `Showing ${SHOWN} of ${formatCount(rows.length)} answers`}
            </span>
            <Button variant="outline" size="sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show fewer" : `Show all ${formatCount(rows.length)}`}
            </Button>
          </DetailCardFooter>
        ) : undefined
      }
    >
      {catalog === undefined ? (
        <RowsSkeleton rows={5} label="Loading booking-form questions" />
      ) : !fields || fields.length === 0 ? (
        <SectionEmpty title="No booking-form questions yet.">Questions appear once people book through a Calendly form.</SectionEmpty>
      ) : (
        <>
          {freshness ? <div className="border-b px-4 py-2">{freshness}</div> : null}
          <ReportNote lead={source === "warehouse" ? "As of the last sync." : "Live."}>
            {source === "warehouse"
              ? "Answers for the whole range come from the reporting database as of its last sync, today included only once it syncs. "
              : null}
            Self-reported on the booking form. Contact answers are never shown. Shares are of the people who gave each answer.
          </ReportNote>
          {answers === undefined ? (
            <RowsSkeleton rows={5} label="Loading answers" />
          ) : rows.length === 0 ? (
            <SectionEmpty title={`No one answered “${answers.label}” ${phrase}.`} />
          ) : (
            <table className="w-full border-collapse">
              <caption className="sr-only">
                People, held calls and won deals by answer to {answers.label}
              </caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className={cn(COLUMN_HEAD, "pl-4 text-left")}>
                    Answer
                  </th>
                  <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                    People
                  </th>
                  <th scope="col" className={cn(COLUMN_HEAD, "text-right")}>
                    Held
                  </th>
                  <th scope="col" className={cn(COLUMN_HEAD, "pr-4 text-right")}>
                    Won
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.answer} className="h-11 border-b last:border-b-0">
                    <th scope="row" className="max-w-0 truncate pr-3 pl-4 text-left font-medium" title={row.answer}>
                      {row.answer}
                    </th>
                    <td className={cn(FIGURE_15, "px-2.5 text-right")}>{formatCount(row.people)}</td>
                    <td className={cn(FIGURE_15, "px-2.5 text-right whitespace-nowrap")}>
                      {formatShare(row.held, row.people)}
                      <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">{formatCount(row.held)}</span>
                    </td>
                    <td className={cn(FIGURE_15, "pr-4 pl-2.5 text-right whitespace-nowrap")}>
                      {formatShare(row.won, row.people)}
                      <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">{formatCount(row.won)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </ReportCard>
  );
}
