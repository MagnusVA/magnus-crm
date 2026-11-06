"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePaginatedQuery } from "convex/react";
import { DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { MissedMeetingRow } from "@/convex/operations/missedMeetings";
import { Button } from "@/components/ui/button";
import {
  dashboardRangeToDayKeys,
  OPERATIONS_DASHBOARD_RANGE_VALIDATION,
} from "@/app/workspace/_components/dashboard-date-utils";
import {
  DateRangePicker,
  formatBusinessDateSpan,
  rangePhrase,
  type DashboardRangeInput,
} from "@/app/workspace/_components/date-range-picker";
import { PageBand } from "@/app/workspace/_components/page-band";
import { useDashboardRange } from "@/app/workspace/_components/use-dashboard-range";
import { HelpTip } from "@/app/workspace/team/_components/team-ui";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  addBusinessDays,
  businessDateForInstant,
  businessDayDisclosure,
  businessDayStart,
  type BusinessDaySetting,
} from "@/lib/businessDay";
import {
  MISSED_MEETINGS_EXPORT_CAP,
  capMissedMeetingRows,
  missedMeetingsCsv,
  needsMoreMissedMeetingRows,
} from "@/lib/operations-reports/missed-meetings-export";
import { cn } from "@/lib/utils";
import { MissedDealsCard, type KindFilter, type ListState } from "./missed-deals-card";
import { MissedFigures, type MissedCounts } from "./missed-figures";

// Deals read per page; the server reads at most 100 a call.
const PAGE_SIZE = 100;

const PRESET_WORDS = { today: "Today", this_week: "This week", this_month: "This month" } as const;

/** The last 30 business days through today, as a custom range the picker can show. */
function lastThirtyDays(todayBusinessDate: string): DashboardRangeInput {
  return {
    kind: "custom",
    startBusinessDate: addBusinessDays(todayBusinessDate, -29),
    endBusinessDateInclusive: todayBusinessDate,
  };
}

