// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("convex/react", () => ({ useQuery: () => undefined }));
vi.mock("@/app/workspace/_components/use-dashboard-range", () => ({
  useDashboardRange: () => ({ range: { kind: "preset", preset: "this_month" }, queryRange: { kind: "preset", preset: "this_month" }, rangeLabel: "This month", setRange: () => {} }),
}));
vi.mock("@/app/workspace/_components/dashboard-date-range-filter", () => ({ DashboardDateRangeFilter: () => null }));
vi.mock("@/app/workspace/operations/_components/operations-report-export-menu", () => ({ OperationsReportExportMenu: () => null }));
vi.mock("@/app/workspace/operations/_components/report-job-status", () => ({ OperationsReportJobStatus: () => null }));
vi.mock("@/app/workspace/operations/lead-gen/_components/raw-submissions-table", () => ({ RawSubmissionsTable: () => null }));
vi.mock("@/app/workspace/operations/_components/use-operations-report-job", () => ({
  useOperationsDashboardReport: () => ({ jobId: "job", job: { status: "ready" }, summary: { generatedAt: 1, payload: { submissions: 42, scheduledHours: 6, leadsPerHour: 7 } } }),
  useOperationsReportRows: () => ({ rows: [], isLoading: false }),
  useAllOperationsReportRows: () => ({ rows: [], isLoading: false, error: null }),
}));

import { LeadGenAdminPageClient } from "@/app/workspace/operations/lead-gen/_components/lead-gen-admin-page-client";

import { TopOriginsTable } from "@/app/workspace/operations/lead-gen/_components/top-origins-table";

describe("Lead Gen historical UI", () => {
  it("keeps original KPI cards, team performance, and Top Posts & Reels", () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(LeadGenAdminPageClient)));
    expect(html).toContain("Total Submissions");
    expect(html).toContain("Specialists Active");
    expect(html).toContain("Scheduled Hours");
    expect(html).toContain("Specialist Performance");
    expect(html).toContain("Top Posts &amp; Reels");
    expect(html).not.toContain("Historical lead-gen summary");
  });
});

describe("Top Posts & Reels by team", () => {
  it("renders separate named team sections for the same post", () => {
    const origin = { originKey: "shared", source: "instagram", originKind: "post", originValue: "https://instagram.com/p/shared", submissions: 3, uniqueProspects: 2 };
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TopOriginsTable, {
      groups: [
        { teamId: "a", teamName: "Team A", totalSubmissions: 3, origins: [origin] },
        { teamId: "b", teamName: "Team B", totalSubmissions: 1, origins: [{ ...origin, submissions: 1, uniqueProspects: 1 }] },
      ],
    })));
    expect(html).toContain('aria-label="Team A top posts and reels"');
    expect(html).toContain('aria-label="Team B top posts and reels"');
    expect(html.match(/href="https:\/\/instagram.com\/p\/shared"/g)).toHaveLength(2);
    expect(html).toContain("Top 10 per team");
  });

  it("shows loading and empty states", () => {
    const render = (groups: [] | undefined) => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TopOriginsTable, { groups })));
    expect(render(undefined)).toContain('aria-label="Loading top posts and reels by team"');
    expect(render([])).toContain("No Rankable Origins");
  });
});
