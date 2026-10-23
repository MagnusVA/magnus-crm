// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_DAY_REBUILD_MESSAGE } from "@/lib/businessDay";

const fixture = vi.hoisted(() => ({
  loaded: true,
  ready: false,
  queries: vi.fn(),
}));
vi.mock("convex/react", () => ({
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) => {
    const name = getFunctionName(reference);
    fixture.queries(name, args);
    if (name === "tenants:getCurrentTenant" && fixture.loaded) {
      return { businessDayReady: fixture.ready, leadGenBusinessDayReady: true };
    }
    return undefined;
  },
}));
vi.mock("@/app/workspace/reports/_components/report-date-controls", () => ({ ReportDateControls: () => null }));
vi.mock("@/app/workspace/reports/_components/report-attribution-filters", () => ({ ReportAttributionFilters: () => null }));

import { TeamReportPageClient } from "@/app/workspace/reports/team/_components/team-report-page-client";
import { PipelineReportPageClient } from "@/app/workspace/reports/pipeline/_components/pipeline-report-page-client";
import { LeadGenOverviewCard } from "@/app/workspace/_components/lead-gen-overview-card";
import { TopOriginsOverviewSection } from "@/app/workspace/_components/top-origins-overview-section";
import { PhoneCloserOperationsSection } from "@/app/workspace/_components/phone-closer-operations-section";
import { TooltipProvider } from "@/components/ui/tooltip";

beforeEach(() => { fixture.loaded = true; fixture.ready = false; fixture.queries.mockClear(); });

const pages = [
  { name: "Team Performance", component: TeamReportPageClient, query: "reporting/teamPerformance:getTeamOperationsDimensions" },
  { name: "Pipeline Health", component: PipelineReportPageClient, query: "reporting/pipelineHealth:getSchedulingShowRateByOperationsDimensions" },
];

describe("meeting bucket page readiness", () => {
  it.each(pages)("skips $name bucket queries and renders the rebuild notice", ({ component, query }) => {
    const html = renderToStaticMarkup(createElement(component));
    expect(fixture.queries).toHaveBeenCalledWith(query, "skip");
    expect(html).toContain(BUSINESS_DAY_REBUILD_MESSAGE);
  });

  it.each(pages)("waits for tenant readiness before subscribing to $name buckets", ({ component, query }) => {
    fixture.loaded = false;
    renderToStaticMarkup(createElement(component));
    expect(fixture.queries).toHaveBeenCalledWith(query, "skip");
  });

  it.each(pages)("subscribes to $name buckets after readiness", ({ component, query }) => {
    fixture.ready = true;
    renderToStaticMarkup(createElement(component));
    expect(fixture.queries).toHaveBeenCalledWith(query, expect.any(Object));
  });

  it("renders rebuilding Overview sections without totals or generic errors", () => {
    const section = { status: "rebuilding" as const, data: null, truncated: false as const, message: BUSINESS_DAY_REBUILD_MESSAGE, errorCode: null };
    const sections = [
      createElement(LeadGenOverviewCard, { section, range: { kind: "preset", preset: "today" }, expanded: true, onExpandedChange: () => {} }),
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