/** The range as the query takes it: business-day starts, the end exclusive. */
function rangeBounds(range: DashboardRangeInput, now: number, setting: BusinessDaySetting) {
  const { startDayKey, endDayKey } = dashboardRangeToDayKeys(range, now, setting);
  return {
    startDayKey,
    endDayKey,
    startDate: businessDayStart(startDayKey, setting),
    endDate: businessDayStart(addBusinessDays(endDayKey, 1), setting),
  };
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

type Shown = {
  /** The query's arguments, serialized. */
  key: string;
  /** The complete list's rows (a new array whenever any row changes). */
  rows: MissedMeetingRow[];
  truncated: boolean;
  words: string;
  phrase: string;
  hideBookedAgain: boolean;
};

export function MissedMeetingsPageClient() {
  usePageTitle("No-shows & Cancellations");
  const { setting, loaded } = useBusinessDay();
  const now = useNow();
  const todayBusinessDate = businessDateForInstant(now, setting);

  // The page opens on the last 30 days unless the URL names a range. Until
  // a range is chosen, that default follows the workspace's business day.
  const searchParams = useSearchParams();
  const [chosen, setChosen] = useState(() => searchParams.get("range") !== null);
  const defaultRange = lastThirtyDays(todayBusinessDate);
  const { range, setRange, queryRange, validationMessage } = useDashboardRange({
    urlSync: true,
    defaultRange,
    validationOptions: OPERATIONS_DASHBOARD_RANGE_VALIDATION,
  });
  const pickerRange = chosen ? range : defaultRange;
  const activeRange = chosen ? queryRange : defaultRange;
  const onRangeChange = (next: DashboardRangeInput) => {
    setChosen(true);
    setRange(next);
  };

  const [kind, setKind] = useState<KindFilter>("all");
  const [hideBookedAgain, setHideBookedAgain] = useState(true);

  const bounds = rangeBounds(activeRange, now, setting);
  const dates = formatBusinessDateSpan(bounds.startDayKey, bounds.endDayKey, todayBusinessDate);
  const words = !chosen
    ? `Last 30 days · ${dates}`
    : activeRange.kind === "custom"
      ? dates
      : `${PRESET_WORDS[activeRange.preset]} · ${dates}`;
  const phrase = !chosen ? "in the last 30 days" : rangePhrase(activeRange);

  // Every kind is read, and the toggle filters on the page, so its counts
  // and the band's figures are exact for the range.
  const args = useMemo(
    () => ({ startDate: bounds.startDate, endDate: bounds.endDate, hideBookedAgain }),
    [bounds.startDate, bounds.endDate, hideBookedAgain],
  );
  const argsKey = `${args.startDate}:${args.endDate}:${args.hideBookedAgain}`;
  const { results, status, loadMore } = usePaginatedQuery(
    api.operations.missedMeetings.listMissedMeetings,
    loaded ? args : "skip",
    { initialNumItems: PAGE_SIZE },
  );

  // The list and its export are the same rows, so the page reads every page
  // of the range, up to one row past the export's cap.
  useEffect(() => {
    if (status === "CanLoadMore" && needsMoreMissedMeetingRows(results.length)) {
      loadMore(PAGE_SIZE);
    }
  }, [loadMore, results.length, status]);

  const capped = useMemo(() => capMissedMeetingRows(results), [results]);
  const isComplete = loaded && (status === "Exhausted" || capped.truncated);

  // A new range or the booked-again switch keeps the last complete list on
  // screen, dimmed, until the new one has every row (DESIGN.md, Kept Data
  // While Reloading). The first load fills in place.
  const [kept, setKept] = useState<Shown | null>(null);
  // `capped.rows` is a new array whenever any row changes, so `kept` is
  // always the last complete list shown, live edits included.
  if (isComplete && (kept?.key !== argsKey || kept.rows !== capped.rows || kept.truncated !== capped.truncated || kept.words !== words)) {
    setKept({ key: argsKey, rows: capped.rows, truncated: capped.truncated, words, phrase, hideBookedAgain });
  }
  const reloading = !isComplete && kept !== null;
  const firstFill = !isComplete && kept === null && loaded && status !== "LoadingFirstPage";
  const filling = useMemo(
    (): Shown | null =>
      firstFill ? { key: argsKey, rows: capped.rows, truncated: false, words, phrase, hideBookedAgain } : null,
    [argsKey, capped.rows, firstFill, hideBookedAgain, phrase, words],
  );
  // Complete: the fresh rows (an edit to a row's contact or kind shows at
  // once). Reloading: the kept list. First load: the rows so far.
  const fresh = useMemo(
    (): Shown => ({ key: argsKey, rows: capped.rows, truncated: capped.truncated, words, phrase, hideBookedAgain }),
    [argsKey, capped.rows, capped.truncated, hideBookedAgain, phrase, words],
  );
  const shown = isComplete ? fresh : (kept ?? filling);

  const counts = useMemo((): MissedCounts | undefined => {
    if (!shown) return undefined;
    let noShows = 0;
    let bookedAgain = 0;
    for (const row of shown.rows) {
      if (row.missedMeeting === "no_show") noShows += 1;
      if (row.bookedAgain) bookedAgain += 1;
    }
    return { total: shown.rows.length, noShows, canceled: shown.rows.length - noShows, bookedAgain };
  }, [shown]);
  const visible = useMemo(
    () => (shown ? (kind === "all" ? shown.rows : shown.rows.filter((row) => row.missedMeeting === kind)) : undefined),
    [kind, shown],
  );
  const listState: ListState = isComplete
    ? { kind: "complete", truncated: capped.truncated }
    : { kind: "loading", soFar: capped.rows.length };

  const handleExport = () => {
    if (!visible) return;
    const first = bounds.startDayKey;
    const last = bounds.endDayKey;
    downloadCsv(`no-shows-and-cancellations-${first}-to-${last}.csv`, missedMeetingsCsv(visible));
    toast.success(
      capped.truncated
        ? `Exported ${visible.length.toLocaleString()} deals. The range holds more than ${MISSED_MEETINGS_EXPORT_CAP.toLocaleString()}; narrow it for the rest.`
        : `Exported ${visible.length.toLocaleString()} ${visible.length === 1 ? "deal" : "deals"}.`,
    );
  };

  const bandWords = shown?.words ?? words;

  return (
    <div className="@container mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-3.5 pb-6 short:gap-3">
      <PageBand
        title="No-shows & Cancellations"
        description={
          <>
            <HelpTip tip={`${businessDayDisclosure(setting)}.`} className="font-medium text-board-foreground">
              {bandWords}
            </HelpTip>
            {" · "}
            Deals a no-show or a cancellation closed, newest first. Export them for outreach.
          </>
        }
        actions={
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <DateRangePicker
              tone="board"
              value={pickerRange}
              onChange={onRangeChange}
              validationOptions={OPERATIONS_DASHBOARD_RANGE_VALIDATION}
              todayBusinessDate={todayBusinessDate}
            />
            <Button
              type="button"
              variant="outline"
              disabled={!isComplete || !visible || visible.length === 0}
              onClick={handleExport}
              className="h-[34px] rounded-[7px] border-board-foreground/15 bg-board-raised px-3 text-[13px] text-board-foreground hover:bg-board-foreground/10 hover:text-board-foreground dark:border-board-foreground/15 dark:bg-board-raised dark:hover:bg-board-foreground/10"
            >
              <DownloadIcon data-icon="inline-start" />
              Export CSV
            </Button>
          </div>
        }
      >
        <div aria-busy={reloading} className={cn("transition-opacity duration-200", reloading && "opacity-60")}>
          <MissedFigures
            counts={counts}
            partial={shown?.truncated ?? false}
            hideBookedAgain={shown?.hideBookedAgain ?? hideBookedAgain}
          />
        </div>
      </PageBand>

      {chosen && validationMessage ? <p className="text-[13px] text-danger-ink">{validationMessage}</p> : null}

      <MissedDealsCard
        rows={visible}
        counts={counts ? { all: counts.total, no_show: counts.noShows, canceled: counts.canceled } : undefined}
        kind={kind}
        onKindChange={setKind}
        hideBookedAgain={hideBookedAgain}
        onHideBookedAgainChange={setHideBookedAgain}
        listState={listState}
        reloading={reloading}
        rangePhrase={shown?.phrase ?? phrase}
        setting={setting}
        todayBusinessDate={todayBusinessDate}
      />
    </div>
  );
}
