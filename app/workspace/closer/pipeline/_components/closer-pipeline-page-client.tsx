"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { closerLookupTabFromSearch } from "@/convex/closer/pipelineTabs";
import { businessDateForInstant } from "@/lib/businessDay";
import { isMonthKey, pipelineMonth, type MonthKey } from "@/lib/closer-pipeline";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { DealsLookup, type LookupFilters } from "./deals-lookup";
import { PipelineDesk, useHasAnyDeal } from "./pipeline-desk";
import { PipelineHeader } from "./pipeline-header";
import { PipelinePageSkeleton } from "./pipeline-skeleton";

const HOUR = 3_600_000;

/** The URL for the page's month and lookup filters; defaults are left out. */
function pipelineSearch(month: MonthKey | null, filters: LookupFilters) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (filters.tab !== "all") params.set("tab", filters.tab);
  if (filters.programKey) params.set("program", filters.programKey);
  if (filters.search) params.set("q", filters.search);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/**
 * My Pipeline: the month's money strip and one card per program with its
 * open deals, then All deals, the lookup. The month (`month=`) and the
 * lookup's filters (`tab=`, `program=`, `q=`) live in the URL, written with
 * `history.replaceState` so a change doesn't navigate and flash the route
 * skeleton. Today's `stage=` links and old `status=` links open the tab
 * their deals are on.
 */
export function CloserPipelinePageClient() {
  usePageTitle("My Pipeline");
  useBreadcrumbTrail([
    { label: "Today", href: "/workspace/closer" },
    { label: "My Pipeline", href: "/workspace/closer/pipeline" },
  ]);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const now = useNow();
  const { setting, loaded, rebuilding } = useBusinessDay();
  const today = businessDateForInstant(now, setting);
  const currentKey = today.slice(0, 7);

  const [monthParam, setMonthParam] = useState<MonthKey | null>(() => {
    const value = searchParams.get("month");
    return isMonthKey(value) ? value : null;
  });
  const [filters, setFilters] = useState<LookupFilters>(() => ({
    tab: closerLookupTabFromSearch(searchParams),
    programKey: searchParams.get("program") || null,
    search: searchParams.get("q")?.trim() ?? "",
  }));

  // The previous month is cut at the next hour, so the arguments hold still
  // between clock ticks.
  const hour = Math.floor(now / HOUR);
  const month = useMemo(
    () => pipelineMonth(monthParam ?? currentKey, today, (hour + 1) * HOUR, setting),
    [monthParam, currentKey, today, hour, setting],
  );
  const monthInUrl = month.isCurrent ? null : month.key;

  // Writes the URL in place, which also turns an old `stage=` or `status=`
  // link into `tab=`.
  useEffect(() => {
    window.history.replaceState(null, "", `${pathname}${pipelineSearch(monthInUrl, filters)}`);
  }, [pathname, monthInUrl, filters]);

  const changeMonth = useCallback(
    (key: MonthKey) => {
      setMonthParam(key === currentKey ? null : key);
      posthog.capture("pipeline_month_changed", { current: key === currentKey });
    },
    [currentKey],
  );

  const changeFilters = useCallback((next: LookupFilters) => {
    setFilters((previous) => {
      if (previous.tab !== next.tab) {
        posthog.capture("pipeline_tab_changed", { tab: next.tab });
      }
      if (previous.programKey !== next.programKey) {
        posthog.capture("pipeline_program_filter_changed", { any: next.programKey === null });
      }
      return next;
    });
  }, []);

  const lookupHeading = useRef<HTMLHeadingElement>(null);
  const showProgram = useCallback((programKey: string) => {
    setFilters({ tab: "all", programKey, search: "" });
    const heading = lookupHeading.current;
    if (heading) {
      heading.scrollIntoView({ behavior: "smooth", block: "start" });
      heading.focus({ preventScroll: true });
    }
  }, []);

  const hasAnyDeal = useHasAnyDeal();

  if (!loaded) {
    return <PipelinePageSkeleton />;
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-3.5 pb-6">
      <PipelineHeader
        month={month}
        currentKey={currentKey}
        setting={setting}
        rebuilding={rebuilding}
        onMonthChange={changeMonth}
      />

      <SectionErrorBoundary
        sectionName="pipeline desk"
        fallback={
          <div className="rounded-xl border bg-card">
            <SectionError what="your month and open deals" />
          </div>
        }
      >
        <PipelineDesk month={month} now={now} setting={setting} onShowProgram={showProgram} />
      </SectionErrorBoundary>

      {hasAnyDeal === false ? null : (
        <SectionErrorBoundary
          sectionName="all deals"
          fallback={
            <div className="rounded-xl border bg-card">
              <SectionError what="your deals" />
            </div>
          }
        >
          <DealsLookup
            filters={filters}
            onFiltersChange={changeFilters}
            now={now}
            setting={setting}
            headingRef={lookupHeading}
          />
        </SectionErrorBoundary>
      )}
    </div>
  );
}
