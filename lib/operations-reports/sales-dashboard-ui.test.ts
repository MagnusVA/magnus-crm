// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
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
        totalCalls: 4,
        showed: 3,
        canceled: 0,
        noShows: 1,
        showUpRate: 0.75,
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
      : [],
    isLoading: false,
    error: null,
  }),
}));

import { SalesCallsPageClient } from "@/app/workspace/operations/sales-calls/_components/sales-calls-page-client";

describe("Sales Calls historical UI", () => {
  it("keeps the original cards, chart, closer table, and meeting list", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(SalesCallsPageClient),
      ),
    );
    expect(html).toContain("Total Calls");
    expect(html).toContain("Cash Collected");
    expect(html).toContain("Per Program Statistic");
    expect(html).toContain("Phone Closers");
    expect(html).toContain("Meetings");
    expect(html).toContain("Money values: HNL");
    expect(html).not.toContain("Historical sales-call summary");
  });
});
