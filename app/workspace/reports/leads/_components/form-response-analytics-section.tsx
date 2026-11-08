"use client";

import { useState } from "react";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { DetailCardFooter, detailLinkClass } from "@/app/workspace/closer/meetings/_components/detail-card";
import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { BarList, ReportCard, ReportNote, RowsSkeleton } from "../../_components/report-ui";
import { formatCount } from "./leads-figures";

// One booking-form field's answers in the range: the field picker sits in
// the title row, the answers are ruled bar rows, most common first. Ten show;
// the footer counts them and opens the rest in place.

type Catalog = FunctionReturnType<typeof api.reporting.formResponseAnalytics.getFieldCatalog>;
type Distribution = FunctionReturnType<typeof api.reporting.formResponseAnalytics.getAnswerDistribution>;

const SHOWN_ANSWERS = 10;
const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function FormResponseAnalyticsSection({
  catalog,
  selectedFieldKey,
  onSelectedFieldKeyChange,
  distribution,
  rangePhrase,
}: {
  catalog: Catalog | undefined;
  selectedFieldKey: string | null;
  onSelectedFieldKeyChange: (fieldKey: string) => void;
  /** The selected field's answers for the page's range; the page loads them. */
  distribution: Distribution | undefined;
  rangePhrase: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const [shownFor, setShownFor] = useState(selectedFieldKey);
  // A new field starts folded.
  if (shownFor !== selectedFieldKey) {
    setShownFor(selectedFieldKey);
    setShowAll(false);
  }

  // One option per field key: the same question on two event types shares a key.
  const fields = catalog?.filter((field, index) => catalog.findIndex((other) => other.fieldKey === field.fieldKey) === index);
  const answers = distribution ? [...distribution.distribution].sort((a, b) => b.count - a.count) : [];
  const shown = showAll ? answers : answers.slice(0, SHOWN_ANSWERS);

  return (
    <ReportCard
      title="Booking form answers"
      container="@container/answers"
      meta={
        fields && fields.length > 0 ? (
          <Select value={selectedFieldKey ?? undefined} onValueChange={onSelectedFieldKeyChange}>
            <SelectTrigger
              aria-label="Booking-form field"
              className="h-[30px]! w-[22rem] max-w-full min-w-0 rounded-[7px] bg-background text-[13px] text-foreground [&>span]:truncate"
            >
              <SelectValue placeholder="Pick a field" />
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
        distribution && answers.length > 0 ? (
          <DetailCardFooter className="font-normal">
            <span className="text-[13px]">
              {formatCount(distribution.totalResponses)} answer{distribution.totalResponses === 1 ? "" : "s"} ·{" "}
              {formatCount(distribution.distinctAnswers)} different
            </span>
            {answers.length > SHOWN_ANSWERS ? (
              <button
                type="button"
                aria-expanded={showAll}
                className={cn(detailLinkClass, "text-[13px]")}
                onClick={() => setShowAll((value) => !value)}
              >
                {showAll ? `Show top ${SHOWN_ANSWERS}` : `Show all ${formatCount(answers.length)}`}
              </button>
            ) : null}
          </DetailCardFooter>
        ) : null
      }
    >
      {fields === undefined ? (
        <RowsSkeleton rows={4} label="Loading booking-form fields" />
      ) : fields.length === 0 ? (
        <SectionEmpty title="No booking-form fields yet.">
          Fields appear here once bookings with custom Calendly questions come in.
        </SectionEmpty>
      ) : selectedFieldKey === null ? (
        <SectionEmpty title="Pick a field to see its answers." />
      ) : distribution === undefined ? (
        <RowsSkeleton rows={5} label="Loading answers" />
      ) : answers.length === 0 ? (
        <SectionEmpty title={`No answers to this field ${rangePhrase}.`} />
      ) : (
        <>
          {distribution.isTruncated ? (
            <ReportNote lead="Capped.">Too many answers to read at once, so only the most common are counted.</ReportNote>
          ) : null}
          <BarList
            label="Answers, most common first"
            labelColumn="18rem"
            rows={shown.map((entry) => ({
              key: entry.answer,
              label: <span title={entry.answer}>{entry.answer}</span>,
              meta: `${percent.format(entry.percent)}% of answers`,
              value: entry.count,
              display: formatCount(entry.count),
            }))}
          />
        </>
      )}
    </ReportCard>
  );
}
