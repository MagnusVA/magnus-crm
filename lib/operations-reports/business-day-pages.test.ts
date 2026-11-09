// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_DAY_REBUILD_MESSAGE, type BusinessDaySetting } from "@/lib/businessDay";

const fixture = vi.hoisted(() => ({
  businessDay: undefined as BusinessDaySetting | undefined,
  loaded: true,
  ready: false,
  queries: vi.fn(),
}));
// A tenant whose pages still read Convex (useAnalyticsSource).
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/workspace/reports",
  useRouter: () => ({ replace: () => {} }),
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    fixture.queries(name, args);
    if (name === "tenants:getCurrentTenant" && fixture.loaded) {
      return { businessDay: fixture.businessDay, businessDayReady: fixture.ready, leadGenBusinessDayReady: true, analyticsReports: [] };
    }
    return undefined;
  },
  useMutation: () => async () => ({ started: false }),
}));
vi.mock("@/app/workspace/reports/_components/report-attribution-filters", () => ({ ReportAttributionFilters: () => null }));

import { TeamReportPageClient } from "@/app/workspace/reports/team/_components/team-report-page-client";
import { RevenueReportPageClient } from "@/app/workspace/reports/revenue/_components/revenue-report-page-client";
import { LeadGenRanking } from "@/app/workspace/_components/overview-rankings";
import { TopOriginsOverviewSection } from "@/app/workspace/_components/top-origins-overview-section";
import { PhoneCloserOperationsSection } from "@/app/workspace/_components/phone-closer-operations-section";
import { TooltipProvider } from "@/components/ui/tooltip";

// Pages render inside the app layout's TooltipProvider.
const renderPage = (component: () => React.ReactNode) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(component)));

beforeEach(() => { fixture.businessDay = undefined; fixture.loaded = true; fixture.ready = false; fixture.queries.mockClear(); });

// The day keys each page's default range sends on 2026-10-22: it opens on Today.
const pages = [
  {
    name: "Team Performance",
    component: TeamReportPageClient,
    query: "reporting/teamPerformance:getTeamOperationsDimensions",
    defaultKeys: { startDayKey: "2026-10-22", endDayKeyExclusive: "2026-10-23" },
  },
];

describe("meeting bucket page readiness", () => {
  it.each(pages)("skips $name bucket queries and renders the rebuild notice", ({ component, query }) => {
    const html = renderPage(component);
    expect(fixture.queries).toHaveBeenCalledWith(query, "skip");
    expect(html).toContain(BUSINESS_DAY_REBUILD_MESSAGE);
  });

  it.each(pages)("waits for tenant readiness before subscribing to $name buckets", ({ component, query }) => {
    fixture.loaded = false;
    renderPage(component);
    expect(fixture.queries).toHaveBeenCalledWith(query, "skip");
  });

  it.each(pages)("subscribes to $name buckets after readiness", ({ component, query }) => {
    fixture.ready = true;
    renderPage(component);
    expect(fixture.queries).toHaveBeenCalledWith(query, expect.any(Object));
  });

  it.each(pages)("passes today's business day keys to $name buckets", ({ component, query, defaultKeys }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 22, 12));
      fixture.ready = true;
      renderPage(component);
      expect(fixture.queries).toHaveBeenCalledWith(query, defaultKeys);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { loaded: false, ready: true },
    { loaded: true, ready: false },
  ])("skips every Team query with loaded=$loaded and ready=$ready", ({ loaded, ready }) => {
    fixture.loaded = loaded;
    fixture.ready = ready;
    renderPage(TeamReportPageClient);
    const reportQueries = fixture.queries.mock.calls.filter(([name]) => name.startsWith("reporting/"));
    expect(reportQueries).toHaveLength(4);
    for (const [, args] of reportQueries) expect(args).toBe("skip");
  });

  it.each([
    { setting: undefined, start: "2026-10-22T07:00:00Z", end: "2026-10-23T07:00:00Z" },
    { setting: { timeZone: "America/Tegucigalpa", dayStartHour: 4 }, start: "2026-10-22T10:00:00Z", end: "2026-10-23T10:00:00Z" },
  ])("aligns all four Team queries with the tenant business days: $setting", ({ setting, start, end }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 9, 22, 12));
      fixture.ready = true;
      fixture.businessDay = setting;
      renderPage(TeamReportPageClient);
      for (const query of [
        "reporting/teamPerformance:getTeamPerformanceMetrics",
        "reporting/teamOutcomes:getTeamOutcomeMix",
        "reporting/teamActions:getActionsPerCloserPerDay",
      ]) {
        expect(fixture.queries).toHaveBeenCalledWith(query, {
          startDate: Date.parse(start),
          endDate: Date.parse(end),
        });
      }
      expect(fixture.queries).toHaveBeenCalledWith("reporting/teamPerformance:getTeamOperationsDimensions", {
        startDayKey: "2026-10-22",
        endDayKeyExclusive: "2026-10-23",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(pages)("keeps $name on yesterday's business date until the tenant's day starts", ({ component, query }) => {
    vi.useFakeTimers();
    try {
      // 12:30 am on Oct 23 in Tegucigalpa: days run from 1:00 am, so it's still Oct 22.
      vi.setSystemTime(Date.UTC(2026, 9, 23, 6, 30));
      fixture.ready = true;
      renderPage(component);
      expect(fixture.queries).toHaveBeenCalledWith(query, { startDayKey: "2026-10-22", endDayKeyExclusive: "2026-10-23" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads a browser-day report (Revenue) on the tenant's business day", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 22, 18));
      fixture.ready = true;
      renderPage(RevenueReportPageClient);
      expect(fixture.queries).toHaveBeenCalledWith("reporting/revenue:getRevenueMetrics", {
        startDate: Date.parse("2026-10-22T07:00:00Z"),
        endDate: Date.parse("2026-10-23T07:00:00Z"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timestamp report (Revenue) reading while meeting buckets rebuild", () => {
    fixture.ready = false;
    renderPage(RevenueReportPageClient);
    expect(fixture.queries).toHaveBeenCalledWith("reporting/revenue:getRevenueMetrics", expect.any(Object));
    expect(fixture.queries).not.toHaveBeenCalledWith("reporting/revenue:getRevenueMetrics", "skip");
  });

  it("renders rebuilding Overview sections without totals or generic errors", () => {
    const section = { status: "rebuilding" as const, data: null, truncated: false as const, message: BUSINESS_DAY_REBUILD_MESSAGE, errorCode: null };
    const sections = [
      createElement(LeadGenRanking, { section, range: { kind: "preset", preset: "today" } }),
      createElement(TopOriginsOverviewSection, { section }),
      createElement(PhoneCloserOperationsSection, { section }),
    ];
    for (const element of sections) {
      const html = renderToStaticMarkup(createElement(TooltipProvider, null, element));
      expect(html).toContain(BUSINESS_DAY_REBUILD_MESSAGE);
      expect(html).not.toContain("Section unavailable");
      expect(html).not.toContain("Total submissions");
    }
    expect(fixture.queries).not.toHaveBeenCalled();
  });
});
