"use client";

import type { ReactNode } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import type { AnswersOutput } from "@/convex/reports/scorecard";
import type { AnalyticsSource } from "@/app/workspace/_components/analytics/use-analytics-report";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PageRows, ReportPager, usePagedRows } from "../../_components/report-paging";
import { COLUMN_HEAD, FIGURE_15, ReportCard, ReportNote, RowsSkeleton } from "../../_components/report-ui";
import { formatCount, formatShare } from "./report-money";

// What predicts a sale (§08): for each answer to one booking-form question,
// how many people gave it, and how many of those people held a call and
// bought. ClickHouse answers the whole range as of the last sync, since the
// people and their deals can't be split at today (merge `null`).

type Catalog = FunctionReturnType<typeof api.reports.formFields.getFieldCatalog>;

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
  programKey,
  answers,
  source,
  freshness,
  reloading,
  phrase,
}: {
  catalog: Catalog | undefined;
  fieldKey: string | null;
  onFieldKeyChange: (next: string) => void;
  /** The program filter, so a new program goes back to the first page. */
  programKey: string;
  answers: AnswersOutput | undefined;
  source: AnalyticsSource;
  /** This card's own freshness line: it reads the whole range as of the last sync. */
  freshness: ReactNode;
  reloading: boolean;
  phrase: string;
}) {
  const fields = answerFields(catalog);
  const rows = answers?.answers ?? [];
  const { rows: shown, pager } = usePagedRows(rows, { resetKey: `${fieldKey ?? ""}|${programKey}|${phrase}` });
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
      footer={answers === undefined || rows.length === 0 ? undefined : <ReportPager pager={pager} noun="answers" />}
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
            <PageRows pager={pager}>
              <table className="w-full border-collapse">
                <caption className="sr-only">
                  People, and how many of them held a call and bought, by answer to {answers.label}
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
            </PageRows>
          )}
        </>
      )}
    </ReportCard>
  );
}
