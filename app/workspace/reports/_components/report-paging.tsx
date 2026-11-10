"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { DetailCardFooter } from "@/app/workspace/closer/meetings/_components/detail-card";
import { Button } from "@/components/ui/button";
import { pageWindow } from "@/lib/reporting/paging";
import { cn } from "@/lib/utils";

// Paging for a report card's rows (DESIGN.md, The Report Pager). A card
// shows one page of its list, so its height comes from the page size and
// never from how much data the range holds. `usePagedRows` pages rows the
// browser already has; `useCursorPages` pages a Convex paginated query.

/** Rows per page: two-line rows and one-line table rows. */
export const LIST_PAGE_SIZE = 10;
export const TABLE_PAGE_SIZE = 12;

export type PagerState = {
  /** 1-based positions of the first and last row shown; 0 and 0 when empty. */
  from: number;
  to: number;
  /** Every row there is, or null when the server hasn't said. */
  total: number | null;
  /** The total is a lower bound ("184+"). */
  totalIsMinimum?: boolean;
  /** More than one page exists, so the pager shows. */
  paged: boolean;
  /** The page shown holds a full page of rows. */
  full: boolean;
  /** The next page is still loading. */
  loading?: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  previous: () => void;
  next: () => void;
};

/**
 * One page of rows the browser already holds. The page goes back to the
 * first when `resetKey` changes (a new range, filter or sort), and steps
 * back by itself when the rows shrink under it.
 */
export function usePagedRows<T>(
  rows: readonly T[],
  { pageSize = LIST_PAGE_SIZE, resetKey }: { pageSize?: number; resetKey?: string } = {},
): { rows: T[]; pager: PagerState } {
  const [state, setState] = useState({ page: 0, key: resetKey });
  // Reset during render, so a new filter never paints its old page.
  const page = state.key === resetKey ? state.page : 0;
  if (state.key !== resetKey) setState({ page: 0, key: resetKey });
  const view = pageWindow(rows.length, pageSize, page);
  const shown = rows.slice(view.start, view.end);
  const go = (next: number) => setState({ page: Math.min(Math.max(next, 0), view.lastPage), key: resetKey });
  return {
    rows: shown,
    pager: {
      from: view.from,
      to: view.to,
      total: rows.length,
      paged: rows.length > pageSize,
      full: shown.length === pageSize,
      hasPrevious: view.page > 0,
      hasNext: view.page < view.lastPage,
      previous: () => go(view.page - 1),
      next: () => go(view.page + 1),
    },
  };
}

/** What `usePaginatedQuery` returns, as far as the pager needs it. */
export type CursorList<T> = {
  results: T[];
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
  loadMore: (numItems: number) => void;
};

/**
 * A paginated query restarts when its arguments change (a clock, a filter).
 * This keeps the last loaded rows in place until the new first page answers,
 * so the card doesn't fall back to its skeleton.
 */
export function useKeptCursorList<T>(list: CursorList<T>): CursorList<T> {
  const loading = list.status === "LoadingFirstPage";
  const [kept, setKept] = useState<{ results: T[]; status: CursorList<T>["status"] } | null>(null);
  if (!loading && (kept === null || kept.results !== list.results || kept.status !== list.status)) {
    setKept({ results: list.results, status: list.status });
  }
  if (!loading || kept === null) return list;
  return { results: kept.results, status: kept.status === "LoadingMore" ? "CanLoadMore" : kept.status, loadMore: () => {} };
}

/**
 * One page of a Convex paginated query. The query only ever appends, so this
 * shows a window of what has loaded and asks for one page ahead, which makes
 * Next show its rows at once. `total` is the count the page's summary gives,
 * when it has one; the list's own length replaces it once every row loaded.
 * The page goes back to the first when `resetKey` changes (new arguments).
 *
 * A filtered query can answer with a short page while more rows remain on
 * the server. Next then fills the page shown before it moves on.
 */
