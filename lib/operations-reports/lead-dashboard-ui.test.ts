// @vitest-environment node
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

// A tenant with the page not switched to ClickHouse, so a long range takes the
// snapshot path.
vi.mock("convex/react", async () => {
  const { getFunctionName } = await import("convex/server");
  return {
    useQuery: (query: Parameters<typeof getFunctionName>[0]) =>
      getFunctionName(query) === "tenants:getCurrentTenant"
        ? { analyticsReports: [], leadGenBusinessDayReady: true }
        : undefined,
    useMutation: () => async () => null,
  };
});
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/workspace/_components/use-dashboard-range", () => ({
  useDashboardRange: () => ({ range: { kind: "preset", preset: "this_month" }, queryRange: { kind: "preset", preset: "this_month" }, rangeLabel: "This month", setRange: () => {} }),
}));
vi.mock("@/app/workspace/_components/dashboard-date-range-filter", () => ({ DashboardDateRangeFilter: () => null }));
vi.mock("@/app/workspace/operations/_components/operations-report-export-menu", () => ({ OperationsReportExportMenu: () => null }));
vi.mock("@/app/workspace/operations/_components/report-job-status", () => ({ OperationsReportJobStatus: () => null }));
vi.mock("@/app/workspace/operations/lead-gen/_components/raw-submissions-card", () => ({ RawSubmissionsCard: () => null }));
vi.mock("@/app/workspace/operations/_components/use-operations-report-job", () => ({
  useOperationsDashboardReport: () => ({ jobId: "job", job: { status: "ready" }, summary: { generatedAt: 1, payload: { submissions: 42, scheduledHours: 6, leadsPerHour: 7 } } }),
  useOperationsReportRows: () => ({ rows: [], isLoading: false }),
  useAllOperationsReportRows: () => ({ rows: [], isLoading: false, error: null }),
}));

import { LeadGenAdminPageClient } from "@/app/workspace/operations/lead-gen/_components/lead-gen-admin-page-client";

import { TopPostsByTeam } from "@/app/workspace/operations/lead-gen/_components/top-posts-by-team";

describe("Lead Gen historical UI", () => {
  it("keeps the totals, the specialists and Top posts & reels on a snapshot range", () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(LeadGenAdminPageClient)));
    expect(html).toContain("Submissions");
    expect(html).toContain("Specialists active");
    expect(html).toContain("Scheduled hours");
    expect(html).toContain("Per scheduled hour");
    expect(html).toContain("Prospect conversion");
    expect(html).toContain("Specialists");
    expect(html).toContain("Top posts &amp; reels");
    expect(html).toContain("Respark");
    expect(html).not.toContain("Historical lead-gen summary");
  });
});

describe("Top posts & reels by team", () => {
  const origin = { originKey: "shared", source: "instagram", originKind: "post", originValue: "https://instagram.com/p/shared", submissions: 3, uniqueProspects: 2 };
  const render = (groups: Parameters<typeof TopPostsByTeam>[0]["groups"]) =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(TopPostsByTeam, { groups, rangePhrase: "today", reloading: false })));

  it("names each team as a tab and shows the busiest team's posts", () => {
    const html = render([
      { teamId: "a", teamName: "Team A", totalSubmissions: 3, origins: [origin] },
      { teamId: "b", teamName: "Team B", totalSubmissions: 1, origins: [{ ...origin, submissions: 1, uniqueProspects: 1 }] },
    ]);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Team A</);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*>Team B</);
    expect(html).toContain('aria-label="Team A top posts and reels by submissions"');
    expect(html.match(/href="https:\/\/instagram.com\/p\/shared"/g)).toHaveLength(1);
  });

  it("drops the tabs for a single team", () => {
    const html = render([{ teamId: "a", teamName: "Team A", totalSubmissions: 3, origins: [origin] }]);
    expect(html).not.toContain('role="tab"');
    expect(html).toContain("Team A · by submissions");
  });

  it("shows loading and empty states", () => {
    expect(render(undefined)).toContain('aria-label="Loading top posts and reels"');
    expect(render([])).toContain("No submissions came from a post or reel today.");
  });
});
