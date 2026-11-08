"use client";

import { SectionEmpty } from "@/app/workspace/closer/_components/section-state";
import { BarList, ReportCard, RowsSkeleton } from "../../_components/report-ui";
import { AmountShare, wholeShare } from "./amount-share";
import { countWords } from "./revenue-format";

type Bucket = { count: number; label: string };

type DealSizeDistributionProps = {
  distribution:
    | { under500: Bucket; to2k: Bucket; to5k: Bucket; to10k: Bucket; over10k: Bucket }
    | undefined;
  rangePhrase: string;
  reloading?: boolean;
};

// Smallest to largest: the buckets are an order, not a ranking.
const BUCKET_ORDER = ["under500", "to2k", "to5k", "to10k", "over10k"] as const;

/** Final payments counted by amount bucket, in ruled bar rows. */
export function DealSizeDistribution({ distribution, rangePhrase, reloading }: DealSizeDistributionProps) {
  const buckets = distribution ? BUCKET_ORDER.map((key) => ({ key, ...distribution[key] })) : undefined;
  const total = buckets?.reduce((sum, bucket) => sum + bucket.count, 0) ?? 0;

  return (
    <ReportCard title="Deal size" meta="Final payments by amount" reloading={reloading}>
      {buckets === undefined ? (
        <RowsSkeleton rows={5} label="Loading deal sizes" />
      ) : total === 0 ? (
        <SectionEmpty title={`No deals ${rangePhrase}.`} />
      ) : (
        <BarList
          label="Deals by amount"
          labelColumn="8rem"
          rows={buckets.map((bucket) => ({
            key: bucket.key,
            label: bucket.label.replace(" - ", " – "),
            value: bucket.count,
            display: <AmountShare amount={countWords(bucket.count, "deal")} share={wholeShare(bucket.count, total)} />,
          }))}
        />
      )}
    </ReportCard>
  );
}
