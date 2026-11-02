"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { closerLookupTabFromSearch } from "@/convex/closer/pipelineTabs";
import { businessDateForInstant } from "@/lib/businessDay";
import {
  isMonthKey,
  pipelineMonth,
  type BookFilter,
  type DealState,
  type MonthKey,
  type RecordAge,
} from "@/lib/closer-pipeline";
import { useBusinessDay } from "@/hooks/use-business-day";
import { useNow } from "@/hooks/use-now";
import { usePageTitle } from "@/hooks/use-page-title";
import { useBreadcrumbTrail } from "@/hooks/use-breadcrumbs";
import { SectionErrorBoundary } from "@/app/workspace/_components/section-error-boundary";
import { SectionError } from "@/app/workspace/closer/_components/section-state";
import { Button } from "@/components/ui/button";
import { DealsLookup, type LookupFilters } from "./deals-lookup";
import { PipelineDesk, useHasAnyDeal } from "./pipeline-desk";
import { PipelineHeader } from "./pipeline-header";
import { PipelinePageSkeleton } from "./pipeline-skeleton";

const HOUR = 3_600_000;

/** URL keys that open the lookup on their own. */
const LOOKUP_KEYS = ["tab", "program", "q", "stage", "status"] as const;
const DEAL_STATES: readonly DealState[] = ["ahead", "no_step", "not_recorded"];
const RECORD_AGES: readonly RecordAge[] = ["under_30", "30_90", "over_90"];

/** The open-deals filter from the URL (`show=`, `age=`, `in=`). */
function bookFilterFromSearch(params: URLSearchParams): BookFilter {
  const show = params.get("show");
  const state = DEAL_STATES.find((value) => value === show) ?? null;
  const ageParam = params.get("age");
  const age = state === "not_recorded" ? (RECORD_AGES.find((value) => value === ageParam) ?? null) : null;
  return { state, age, programKey: params.get("in") || null };
}

/** The URL for the page's month, the open-deals filter and the lookup's filters; defaults are left out. */
function pipelineSearch(month: MonthKey | null, book: BookFilter, filters: LookupFilters) {
  const params = new URLSearchParams();
  if (month) params.set("month", month);
  if (book.state) params.set("show", book.state);
  if (book.age) params.set("age", book.age);
  if (book.programKey) params.set("in", book.programKey);
  if (filters.tab !== "all") params.set("tab", filters.tab);
  if (filters.programKey) params.set("program", filters.programKey);
  if (filters.search) params.set("q", filters.search);
  const search = params.toString();
  return search ? `?${search}` : "";
}

/**
 * My Pipeline: the book panel and the open deals it filters, then All
 * deals, the lookup, folded until it's wanted. The month (`month=`), the
 * open-deals filter (`show=`, `age=`, `in=`) and the lookup's filters
 * (`tab=`, `program=`, `q=`) live in the URL, written with
 * `history.replaceState` so a change doesn't navigate and flash the route
 * skeleton, and coming back from a call's page keeps the list where it was.
 * Today's `stage=` links and old `status=` links open the lookup on the tab
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
  const [book, setBook] = useState<BookFilter>(() => bookFilterFromSearch(searchParams));
  // The lookup opens on its own when a link asks for it.
  const [lookupOpen, setLookupOpen] = useState(() => LOOKUP_KEYS.some((key) => searchParams.has(key)));
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

  // Next keeps this page's state when the closer navigates away and back, so
  // a link that arrives later (Today's stage counts, a `show=` link) is read
  // here. The URL this page writes itself is skipped.
  const searchKey = searchParams.toString();
  const [seenSearch, setSeenSearch] = useState(searchKey);
  if (searchKey !== seenSearch) {
    setSeenSearch(searchKey);
    if (searchKey !== pipelineSearch(monthInUrl, book, filters).replace(/^\?/, "")) {
      const value = searchParams.get("month");
      setMonthParam(isMonthKey(value) ? value : null);
      setBook(bookFilterFromSearch(searchParams));
      setFilters({
        tab: closerLookupTabFromSearch(searchParams),
        programKey: searchParams.get("program") || null,
        search: searchParams.get("q")?.trim() ?? "",
      });
      if (LOOKUP_KEYS.some((key) => searchParams.has(key))) setLookupOpen(true);
    }
  }

  // Writes the URL in place, which also turns an old `stage=` or `status=`
  // link into `tab=`.
  useEffect(() => {
    window.history.replaceState(null, "", `${pathname}${pipelineSearch(monthInUrl, book, filters)}`);
  }, [pathname, monthInUrl, book, filters]);

  const changeBook = useCallback((next: BookFilter) => {
    setBook((previous) => {
      if (previous.state !== next.state || previous.age !== next.age) {
        posthog.capture("pipeline_book_filter_changed", { state: next.state ?? "all", age: next.age });
      }
      if (previous.programKey !== next.programKey) {
        posthog.capture("pipeline_program_filter_changed", { any: next.programKey === null });
      }
      return next;
    });
  }, []);

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
        <PipelineDesk month={month} now={now} setting={setting} filter={book} onFilter={changeBook} />
      </SectionErrorBoundary>

      {hasAnyDeal === false ? null : lookupOpen ? (
        <SectionErrorBoundary
          sectionName="all deals"
          fallback={
            <div className="rounded-xl border bg-card">
              <SectionError what="your deals" />
            </div>
          }
        >
          <DealsLookup filters={filters} onFiltersChange={changeFilters} now={now} setting={setting} />
        </SectionErrorBoundary>
      ) : (
        <section
          aria-labelledby="all-deals-title"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-card px-4 py-2.5 text-sm text-card-foreground"
        >
          <h2 id="all-deals-title" className="text-[15px] font-semibold">
            All deals
          </h2>
          <p className="text-[13px] text-muted-foreground">Every deal you worked, won and lost included.</p>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setLookupOpen(true);
              posthog.capture("pipeline_lookup_opened");
            }}
          >
            Find a deal
          </Button>
        </section>
      )}
    </div>
  );
}
