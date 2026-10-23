// @vitest-environment node
import { createElement } from "react";
import { getFunctionName } from "convex/server";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ATTENDANCE_COUNTS_PARTIAL_HELP, ResultsRecorded } from "@/app/workspace/_components/results-recorded";
import { TooltipProvider } from "@/components/ui/tooltip";

const fixture = vi.hoisted(() => ({ partial: false, rebuilding: false, loaded: true, requiresSnapshot: true, queries: vi.fn() }));

vi.mock("@/hooks/use-business-day", () => ({
  useBusinessDay: () => ({ setting: { timeZone: "America/Tegucigalpa", dayStartHour: 1 }, rebuilding: fixture.rebuilding, loaded: fixture.loaded, version: 0 }),
}));

vi.mock("@/app/workspace/_components/dashboard-date-utils", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/app/workspace/_components/dashboard-date-utils")>(),
  requiresOperationsReportSnapshot: () => fixture.requiresSnapshot,
}));

vi.mock("convex-helpers/react", () => ({
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: () => undefined,
  }),
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => { fixture.queries(getFunctionName(reference), args); return undefined; },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: () => undefined,
  }),
}));
vi.mock("@/app/workspace/_components/use-dashboard-range", () => ({
  useDashboardRange: () => ({
    range: { kind: "preset", preset: "this_month" },
    queryRange: { kind: "preset", preset: "this_month" },
    rangeLabel: "This month",
    setRange: () => undefined,
  }),
}));
vi.mock("@/app/workspace/_components/dashboard-date-range-filter", () => ({
  DashboardDateRangeFilter: () => null,
}));
vi.mock("@/app/workspace/operations/_components/operations-report-export-menu", () => ({
  OperationsReportExportMenu: () => null,
}));
vi.mock("@/app/workspace/operations/_components/report-job-status", () => ({
  OperationsReportJobStatus: () => null,
}));
vi.mock("@/app/workspace/operations/_components/use-operations-report-job", () => ({
  useOperationsDashboardReport: () => ({
    jobId: "job",
    job: { status: "ready" },
    summary: {
      generatedAt: 1,
      payload: {
        attendanceCountsPartial: fixture.partial,
        totalCalls: 4,
        showed: 3,
        canceled: 0,
        noShows: 1,
        showUpRate: 0.75,
        resultsRecorded: 4,
        pastCalls: 6,
        start: 100,
        end: 200,
      },
    },
  }),
  useAllOperationsReportRows: ({ section }: { section: string }) => ({
    rows: section === "sales_summary_money"
      ? [{
          rowKey: "HNL",
          payload: {
            currency: "HNL",
            paymentSalesCount: 1,
            cashCollectedMinor: 250000,
            closeRate: 1 / 3,
            avgCashPerSaleMinor: 250000,
          },
        }]
      : section === "sales_closer"
        ? [{ rowKey: "closer", payload: {
            label: "Closer", booked: 6, showed: 3, noShows: 1,
            resultsRecorded: 4, pastCalls: 6, attendanceCountsPartial: fixture.partial,
          } }]
        : [],
    isLoading: false,
    error: null,
  }),
}));

import { SalesCallsPageClient } from "@/app/workspace/operations/sales-calls/_components/sales-calls-page-client";

describe("Sales Calls historical UI", () => {
  it.each([
    { loaded: false, rebuilding: false },
    { loaded: true, rebuilding: true },
    { loaded: true, rebuilding: false },
  ])("gates live bucket subscriptions with loaded=$loaded and rebuilding=$rebuilding", ({ loaded, rebuilding }) => {
    fixture.loaded = loaded;
    fixture.rebuilding = rebuilding;
    fixture.requiresSnapshot = false;
    fixture.queries.mockClear();
    try {
      renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SalesCallsPageClient)));
      expect(fixture.queries).toHaveBeenCalledWith(
        "operations/salesCallsDashboard:getSalesCallsDashboard",
        loaded && !rebuilding ? expect.objectContaining({ range: expect.any(Object) }) : "skip",
      );
    } finally {
      fixture.loaded = true;
      fixture.rebuilding = false;
      fixture.requiresSnapshot = true;
    }
  });

  it("replaces stale snapshot totals with the rebuilding notice", () => {
    fixture.rebuilding = true;
    try {
      const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SalesCallsPageClient)));
      expect(html).toContain("Day totals are being rebuilt after a business day change.");
      expect(html).not.toContain("Total Calls");
      expect(html).not.toContain("4 of 6 past calls have a result");
    } finally {
      fixture.rebuilding = false;
    }
  });

  it.each([true, false, undefined])("qualifies the results line only when partial is %s", (attendanceCountsPartial) => {
    const html = renderToStaticMarkup(createElement(ResultsRecorded, {
      resultsRecorded: 4, pastCalls: 6, attendanceCountsPartial,
    }));
    expect(html).toContain(`4 of 6 past calls have a result${attendanceCountsPartial ? " (partial)" : ""}`);
    expect(html.includes("(partial)")).toBe(attendanceCountsPartial === true);
    expect(html.includes(ATTENDANCE_COUNTS_PARTIAL_HELP)).toBe(attendanceCountsPartial === true);
  });

  it.each([true, false])("renders a saved snapshot qualifier when partial is %s", (partial) => {
    fixture.partial = partial;
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(SalesCallsPageClient)));
    // The stat card, closer row, and table total retain the snapshot flag.
    expect(html.match(/past calls have a result/g)).toHaveLength(3);
    expect(html.match(/\(partial\)/g) ?? []).toHaveLength(partial ? 3 : 0);
    expect(html.includes(ATTENDANCE_COUNTS_PARTIAL_HELP)).toBe(partial);
    fixture.partial = false;
  });

  it("keeps the original cards, chart, closer table, and meeting list", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(SalesCallsPageClient),
      ),
    );
    expect(html).toContain("Total Calls");
    expect(html).toContain("4 of 6 past calls have a result");
    expect(html).toContain("Cash Collected");
    expect(html).toContain("Per Program Statistic");
    expect(html).toContain("Phone Closers");
    expect(html).toContain("Meetings");
    expect(html).toContain("Money values: HNL");
    expect(html).not.toContain("Historical sales-call summary");
  });
});
