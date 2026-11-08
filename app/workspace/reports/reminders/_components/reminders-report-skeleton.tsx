"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { REPORT_PAGE, ReportBand } from "../../_components/report-ui";
import { PerCloserReminderConversionTable } from "./per-closer-reminder-conversion-table";
import { ReminderChainLengthHistogram } from "./reminder-chain-length-histogram";
import { ReminderFigures } from "./reminder-figures";
import { ReminderOutcomeStrip } from "./reminder-outcome-strip";
import { REMINDERS_BAND_TITLE, REMINDERS_PAIR } from "./reminders-report-config";

const BAND_BONE = "h-[34px] rounded-[7px] bg-board-raised";

/**
 * The route's loading state: the band with its date controls, figure zones
 * and filters, the outcome strip and the pair, each at its real height.
 */
export function RemindersReportSkeleton() {
  return (
    <div className={REPORT_PAGE}>
      <ReportBand
        title={REMINDERS_BAND_TITLE}
        actions={
          <>
            <Skeleton className={`${BAND_BONE} w-[27rem] max-w-full`} />
            <Skeleton className={`${BAND_BONE} w-[8.5rem]`} />
          </>
        }
        figures={<ReminderFigures data={undefined} rangePhrase="" />}
        filters={
          <>
            <Skeleton className={`${BAND_BONE} w-[184px]`} />
            <Skeleton className={`${BAND_BONE} w-[164px]`} />
          </>
        }
      />
      <ReminderOutcomeStrip data={undefined} rangePhrase="" reloading={false} />
      <div className={REMINDERS_PAIR}>
        <PerCloserReminderConversionTable data={undefined} reloading={false} />
        <ReminderChainLengthHistogram data={undefined} reloading={false} />
      </div>
    </div>
  );
}
