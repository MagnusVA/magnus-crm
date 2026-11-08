"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BarList, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { formatCount } from "./pipeline-figures";

// The range's no-shows by who recorded them.

type Split = { closer: number; calendly_webhook: number; none: number };

const SOURCES: Array<{ key: keyof Split; label: string; meta: string }> = [
  { key: "closer", label: "Closer", meta: "Marked by the closer" },
  { key: "calendly_webhook", label: "Calendly", meta: "Marked in Calendly" },
  { key: "none", label: "No source", meta: "Recorded without one" },
];

export function NoShowSourcesCard({
  split,
  rangeLabel,
  rangePhrase,
  reloading,
}: {
  split: Split | undefined;
  /** "This week", "Today", "In this range". */
  rangeLabel: string;
  /** "this week", "today", "in this range". */
  rangePhrase: string;
  reloading?: boolean;
}) {
  const total = split ? split.closer + split.calendly_webhook + split.none : 0;
  return (
    <ReportCard
      title="No-show sources"
      meta={split === undefined ? rangeLabel : `${rangeLabel} · ${formatCount(total)} no-show${total === 1 ? "" : "s"}`}
      container="@container/noshow"
      reloading={reloading}
    >
      {split === undefined ? (
        <RowsSkeleton rows={3} label="Loading no-show sources" />
      ) : total === 0 ? (
        <SectionEmpty title={`No no-shows ${rangePhrase}.`} />
      ) : (
        <BarList
          label="No-shows by source"
          labelColumn="11rem"
          rows={SOURCES.map((source) => ({
            key: source.key,
            label: source.label,
            meta: source.meta,
            value: split[source.key],
            display: formatCount(split[source.key]),
          }))}
        />
      )}
    </ReportCard>
  );
}
