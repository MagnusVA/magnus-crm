"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { cn } from "@/lib/utils";
import { FIGURE_15, ReportCard, RowsSkeleton, SINGLE_SERIES } from "../../_components/report-ui";
import { formatCount } from "./leads-figures";

// Each booking-form field's most common answer in the range, in the bar
// rows' grammar (The Programs Card) but against 100%: the field over its top
// answer, and the answer's share of the field's answers as the bar.

interface FieldRow {
  fieldKey: string;
  topAnswer: string;
  topAnswerCount: number;
  totalResponses: number;
  topAnswerShare: number;
}

/** A field key as words, for fields the catalog doesn't name. */
function formatFieldKey(fieldKey: string) {
  return fieldKey
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const share = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });

export function TopAnswerPerFieldList({
  rows,
  fieldLabels,
  rangePhrase,
  reloading,
}: {
  rows: FieldRow[] | undefined;
  /** The catalog's label for each field key, when it has one. */
  fieldLabels: ReadonlyMap<string, string>;
  rangePhrase: string;
  reloading?: boolean;
}) {
  return (
    <ReportCard
      title="Top answer per field"
      meta={rows && rows.length > 0 ? "Share of the field's answers" : undefined}
      container="@container/top"
      reloading={reloading}
    >
      {rows === undefined ? (
        <RowsSkeleton rows={5} rowHeight="h-[60px]" label="Loading top answers" />
      ) : rows.length === 0 ? (
        <SectionEmpty title={`No form answers ${rangePhrase}.`}>
          Answers appear here once booked meetings include booking-form responses.
        </SectionEmpty>
      ) : (
        <ul aria-label="Top answer per booking-form field" className="flex flex-col">
          {rows.map((row) => {
            const label = fieldLabels.get(row.fieldKey) ?? formatFieldKey(row.fieldKey);
            return (
              <li
                key={row.fieldKey}
                className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 border-b px-4 py-2 last:border-b-0 @lg/top:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium" title={label}>
                    {label}
                  </p>
                  <p className="truncate text-[13px] text-muted-foreground" title={row.topAnswer}>
                    {row.topAnswer || "No answer"} · {formatCount(row.topAnswerCount)} of {formatCount(row.totalResponses)}
                  </p>
                </div>
                {/* The bar is the share itself, so a full bar is every answer. */}
                <div aria-hidden="true" className="order-last col-span-2 h-2 overflow-hidden rounded-[3px] bg-muted @lg/top:order-none @lg/top:col-span-1">
                  <div className="h-full rounded-[3px]" style={{ width: `${row.topAnswerShare * 100}%`, background: SINGLE_SERIES }} />
                </div>
                <p className={cn(FIGURE_15, "text-right whitespace-nowrap")}>{share.format(row.topAnswerShare)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </ReportCard>
  );
}