export function useCursorPages<T>(
  list: CursorList<T>,
  {
    pageSize = LIST_PAGE_SIZE,
    total = null,
    totalIsMinimum = false,
    resetKey,
  }: { pageSize?: number; total?: number | null; totalIsMinimum?: boolean; resetKey?: string } = {},
): { rows: T[]; firstLoad: boolean; pager: PagerState } {
  const [state, setState] = useState({ page: 0, key: resetKey });
  const page = state.key === resetKey ? state.page : 0;
  if (state.key !== resetKey) setState({ page: 0, key: resetKey });
  const setPage = (next: number) => setState({ page: next, key: resetKey });
  const loaded = list.results.length;
  const exhausted = list.status === "Exhausted";
  const firstLoad = list.status === "LoadingFirstPage";
  // A row leaving the list (a call gets its result) can empty the last page.
  const { page: current, lastPage: last, start, end } = pageWindow(loaded, pageSize, page);
  const shown = list.results.slice(start, end);
  const moreOnServer = list.status === "CanLoadMore" || list.status === "LoadingMore";
  const known = exhausted ? loaded : total === null ? null : Math.max(total, loaded);
  return {
    rows: shown,
    firstLoad,
    pager: {
      from: shown.length === 0 ? 0 : start + 1,
      to: start + shown.length,
      total: known,
      totalIsMinimum: !exhausted && totalIsMinimum,
      paged: loaded > pageSize || moreOnServer,
      full: shown.length === pageSize,
      // The page shown is waiting for rows: Next was pressed past what has
      // loaded, or a short page is being filled.
      loading: list.status === "LoadingMore" && (page > last || shown.length < pageSize),
      hasPrevious: current > 0,
      hasNext: start + pageSize < loaded || moreOnServer,
      previous: () => setPage(Math.max(current - 1, 0)),
      next: () => {
        if (shown.length < pageSize) {
          if (list.status === "CanLoadMore") list.loadMore(pageSize);
          return;
        }
        // Keep one page loaded beyond the one about to show.
        if (start + 3 * pageSize > loaded && list.status === "CanLoadMore") list.loadMore(pageSize);
        setPage(current + 1);
      },
    },
  };
}

const COUNT = "font-condensed text-[15px] font-semibold text-foreground tabular-nums";

/**
 * A card's 40px pager footer: "1–10 of 184" on the left and Previous and
 * Next on the right. It draws nothing while the list fits one page, so a
 * short list has no footer.
 */
export function ReportPager({
  pager,
  noun,
  className,
  children,
}: {
  pager: PagerState;
  /** What the rows are, for the buttons' names: "calls", "deals". */
  noun: string;
  className?: string;
  /** A note that stays on every page, left of the count. */
  children?: ReactNode;
}) {
  if (!pager.paged) return children ? <DetailCardFooter className={cn("font-normal", className)}>{children}</DetailCardFooter> : null;
  return (
    <DetailCardFooter className={cn("font-normal", className)}>
      <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[13px]" aria-live="polite">
        <span>
          <span className={COUNT}>
            {pager.from.toLocaleString("en-US")}–{pager.to.toLocaleString("en-US")}
          </span>
          {pager.total !== null ? (
            <>
              {" of "}
              <span className={COUNT}>
                {pager.total.toLocaleString("en-US")}
                {pager.totalIsMinimum ? "+" : ""}
              </span>
            </>
          ) : pager.hasNext ? (
            " of more"
          ) : null}
          <span className="sr-only"> {noun}</span>
        </span>
        {children}
      </p>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={`Previous ${noun}`}
          title="Previous"
          disabled={!pager.hasPrevious}
          onClick={pager.previous}
        >
          <ChevronLeftIcon aria-hidden="true" />
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label={`Next ${noun}`}
          title="Next"
          disabled={!pager.hasNext}
          onClick={pager.next}
        >
          <ChevronRightIcon aria-hidden="true" />
        </Button>
      </div>
    </DetailCardFooter>
  );
}

/**
 * Keeps a paged list at the height of a full page, so the pager under it
 * doesn't move when the last page is short. It measures a full page and
 * holds that as the minimum; a list that fits one page takes its own height.
 */
export function PageRows({
  pager,
  className,
  children,
}: {
  pager: PagerState;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fullHeight = useRef<number | null>(null);
  const { paged, full } = pager;
  // Written to the element, not to state: measuring must not render again.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.minHeight = "";
    if (!paged) return;
    if (full) fullHeight.current = element.offsetHeight;
    else if (fullHeight.current !== null) element.style.minHeight = `${fullHeight.current}px`;
  });
  return (
    <div
      ref={ref}
      aria-busy={pager.loading || undefined}
      className={cn("transition-opacity duration-200", pager.loading && "opacity-60", className)}
    >
      {children}
    </div>
  );
}
