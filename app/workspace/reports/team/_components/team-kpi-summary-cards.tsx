"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ActivityIcon,
  InfoIcon,
  PhoneIcon,
  PercentIcon,
  Repeat2Icon,
  DollarSignIcon,
  CoinsIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  XIcon,
} from "lucide-react";
import type {
  ActionsPerCloserMetrics,
  DerivedOutcomes,
  TeamTotals,
} from "./team-report-types";
import {
  formatCompactCurrency,
  formatRate,
} from "./team-report-formatters";

interface TeamKpiSummaryCardsProps {
  totals: TeamTotals;
  derivedOutcomes: DerivedOutcomes;
  actionsPerCloser: ActionsPerCloserMetrics;
}

/**
 * localStorage key for the one-time "Team Revenue renamed" notice. The
 * metric was renamed from "Team Revenue" to "Team Commissionable Revenue"
 * in v0.5.1 and its denominator shifted — exclusively closer-attributed
 * commissionable payments. This flag lets admins dismiss the explainer
 * once they have acknowledged the semantic change.
 */
const TEAM_REVENUE_RENAME_NOTICE_KEY =
  "team-report:commissionable-revenue-rename-notice-v0.5.1";

// --- useSyncExternalStore adapters for the localStorage dismissal flag -----
// This avoids the `setState-in-effect` anti-pattern: React reads the client
// snapshot on mount and re-renders automatically on `storage` events (so
// dismissing in one tab updates any other open tabs too). The server snapshot
// returns `false` to guarantee hydration-matching HTML.

function subscribeToStorage(callback: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", callback);
  return () => window.removeEventListener("storage", callback);
}

function getDismissedSnapshot(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.localStorage.getItem(TEAM_REVENUE_RENAME_NOTICE_KEY) === "1"
  );
}

function getDismissedServerSnapshot(): boolean {
  // On the server we always render *as if* the notice is still visible so
  // the initial HTML matches the "first-visit" state. Client hydration will
  // reconcile via the client snapshot once mounted.
  return false;
}

export function TeamKpiSummaryCards({
  totals,
  derivedOutcomes,
  actionsPerCloser,
}: TeamKpiSummaryCardsProps) {
  const totalBooked = totals.newBookedCalls + totals.followUpBookedCalls;
  const totalShowed = totals.newShowed + totals.followUpShowed;

  // Dismissal flag sourced from localStorage via a React 18 external store.
  // Dispatches a synthetic `storage` event after writing so the component
  // re-renders in the same tab (the native `storage` event only fires in
  // *other* tabs).
  const dismissed = useSyncExternalStore(
    subscribeToStorage,
    getDismissedSnapshot,
    getDismissedServerSnapshot,
  );
  const noticeVisible = !dismissed;

  const dismissNotice = useCallback(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(TEAM_REVENUE_RENAME_NOTICE_KEY, "1");
    // Manually dispatch so `useSyncExternalStore` re-reads in this tab.
    window.dispatchEvent(new StorageEvent("storage"));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      {noticeVisible && (
        <Alert className="relative pr-10">
          <InfoIcon />
          <AlertTitle>Heads up — metric renamed</AlertTitle>
          <AlertDescription>
            <span className="font-medium">Team Revenue</span> is now{" "}
            <span className="font-medium">Team Commissionable Revenue</span>.
            It shows only closer-attributed commissionable payments — deposits
            and final sales logged from meetings, reminders, and review
            resolutions. Post-conversion (customer-direct) payments now have
            their own card below.
          </AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-2 top-2 size-7"
            onClick={dismissNotice}
            aria-label="Dismiss metric-rename notice"
          >
            <XIcon className="size-4" />
          </Button>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Total Booked
              </CardTitle>
              <PhoneIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{totalBooked}</div>
            <p className="text-xs text-muted-foreground">
              {totals.newBookedCalls} new, {totals.followUpBookedCalls} follow-up
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Show-Up Rate
              </CardTitle>
              <PercentIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(totals.overallShowUpRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totalShowed} showed of {totals.overallConfirmedDenominator} eligible
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Team Commissionable Revenue
              </CardTitle>
              <DollarSignIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCompactCurrency(totals.totalRevenueMinor)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totals.totalSales} deal{totals.totalSales === 1 ? "" : "s"}
            </p>
            <p className="mt-1 text-[11px] italic text-muted-foreground/80">
              Excludes post-conversion payments.
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Close Rate
              </CardTitle>
              <TrendingUpIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(totals.overallCloseRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totals.totalSales} sales / {totalShowed} showed
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Post-Conversion Revenue
              </CardTitle>
              <CoinsIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCompactCurrency(totals.postConversionRevenueMinor)}
            </div>
            <p className="text-xs text-muted-foreground">
              Customer-direct payments — not attributed to closers
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Lost Deals
              </CardTitle>
              <TrendingDownIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {derivedOutcomes.lostDeals}
            </div>
            <p className="text-xs text-muted-foreground">
              Opportunities that resolved as lost in this range
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Rebook Rate
              </CardTitle>
              <Repeat2Icon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatRate(derivedOutcomes.rebookRate)}
            </div>
            <p className="text-xs text-muted-foreground">
              {derivedOutcomes.rebookNumerator} rebooked of{" "}
              {derivedOutcomes.rebookDenominator} missed
            </p>
          </CardContent>
        </Card>

        <Card size="sm">
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Actions / Closer / Day
              </CardTitle>
              <ActivityIcon className="size-4 text-muted-foreground" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {actionsPerCloser.actionsPerCloserPerDay !== null
                ? actionsPerCloser.actionsPerCloserPerDay.toFixed(1)
                : "\u2014"}
            </div>
            <p className="text-xs text-muted-foreground">
              {actionsPerCloser.distinctCloserActors} active closer
              {actionsPerCloser.distinctCloserActors === 1 ? "" : "s"} across{" "}
              {actionsPerCloser.daySpanDays} day
              {actionsPerCloser.daySpanDays === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
